// WHAT THIS FILE IS:
// The orchestrator. The small program that ties everything together for
// Session 1: read the config, read the ticket, call the parse agent
// (Claude Code, headless), show you the result, wait for your y/n, and
// save. Every run appends one line to runlog.jsonl so there's a record.
//
// Usage:
//   npm run sdlc run 001

import {
  readFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { resolve, relative, sep, isAbsolute } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { runChecks, runE2E, GateResult, checkReview, checkCoverage } from "./gates";
import { checkBundle, PRODUCT_KB_SPEC } from "./kb-conformance";
import {
  fetchUploadJobContext,
  writeContextArtifacts,
  validateUploadJobId,
  REQUIRED_FETCH_ENV,
  makeSentryGet,
  makeSentryBinaryGet,
  downloadJobArtifacts,
  buildReproduceInput,
  type FetchConfig,
} from "./fetch-context";

type StageMode = "manual" | "approve" | "auto";
type ProjectConfig = { productPath: string; knowledgePath: string };
type Config = {
  project: ProjectConfig;
  // enabled defaults to true when omitted; enabled:false skips the stage
  // entirely (no agent, no gate) — see runNamedStage.
  stages: Record<string, { mode: StageMode; maxTurns?: number; enabled?: boolean }>;
  // Optional post-ticket learning loop (Retrospector, then Curators). Off by
  // omission so the writing flow runs standalone on a fork that hasn't opted in.
  learning?: { enabled: boolean };
  // Optional MCP wiring. `configPath` points at an MCP-format file in THIS repo
  // (default "mcp.json") whose ${ENV} placeholders resolve from the loaded .env;
  // `stages` maps a stage name to the tool patterns that stage may call (e.g.
  // {"spec": ["mcp__MongoDB__*"]}). A stage not listed gets no MCP — so a fork
  // with no `mcp` block behaves exactly as before. See mcpForStage / the preflight
  // in main(). Servers are always loaded with --strict-mcp-config (reproducible;
  // ignores desktop/user/claude.ai connectors).
  mcp?: { configPath?: string; stages?: Record<string, string[]> };
  // Optional pre-fetch of external debugging context (for the `fetch` command).
  // Deterministic, not agent/MCP-driven: pulls one upload job's MongoDB document
  // and its matching Sentry events into context/<id>/context.{md,json}. Requires the
  // SENTRY_AUTH_TOKEN and MONGODB_URI credentials (see .env.example) — the fetch
  // preflight in runFetchCommand fails fast if either is unset. Omit this block
  // and the `fetch` command is simply unavailable. See pipeline/fetch-context.ts.
  fetch?: FetchConfig;
  // Optional config for the ON-DEMAND `reproduce` command: run the real scraper
  // headed against a failing job to reproduce it / validate a fix. `command` is run
  // in `cwd` with `env` applied (e.g. HEADED=true, SKIP_MONGO=true); the orchestrator
  // builds a self-contained input from the Mongo step, prompts for the portal password,
  // and passes it via the child's env INPUT payload (never written to disk/logs).
  // Consumed by runReproduceCommand.
  reproduce?: {
    command: string;
    cwd: string;
    env?: Record<string, string>;
    passwordPrompt?: string;
  };
};

type ProductComponent = { path: string; check: string; test?: string };
type ProductDescriptor = {
  name: string;
  components: Record<string, ProductComponent>;
  e2e?: { run: string; testDir?: string };
};

// Resolved once at startup and passed down, so no function reaches for a
// global. workdir is the absolute product repo path; knowledgeDir is the
// absolute knowledge repo path.
type Paths = { workdir: string; knowledgeDir: string };

// Bundles everything resolved once in main() so it can be threaded through
// as a single value instead of three separate params. Inside each stage,
// ctx only reaches the code-touching calls (buildPrompt, callAgent,
// ensureBranch, runChecks) — artifact reads/writes stay pipeline-local and
// never touch ctx.
type Ctx = {
  config: Config;
  paths: Paths;
  descriptor: ProductDescriptor;
  // Unique id for THIS orchestrator run: `${Date.now()}-${uuid8}`. Minted once in
  // main(), stamped into the run_started event, the run.lock.json mutex, and every
  // approval request.json so the dashboard/derive can scope approvals to the live
  // run and the startup sweep can discard stale ones from prior runs.
  runId: string;
};

type RetryContext = { priorAttempt: string; feedback: string };

// Bounded retry for the implement stage's automated fix loop (agent ->
// gate -> feed error back -> retry). Unlike the human reject loop for
// parse/spec, nothing here is asking a person each time, so it needs a
// hard ceiling or a persistently broken spec could retry forever.
const MAX_IMPLEMENT_ATTEMPTS = 3;

// Separate, smaller budget for E2E infra-failures specifically (PocketBase
// never came up, a port was taken, etc.). These retry the GATE, never the
// agent — there's no code to fix — so they don't share a counter with
// MAX_IMPLEMENT_ATTEMPTS. Exhausting this is an environment problem, not a
// code problem, and stops the pipeline for a human rather than looping the
// agent against a harness that isn't the code's fault.
const MAX_INFRA_RETRIES = 2;

// Cap on the QA -> implement -> QA belt. A QA failure (failing test or a
// coverage gap) means the code or its coverage is wrong, so work goes back to
// implement (which has its own syntax gate), then QA re-runs. Bounded like the
// implement belt so a persistently-failing feature summons a human.
const MAX_QA_ATTEMPTS = 3;

// Cap on the review -> implement -> review belt. A [BLOCKER] review finding
// means the CODE is wrong, so work goes back to implement (with the blocker
// text as feedback), then review re-runs. Bounded like the implement/QA belts
// so a persistently-blocked change summons a human instead of looping forever.
const MAX_REVIEW_ATTEMPTS = 3;

// The pipeline's fixed stage sequence. Both the auto-resume logic and the
// default run order in main() walk this same list, so adding a stage
// later (deploy) means adding it here once.
const STAGE_ORDER = ["reproduce", "investigate", "spec", "implement", "review", "test", "qa"] as const;
type Stage = (typeof STAGE_ORDER)[number];

function readConfig(): Config {
  const config: Config = JSON.parse(readFileSync("sdlc.config.json", "utf8"));
  if (!config.project?.productPath) {
    throw new Error("sdlc.config.json missing project.productPath");
  }
  if (!config.project?.knowledgePath) {
    throw new Error("sdlc.config.json missing project.knowledgePath");
  }
  return config;
}

function resolvePaths(config: Config): Paths {
  const workdir = resolve(config.project.productPath);
  const knowledgeDir = resolve(config.project.knowledgePath);

  if (!existsSync(workdir)) {
    throw new Error(`Product repo not found at ${workdir} (project.productPath).`);
  }
  // Validate the knowledge repo exists now, even though nothing writes to it
  // until Steps 4-5. Fail early rather than mid-run later.
  if (!existsSync(knowledgeDir)) {
    throw new Error(`Knowledge repo not found at ${knowledgeDir} (project.knowledgePath).`);
  }
  return { workdir, knowledgeDir };
}

function readProductDescriptor(workdir: string): ProductDescriptor {
  const path = resolve(workdir, ".sdlc/product.json");
  if (!existsSync(path)) {
    throw new Error(`Product descriptor not found at ${path}. Every product needs .sdlc/product.json.`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function readTicket(id: string): string {
  const path = `tickets/${id}.md`;
  if (!existsSync(path)) {
    throw new Error(`No ticket found at ${path}`);
  }
  return readFileSync(path, "utf8");
}

function readSpec(id: string): string {
  const path = `specs/${id}.md`;
  if (!existsSync(path)) {
    throw new Error(`No spec found at ${path}. Run the spec stage first.`);
  }
  return readFileSync(path, "utf8");
}

// The investigate stage's input: the debug context fetched for this upload job
// (the ticketId IS the uploadJobId in the debugging flow). Fails with a clear
// instruction if `fetch` hasn't run yet.
function readInvestigateContext(id: string): string {
  const path = `context/${id}/context.md`;
  if (!existsSync(path)) {
    throw new Error(
      `No fetched context at ${path}. Run \`npm run sdlc fetch ${id}\` first ` +
        `(or \`npm run sdlc debug ${id}\`, which fetches then runs).`,
    );
  }
  let out = readFileSync(path, "utf8");
  // Fold in the live reproduction result when the reproduce stage produced one.
  const reproPath = `context/${id}/reproduce.md`;
  if (existsSync(reproPath)) out += "\n\n---\n\n" + readFileSync(reproPath, "utf8");
  return out;
}

// investigate's approved output (root cause + remediation acceptance criteria) is
// saved AS the ticket, so spec/implement/review consume it unchanged via readTicket.
function writeInvestigation(id: string, output: string): void {
  mkdirSync("tickets", { recursive: true });
  writeFileSync(`tickets/${id}.md`, `# Investigation — upload job ${id}\n\n${output}\n`);
}

// Creates (or, on a rerun, switches to) an isolated feature branch before
// the implement stage runs, so an agent with Write/Edit/Bash access never
// touches main directly. Runs against the product repo (cwd), not the
// pipeline repo — the branch being created lives in the product's git history.
function ensureBranch(ticketId: string, cwd: string): string {
  const branch = `feature/${ticketId}`;
  const alreadyExists =
    spawnSync("git", ["rev-parse", "--verify", branch], { cwd, encoding: "utf8" }).status === 0;
  const result = spawnSync(
    "git",
    alreadyExists ? ["checkout", branch] : ["checkout", "-b", branch],
    { cwd, encoding: "utf8" }
  );
  if (result.status !== 0) {
    throw new Error(`Failed to switch to branch ${branch} in ${cwd}: ${result.stderr}`);
  }
  return branch;
}

// Builds the prompt a stage agent sees: the PRODUCT's project context
// (its own CLAUDE.md — stack, conventions, rules), its role description
// (from roleFile, which stays in the pipeline repo — role prompts are
// generic, not product-specific), the input it's working on, and — if a
// prior attempt was rejected — the rejected output plus the reviewer's
// feedback, so the agent revises instead of starting over blind.
//
// The trailing directive matters: without it, a headless Claude Code
// session sometimes treats this whole blob as passive background context
// (it auto-loads repo/git state regardless) and responds with a chatty
// "here's what I see in your repo, what would you like me to do?" instead
// of just doing the stage's job. An explicit "produce your output now, no
// questions, no preamble" instruction reliably prevents that.
function buildPrompt(
  workdir: string,
  roleFile: string,
  input: string,
  retry?: RetryContext,
  kbIndex?: { dir: string; indexText: string }
): string {
  const productClaudeMd = `${workdir}/CLAUDE.md`;
  const projectContext = existsSync(productClaudeMd) ? readFileSync(productClaudeMd, "utf8") : "";
  const roleDescription = readFileSync(roleFile, "utf8");
  const sections = [projectContext, roleDescription].filter(Boolean);

  // Inject the KB index (small) so the agent knows what durable knowledge
  // exists and can read the concept files it needs ON DEMAND from disk — the KB
  // dir is added as a readable root via callAgent's addDir. Only the index is
  // injected; concept bodies are never bulk-loaded.
  if (kbIndex) {
    sections.push(
      [
        "## Project knowledge base",
        "A knowledge base of durable facts about this product is available at:",
        `  ${kbIndex.dir}`,
        "Read concept files from there ON DEMAND — only the ones relevant to this",
        "task — and follow what they say. Paths in the index below are relative to",
        "that directory. Do not load concepts you don't need.",
        "",
        "### Index",
        kbIndex.indexText,
      ].join("\n")
    );
  }

  sections.push("## Input", input);

  if (retry) {
    sections.push(
      [
        "## Your previous attempt was rejected",
        `Reviewer feedback: ${retry.feedback}`,
        "",
        "Previous output:",
        retry.priorAttempt,
        "",
        "Produce a revised version addressing the feedback.",
      ].join("\n")
    );
  }

  sections.push(
    "Now produce your output for the Input above, per the role instructions. " +
      "Respond with ONLY the required markdown deliverable — no questions, " +
      "no summary of repository state, no preamble."
  );

  return sections.join("\n\n---\n\n");
}

// Reads the knowledge repo's root index.md, if present, for the KB-reading
// stages (parse/spec/implement/review). The index is small and injected every
// such call; concept bodies are read by the agent on demand (callAgent's addDir
// grants read access to knowledgeDir). Returns undefined when there's no index,
// so a stage runs EXACTLY as before on a fork with no KB — the feature can't
// regress the writing flow. NB: the index sits at the repo root (knowledgeDir),
// not under a bundle/ subdir, matching the OKF layout.
function readKbIndex(knowledgeDir: string): { dir: string; indexText: string } | undefined {
  const indexPath = `${knowledgeDir}/index.md`;
  if (!existsSync(indexPath)) return undefined;
  return { dir: knowledgeDir, indexText: readFileSync(indexPath, "utf8") };
}

// Loads KEY=VALUE lines from a .env file into process.env WITHOUT overwriting
// vars already present in the real environment (an explicit shell export wins).
// Per-user MCP credentials live here (gitignored, never committed): a product's
// .sdlc/mcp.json references them as ${VAR}, and since callAgent spawns the claude
// child inheriting the orchestrator's process.env, loading them here is what lets
// that expansion resolve. Intentionally tiny (no dotenv dependency — keeps the
// "Node only, no deps" stack): KEY=VALUE, # comments, blank lines, and optional
// surrounding quotes on the value. Not a full dotenv parser (no interpolation).
function loadEnvFile(envPath: string): void {
  if (!existsSync(envPath)) return;
  for (const raw of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

// Quotes each part and joins them into one command-line string, for
// platforms that need shell: true. Node deprecates (DEP0190) passing an
// args array alongside shell: true, because it has to join them into one
// string itself without escaping — a real injection risk if any part
// came from untrusted input. Doing the join explicitly here, ourselves,
// avoids that: spawnSync gets one pre-built string and no args array, so
// there's nothing left for it to (mis)join.
function quoteCommandLine(parts: string[]): string {
  return parts.map((part) => `"${part.replace(/"/g, '\\"')}"`).join(" ");
}

// How long a single agent invocation may run before the orchestrator kills
// it and fails loudly. Nothing else bounds this: --allowedTools scopes WHAT
// the agent can touch, not how long it can run, and maxTurns (see below)
// isn't enforced by the CLI at all. Without a ceiling, an agent stuck
// retrying a tool call it has no permission for (or just exploring
// indefinitely) hangs the pipeline forever with no way to tell it apart
// from a slow-but-fine run.
const AGENT_TIMEOUT_MS = 10 * 60 * 1000;

// Kills the whole process tree, not just the immediate child. On Windows
// the claude CLI runs under `shell: true` (cmd.exe wrapping claude.cmd
// wrapping node.exe); a bare child.kill() only signals cmd.exe and can
// leave the real work orphaned and still running. taskkill /T recurses.
function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"]);
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // process group already gone
    }
  }
}

// Invokes Claude Code headlessly and returns its text output.
//
// The prompt travels over stdin rather than as a CLI argument: on Windows,
// npm installs "claude" as a .cmd shim, and cmd.exe re-parses argv, which
// mangles long/multiline text. Stdin sidesteps that and works the same on
// every platform. Windows also requires shell: true to launch .cmd files
// at all (Node refuses without it) — see quoteCommandLine above for why
// that's paired with a pre-built command string rather than an args array.
//
// Runs via async spawn() rather than spawnSync() so stdout/stderr can be
// streamed to the console as they arrive, instead of appearing all at once
// (or not at all) only after the whole call returns — a long-running stage
// used to look identical to a hung one because nothing could be printed
// while Node was blocked synchronously inside spawnSync.
//
// allowedTools scopes what the agent can touch — e.g. the spec stage is
// read-only, so it's invoked with allowedTools: ["Read"], matching the
// "read-only agent" permission scoping described for parse/spec/review.
//
// cwd is the product repo. Launching the claude CLI there — not in the
// pipeline repo — is what makes it auto-load the PRODUCT's own CLAUDE.md
// and git state, on top of the product CLAUDE.md text buildPrompt already
// injects explicitly. Belt and suspenders: the explicit injection guarantees
// the content reaches the prompt even for read-only stages where auto-load
// behavior is less predictable; cwd makes git state (branch, diff) real too.
//
// maxTurns is accepted for forward compatibility with sdlc.config.json's
// implement.maxTurns, but this CLI version (checked via `claude --help`)
// has no turn-limiting flag, only --max-budget-usd (a dollar cap, not a
// turn cap). It is intentionally NOT enforced here rather than silently
// mapped to a different unit. AGENT_TIMEOUT_MS above is the real ceiling
// on an unattended run now, not a turn limit.
// Best-effort single-token description of what a tool call acted on, for the
// live activity feed (agent_tool_use events).
function toolTarget(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  if (typeof i.file_path === "string") return i.file_path;
  if (typeof i.path === "string") return i.path;
  if (typeof i.pattern === "string") return i.pattern;
  if (typeof i.command === "string") return i.command.slice(0, 60);
  return "";
}

// If absFile is inside kbDir, return its bundle-relative path (forward slashes);
// otherwise null. Used to recognize a Read that "reaches into" the KB.
function kbRelative(kbDir: string, absFile: string): string | null {
  const rel = relative(kbDir, resolve(absFile));
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

// Runs a headless Claude Code agent and returns its final text. Uses
// --output-format stream-json (which the CLI requires --verbose for) so the
// orchestrator can SEE the agent's tool calls as they happen — that visibility
// is what powers the live telemetry: every tool call becomes an agent_tool_use
// event, and a Read under the KB dir (opts.addDir) becomes a kb_read event, so
// a dashboard can show an agent "reaching for the KB" in real time. The final
// text still comes back to callers exactly as before (from the terminal
// "result" event), so switching output format is transparent to every stage.
function callAgent(
  prompt: string,
  opts: {
    cwd: string;
    allowedTools?: string[];
    maxTurns?: number;
    addDir?: string;
    // Additional readable roots beyond addDir (each becomes another --add-dir).
    // addDir stays the KB dir (kb_read telemetry keys on it); extraDirs are e.g.
    // the fetched context/<id>/ dir handed to the investigate stage.
    extraDirs?: string[];
    // Absolute path to an .mcp.json giving this stage's agent live (MCP) tools.
    // When set, callAgent passes --mcp-config <path> --strict-mcp-config.
    mcpConfig?: string;
    // Tag emitted telemetry events so the UI can attribute them to a run/stage.
    ticket?: string;
    stage?: string;
  }
): Promise<string> {
  const claudeCommand = process.platform === "win32" ? "claude.cmd" : "claude";
  // addDir grants the agent read access to a directory OUTSIDE its cwd (the
  // product repo) — used to hand the KB-reading stages the knowledge repo.
  // Woven into `args` HERE, before the ...args spread that BOTH branches below
  // consume: the POSIX branch passes the array to spawn, the win32 branch spreads
  // it through quoteCommandLine into one quoted command string. Building it here
  // means the path is individually quoted on Windows (spaces-safe) and DEP0190
  // stays avoided. Do NOT move this into the spawn/command-string call sites.
  const dirArgs = [
    ...(opts?.addDir ? ["--add-dir", opts.addDir] : []),
    ...(opts?.extraDirs ?? []).flatMap((d) => ["--add-dir", d]),
  ];
  // Load MCP servers for this stage from an EXPLICIT config path (a project
  // .mcp.json auto-loads only after an interactive trust prompt — useless for a
  // headless run). --strict-mcp-config makes the agent ignore every OTHER MCP
  // source (user/desktop/claude.ai connectors) so a run sees ONLY what the
  // product declares and is reproducible across forkers' machines. Woven into
  // `args` HERE (like dirArgs), before the win32/POSIX fork below, so the path is
  // individually quoted on Windows (spaces-safe) and DEP0190 stays avoided.
  const mcpArgs = opts?.mcpConfig
    ? ["--mcp-config", opts.mcpConfig, "--strict-mcp-config"]
    : [];
  // stream-json emits one JSON event per line (assistant/tool_use/result/…);
  // the CLI rejects it in --print mode without --verbose.
  const streamArgs = ["--output-format", "stream-json", "--verbose"];
  const args = opts?.allowedTools
    ? [...dirArgs, ...mcpArgs, "--allowedTools", opts.allowedTools.join(","), ...streamArgs, "-p"]
    : [...dirArgs, ...mcpArgs, ...streamArgs, "-p"];

  const kbDir = opts.addDir;

  return new Promise((resolvePromise, reject) => {
    const child =
      process.platform === "win32"
        ? spawn(quoteCommandLine([claudeCommand, ...args]), { cwd: opts.cwd, shell: true })
        : // detached makes the child its own process-group leader, so killTree's
          // `process.kill(-pid)` on timeout actually reaches the whole tree
          // (without it the negative-pid group signal throws ESRCH and the child
          // is orphaned). Windows uses taskkill /T instead and needs no equivalent.
          spawn(claudeCommand, args, { cwd: opts.cwd, detached: true });

    let stderr = "";
    let lineBuf = "";
    let resultText = "";
    let sawResult = false;
    const textParts: string[] = []; // fallback if no terminal result event
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
    }, AGENT_TIMEOUT_MS);

    const handleEvent = (ev: any) => {
      if (!ev || typeof ev !== "object") return;
      if (ev.type === "assistant" && ev.message && Array.isArray(ev.message.content)) {
        for (const block of ev.message.content) {
          if (block.type === "text" && typeof block.text === "string") {
            textParts.push(block.text);
            process.stdout.write(block.text);
          } else if (block.type === "tool_use") {
            const name = String(block.name ?? "tool");
            const target = toolTarget(block.input);
            process.stdout.write(`\n  → ${name}${target ? " " + target : ""}\n`);
            emitEvent("agent_tool_use", { ticket: opts.ticket, stage: opts.stage, tool: name, target });
            if (name === "Read" && kbDir && block.input && typeof block.input.file_path === "string") {
              const rel = kbRelative(kbDir, block.input.file_path);
              if (rel !== null) {
                emitEvent("kb_read", { ticket: opts.ticket, stage: opts.stage, file: rel });
              }
            }
          }
        }
      } else if (ev.type === "result") {
        sawResult = true;
        if (typeof ev.result === "string") resultText = ev.result;
      }
    };

    const handleLine = (raw: string) => {
      const line = raw.trim();
      if (!line) return;
      let ev: unknown;
      try {
        ev = JSON.parse(line);
      } catch {
        return; // not a JSON event line (stray diagnostic output) — ignore
      }
      // handleEvent runs OUTSIDE the parse guard on purpose: an exception here
      // (e.g. emitEvent's appendFileSync failing) is a real IO/logic error and
      // must not be silently swallowed as "not JSON".
      handleEvent(ev);
    };

    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      lineBuf += chunk;
      let idx: number;
      while ((idx = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 1);
        handleLine(line);
      }
    });

    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to invoke claude CLI: ${err.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (lineBuf.trim()) handleLine(lineBuf); // flush a final unterminated line
      if (timedOut) {
        reject(
          new Error(
            `claude CLI timed out after ${AGENT_TIMEOUT_MS / 1000}s and was killed.\n` +
              `Partial output:\n${(sawResult ? resultText : textParts.join("")).trim()}\n${stderr}`
          )
        );
        return;
      }
      if (code !== 0) {
        reject(new Error(`claude CLI exited with code ${code}: ${stderr}`));
        return;
      }
      resolvePromise((sawResult ? resultText : textParts.join("")).trim());
    });

    child.stdin!.write(prompt);
    child.stdin!.end();
  });
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} (y/n) `);
  rl.close();
  return answer.trim().toLowerCase().startsWith("y");
}

async function promptText(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} `);
  rl.close();
  return answer.trim();
}

// ---- Dashboard control plane: approvals (file <-> HTTP handoff) ----

// Repo-root-relative paths for a given pause, keyed by <TICKET>__<STAGE>. The
// dashboard server writes the decision.json; the orchestrator writes the
// request.json (and, for generic stages, a preview.md). These three files ARE
// the approval channel — see the SHARED CONTRACT.
function approvalPaths(ticket: string, stage: string): {
  request: string;
  decision: string;
  preview: string;
} {
  const key = `${ticket}__${stage}`;
  return {
    request: `approvals/${key}.request.json`,
    decision: `approvals/${key}.decision.json`,
    preview: `approvals/${key}.preview.md`,
  };
}

// process.kill(pid, 0) probes liveness without signalling: it throws ESRCH when
// the pid is gone, EPERM when it exists but we can't signal it (still alive).
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

// A human approval that can arrive from EITHER the terminal (readline y/n, when a
// TTY is present) OR the dashboard (a decision.json the server wrote in response
// to a POST /command). Both race under a single settle-once guard so whichever
// answers first wins and the other is torn down cleanly — no leaked readline on
// stdin, no stale control files left behind. Returns which path settled it.
//
// The portal PASSWORD is deliberately NOT part of this channel: it is prompted
// only over the terminal in doReproduce (never file-channelled). This gate only
// carries the approve/reject decision (+ optional feedback on reject).
async function awaitApproval(
  ctx: Ctx,
  args: {
    ticket: string;
    stage: string;
    attempt: number;
    question: string;
    // Repo-root-relative path the dashboard fetches as /data/<previewPath> to show
    // the produced output. "" when there's nothing to preview (reproduce).
    previewPath: string;
    wantFeedback: boolean;
  }
): Promise<{ approved: boolean; feedback?: string; via: "terminal" | "dashboard" }> {
  const { ticket, stage, attempt, question, previewPath, wantFeedback } = args;
  const paths = approvalPaths(ticket, stage);

  mkdirSync("approvals", { recursive: true });
  // Clear any leftover decision from a prior pause so the interval can't pick up
  // a stale answer before the human acts on THIS request.
  if (existsSync(paths.decision)) {
    try {
      unlinkSync(paths.decision);
    } catch {
      /* best effort */
    }
  }

  const promptId = randomUUID();
  const request = {
    ticket,
    stage,
    attempt,
    promptId,
    runId: ctx.runId,
    ts: new Date().toISOString(),
    question,
    previewPath,
    wantFeedback,
  };
  writeFileSync(paths.request, JSON.stringify(request, null, 2));
  emitEvent("awaiting_approval", { ticket, stage, runId: ctx.runId, promptId, attempt });

  return new Promise((resolvePromise) => {
    let settled = false;
    let interval: ReturnType<typeof setInterval>;
    let rl: ReturnType<typeof createInterface> | undefined;
    const ac = new AbortController();

    const cleanup = () => {
      clearInterval(interval);
      ac.abort(); // reject any pending terminal question so its await unwinds
      if (rl) {
        try {
          rl.close();
        } catch {
          /* already closed */
        }
      }
      // Tear down the control files for this pause (request + decision + the
      // orchestrator-owned preview.md). previewPath in the request may point at a
      // persisted artifact (e.g. reviews/<id>.md for review) — we NEVER delete
      // that; only the approvals/<key>.preview.md we may have written.
      for (const p of [paths.request, paths.decision, paths.preview]) {
        try {
          if (existsSync(p)) unlinkSync(p);
        } catch {
          /* best effort */
        }
      }
    };

    const settle = (result: { approved: boolean; feedback?: string; via: "terminal" | "dashboard" }) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(result);
    };

    // (1) File source: poll for the server-written decision.json.
    interval = setInterval(() => {
      if (settled) return;
      if (!existsSync(paths.decision)) return;
      let dec: any;
      try {
        dec = JSON.parse(readFileSync(paths.decision, "utf8"));
      } catch {
        return; // torn/partial write — keep waiting, don't crash
      }
      if (!dec || dec.promptId !== promptId) {
        // A decision for a DIFFERENT prompt (stale) — discard it and keep waiting.
        try {
          unlinkSync(paths.decision);
        } catch {
          /* best effort */
        }
        return;
      }
      settle({
        approved: dec.decision === "approve",
        feedback: typeof dec.feedback === "string" ? dec.feedback : "",
        via: "dashboard",
      });
    }, 300);

    // (2) Terminal source: only when a real TTY is attached. Uses an AbortSignal
    // so a dashboard win can cancel the pending question and free stdin.
    if (process.stdin.isTTY) {
      rl = createInterface({ input: process.stdin, output: process.stdout });
      (async () => {
        const ans = await rl!.question(`${question} (y/n) `, { signal: ac.signal });
        if (settled) return;
        if (ans.trim().toLowerCase().startsWith("y")) {
          settle({ approved: true, via: "terminal" });
          return;
        }
        let feedback = "";
        if (wantFeedback) {
          const fb = await rl!.question("What should change? ", { signal: ac.signal });
          if (settled) return;
          feedback = fb.trim();
        }
        settle({ approved: false, feedback, via: "terminal" });
      })().catch(() => {
        // Expected when a dashboard decision settled first: ac.abort() rejects the
        // pending question. Swallow it — settle() already resolved the outer promise.
      });
    }
  });
}

// ---- Run mutex + startup sweep (dashboard control plane) ----

// Acquires the single-run lock BEFORE the stage loop. A live lock (its pid still
// alive) means another run owns the pipeline — refuse and exit non-zero. A dead
// pid is a stale lock from a crashed run — overwrite it. The server also reads
// this file to fail fast on POST /command {cmd:"start"}, but the orchestrator is
// authoritative: it re-acquires here.
function acquireRunLock(ctx: Ctx, ticket: string): void {
  mkdirSync("approvals", { recursive: true });
  const lockPath = "approvals/run.lock.json";
  if (existsSync(lockPath)) {
    try {
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      if (typeof lock.pid === "number" && lock.pid !== process.pid && isPidAlive(lock.pid)) {
        console.error(
          `a run is already in progress (pid ${lock.pid}, ticket ${lock.ticket ?? "?"}). ` +
            `Wait for it to finish, or remove ${resolve(lockPath)} if you're sure it's stale.`
        );
        process.exit(1);
      }
      // Otherwise the lock is stale (dead pid / our own pid) — fall through and overwrite.
    } catch {
      // Unreadable lock — treat as stale and overwrite.
    }
  }
  writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, ticket, runId: ctx.runId, startedAt: new Date().toISOString() }, null, 2)
  );
}

// Releases the lock at the end of the run — but ONLY if it's still ours (runId
// matches). If a later run legitimately overwrote a stale lock we'd otherwise
// delete theirs.
function releaseRunLock(ctx: Ctx): void {
  const lockPath = "approvals/run.lock.json";
  try {
    if (!existsSync(lockPath)) return;
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    if (lock.runId === ctx.runId) unlinkSync(lockPath);
  } catch {
    /* best effort */
  }
}

// Deletes leftover approval control files from PRIOR runs so the dashboard never
// shows a pause that no longer belongs to the live run. A request.json whose
// embedded runId != ours is stale; its sibling decision.json/preview.md go with
// it. Then any orphan decision.json/preview.md (no matching request) is swept
// too. run.lock.json is left to the mutex.
function sweepStaleApprovals(runId: string): void {
  const dir = "approvals";
  if (!existsSync(dir)) return;
  const suffixes = [".request.json", ".decision.json", ".preview.md"];

  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".request.json")) continue;
    const key = name.slice(0, -".request.json".length);
    let stale = true;
    try {
      const req = JSON.parse(readFileSync(`${dir}/${name}`, "utf8"));
      stale = req.runId !== runId;
    } catch {
      stale = true; // unreadable request — treat as stale
    }
    if (stale) {
      for (const suffix of suffixes) {
        const p = `${dir}/${key}${suffix}`;
        try {
          if (existsSync(p)) unlinkSync(p);
        } catch {
          /* best effort */
        }
      }
    }
  }

  // Orphan decision/preview files (their request is gone) — clean them up.
  for (const name of readdirSync(dir)) {
    const suffix = name.endsWith(".decision.json")
      ? ".decision.json"
      : name.endsWith(".preview.md")
        ? ".preview.md"
        : null;
    if (!suffix) continue;
    const key = name.slice(0, -suffix.length);
    if (!existsSync(`${dir}/${key}.request.json`)) {
      try {
        unlinkSync(`${dir}/${name}`);
      } catch {
        /* best effort */
      }
    }
  }
}

function logRun(entry: Record<string, unknown>): void {
  appendFileSync("runlog.jsonl", JSON.stringify(entry) + "\n");
}

// Fine-grained, real-time telemetry for a live UI. Unlike runlog.jsonl (one row
// per finished stage — the durable resume state machine), events.jsonl is an
// append-only, timestamped NDJSON stream written AS things happen: run/stage
// lifecycle, per-tool-call activity (incl. kb_read when an agent opens a KB
// concept), gate results, and belt routing. A dashboard tails this file to show
// the pipeline live. It is telemetry only — nothing here gates the pipeline.
function emitEvent(type: string, data: Record<string, unknown> = {}): void {
  appendFileSync("events.jsonl", JSON.stringify({ ts: new Date().toISOString(), type, ...data }) + "\n");
}

function readRunlog(): Array<{ stage?: string; ticket?: string; approved?: boolean }> {
  if (!existsSync("runlog.jsonl")) return [];
  const raw = readFileSync("runlog.jsonl", "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => JSON.parse(line));
}

// Resumes a ticket from wherever it last left off, instead of always
// restarting at parse. runlog.jsonl is already a durable, append-only
// record of every stage attempt (see logRun), so it doubles as pipeline
// state — no separate state file to invent or keep in sync.
//
// "Last completed" means the highest-index stage in STAGE_ORDER that has
// a logged approved:true entry for this ticket. Rejected attempts
// (approved:false) don't count, so a stage that was rejected and later
// approved still resolves correctly; a stage that failed its gate (also
// approved:false, e.g. implement's build check) resumes AT that stage to
// retry it, not past it.
function resolveStartStage(ticketId: string): Stage {
  const log = readRunlog();
  let lastCompletedIndex = -1;

  for (const entry of log) {
    if (entry.ticket !== ticketId || entry.approved !== true) continue;
    const index = STAGE_ORDER.indexOf(entry.stage as Stage);
    if (index > lastCompletedIndex) lastCompletedIndex = index;
  }

  const nextIndex = lastCompletedIndex + 1;
  if (nextIndex >= STAGE_ORDER.length) {
    console.log(
      `Ticket ${ticketId} has already completed every configured stage (${STAGE_ORDER.join(" -> ")}).`
    );
    console.log("Use --stage <name> to force a re-run of a specific stage.");
    process.exit(0);
  }

  return STAGE_ORDER[nextIndex];
}

type StageOptions = {
  stage: string;
  ticketId: string;
  mode: StageMode;
  roleFile: string;
  getInput: () => string;
  onApprove: (output: string) => void;
  allowedTools?: string[];
  // When true, inject the product KB index and add the KB dir as a readable
  // root. Set on the KB-reading stages (parse/spec/review); test does NOT read
  // the KB (it works from the spec + code), and qa is deterministic.
  usesKb?: boolean;
  // Extra absolute directories (beyond the KB) to grant the agent read access to,
  // as additional --add-dir roots. Used by investigate to read the fetched
  // context/<id>/ dir (context.md + downloaded failure artifacts) which lives in
  // the pipeline repo, outside the agent's product-repo cwd.
  extraReadDirs?: string[];
};

// Generic stage runner: build the prompt, call the agent, show the
// output, and (in "approve" mode) wait for a human decision. On approval,
// hands the output to the stage's onApprove callback to save wherever
// that stage's artifact belongs. On rejection, asks what should change,
// logs the rejection with that feedback, then re-runs this same stage
// with the rejected output and the feedback folded into the prompt so
// the agent revises instead of guessing again from scratch. Keeps
// looping until the human approves. "auto" mode skips the pause entirely
// since there's no human to ask.
// Resolves which MCP tools (and the config file) a given stage should receive,
// from sdlc.config.json's optional `mcp` block. Returns empty when the stage
// isn't configured, so it behaves EXACTLY as before on a fork with no MCP. This
// is the SINGLE place the stage->server policy is decided; the (few) agent call
// sites just merge the returned tools into their allowedTools and hand mcpConfig
// to callAgent (which adds --mcp-config <path> --strict-mcp-config).
function mcpForStage(ctx: Ctx, stage: string): { mcpConfig?: string; tools: string[] } {
  const tools = ctx.config.mcp?.stages?.[stage] ?? [];
  if (tools.length === 0) return { tools: [] };
  const configPath = resolve(ctx.config.mcp?.configPath ?? "mcp.json");
  if (!existsSync(configPath)) {
    throw new Error(
      `sdlc.config.json enables MCP for stage "${stage}" but no MCP config file ` +
        `exists at ${configPath} (set mcp.configPath; default "mcp.json").`
    );
  }
  return { mcpConfig: configPath, tools };
}

// Finds ${VAR} references WITHOUT a ":-default" in an mcp.json's text — the
// credentials the config REQUIRES from the environment. (${VAR:-x} is skipped:
// it self-supplies a default, so it won't match this pattern.) Used by main()'s
// preflight to fail fast, before any agent runs half-blind because a server
// silently failed to start on a missing credential.
function requiredMcpEnvVars(mcpText: string): string[] {
  const req = new Set<string>();
  for (const m of mcpText.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) req.add(m[1]);
  return [...req];
}

async function runStage(opts: StageOptions, ctx: Ctx, retry?: RetryContext, attempt = 1): Promise<void> {
  const startedAt = Date.now();
  const input = opts.getInput();
  const kb = opts.usesKb ? readKbIndex(ctx.paths.knowledgeDir) : undefined;
  const prompt = buildPrompt(ctx.paths.workdir, opts.roleFile, input, retry, kb);

  emitEvent("stage_started", { ticket: opts.ticketId, stage: opts.stage, mode: opts.mode, retry: retry ? true : undefined });
  emitEvent("agent_started", { ticket: opts.ticketId, stage: opts.stage, kb: { offered: !!kb, dir: kb ? kb.dir : undefined } });

  console.log(`\nRunning ${opts.stage} agent on ticket ${opts.ticketId}...\n`);
  const mcp = mcpForStage(ctx, opts.stage);
  const output = await callAgent(prompt, {
    cwd: ctx.paths.workdir,
    allowedTools: opts.allowedTools ? [...opts.allowedTools, ...mcp.tools] : opts.allowedTools,
    addDir: kb ? kb.dir : undefined,
    extraDirs: opts.extraReadDirs,
    mcpConfig: mcp.mcpConfig,
    ticket: opts.ticketId,
    stage: opts.stage,
  });

  console.log(`----- ${opts.stage} agent output -----\n`);
  console.log(output);
  console.log("\n-------------------------------\n");

  const save = () => {
    opts.onApprove(output);
    console.log(`Saved (${opts.stage}).`);
    logRun({
      stage: opts.stage,
      ticket: opts.ticketId,
      mode: opts.mode,
      durationMs: Date.now() - startedAt,
      approved: true,
    });
    emitEvent("stage_finished", { ticket: opts.ticketId, stage: opts.stage, approved: true, durationMs: Date.now() - startedAt });
  };

  if (opts.mode !== "approve") {
    save();
    return;
  }

  // The pipeline is now blocked on a human decision, answerable from EITHER the
  // terminal or the dashboard (awaitApproval races both). The generic stage's
  // artifact isn't persisted until approval, so write a preview.md the dashboard
  // can fetch; awaitApproval emits the awaiting_approval telemetry and tears the
  // preview down on settle.
  const paths = approvalPaths(opts.ticketId, opts.stage);
  mkdirSync("approvals", { recursive: true });
  writeFileSync(paths.preview, output);

  const decision = await awaitApproval(ctx, {
    ticket: opts.ticketId,
    stage: opts.stage,
    attempt,
    question: "Approve this output?",
    previewPath: paths.preview,
    wantFeedback: true,
  });
  if (decision.approved) {
    save();
    return;
  }

  const feedback = decision.feedback ?? "";
  logRun({
    stage: opts.stage,
    ticket: opts.ticketId,
    mode: opts.mode,
    durationMs: Date.now() - startedAt,
    approved: false,
    feedback,
  });
  emitEvent("stage_finished", { ticket: opts.ticketId, stage: opts.stage, approved: false, durationMs: Date.now() - startedAt });

  console.log(`\nRe-running ${opts.stage} agent with your feedback...\n`);
  await runStage(opts, ctx, { priorAttempt: output, feedback }, attempt + 1);
}

function runStageInvestigate(ticketId: string, mode: StageMode, ctx: Ctx): Promise<void> {
  return runStage(
    {
      stage: "investigate",
      ticketId,
      mode,
      roleFile: "agents/investigate.md",
      // Input is the fetched debug context (Mongo + Sentry + downloaded failure
      // artifacts) written by `fetch` to context/<id>/. ticketId IS the uploadJobId.
      getInput: () => readInvestigateContext(ticketId),
      // Read-scoped: investigate reads the context + KB + scraper source and emits a
      // diagnosis; it writes nothing itself (the orchestrator saves the ticket).
      // Grep/Glob let it search the KB (esp. cases/) by portal + error signature.
      allowedTools: ["Read", "Grep", "Glob"],
      usesKb: true,
      // Grant read access to the fetched context dir (pipeline-repo-local, outside
      // the agent's product-repo cwd) so it can open context.md AND the downloaded
      // error-screenshot / recording under context/<id>/artifacts/.
      extraReadDirs: [resolve(`context/${ticketId}`)],
      // Save the diagnosis + remediation criteria (AC-N) AS the ticket, so
      // spec/implement/review consume it unchanged via readTicket.
      onApprove: (output) => writeInvestigation(ticketId, output),
    },
    ctx
  );
}

function writeSpec(ticketId: string, output: string): void {
  mkdirSync("specs", { recursive: true });
  writeFileSync(`specs/${ticketId}.md`, output);
}

function runStageSpec(ticketId: string, mode: StageMode, ctx: Ctx): Promise<void> {
  return runStage(
    {
      stage: "spec",
      ticketId,
      mode,
      roleFile: "agents/spec.md",
      // The ticket now includes the parse stage's approved criteria, which
      // is exactly what the spec agent needs to work from.
      getInput: () => readTicket(ticketId),
      allowedTools: ["Read"],
      usesKb: true,
      onApprove: (output) => writeSpec(ticketId, output),
    },
    ctx
  );
}

// Implement's gate is now light: syntax only. Authoritative testing (the full
// E2E suite + coverage) moved to QA. Implement self-corrects against syntax;
// all behavioral correction happens via the QA -> implement belt. A syntax
// failure is always a real-failure (route back to implement); there is no
// infra-failure path here because nothing stands up the app.
async function runImplementGate(ctx: Ctx): Promise<GateResult> {
  return runChecks(ctx.paths.workdir, ctx.descriptor.components);
}

// QA's gate is the authoritative one. It runs the full E2E suite (with the same
// infra-vs-real discrimination and infra-retry-the-gate logic implement's gate
// used to have) and then the deterministic coverage check. Order: E2E first
// (if the app is broken, coverage is moot), then coverage. Both must pass.
async function runQaGate(ticketId: string, ctx: Ctx): Promise<GateResult> {
  if (!ctx.descriptor.e2e) {
    throw new Error(
      "Product descriptor has no e2e.run command — QA is the authoritative gate " +
        "and needs one (see .sdlc/product.json)."
    );
  }

  // Full E2E, with infra-failures retried HERE, never blamed on the agent.
  // The E2E suite runs silently (one long command, minutes) after the qa AGENT
  // has already finished — so emit a marker: without it a live UI shows qa
  // "running" stuck on the agent's last tool call, looking frozen.
  emitEvent("gate_started", { ticket: ticketId, stage: "qa", source: "e2e" });
  let e2e: GateResult | undefined;
  for (let attempt = 1; attempt <= MAX_INFRA_RETRIES + 1; attempt++) {
    e2e = await runE2E(ctx.paths.workdir, ctx.descriptor.e2e.run);
    if (e2e.kind !== "infra-failure") break;
    console.log(
      `E2E infra failure (attempt ${attempt}/${MAX_INFRA_RETRIES + 1}) — harness problem, not code. ` +
        (attempt <= MAX_INFRA_RETRIES ? "Retrying the gate..." : "Out of retries.")
    );
    if (attempt > MAX_INFRA_RETRIES) return e2e;
  }
  if (!e2e!.passed) return e2e!; // real-failure: a test genuinely failed

  // Coverage is only meaningful when the test stage runs. With `test` disabled
  // there are no COVERS tags to find, so requiring coverage would make every
  // ticket with a new acceptance criterion unpassable — gate on E2E alone
  // instead. (Disabling test opts out of the whole test+coverage discipline;
  // a test-disabled product doesn't even need e2e.testDir declared.)
  if (!stageEnabled(ctx, "test")) return e2e!;

  // Tests pass — now check they cover every acceptance criterion. testDir must
  // be declared: defaulting to scanning the whole product repo is slow and can
  // pick up unrelated test files. Fail loudly like the rest of the descriptor
  // reads, rather than guess.
  const testDir = ctx.descriptor.e2e.testDir;
  if (!testDir) {
    throw new Error(
      "Product descriptor's e2e block has no testDir — coverage checking needs " +
        "to know where test files live (see .sdlc/product.json)."
    );
  }
  emitEvent("gate_started", { ticket: ticketId, stage: "qa", source: "coverage" });
  return checkCoverage(ticketId, resolve(ctx.paths.workdir, testDir));
}

// The implement stage doesn't fit runStage()'s shape: the agent writes
// files itself (it gets Read/Edit/Write), rather than returning text for
// the orchestrator to save, and what gates it isn't a human y/n but a
// deterministic syntax check. So it's its own function:
//   1. switch to an isolated feature branch in the product repo — never
//      touch main directly
//   2. run the implement agent against the approved spec
//   3. run the implement gate (syntax only) from the orchestrator's own
//      process, not the agent's — the agent has no Bash access at all,
//      because Claude Code's own Bash sandbox can silently block a tool
//      call independently of --allowedTools scoping, which once left a
//      real run with the agent unable to verify itself for reasons it
//      couldn't even diagnose. Only the orchestrator's check is trusted.
//   4. on a failure, feed the exact syntax-error output back to a fresh
//      agent call and retry, up to MAX_IMPLEMENT_ATTEMPTS, before giving
//      up and handing the branch to a human. Behavioral correctness is no
//      longer implement's gate — that moved to QA (runQaGate), which routes
//      failures back here via the QA belt (see runStageQa).

// seedFeedback lets a caller (the QA or review belt) start the implement agent
// off with an explicit reason it's being re-run — e.g. a failing E2E assertion
// or a [BLOCKER] review finding — instead of re-running it blind against the
// unchanged spec. Without it, the agent has no signal about what to change and
// tends to reproduce the same code. The current branch already holds its prior
// work, which it reads, so we don't need to re-supply the old output verbatim.
async function runStageImplement(
  ticketId: string,
  mode: StageMode,
  ctx: Ctx,
  maxTurns?: number,
  seedFeedback?: string
): Promise<void> {
  const startedAt = Date.now();
  const branch = ensureBranch(ticketId, ctx.paths.workdir);
  const spec = readSpec(ticketId);
  // Implement reads the product KB too (data shapes, decisions, conventions),
  // same as spec/review. Read once — the spec doesn't change across attempts.
  const kb = readKbIndex(ctx.paths.knowledgeDir);

  let retry: RetryContext | undefined = seedFeedback
    ? { priorAttempt: "Your current implementation is on the feature branch — read it before changing.", feedback: seedFeedback }
    : undefined;
  let lastOutput = "";
  const mcp = mcpForStage(ctx, "implement");

  for (let attempt = 1; attempt <= MAX_IMPLEMENT_ATTEMPTS; attempt++) {
    const prompt = buildPrompt(ctx.paths.workdir, "agents/implement.md", spec, retry, kb);

    emitEvent("stage_started", { ticket: ticketId, stage: "implement", attempt, branch });
    emitEvent("agent_started", { ticket: ticketId, stage: "implement", kb: { offered: !!kb, dir: kb ? kb.dir : undefined } });

    console.log(
      `\nRunning implement agent on ticket ${ticketId} (branch ${branch}, attempt ${attempt}/${MAX_IMPLEMENT_ATTEMPTS})...\n`
    );
    const report = await callAgent(prompt, {
      cwd: ctx.paths.workdir,
      allowedTools: ["Read", "Edit", "Write", ...mcp.tools],
      maxTurns,
      addDir: kb ? kb.dir : undefined,
      mcpConfig: mcp.mcpConfig,
      ticket: ticketId,
      stage: "implement",
    });

    console.log("----- implement agent report -----\n");
    console.log(report);
    console.log("\n-------------------------------\n");

    console.log(`Running the implement gate (syntax checks) in ${ctx.paths.workdir}...`);
    const gate = await runImplementGate(ctx);
    lastOutput = gate.output;

    logRun({
      stage: "implement",
      ticket: ticketId,
      mode,
      branch,
      attempt,
      durationMs: Date.now() - startedAt,
      approved: gate.passed,
      gateKind: gate.kind,
    });
    emitEvent("gate_result", { ticket: ticketId, stage: "implement", source: gate.source, kind: gate.kind, passed: gate.passed, attempt });

    if (gate.passed) {
      console.log(`Syntax gate passed on branch ${branch} (attempt ${attempt}/${MAX_IMPLEMENT_ATTEMPTS}).`);
      emitEvent("stage_finished", { ticket: ticketId, stage: "implement", approved: true, durationMs: Date.now() - startedAt, attempt });
      return;
    }

    // The implement gate is syntax-only now, so a failure is always a
    // real-failure (broken code the agent should fix) — there is no
    // infra-failure path here, since nothing stands up the app. Authoritative
    // behavioral verification (which CAN infra-fail) lives in QA.
    console.log(`Syntax gate failed on attempt ${attempt}/${MAX_IMPLEMENT_ATTEMPTS}.`);
    retry = { priorAttempt: report, feedback: `Syntax check failed with:\n${gate.output}` };
  }

  emitEvent("stage_finished", { ticket: ticketId, stage: "implement", approved: false, reason: "exhausted", attempt: MAX_IMPLEMENT_ATTEMPTS, durationMs: Date.now() - startedAt });
  throw new Error(
    `Syntax gate failed for ticket ${ticketId} on branch ${branch} after ${MAX_IMPLEMENT_ATTEMPTS} attempts.\n` +
      `Last output:\n${lastOutput}\n` +
      "Inspect the branch — the pipeline does not retry further."
  );
}

function writeReview(ticketId: string, output: string): void {
  mkdirSync("reviews", { recursive: true });
  writeFileSync(`reviews/${ticketId}.md`, output);
}

// Review is now a GATED, belted stage — not a plain runStage. The agent writes
// findings; a deterministic script (checkReview) decides whether any are
// [BLOCKER]. A blocker means the CODE is wrong, so the belt routes to IMPLEMENT
// with the blocker text as the fix brief, then review re-runs — capped at
// MAX_REVIEW_ATTEMPTS, then a human. It doesn't fit runStage() for the same
// reason implement/qa don't: its gate is a script, and a failing gate isn't the
// review agent's own to fix.
//
// mode governs ONLY the human pause on the review TEXT (approve => y/n before
// the gate; reject re-runs the agent in place with feedback). The [BLOCKER] gate
// runs regardless of mode, exactly like implement's syntax gate and QA's E2E
// gate — a deterministic gate is not something a mode can switch off.
async function runStageReview(ticketId: string, mode: StageMode, ctx: Ctx): Promise<void> {
  const spec = readSpec(ticketId);
  const kb = readKbIndex(ctx.paths.knowledgeDir);
  const mcp = mcpForStage(ctx, "review");

  for (let attempt = 1; attempt <= MAX_REVIEW_ATTEMPTS; attempt++) {
    const startedAt = Date.now();
    emitEvent("stage_started", { ticket: ticketId, stage: "review", attempt, mode });

    // Produce findings (agent), with the approve-mode human loop. A human reject
    // re-runs the agent in place (unbounded — a person is present), same as
    // runStage's reject loop; it does not consume a belt attempt.
    let retry: RetryContext | undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const prompt = buildPrompt(ctx.paths.workdir, "agents/review.md", spec, retry, kb);
      emitEvent("agent_started", { ticket: ticketId, stage: "review", kb: { offered: !!kb, dir: kb ? kb.dir : undefined } });
      console.log(`\nRunning review agent on ticket ${ticketId} (attempt ${attempt}/${MAX_REVIEW_ATTEMPTS})...\n`);
      const output = await callAgent(prompt, {
        cwd: ctx.paths.workdir,
        allowedTools: ["Read", ...mcp.tools],
        addDir: kb ? kb.dir : undefined,
        mcpConfig: mcp.mcpConfig,
        ticket: ticketId,
        stage: "review",
      });
      console.log(`----- review agent output -----\n`);
      console.log(output);
      console.log("\n-------------------------------\n");
      writeReview(ticketId, output);

      if (mode !== "approve") break;
      // Review's artifact IS persisted (reviews/<id>.md, just written) — so the
      // dashboard previews that path directly and NO approvals preview.md is
      // written. Pass the real belt attempt so the UI can attribute the pause.
      const decision = await awaitApproval(ctx, {
        ticket: ticketId,
        stage: "review",
        attempt,
        question: "Approve this review?",
        previewPath: `reviews/${ticketId}.md`,
        wantFeedback: true,
      });
      if (decision.approved) break;
      retry = { priorAttempt: output, feedback: decision.feedback ?? "" };
    }

    // Deterministic blocker gate — runs regardless of mode.
    const gate = checkReview(ticketId);
    logRun({
      stage: "review",
      ticket: ticketId,
      mode,
      attempt,
      durationMs: Date.now() - startedAt,
      approved: gate.passed,
      gateKind: gate.kind,
      gateSource: gate.source,
    });
    emitEvent("gate_result", { ticket: ticketId, stage: "review", source: gate.source, kind: gate.kind, passed: gate.passed, attempt });

    if (gate.passed) {
      console.log("Review gate passed (no blocking findings).");
      emitEvent("stage_finished", { ticket: ticketId, stage: "review", approved: true, durationMs: Date.now() - startedAt, attempt });
      return;
    }

    if (attempt >= MAX_REVIEW_ATTEMPTS) break;

    // A [BLOCKER] is the CODE's problem -> implement owns the fix. Honor the
    // enabled flag: if implement is off, the pipeline can't auto-fix, so stop
    // for a human (mirror of QA's belt guard).
    if (!stageEnabled(ctx, "implement")) {
      console.log("Review found blockers but implement is disabled (enabled:false) — stopping for a human.");
      emitEvent("stage_finished", { ticket: ticketId, stage: "review", approved: false, reason: "belt-target-disabled", beltTarget: "implement", attempt });
      throw new Error(
        `Review found [BLOCKER] finding(s) for ticket ${ticketId} that the implement stage owns, but implement ` +
          `is disabled (enabled:false) in sdlc.config.json — the pipeline will not run a stage you turned off. ` +
          `Re-enable implement (or resolve by hand), then re-run review.\n\n${gate.output}`
      );
    }
    console.log("Review found BLOCKER(s). Re-running the IMPLEMENT stage with the blocker details, then re-reviewing.");
    emitEvent("belt_route", { ticket: ticketId, from: "review", to: "implement", reason: "blocker", attempt });
    emitEvent("stage_finished", { ticket: ticketId, stage: "review", approved: false, durationMs: Date.now() - startedAt, attempt });
    await runStageImplement(
      ticketId,
      ctx.config.stages.implement?.mode ?? "auto",
      ctx,
      ctx.config.stages.implement?.maxTurns,
      `The review stage found blocking issues. Fix the code so these are resolved (do not try to silence the reviewer):\n${gate.output}`
    );
  }

  emitEvent("stage_finished", { ticket: ticketId, stage: "review", approved: false, reason: "exhausted", attempt: MAX_REVIEW_ATTEMPTS });
  throw new Error(
    `Review still reports [BLOCKER] finding(s) for ticket ${ticketId} after ${MAX_REVIEW_ATTEMPTS} attempts. ` +
      `See reviews/${ticketId}.md and inspect the branch — the pipeline does not retry further.`
  );
}

// The test agent writes test/*.test.ts itself (it gets Read/Edit/Write),
// so there's nothing for the orchestrator to save on approval — same
// reason implement's agent call has no onApprove-driven save either, just
// without implement's checks-gate loop, since a failing test suite here
// isn't the test agent's fault to fix (that's a review/implement problem).
// seedFeedback lets the QA belt re-run the test stage with an explicit
// coverage gap to close (which AC-N lack a live tagged test), rather than
// blind. A coverage failure is the test stage's to fix — never implement's —
// because COVERS tags and E2E scenarios are the test agent's output.
function runStageTest(ticketId: string, mode: StageMode, ctx: Ctx, seedFeedback?: string): Promise<void> {
  return runStage(
    {
      stage: "test",
      ticketId,
      mode,
      roleFile: "agents/test.md",
      getInput: () => readSpec(ticketId),
      allowedTools: ["Read", "Edit", "Write"],
      onApprove: () => {},
    },
    ctx,
    seedFeedback
      ? { priorAttempt: "Your current tests are on the feature branch — read them before changing.", feedback: seedFeedback }
      : undefined
  );
}

// Writes a DETERMINISTIC qa/<id>.md summary (no model involved) so the
// dashboard's QA tab stays meaningful now that QA has no agent. The E2E/coverage
// breakdown is inferred from the single deciding GateResult exactly as the
// dashboard's gateChecks does: runQaGate runs E2E then coverage and stops at the
// first failure, so gate.source says how far it got. testEnabled=false means the
// test stage is off and coverage was intentionally skipped. Renders through the
// dashboard's parseMd/cellColor (heading + pipe table + fenced detail).
function writeQaSummary(ticketId: string, gate: GateResult, testEnabled: boolean): void {
  mkdirSync("qa", { recursive: true });

  const e2ePassed = gate.passed || gate.source === "coverage"; // coverage only runs if E2E passed
  const e2eLabel = e2ePassed ? "PASS" : gate.kind === "infra-failure" ? "INFRA" : "FAIL";
  const coverageLabel = !testEnabled
    ? "SKIPPED"
    : gate.passed
      ? "PASS"
      : gate.source === "coverage"
        ? "FAIL"
        : "n/a"; // E2E failed first; coverage never ran

  const md = [
    `## QA Gate: ${ticketId}`,
    "",
    "Deterministic gate — no agent. QA passes iff the E2E suite is green" +
      (testEnabled
        ? " and every acceptance criterion has a live COVERS tag."
        : " (coverage skipped: the test stage is disabled)."),
    "",
    "| Check | Result |",
    "|----------|--------|",
    `| E2E | ${e2eLabel} |`,
    `| Coverage | ${coverageLabel} |`,
    "",
    `Verdict: ${gate.passed ? "SHIP" : "NO-SHIP"}`,
    "",
    "### Detail",
    "",
    "```",
    gate.output.trim(),
    "```",
    "",
  ].join("\n");

  writeFileSync(`qa/${ticketId}.md`, md);
}

// QA is now a purely DETERMINISTIC gate stage — no agent, no verdict. It passes
// iff the E2E suite is green (and, when the test stage is enabled, every
// acceptance criterion has a live COVERS tag — see runQaGate). The orchestrator
// still WRITES a deterministic qa/<id>.md summary so the dashboard's QA tab
// stays meaningful. It does not fit runStage (its gate is a script, not a human
// y/n) or runStageImplement (a QA failure isn't QA's own to fix).
//
// The routing is the point. A failing E2E test means the CODE doesn't meet a
// criterion -> re-run IMPLEMENT (with the failing assertions threaded in). A
// coverage gap means a test is MISSING -> re-run TEST (told which AC-N) to ADD
// it. A failing test is never routed back to the test agent "to make it pass" —
// that would invite weakening the test to go green; a red test is always the
// code's problem, and if the code genuinely can't satisfy it, implement exhausts
// its attempts and a human is summoned with the test still honest.
async function runStageQa(ticketId: string, mode: StageMode, ctx: Ctx): Promise<void> {
  const testEnabled = stageEnabled(ctx, "test");

  for (let attempt = 1; attempt <= MAX_QA_ATTEMPTS; attempt++) {
    const startedAt = Date.now();

    emitEvent("stage_started", { ticket: ticketId, stage: "qa", attempt });

    console.log(`\nRunning QA gate on ticket ${ticketId} (attempt ${attempt}/${MAX_QA_ATTEMPTS})...\n`);
    const gate = await runQaGate(ticketId, ctx); // E2E [+ coverage when test enabled]
    writeQaSummary(ticketId, gate, testEnabled); // deterministic qa/<id>.md for the dashboard

    logRun({
      stage: "qa",
      ticket: ticketId,
      mode,
      attempt,
      durationMs: Date.now() - startedAt,
      approved: gate.passed,
      gateKind: gate.kind,
      gateSource: gate.source,
    });
    emitEvent("gate_result", { ticket: ticketId, stage: "qa", source: gate.source, kind: gate.kind, passed: gate.passed, attempt });

    if (gate.passed) {
      console.log(`QA passed (E2E green${testEnabled ? ", coverage complete" : ", coverage skipped — test stage disabled"}).`);
      emitEvent("stage_finished", { ticket: ticketId, stage: "qa", approved: true, durationMs: Date.now() - startedAt, attempt });
      return;
    }

    // An infra-failure from the QA gate is an environment problem, not the
    // code's fault — stop for a human rather than belt the agent.
    if (gate.kind === "infra-failure") {
      emitEvent("stage_finished", { ticket: ticketId, stage: "qa", approved: false, reason: "infra-failure", attempt });
      throw new Error(
        `QA E2E infra failure for ticket ${ticketId}: the harness didn't come up ` +
          `(PocketBase/port/setup), not the code.\n\n${gate.output}`
      );
    }

    if (attempt >= MAX_QA_ATTEMPTS) break;

    // The belt routes the fix to the stage that OWNS it: a coverage gap -> test
    // (a covering test is MISSING), any other failure -> implement (the CODE is
    // wrong). But an operator can turn a stage off (enabled:false), and the belt
    // must honor that — the whole point of the flag — rather than silently
    // running a stage the operator disabled. With the owning stage off, the
    // pipeline can't auto-close this gap, so it stops for a human instead.
    const beltTarget: Stage = gate.source === "coverage" ? "test" : "implement";
    if (!stageEnabled(ctx, beltTarget)) {
      console.log(
        `QA ${gate.source} failure routes to the ${beltTarget} stage, but ${beltTarget} is disabled ` +
          `(enabled:false) — stopping for a human rather than running a disabled stage.`
      );
      emitEvent("stage_finished", { ticket: ticketId, stage: "qa", approved: false, reason: "belt-target-disabled", beltTarget, attempt });
      throw new Error(
        `QA found a ${gate.source} failure for ticket ${ticketId} that the ${beltTarget} stage owns, but ` +
          `${beltTarget} is disabled (enabled:false) in sdlc.config.json — the pipeline will not run a stage ` +
          `you turned off. Re-enable ${beltTarget} (or resolve it by hand), then re-run QA.\n\n${gate.output}`
      );
    }

    if (gate.source === "coverage") {
      // A test is MISSING — the test stage owns this, not implement.
      console.log(`QA coverage gap. Re-running the TEST stage to add the missing tagged test(s).`);
      emitEvent("belt_route", { ticket: ticketId, from: "qa", to: "test", reason: "coverage", attempt });
      await runStageTest(
        ticketId,
        ctx.config.stages.test?.mode ?? "auto",
        ctx,
        `The QA coverage gate rejected the current tests:\n${gate.output}\n\n` +
          `Add or fix E2E scenarios so every listed acceptance criterion has a LIVE (non-skipped) ` +
          `test tagged "// COVERS: <AC-N>". Do NOT weaken, skip, or delete existing tests to pass.`
      );
    } else {
      // A failing E2E test — the CODE is wrong, so route to implement with the
      // failing assertions (the most useful feedback).
      console.log(`QA E2E failure. Re-running the IMPLEMENT stage with the failing assertions.`);
      emitEvent("belt_route", { ticket: ticketId, from: "qa", to: "implement", reason: gate.source, attempt });
      await runStageImplement(
        ticketId,
        ctx.config.stages.implement?.mode ?? "auto",
        ctx,
        ctx.config.stages.implement?.maxTurns,
        `The QA end-to-end suite failed. Fix the code so these pass (do not change the tests):\n${gate.output}`
      );
    }
  }

  emitEvent("stage_finished", { ticket: ticketId, stage: "qa", approved: false, reason: "exhausted", attempt: MAX_QA_ATTEMPTS });
  throw new Error(
    `QA failed for ticket ${ticketId} after ${MAX_QA_ATTEMPTS} attempts. ` +
      `Last gate output in qa/${ticketId}.md. Inspect the branch — ` +
      `the pipeline does not retry further.`
  );
}

// ---- Retrospector: per-ticket aggregation (first step of the learning loop) ----

// This ticket's runlog entries as the factual record of what happened — every
// stage attempt, gate result, retry count, and rejection feedback. This is the
// Retrospector's most valuable signal: a clean first-pass ticket teaches
// little; a ticket that belted the QA gate twice teaches a lot.
function readTicketRunlog(ticketId: string): string {
  const entries = readRunlog().filter((e) => e.ticket === ticketId);
  return entries.map((e) => JSON.stringify(e)).join("\n");
}

// Gathers this ticket's runlog slice + its artifacts into one input blob. The
// artifacts live in THIS repo (the handoff protocol), so they're read
// pipeline-local, not from the product repo.
function gatherRetroInput(ticketId: string, failureNote?: string): string {
  const parts: string[] = [];
  // A failed/aborted run is the highest-signal input for the Retrospector, so
  // surface the outcome up front when we're running it after a failure.
  if (failureNote) {
    parts.push(
      "## Run outcome\nThis run FAILED and did NOT ship — the pipeline aborted. " +
        "Reflect on the root cause and what would have prevented it.\n\n" + failureNote
    );
  }
  parts.push("## Runlog\n" + readTicketRunlog(ticketId));
  for (const [label, path] of [
    ["Ticket", `tickets/${ticketId}.md`],
    ["Spec", `specs/${ticketId}.md`],
    ["Review", `reviews/${ticketId}.md`],
    ["QA report", `qa/${ticketId}.md`],
  ] as const) {
    if (existsSync(path)) parts.push(`## ${label}\n` + readFileSync(path, "utf8"));
  }
  return parts.join("\n\n---\n\n");
}

function writeRetroSummary(ticketId: string, output: string): void {
  mkdirSync("retros", { recursive: true });
  writeFileSync(`retros/${ticketId}.md`, output);
}

// Per-ticket aggregation. Read-only and product-agnostic: it REPORTS what
// happened; it does not touch code or any KB and gates nothing. Its summary is
// advisory input to the Curator. Runs after the writing flow, on SUCCESS OR
// FAILURE (a belted/aborted run is the most instructive — it must not be lost),
// gated by config.learning.enabled. Logged as its own stage but NOT part of
// STAGE_ORDER, so it never affects auto-resume. failureNote, when present, tells
// the Retrospector the run failed (and why) so it reflects on the failure.
async function runStageRetrospector(ticketId: string, ctx: Ctx, failureNote?: string): Promise<void> {
  const startedAt = Date.now();
  const input = gatherRetroInput(ticketId, failureNote);
  const prompt = buildPrompt(ctx.paths.workdir, "agents/retrospector.md", input);

  emitEvent("stage_started", { ticket: ticketId, stage: "retrospector", outcome: failureNote ? "failed" : "complete" });
  emitEvent("agent_started", { ticket: ticketId, stage: "retrospector", kb: { offered: false } });

  console.log(`\nRunning retrospector on ticket ${ticketId}...\n`);
  const summary = await callAgent(prompt, { cwd: ctx.paths.workdir, allowedTools: ["Read"], ticket: ticketId, stage: "retrospector" });

  console.log("----- retrospector summary -----\n");
  console.log(summary);
  console.log("\n-------------------------------\n");

  writeRetroSummary(ticketId, summary);
  logRun({
    stage: "retrospector",
    ticket: ticketId,
    durationMs: Date.now() - startedAt,
    approved: true, // aggregation always "succeeds" — it produces a summary
  });
  emitEvent("stage_finished", { ticket: ticketId, stage: "retrospector", approved: true, durationMs: Date.now() - startedAt });
  console.log(`Retrospective written to retros/${ticketId}.md.`);
}

// ---- Curator: proposes conformance-checked KB updates as a pushed branch ----

// Cap on the Curator's shape-fix belt: it drafts a proposal, the conformance
// script gates SHAPE, and on failure the violations are fed back once. Bounded
// like the other belts so a persistently malformed proposal can't loop forever.
const MAX_CURATOR_ATTEMPTS = 2;

// Thin git wrapper for KB-repo operations. git is a real .exe (not a .cmd
// shim), so the args-array form is safe — no shell:true, no DEP0190, same as
// ensureBranch.
function runGit(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

// Parses the Curator's proposal into (bundle-relative path, content) blocks.
// The agent emits blocks delimited EXACTLY as:
//   ===FILE: decisions/foo.md===
//   <content>
//   ===END===
// Paths are validated bundle-relative (no absolute, no drive letter, no ".."),
// so a proposal can never write outside the KB repo.
function parseProposalFiles(proposal: string): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];
  const re = /===FILE:[ \t]*(.+?)[ \t]*===\r?\n([\s\S]*?)\r?\n===END===/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(proposal)) !== null) {
    const path = m[1].trim().replace(/\\/g, "/");
    if (!path || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.split("/").includes("..")) {
      console.log(`Curator: ignoring unsafe proposal path "${m[1].trim()}".`);
      continue;
    }
    files.push({ path, content: m[2] });
  }
  return files;
}

// Cuts a fresh branch in the KB repo, writes the proposed files, and commits.
// Returns the branch the repo was on before, so a failed attempt can be undone
// and the repo left as we found it.
function applyProposalToBranch(
  kbDir: string,
  branch: string,
  files: Array<{ path: string; content: string }>,
  ticketId: string
): string {
  const head = runGit(kbDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!head.ok) throw new Error(`KB repo: cannot read current branch: ${head.stderr}`);
  const original = head.stdout;

  const co = runGit(kbDir, ["checkout", "-b", branch]);
  if (!co.ok) throw new Error(`KB repo: cannot create branch ${branch}: ${co.stderr}`);

  for (const f of files) {
    const target = resolve(kbDir, f.path);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, f.content);
  }

  runGit(kbDir, ["add", "-A"]);
  const commit = runGit(kbDir, ["commit", "-m", `KB update from ticket ${ticketId}`]);
  if (!commit.ok) {
    runGit(kbDir, ["checkout", original]);
    runGit(kbDir, ["branch", "-D", branch]);
    throw new Error(`KB repo: commit failed on ${branch}: ${commit.stderr || commit.stdout}`);
  }
  return original;
}

// Discards a failed attempt's branch and returns to the original branch.
function resetBranch(kbDir: string, original: string, branch: string): void {
  runGit(kbDir, ["checkout", original]);
  runGit(kbDir, ["branch", "-D", branch]);
}

// The high-level prose the curator emits AROUND its file blocks — the NO CHANGE
// reason, or the ## Summary (Inserted/Discarded/Unresolved). We strip the
// ===FILE===…===END=== blocks (full concept bodies — not "high level") and keep
// the rest, which is exactly what the Curator tab should show.
function curatorProse(proposal: string): string {
  return proposal
    .replace(/===FILE:[\s\S]*?===END===/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Writes a high-level curator/<id>.md so the dashboard's Curator tab can show,
// per ticket, what the curator decided to insert into the KB vs discard — and
// the PR/branch + shape-gate outcome. Deterministic header (paths only, never
// file bodies) + the agent's own Inserted/Discarded/Unresolved prose. Called on
// every real exit path of runCurator (NO CHANGE, malformed, conformance-fail,
// push-fail, success) so the tab reflects whatever actually happened.
function writeCuratorSummary(
  ticketId: string,
  info: {
    outcome: string;
    files?: Array<{ path: string }>;
    branch?: string;
    pushed?: boolean;
    conformance?: "pass" | "fail" | "n/a";
    violations?: string;
    agentText: string;
  }
): void {
  mkdirSync("curator", { recursive: true });
  const filesList =
    info.files && info.files.length ? info.files.map((f) => `- \`${f.path}\``).join("\n") : "— none —";
  const pr = info.branch
    ? info.pushed
      ? `pushed \`${info.branch}\` to origin — open a PR to review/merge`
      : `committed locally on \`${info.branch}\` — push failed, not yet on origin`
    : "no branch pushed";
  const conf = info.conformance === "pass" ? "PASS" : info.conformance === "fail" ? "FAIL" : "n/a";
  const md = [
    `## Curator: ${ticketId}`,
    "",
    `**Outcome:** ${info.outcome}`,
    "",
    "**Proposed to the KB (files):**",
    filesList,
    "",
    `**PR / branch:** ${pr}`,
    `**KB shape (conformance):** ${conf}`,
    ...(info.violations ? ["", "```", info.violations, "```"] : []),
    "",
    "---",
    "",
    info.agentText || "_(no high-level summary provided by the curator)_",
    "",
  ].join("\n");
  writeFileSync(`curator/${ticketId}.md`, md);
}

// The Curator: sole writer to a KB, deliberately picky, never writes directly.
// It reads the KB's own CONVENTIONS + current index + the Retrospector summary
// and proposes either "NO CHANGE" or conformance-checked concept files. The
// ORCHESTRATOR (not the agent) writes those into a KB branch, runs the shape
// gate, and — on pass — pushes the branch for a human to PR/merge (the real,
// human, KB-write gate). On a shape failure the violations are fed back once
// (bounded belt). `which` is future-proofed for a second (pipeline) KB; only
// "product" (-> knowledgeDir / OKF) is wired today.
async function runCurator(ticketId: string, ctx: Ctx, which: "product"): Promise<void> {
  const kbDir = ctx.paths.knowledgeDir;
  if (!kbDir || !existsSync(kbDir)) {
    console.log(`Skipping ${which} curator (no KB at ${kbDir}).`);
    return;
  }
  const retroPath = `retros/${ticketId}.md`;
  if (!existsSync(retroPath)) {
    console.log(`Skipping ${which} curator (no retrospective at ${retroPath}).`);
    return;
  }

  // Never fight the KB repo's working tree: uncommitted changes there could get
  // entangled by our branch/commit. Bail cleanly for a human instead.
  const status = runGit(kbDir, ["status", "--porcelain"]);
  if (!status.ok) {
    console.log(`Skipping ${which} curator: cannot read KB git status (${status.stderr}).`);
    return;
  }
  if (status.stdout.length > 0) {
    console.log(`Skipping ${which} curator: KB repo ${kbDir} has uncommitted changes — commit or stash them first.`);
    return;
  }

  const bundleRoot = kbDir; // OKF: the bundle root IS the repo root (no bundle/ subdir).
  const spec = PRODUCT_KB_SPEC;
  const conventions = existsSync(`${kbDir}/CONVENTIONS.md`) ? readFileSync(`${kbDir}/CONVENTIONS.md`, "utf8") : "";
  const indexText = existsSync(`${bundleRoot}/index.md`) ? readFileSync(`${bundleRoot}/index.md`, "utf8") : "(empty KB)";
  const summary = readFileSync(retroPath, "utf8");

  const input = [
    "## CONVENTIONS (follow these EXACTLY — they govern both shape and judgment)\n" + conventions,
    "## Current KB index\n" + indexText,
    "## Retrospector summary (the ticket to consider)\n" + summary,
  ].join("\n\n---\n\n");

  const startedAt = Date.now();
  const branchBase = `kb/${ticketId}-${startedAt}`;
  let retry: RetryContext | undefined;

  const stage = `curator-${which}`;
  for (let attempt = 1; attempt <= MAX_CURATOR_ATTEMPTS; attempt++) {
    const prompt = buildPrompt(ctx.paths.workdir, "agents/curator.md", input, retry);
    emitEvent("stage_started", { ticket: ticketId, stage, attempt });
    emitEvent("agent_started", { ticket: ticketId, stage, kb: { offered: true, dir: kbDir } });
    console.log(`\nRunning ${which} curator on ticket ${ticketId} (attempt ${attempt}/${MAX_CURATOR_ATTEMPTS})...\n`);
    // Read-only + a readable root into the KB so it can inspect existing
    // concepts (update-over-duplicate). It PROPOSES file text; it never writes.
    const proposal = await callAgent(prompt, { cwd: ctx.paths.workdir, allowedTools: ["Read"], addDir: kbDir, ticket: ticketId, stage });

    console.log("----- curator proposal -----\n");
    console.log(proposal);
    console.log("\n----------------------------\n");

    if (/^\s*NO CHANGE\b/i.test(proposal)) {
      console.log(`Curator (${which}): no change proposed.`);
      writeCuratorSummary(ticketId, { outcome: "NO CHANGE — nothing durable to record", conformance: "n/a", agentText: curatorProse(proposal) });
      logRun({ stage, ticket: ticketId, durationMs: Date.now() - startedAt, approved: true, change: false });
      emitEvent("stage_finished", { ticket: ticketId, stage, approved: true, change: false, durationMs: Date.now() - startedAt });
      return;
    }

    const files = parseProposalFiles(proposal);
    if (files.length === 0) {
      const fb =
        "Your response was neither a line starting with 'NO CHANGE' nor any " +
        "===FILE: <path>=== ... ===END=== blocks. Emit exactly one of those two forms.";
      if (attempt >= MAX_CURATOR_ATTEMPTS) {
        console.log(`Curator (${which}) produced no usable file blocks; skipping.`);
        writeCuratorSummary(ticketId, { outcome: "No usable proposal — neither NO CHANGE nor parseable file blocks", conformance: "n/a", agentText: curatorProse(proposal) });
        logRun({ stage, ticket: ticketId, durationMs: Date.now() - startedAt, approved: false, change: false });
        emitEvent("stage_finished", { ticket: ticketId, stage, approved: false, change: false, durationMs: Date.now() - startedAt });
        return;
      }
      retry = { priorAttempt: proposal, feedback: fb };
      continue;
    }

    const branch = `${branchBase}-a${attempt}`;
    const original = applyProposalToBranch(kbDir, branch, files, ticketId);

    const conformance = checkBundle(bundleRoot, spec);
    emitEvent("gate_result", { ticket: ticketId, stage, source: "conformance", kind: conformance.passed ? "pass" : "real-failure", passed: conformance.passed, attempt });
    if (!conformance.passed) {
      const violations = conformance.violations.map((v) => `  [${v.rule}] ${v.file}: ${v.detail}`).join("\n");
      console.log(`Curator (${which}) conformance FAILED:\n${violations}`);
      resetBranch(kbDir, original, branch);
      if (attempt >= MAX_CURATOR_ATTEMPTS) {
        console.log(`Curator (${which}) could not produce conformant output after ${attempt} attempts; skipping (no push).`);
        writeCuratorSummary(ticketId, { outcome: "Proposal rejected by the KB shape gate (conformance)", files, conformance: "fail", violations, agentText: curatorProse(proposal) });
        logRun({ stage, ticket: ticketId, durationMs: Date.now() - startedAt, approved: false, change: false });
        emitEvent("stage_finished", { ticket: ticketId, stage, approved: false, change: false, durationMs: Date.now() - startedAt });
        return;
      }
      retry = {
        priorAttempt: proposal,
        feedback: `The KB conformance (shape) check rejected your proposal:\n${violations}\n\nFix exactly these and re-emit the file blocks.`,
      };
      continue;
    }

    // Shape is valid — push the branch, then restore the repo to its original
    // branch so we leave it as we found it. The human opens the PR (real gate).
    const push = runGit(kbDir, ["push", "-u", "origin", branch]);
    runGit(kbDir, ["checkout", original]);
    if (!push.ok) {
      console.log(`Curator (${which}): conformant branch ${branch} committed locally but push failed: ${push.stderr}`);
      writeCuratorSummary(ticketId, { outcome: "KB update committed locally; push to origin failed", files, branch, pushed: false, conformance: "pass", agentText: curatorProse(proposal) });
      logRun({ stage, ticket: ticketId, durationMs: Date.now() - startedAt, approved: true, change: true, branch, pushed: false });
      emitEvent("stage_finished", { ticket: ticketId, stage, approved: true, change: true, branch, pushed: false, durationMs: Date.now() - startedAt });
      return;
    }
    console.log(`Curator (${which}): pushed branch ${branch} to origin — open a PR to review/merge.`);
    writeCuratorSummary(ticketId, { outcome: "Proposed KB update — open a PR to review/merge", files, branch, pushed: true, conformance: "pass", agentText: curatorProse(proposal) });
    logRun({ stage, ticket: ticketId, durationMs: Date.now() - startedAt, approved: true, change: true, branch, pushed: true });
    emitEvent("stage_finished", { ticket: ticketId, stage, approved: true, change: true, branch, pushed: true, durationMs: Date.now() - startedAt });
    return;
  }
}

// A stage is enabled unless sdlc.config.json explicitly turns it off with
// enabled:false. Single source of truth consulted BOTH by the main stage loop
// (runNamedStage) and by the QA belt, so "disabled" means the same thing
// everywhere: the stage never runs — not as a normal step, and not as a
// belt-routed fix. An unconfigured stage is not "disabled" (runNamedStage skips
// it separately, with a different note); this only reports the explicit off.
function stageEnabled(ctx: Ctx, stage: Stage): boolean {
  return ctx.config.stages[stage]?.enabled !== false;
}

// The stages that produce or act on a CODE fix. When investigate returns a "no-fix"
// verdict these are skipped, so the run finishes at the learning loop instead.
const FIX_STAGES: ReadonlySet<Stage> = new Set(["spec", "implement", "review", "test", "qa"]);

// Investigate declares a machine-readable verdict line in its ticket, e.g.
// `Resolution: no-fix (business)` or `Resolution: code-fix (scraper)`. A **no-fix**
// verdict — a business error (obsolete PO, PO needs confirmation, …), a portal-side
// change, or a transient/timeout — means there is nothing to change in code, so the fix
// stages (see FIX_STAGES) are skipped and the pipeline goes straight to the learning
// loop, which still records the case + KB update. Absence of the marker is NOT no-fix
// (safe default: never skip a fix we might need). investigate is approve-gated, so a
// human has vetted this verdict before we act on it. Tolerant of markdown bold / list
// prefixes: matches "Resolution: no-fix", "- **Resolution:** no fix", etc.
function investigateIsNoFix(ticketId: string): boolean {
  const path = `tickets/${ticketId}.md`;
  if (!existsSync(path)) return false;
  return /^\s*[-*]?\s*\**\s*Resolution\**\s*:\s*\**\s*no[-\s]?fix\b/im.test(readFileSync(path, "utf8"));
}

// Runs one named stage if it's configured in sdlc.config.json, skipping
// it (with a note) otherwise — same behavior main() already had per
// stage, just centralized so main() can loop over STAGE_ORDER instead of
// repeating this if-block three times.
async function runNamedStage(stage: Stage, ticketId: string, ctx: Ctx): Promise<void> {
  const stageConfig = ctx.config.stages[stage];
  if (!stageConfig) {
    console.log(`Skipping ${stage} (not configured in sdlc.config.json).`);
    return;
  }

  // A stage can be turned off with "enabled": false. Skipping is literal: no
  // agent runs and no gate runs. It's the operator's call — a later stage that
  // reads this one's artifact (e.g. spec) will fail if that artifact is missing,
  // and disabling qa removes the authoritative gate. Emit a telemetry event so a
  // tailing dashboard can render the stage as "skipped" rather than "not reached".
  if (!stageEnabled(ctx, stage)) {
    console.log(`Skipping ${stage} (disabled in sdlc.config.json).`);
    emitEvent("stage_skipped", { ticket: ticketId, stage, reason: "disabled" });
    return;
  }

  // Dynamic per-run skip: when investigate concluded there is no code change to make
  // (a "no-fix" verdict in its ticket), skip the fix stages and let the run fall through
  // to the learning loop, which still records the case + KB update. investigate and
  // reproduce are never skipped this way (they're not in FIX_STAGES).
  if (FIX_STAGES.has(stage) && investigateIsNoFix(ticketId)) {
    console.log(
      `Skipping ${stage} — investigate returned a no-fix verdict (no code change needed); ` +
        `the run will finish at the learning loop and record the case.`,
    );
    emitEvent("stage_skipped", { ticket: ticketId, stage, reason: "no-fix" });
    return;
  }

  try {
    switch (stage) {
      case "reproduce":
        await runStageReproduce(ticketId, stageConfig.mode, ctx);
        return;
      case "investigate":
        await runStageInvestigate(ticketId, stageConfig.mode, ctx);
        return;
      case "spec":
        await runStageSpec(ticketId, stageConfig.mode, ctx);
        return;
      case "implement":
        await runStageImplement(ticketId, stageConfig.mode, ctx, stageConfig.maxTurns);
        return;
      case "review":
        await runStageReview(ticketId, stageConfig.mode, ctx);
        return;
      case "test":
        await runStageTest(ticketId, stageConfig.mode, ctx);
        return;
      case "qa":
        await runStageQa(ticketId, stageConfig.mode, ctx);
        return;
    }
  } catch (err) {
    // A stage that emitted stage_started but then threw before its own
    // stage_finished — e.g. callAgent rejecting on timeout / non-zero CLI exit
    // — would otherwise leave that lane "running" forever in a tailing UI
    // (run_finished is stage-agnostic). Emit a terminal event so the UI can
    // close the lane, then rethrow to preserve the pipeline's fail-stop.
    emitEvent("stage_finished", {
      ticket: ticketId,
      stage,
      approved: false,
      reason: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

// Deterministic pre-fetch: pull one upload job's MongoDB document and its
// matching Sentry events, then write context/<id>/context.{md,json}. No agent, no MCP —
// scripted orchestrator code (pipeline/fetch-context.ts). Fails fast on a bad
// id, a missing `fetch` config block, or missing credentials, mirroring the MCP
// credential preflight in main().
async function runFetchCommand(uploadJobId: string): Promise<void> {
  validateUploadJobId(uploadJobId);

  const config = readConfig();
  if (!config.fetch) {
    throw new Error(
      "sdlc.config.json has no `fetch` block. Add one (see the `_comment_fetch` " +
        "note in sdlc.config.json) before running `fetch`.",
    );
  }

  loadEnvFile(resolve(".env"));
  const missing = REQUIRED_FETCH_ENV.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(
      `Missing credential(s) for the fetch: ${missing.join(", ")}.\n` +
        `Set them in this repo's .env (see .env.example) or your environment before running.`,
    );
  }

  console.log(`\nFetching debug context for upload job ${uploadJobId}...`);
  const jobCtx = await fetchUploadJobContext(uploadJobId, config.fetch, {
    authToken: process.env.SENTRY_AUTH_TOKEN,
    mongoUri: process.env.MONGODB_URI,
  });

  // Best-effort: download the failure artifacts attached to the job's Sentry events —
  // the error screenshot(s) AND the page.html DOM snapshot(s) — into context/<id>/
  // artifacts/ (same SENTRY_AUTH_TOKEN — no S3, no extra creds), so the investigate
  // stage can open the PNG or Grep/Read the HTML.
  const token = process.env.SENTRY_AUTH_TOKEN as string;
  const jobDir = `context/${uploadJobId}`;
  jobCtx.artifacts = await downloadJobArtifacts(
    jobCtx,
    config.fetch,
    {
      jsonGet: makeSentryGet(config.fetch.sentry.regionUrl, token),
      binGet: makeSentryBinaryGet(config.fetch.sentry.regionUrl, token),
    },
    jobDir,
  );
  if (jobCtx.artifacts.length) {
    const ok = jobCtx.artifacts.filter((a) => a.localPath).length;
    console.log(`  Artifacts: ${ok}/${jobCtx.artifacts.length} (screenshot + page.html) from Sentry → ${jobDir}/artifacts/`);
  }

  const sentryCount = jobCtx.sentry.reduce((n, s) => n + s.events.length, 0);
  const { mdPath, jsonPath } = writeContextArtifacts(jobCtx);
  console.log(`  Mongo:  job ${jobCtx.mongo ? "found" : "NOT found"} (status: ${jobCtx.mongo?.status ?? "?"})`);
  console.log(`  Sentry: ${sentryCount} event(s) across ${jobCtx.sentry.length} project(s)`);
  for (const s of jobCtx.sentry) {
    if (s.error) console.log(`    - ${s.project}: fetch error — ${s.error}`);
  }
  console.log(`\nWrote:\n  ${mdPath}\n  ${jsonPath}`);
}

// ON-DEMAND: run the REAL scraper headed against a failing job to reproduce it or
// validate a fix. Deterministic orchestrator code (no agent). Requires `fetch` to
// have run (requires context/<id>/ to exist). Prompts for the portal password and
// passes it to the child ONLY via the env INPUT payload — never written to disk or a
// log. The input is built COMPLETE from the Mongo step (the upload_jobs aggregation)
// with directInvoiceSubmission forced false, so the scraper runs with no MongoDB of
// its own (SKIP_MONGO) and never files a live invoice (draft only).
// Tee a child's stdout+stderr to BOTH the terminal (live) and a captured string
// (tail-capped), returning the exit code — so the human watches the headed run live
// while the pipeline keeps a copy for the investigate agent.
const REPRODUCE_LOG_CAP = 64 * 1024;
function spawnTee(
  command: string,
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, { cwd: opts.cwd, env: opts.env, shell: true });
    let output = "";
    const onData = (chunk: Buffer) => {
      const s = chunk.toString();
      process.stdout.write(s);
      output += s;
      if (output.length > REPRODUCE_LOG_CAP) output = output.slice(-REPRODUCE_LOG_CAP);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ exitCode: code, output }));
  });
}

function renderReproduceMd(
  uploadJobId: string,
  portalName: string,
  command: string,
  exitCode: number | null,
  output: string,
): string {
  return [
    `# Local reproduction — upload job ${uploadJobId}`,
    "",
    `_Ran ${new Date().toISOString()}_`,
    "",
    `- **Portal:** ${portalName}`,
    `- **Command:** \`${command}\` (HEADED, draft-only — never submits)`,
    `- **Exit code:** ${exitCode} — a NON-ZERO exit usually means the failure reproduced; compare the error below to the Sentry error in context.md.`,
    "",
    "## Console output (tail)",
    "",
    "```",
    output.trim() || "(no output captured)",
    "```",
    "",
  ].join("\n");
}

// Core reproduce: build a self-contained input from the Mongo step, prompt for the
// password, run the real scraper HEADED (draft-only), and CAPTURE the result to
// context/<id>/reproduce.md so the investigate stage can read it. Throws on setup
// errors (missing context/creds/cwd). Returns the exit code + artifact path.
async function doReproduce(uploadJobId: string, config: Config): Promise<{ exitCode: number | null; mdPath: string }> {
  if (!config.reproduce) throw new Error("sdlc.config.json has no `reproduce` block (see its _comment_reproduce note).");
  if (!config.fetch) throw new Error("reproduce builds its input from the `fetch.mongo` config, which is missing.");

  const jobDir = `context/${uploadJobId}`;
  if (!existsSync(`${jobDir}/context.json`)) {
    throw new Error(`No fetched context at ${jobDir}/context.json. Run \`npm run sdlc fetch ${uploadJobId}\` first.`);
  }

  loadEnvFile(resolve(".env"));
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error("MONGODB_URI is required in this repo's .env — reproduce builds the scraper input from the Mongo step.");
  }

  // The portal password is prompted STRICTLY over the terminal — never file-
  // channelled. Without a TTY (e.g. a dashboard-triggered pause where nobody is at
  // this console) there's no safe way to collect it, so fail loudly. In the
  // reproduce STAGE the surrounding try/catch turns this into "continue without
  // reproduction" (no hang); the standalone reproduce command surfaces it as an error.
  if (!process.stdin.isTTY) {
    throw new Error(
      "reproduce needs a TTY for the portal password — run from a terminal, or set reproduce mode to skip"
    );
  }

  const password = await promptText(config.reproduce.passwordPrompt ?? "Portal password");
  if (!password) throw new Error("No password entered — aborting reproduce.");

  // Build a SELF-CONTAINED input from the Mongo step (the upload_jobs aggregation), so
  // the scraper does NOT re-hydrate and needs no MongoDB of its own (SKIP_MONGO).
  const input: any = await buildReproduceInput(
    mongoUri,
    config.fetch.mongo.database,
    config.fetch.mongo.collection,
    uploadJobId,
  );
  if (!input) {
    throw new Error(`Upload job ${uploadJobId} not found in ${config.fetch.mongo.database}.${config.fetch.mongo.collection}.`);
  }
  const portalName: string = input.portalName ?? "?";
  input.portalUser = { ...input.portalUser, password };
  // Force draft-only, and drop uploadJob so the scraper does NOT re-hydrate (input is complete).
  input.invoiceFormValues = { ...input.invoiceFormValues, directInvoiceSubmission: false };
  delete input.uploadJob;

  const cwd = resolve(config.reproduce.cwd);
  if (!existsSync(cwd)) throw new Error(`reproduce.cwd not found: ${cwd}`);
  // Strip MONGODB_URI (and the cache URI) from the CHILD env. This repo's .env sets
  // MONGODB_URI so the pipeline can build the input above, but the scraper reads
  // `MONGODB_URI = process.env.MONGODB_URI || (SKIP_MONGO ? undefined : <ssm>)`, so an
  // inherited value would defeat SKIP_MONGO — the scraper would then open its session
  // cache (session-cache.cache) with our fetch-scoped creds and die on an unauthorized
  // upsert. Removing it here (Node's --env-file can't override an already-set var) lets
  // SKIP_MONGO resolve MONGODB_URI to undefined so the cache is null and no Mongo is
  // touched — the no-Mongo mode the scraper is written for. The pipeline keeps its own.
  // NB: this alone is not enough — @montopay/base-scraper's base_constants.ts resolves
  // its OWN mongo URI at import and does NOT honor SKIP_MONGO, so with MONGODB_URI stripped
  // it falls back to SSM and crashes before main(). reproduce.env sets NODE_ENV=test so that
  // fallback returns "" instead. Both must stay in sync (see sdlc.config.json _comment_reproduce).
  const { MONGODB_URI: _drop, CACHE_MONGODB_URI: _dropCache, ...childEnv } = process.env;
  const env = { ...childEnv, ...(config.reproduce.env ?? {}), INPUT: JSON.stringify(input) };

  console.log(`\nReproducing upload job ${uploadJobId} (${portalName}) — HEADED, draft-only.`);
  console.log(`  $ ${config.reproduce.command}   (cwd: ${cwd})\n`);
  const { exitCode, output } = await spawnTee(config.reproduce.command, { cwd, env });

  mkdirSync(jobDir, { recursive: true });
  const mdPath = `${jobDir}/reproduce.md`;
  writeFileSync(mdPath, renderReproduceMd(uploadJobId, portalName, config.reproduce.command, exitCode, output));
  return { exitCode, mdPath };
}

// Standalone `npm run sdlc reproduce <id>` — runs a reproduction directly.
async function runReproduceCommand(uploadJobId: string): Promise<void> {
  validateUploadJobId(uploadJobId);
  const config = readConfig();
  const { exitCode, mdPath } = await doReproduce(uploadJobId, config);
  console.log(`\nReproduce exit ${exitCode}. Captured to ${mdPath}.`);
  console.log(
    exitCode === 0
      ? "Completed (exit 0). If it did NOT reproduce, the failure may be prod-only (IP/proxy/portal state)."
      : "Non-zero exit — a reproduced failure is expected here; investigate will compare it to the Sentry error.",
  );
}

// Pipeline stage: OFFER a live reproduction before investigate (approve mode) and
// capture its result to context/<id>/reproduce.md so investigate ingests it. Never
// blocks the pipeline — a decline skips it, and a failed run is noted and continues.
async function runStageReproduce(ticketId: string, mode: StageMode, ctx: Ctx): Promise<void> {
  const startedAt = Date.now();
  emitEvent("stage_started", { ticket: ticketId, stage: "reproduce", mode });
  const finish = (extra: Record<string, unknown> = {}) => {
    logRun({ stage: "reproduce", ticket: ticketId, mode, durationMs: Date.now() - startedAt, approved: true });
    emitEvent("stage_finished", { ticket: ticketId, stage: "reproduce", approved: true, durationMs: Date.now() - startedAt, ...extra });
  };

  if (mode === "manual") {
    console.log(`reproduce: manual mode — skipping (run \`npm run sdlc reproduce ${ticketId}\` yourself if needed).`);
    return finish({ ran: false });
  }

  let run = true;
  if (mode === "approve") {
    // Reproduce's y/n gate is answerable from the dashboard too (via awaitApproval),
    // but with NO feedback and NO preview — it's a "run it now?" decision, not an
    // artifact to review. The portal password (needed only if approved) is prompted
    // strictly over the terminal in doReproduce, never file-channelled.
    const decision = await awaitApproval(ctx, {
      ticket: ticketId,
      stage: "reproduce",
      attempt: 1,
      question: `Run a live reproduction for job ${ticketId} now? (headed browser; needs the portal password + a Node 22 scraper install)`,
      previewPath: "",
      wantFeedback: false,
    });
    run = decision.approved;
  }
  if (!run) {
    console.log("reproduce: skipped by operator.");
    return finish({ ran: false });
  }

  try {
    const { exitCode, mdPath } = await doReproduce(ticketId, ctx.config);
    console.log(`\nreproduce: captured → ${mdPath} (exit ${exitCode}).`);
    return finish({ ran: true, exitCode });
  } catch (err) {
    // Best-effort: note the failure so investigate knows a reproduction was attempted.
    const msg = err instanceof Error ? err.message : String(err);
    const jobDir = `context/${ticketId}`;
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      `${jobDir}/reproduce.md`,
      `# Local reproduction — upload job ${ticketId}\n\n_Attempted ${new Date().toISOString()}_\n\n**Could not run:** ${msg}\n`,
    );
    console.log(`reproduce: could not run (${msg}) — noted to context/${ticketId}/reproduce.md; continuing.`);
    return finish({ ran: false, error: msg });
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  // The stage override is a plain positional argument, not a --flag:
  // "npm run <script> --flag" is unreliable, since npm intercepts any
  // "--"-prefixed argument it doesn't recognize as its own CLI config
  // (silently dropping it, with only a warning) unless the caller
  // remembers to add a "--" separator first. A bare positional arg has
  // no such gotcha — it always reaches process.argv unmodified.
  const [rawCommand, ticketId, overrideStage, ...rest] = args;
  let command = rawCommand;

  // `fetch <uploadJobId>` — deterministic pre-fetch of a job's MongoDB + Sentry
  // debugging context into context/<id>/context.{md,json}. Kept separate from `run` so
  // the fetch can be iterated in isolation. The ticketId positional slot carries
  // the upload job id here.
  // Single-job commands — the ticketId positional slot carries the uploadJobId.
  if (command === "fetch" || command === "reproduce") {
    const uploadJobId = ticketId;
    if (!uploadJobId || overrideStage || rest.length > 0) {
      console.error(`Usage: npm run sdlc ${command} <uploadJobId>`);
      process.exit(1);
    }
    if (command === "fetch") await runFetchCommand(uploadJobId);
    else await runReproduceCommand(uploadJobId);
    return;
  }

  // `debug <uploadJobId>` = fetch the job's context, then run the pipeline with the
  // uploadJobId as the ticketId. Falls through to the run body below.
  if (command === "debug") {
    if (!ticketId || overrideStage || rest.length > 0) {
      console.error("Usage: npm run sdlc debug <uploadJobId>");
      process.exit(1);
    }
    await runFetchCommand(ticketId);
    console.log(`\n--- Running the debugging pipeline for ${ticketId} ---`);
    command = "run"; // fall through
  }

  if (command !== "run" || !ticketId) {
    console.error(
      "Usage: npm run sdlc run <ticketId> [stageName]\n" +
        "       npm run sdlc debug <uploadJobId>      (fetch + run)\n" +
        "       npm run sdlc fetch <uploadJobId>\n" +
        "       npm run sdlc reproduce <uploadJobId>  (headed; never submits)",
    );
    process.exit(1);
  }

  if (rest.length > 0) {
    console.error(`Unrecognized extra argument(s): ${rest.join(" ")}`);
    process.exit(1);
  }

  if (overrideStage && !STAGE_ORDER.includes(overrideStage as Stage)) {
    console.error(`Unknown stage "${overrideStage}". Valid stages: ${STAGE_ORDER.join(", ")}`);
    process.exit(1);
  }

  const config = readConfig();
  if (!config.stages.investigate) {
    throw new Error("sdlc.config.json is missing an 'investigate' stage entry");
  }

  const paths = resolvePaths(config);
  // Load this project's per-user credentials (gitignored `.env` in THIS pipeline
  // repo, next to sdlc.config.json and mcp.json) before any agent spawns, so MCP
  // servers declared in mcp.json can expand ${ENV} placeholders from the inherited
  // process.env. Kept in the pipeline repo (the per-project fork), never the
  // product repo — the product repo carries no pipeline/credential files.
  loadEnvFile(resolve(".env"));

  // Fail fast on missing MCP credentials. If any stage enables MCP, every ${VAR}
  // its config file requires must already be set (via .env or the real env) BEFORE
  // an agent runs — otherwise a server silently fails to start and the stage runs
  // WITHOUT the tools it was promised (silent capability loss, the worst failure
  // mode). Better to stop here with an exact list than ship a spec written blind.
  if (config.mcp?.stages && Object.values(config.mcp.stages).some((t) => t.length > 0)) {
    const mcpPath = resolve(config.mcp.configPath ?? "mcp.json");
    if (!existsSync(mcpPath)) {
      throw new Error(
        `sdlc.config.json configures mcp.stages but no MCP config file exists at ` +
          `${mcpPath} (set mcp.configPath; default "mcp.json").`
      );
    }
    const missing = requiredMcpEnvVars(readFileSync(mcpPath, "utf8")).filter((v) => !process.env[v]);
    if (missing.length > 0) {
      throw new Error(
        `Missing credential(s) for MCP servers in ${mcpPath}: ${missing.join(", ")}.\n` +
          `Set them in this repo's .env (see .env.example) or your environment before running.`
      );
    }
  }

  const descriptor = readProductDescriptor(paths.workdir);
  // One id for this whole run — stamped into run_started, the run.lock.json mutex,
  // and every approval request.json so the dashboard can scope pauses to the live
  // run and the startup sweep can discard stale ones.
  const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const ctx: Ctx = { config, paths, descriptor, runId };

  console.log(`\nTicket ${ticketId}`);
  console.log(`  Product:       ${descriptor.name} at ${paths.workdir}`);
  console.log(`  Knowledge repo: ${paths.knowledgeDir} (validated, not yet written)`);

  const startStage = (overrideStage as Stage) ?? resolveStartStage(ticketId);
  if (overrideStage) {
    console.log(`Forcing ticket ${ticketId} to start at stage "${startStage}" (explicit override).`);
  } else {
    console.log(`Resuming ticket ${ticketId} from stage "${startStage}" (per runlog.jsonl).`);
  }

  // Single-run mutex: refuse to start if another run is live (its pid alive),
  // overwrite a stale lock otherwise. The dashboard's POST /command {cmd:"start"}
  // also reads this file to fail fast, but the orchestrator is authoritative and
  // re-acquires here. Released in the finally below, but ONLY if still ours.
  acquireRunLock(ctx, ticketId);
  // Discard leftover approval control files from prior runs (stale runId), so the
  // dashboard never surfaces a pause that isn't part of THIS run.
  sweepStaleApprovals(ctx.runId);

  try {
    emitEvent("run_started", {
      ticket: ticketId,
      runId: ctx.runId,
      product: descriptor.name,
      knowledgeDir: paths.knowledgeDir,
      startStage,
      stages: [...STAGE_ORDER],
      learning: !!ctx.config.learning?.enabled,
    });

    // Run the writing flow, CAPTURING (not immediately rethrowing) a stage failure
    // so the learning loop can still run afterward — a belted/aborted ticket is the
    // highest-signal input for the Retrospector, and skipping it on failure (the old
    // behavior) meant the most instructive runs taught nothing.
    let writingError: unknown = null;
    try {
      const startIndex = STAGE_ORDER.indexOf(startStage);
      for (let i = startIndex; i < STAGE_ORDER.length; i++) {
        await runNamedStage(STAGE_ORDER[i], ticketId, ctx);
      }
    } catch (err) {
      writingError = err;
    }
    const errText = writingError ? (writingError instanceof Error ? writingError.message : String(writingError)) : undefined;

    // Learning loop, gated by config. The Retrospector aggregates what happened, on
    // SUCCESS OR FAILURE. The product Curator judges it against the KB's conventions
    // and proposes a conformance-checked branch for a human PR — but ONLY on a clean
    // run: it must cite a product-canonical source, and unshipped work has none (its
    // code sits on feature/<id>, which the conformance gate bans). Learning is
    // advisory, so its own errors are caught and logged, never allowed to mask the
    // real run outcome.
    if (ctx.config.learning?.enabled) {
      try {
        await runStageRetrospector(ticketId, ctx, errText);
        if (!writingError) await runCurator(ticketId, ctx, "product");
      } catch (learnErr) {
        console.error("Learning loop error (non-fatal):", learnErr instanceof Error ? learnErr.message : String(learnErr));
      }
    }

    if (writingError) {
      emitEvent("run_finished", { ticket: ticketId, outcome: "failed", error: errText });
      throw writingError;
    }
    emitEvent("run_finished", { ticket: ticketId, outcome: "complete" });
  } finally {
    releaseRunLock(ctx);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
