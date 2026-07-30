// WHAT THIS FILE IS:
// A tiny mostly-static server for the live dashboard. The dashboard is a
// browser page, and a browser cannot read local files directly, so this serves
// two roots over http:
//   /            -> dashboard/ app assets (index.html, derive.mjs)
//   /data/<path> -> the pipeline repo root (events.jsonl, runlog.jsonl,
//                   tickets/, specs/, reviews/, qa/, retros/, sdlc.config.json)
// The dashboard POLLS those files; there is no transformation/bridge — it just
// hands over the raw artifacts the pipeline already writes. Reads are bound to
// localhost, extension-whitelisted, path-traversal-guarded.
//
// NARROW WRITE SURFACE: one control route, POST /command, is the dashboard's
// "control plane". It does not touch product code — it only (a) starts a run by
// spawning `npm run sdlc debug <jobId>` in a fresh visible console, and
// (b) records a human approve/reject for a paused stage by atomically writing
// approvals/<ticket>__<stage>.decision.json (the orchestrator polls for it).
// It never gates the pipeline itself and never handles the portal password.
// The route is locked down: localhost-only Host, an x-sdlc-dashboard:"1" header,
// a same-origin check, a JSON content-type, a 64KB body cap, and strict
// jobId/ticket/stage/decision validation. Everything else stays read-only.
//
// Run:  npm run dashboard   (then open http://localhost:4300)

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync, unlinkSync, readdirSync, createWriteStream } from "node:fs";
import { resolve, extname, sep } from "node:path";
import { spawn, ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

const ROOT = resolve(process.cwd()); // pipeline repo root — the data
const APP = resolve(ROOT, "dashboard"); // the dashboard app assets
const APPROVALS = resolve(ROOT, "approvals"); // control-plane files (gitignored)
const LOGS = resolve(ROOT, "logs"); // per-run captured console output (gitignored)
const PORT = Number(process.env.DASHBOARD_PORT ?? 4300);

const STAGES = ["reproduce", "investigate", "spec", "review", "test"] as const;
const ID_RE = /^[a-f0-9]{24}$/i;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

// Resolve urlPath under baseDir, refusing anything that escapes it.
function safeResolve(baseDir: string, urlPath: string): string | null {
  const abs = resolve(baseDir, urlPath.replace(/^\/+/, ""));
  // Boundary on the separator: a bare startsWith(baseDir) would let a SIBLING
  // dir whose name extends baseDir (e.g. "<repo>-secrets") escape the jail.
  return abs === baseDir || abs.startsWith(baseDir + sep) ? abs : null;
}

// Host allowlist — the request must be addressed to us at localhost. Guards
// both the write route and the /data/* reads.
function hostAllowed(req: IncomingMessage): boolean {
  const h = req.headers.host;
  return h === `localhost:${PORT}` || h === `127.0.0.1:${PORT}`;
}

// Read the request body with a hard 64KB cap. On overflow: 413 + destroy the
// socket, and resolve null so the caller stops. On any error, resolve null too.
function readBody(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const CAP = 64 * 1024;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      resolvePromise(v);
    };
    req.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > CAP) {
        res.writeHead(413, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        res.end("payload too large");
        req.destroy();
        finish(null);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => finish(null));
  });
}

// The one live run this dashboard is managing. We spawn the pipeline as a CHILD
// (piped stdio) rather than a detached console, so its output streams INTO the
// dashboard and — the one interactive moment — the portal password can be handed
// to it over stdin. Held here so POST /command {cmd:"password"} can reach stdin.
let currentRun: { jobId: string; child: ChildProcess } | null = null;

// Start a run as a managed child of the dashboard. No visible console: stdout +
// stderr are tee'd to logs/<jobId>.log (which the dashboard tails over /data), and
// stdin stays open so the portal password can be written to it later. The headed
// reproduce browser still opens its OWN OS window — that's Chromium, not a console.
// SDLC_DASHBOARD_RUN tells run.ts it may collect the password over stdin instead of
// demanding a TTY.
//
// We spawn a DIRECT node child (the tsx loader) rather than `npm run … ` through a
// shell, on purpose: (a) the password we later write to child.stdin then reaches
// run.ts's process.stdin unmediated — no cmd.exe / npm.cmd link that could swallow
// piped stdin on Windows — and (b) run.lock.json's pid IS this child's pid, so the
// abort route's tree-kill and our child handle refer to the same process. The
// args-array form with shell:false has no quoting or DEP0190 concerns (jobId is also
// regex-validated by the caller). `node --import tsx pipeline/run.ts` is exactly what
// the `npm run sdlc` script (`tsx pipeline/run.ts`) resolves to.
function spawnRun(jobId: string): void {
  mkdirSync(LOGS, { recursive: true });
  const logPath = resolve(LOGS, `${jobId}.log`);
  // Fresh log each run (flags:"w" truncates), with a header so the pane isn't
  // blank during the initial context fetch.
  const log = createWriteStream(logPath, { flags: "w" });
  log.write(`$ npm run sdlc debug ${jobId}\n  ${new Date().toISOString()}\n\n`);

  const child = spawn(process.execPath, ["--import", "tsx", "pipeline/run.ts", "debug", jobId], {
    cwd: ROOT,
    env: { ...process.env, SDLC_DASHBOARD_RUN: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout?.on("data", (c: Buffer) => log.write(c));
  child.stderr?.on("data", (c: Buffer) => log.write(c));
  currentRun = { jobId, child };
  const clear = () => {
    if (currentRun && currentRun.child === child) currentRun = null;
    try { log.end(); } catch { /* already closed */ }
  };
  child.on("close", clear);
  child.on("error", clear);
}

// Force-kill a process and its whole child tree — the orchestrator spawns the
// Claude agent and the headed scraper/Chromium, so a plain kill would orphan them.
function treeKill(pid: number): void {
  if (process.platform === "win32") {
    spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  }
}

// The write route. Security first (Host, header, content-type, Origin), then the
// 64KB-capped body, then per-cmd validation and the narrow side effect.
async function handleCommand(
  req: IncomingMessage,
  res: ServerResponse,
  send: (code: number, type: string, body: string | Buffer) => void,
  sendJson: (code: number, obj: unknown) => void
): Promise<void> {
  if (!hostAllowed(req)) return send(403, "text/plain; charset=utf-8", "forbidden");
  if (req.headers["x-sdlc-dashboard"] !== "1") return send(403, "text/plain; charset=utf-8", "forbidden");
  if (!String(req.headers["content-type"] ?? "").includes("application/json"))
    return send(403, "text/plain; charset=utf-8", "forbidden");
  const origin = req.headers.origin;
  if (origin) {
    let originOk = false;
    try {
      const u = new URL(origin);
      originOk = u.host === `localhost:${PORT}` || u.host === `127.0.0.1:${PORT}`;
    } catch {
      originOk = false;
    }
    if (!originOk) return send(403, "text/plain; charset=utf-8", "forbidden");
  }

  const raw = await readBody(req, res);
  if (raw === null) return; // 413 already sent, or aborted
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return sendJson(400, { error: "invalid JSON" });
  }
  if (!body || typeof body !== "object") return sendJson(400, { error: "invalid body" });

  const cmd = body.cmd;

  if (cmd === "start") {
    const jobId = body.jobId;
    if (typeof jobId !== "string" || !ID_RE.test(jobId)) return sendJson(400, { error: "invalid jobId" });
    // Fastest guard: a child we're already managing. This closes the window during
    // the run's initial `fetch` phase, BEFORE it writes run.lock.json, where the
    // file check below would otherwise see no lock and let a second run spawn.
    if (currentRun && currentRun.child.exitCode === null && !currentRun.child.killed)
      return sendJson(409, { error: "a run is already in progress" });
    // Fail fast if a run is already live. The orchestrator re-acquires the lock
    // authoritatively; we only read it to avoid double-spawning.
    try {
      const lock = JSON.parse(readFileSync(resolve(APPROVALS, "run.lock.json"), "utf8"));
      if (lock && typeof lock.pid === "number") {
        let alive = false;
        try {
          process.kill(lock.pid, 0);
          alive = true;
        } catch (e: any) {
          // ESRCH = no such process (stale lock). EPERM = process exists but we
          // can't signal it — still ALIVE (matches the orchestrator's isPidAlive,
          // so the two liveness checks agree).
          alive = !!e && e.code === "EPERM";
        }
        if (alive) return sendJson(409, { error: "a run is already in progress" });
      }
    } catch {
      // no lock (or unparseable) -> free to start
    }
    spawnRun(jobId);
    return sendJson(202, { ok: true });
  }

  if (cmd === "decision") {
    const ticket = body.ticket;
    const stage = body.stage;
    const promptId = body.promptId;
    const decision = body.decision;
    const feedback = body.feedback ?? "";
    if (typeof ticket !== "string" || !ID_RE.test(ticket)) return sendJson(400, { error: "invalid ticket" });
    if (typeof stage !== "string" || !STAGES.includes(stage as (typeof STAGES)[number]))
      return sendJson(400, { error: "invalid stage" });
    if (decision !== "approve" && decision !== "reject") return sendJson(400, { error: "invalid decision" });
    if (typeof promptId !== "string" || !promptId) return sendJson(400, { error: "invalid promptId" });
    if (typeof feedback !== "string" || feedback.length > 4096) return sendJson(400, { error: "invalid feedback" });

    const reqPath = resolve(APPROVALS, `${ticket}__${stage}.request.json`);
    let request: Record<string, unknown>;
    try {
      request = JSON.parse(readFileSync(reqPath, "utf8"));
    } catch {
      return sendJson(409, { error: "no pending approval" });
    }
    if (request.promptId !== promptId) return sendJson(409, { error: "stale" });

    const decisionObj = { ticket, stage, promptId, decision, feedback, ts: new Date().toISOString() };
    const decisionPath = resolve(APPROVALS, `${ticket}__${stage}.decision.json`);
    // Atomic write: tmp with a unique suffix, then rename over the target, so the
    // polling orchestrator never reads a half-written file.
    const tmp = resolve(APPROVALS, `${ticket}__${stage}.decision.json.${randomUUID()}.tmp`);
    try {
      mkdirSync(APPROVALS, { recursive: true });
      writeFileSync(tmp, JSON.stringify(decisionObj, null, 2));
      renameSync(tmp, decisionPath);
    } catch {
      return sendJson(500, { error: "could not record decision" });
    }
    return sendJson(200, { ok: true });
  }

  if (cmd === "password") {
    // Hand the portal password to the live run over its stdin. Deliberately NOT
    // file-channelled: the secret goes browser -> this route -> the child's stdin,
    // never touching disk or a log. run.ts (dashboard mode) reads exactly one line
    // with echo OFF, so it never lands in logs/<jobId>.log either. Validated against
    // the pending approvals/<jobId>__password.request.json the run wrote.
    const jobId = body.jobId;
    const promptId = body.promptId;
    const password = body.password;
    if (typeof jobId !== "string" || !ID_RE.test(jobId)) return sendJson(400, { error: "invalid jobId" });
    if (typeof promptId !== "string" || !promptId) return sendJson(400, { error: "invalid promptId" });
    if (typeof password !== "string" || !password || password.length > 512)
      return sendJson(400, { error: "invalid password" });
    if (!currentRun || currentRun.jobId !== jobId || !currentRun.child.stdin || currentRun.child.stdin.destroyed)
      return sendJson(409, { error: "no run awaiting a password" });

    const reqPath = resolve(APPROVALS, `${jobId}__password.request.json`);
    let request: Record<string, unknown>;
    try {
      request = JSON.parse(readFileSync(reqPath, "utf8"));
    } catch {
      return sendJson(409, { error: "no pending password prompt" });
    }
    if (request.promptId !== promptId) return sendJson(409, { error: "stale" });

    try {
      currentRun.child.stdin.write(password + "\n");
    } catch {
      return sendJson(500, { error: "could not deliver password" });
    }
    return sendJson(200, { ok: true });
  }

  if (cmd === "abort") {
    // Stop the in-progress run: tree-kill the orchestrator (+ its agent/Chromium
    // children) via the pid in run.lock.json. A force-kill means the orchestrator's
    // own cleanup (releaseRunLock, run_finished) won't run, so we do it here:
    // record run_finished(aborted) so the dashboard reflects it, clear the lock so
    // a new run can start, and remove this run's pending approval files.
    const lockPath = resolve(APPROVALS, "run.lock.json");
    let lock: any = null;
    try {
      lock = JSON.parse(readFileSync(lockPath, "utf8"));
    } catch {
      return sendJson(200, { ok: true, note: "no run in progress" });
    }
    if (!lock || typeof lock.pid !== "number") return sendJson(200, { ok: true, note: "no run in progress" });
    treeKill(lock.pid);
    try {
      appendFileSync(
        resolve(ROOT, "events.jsonl"),
        JSON.stringify({ ts: new Date().toISOString(), type: "run_finished", ticket: lock.ticket, runId: lock.runId, outcome: "aborted" }) + "\n"
      );
    } catch { /* best effort */ }
    try { unlinkSync(lockPath); } catch { /* already gone */ }
    // One run at a time, so every pending approval file belongs to the aborted run.
    try {
      for (const f of readdirSync(APPROVALS)) {
        if (/\.(request\.json|decision\.json|preview\.md)$/.test(f)) {
          try { unlinkSync(resolve(APPROVALS, f)); } catch { /* ignore */ }
        }
      }
    } catch { /* no dir */ }
    return sendJson(200, { ok: true, aborted: lock.ticket });
  }

  return sendJson(400, { error: "unknown cmd" });
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const send = (code: number, type: string, body: string | Buffer) => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  };
  const sendJson = (code: number, obj: unknown) =>
    send(code, "application/json; charset=utf-8", JSON.stringify(obj));
  try {
    const method = (req.method ?? "GET").toUpperCase();
    const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);

    // OPTIONS is never welcome — 403, and deliberately NO Access-Control-Allow-*
    // headers, so a cross-site preflight cannot open the door.
    if (method === "OPTIONS") return send(403, "text/plain; charset=utf-8", "forbidden");

    // The one write route.
    if (method === "POST" && urlPath === "/command") {
      return await handleCommand(req, res, send, sendJson);
    }

    // Anything else that isn't a plain read is refused.
    if (method !== "GET" && method !== "HEAD") {
      return send(405, "text/plain; charset=utf-8", "method not allowed");
    }

    let abs: string | null;
    if (urlPath === "/" || urlPath === "/index.html") {
      abs = resolve(APP, "index.html");
    } else if (urlPath.startsWith("/data/")) {
      if (!hostAllowed(req)) return send(403, "text/plain; charset=utf-8", "forbidden");
      abs = safeResolve(ROOT, urlPath.slice("/data".length)); // /data/events.jsonl -> ROOT/events.jsonl
    } else {
      abs = safeResolve(APP, urlPath); // dashboard assets (derive.mjs, etc.)
    }
    if (!abs) return send(403, "text/plain; charset=utf-8", "forbidden");
    const type = TYPES[extname(abs)];
    if (!type) return send(415, "text/plain; charset=utf-8", "unsupported type");
    try {
      const data = await readFile(abs);
      send(200, type, data);
    } catch {
      // A not-yet-produced artifact (e.g. qa/007.md before QA runs) is a normal
      // 404 the dashboard renders as "not produced yet".
      send(404, "text/plain; charset=utf-8", "not found");
    }
  } catch {
    send(500, "text/plain; charset=utf-8", "error");
  }
});

// Fail fast, and loudly, when the port is already taken — otherwise a second
// `npm run dashboard` used to leak a half-started process (and left the user
// wondering which of several instances they were looking at). A clear message
// with the fix beats a stack trace and a zombie.
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\n  Port ${PORT} is already in use — a dashboard is probably already running.\n` +
        `  Just open http://localhost:${PORT}, or stop the other instance, or pick a free port:\n` +
        `      DASHBOARD_PORT=4301 npm run dashboard\n`
    );
  } else {
    console.error(`\n  Dashboard server error: ${err.message}\n`);
  }
  process.exit(1);
});

// Close the listener on Ctrl+C / kill so the port is released immediately
// instead of lingering in a process that keeps it bound. The unref'd timer is a
// backstop: if a keep-alive connection stalls server.close(), don't hang.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`\n  ${sig} — shutting down dashboard.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  SDLC dashboard  ->  http://localhost:${PORT}`);
  console.log(`  data root: ${ROOT}`);
  console.log(`  localhost only — reads are static; POST /command starts runs &`);
  console.log(`  records approve/reject decisions (approvals/) — Ctrl+C to stop\n`);
});
