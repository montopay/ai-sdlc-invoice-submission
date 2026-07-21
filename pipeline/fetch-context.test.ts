// Tests for the pre-fetch context module (pipeline/fetch-context.ts).
// Run: npm test  (node --import tsx --test)
//
// The module's design splits PURE normalizers (curateJob, normalizeSentryEvent,
// renderSentryQuery, renderContextMarkdown, validateUploadJobId) from thin I/O
// wrappers. The I/O orchestration (fetchSentryForJob, fetchUploadJobContext) is
// tested with INJECTED fetchers — no live Sentry/Mongo, no global mocks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  validateUploadJobId,
  renderSentryQuery,
  curateJob,
  normalizeSentryEvent,
  fetchSentryForJob,
  withRetry,
  renderContextMarkdown,
  writeContextArtifacts,
  fetchUploadJobContext,
  REQUIRED_FETCH_ENV,
  type FetchConfig,
  type JobContext,
} from "./fetch-context";

const VALID_ID = "5f9d1b2c3a4e5f6a7b8c9d0e"; // 24-hex

const CFG: FetchConfig = {
  sentry: {
    org: "monto-e1c13a9a2",
    regionUrl: "https://us.sentry.io",
    projects: ["upload-invoice"],
    queryTemplate: "{id}",
    statsPeriod: "90d",
    maxIssues: 25,
    maxEventsPerIssue: 5,
  },
  mongo: { database: "MontoProd", collection: "upload_jobs" },
};

// --- A representative upload_jobs document (mirrors the real schema) ---------
const RAW_JOB = {
  _id: VALID_ID,
  status: "Failed",
  createdAt: "2026-07-19T10:00:00.000Z",
  startedAt: "2026-07-19T10:00:05.000Z",
  finishedAt: "2026-07-19T10:01:00.000Z",
  portalName: "Coupa",
  customerName: "Acme Corp",
  ai: true,
  autoLaunch: true,
  sfExecutionArn: "arn:aws:states:us-east-1:123:execution:upload:abc",
  lambdaInvokeId: "lambda-invoke-xyz",
  errorMessage: "Portal login failed",
  error: { message: "TimeoutError: waiting for selector #login" },
  lastErrorClassification: {
    category: "AUTH",
    severity: "high",
    description: "Login credentials rejected",
    isRetryable: false,
  },
  lastErrorScreenshot: { url: "https://x", key: "shots/last.png", bucket: "monto-shots" },
  aiResults: {
    statusCode: 200,
    body: {
      result: {
        status: "FAILED",
        loginResult: { status: "FAILED" },
        uploadInvoiceResults: [
          {
            invoiceId: "inv-1",
            status: "FAILED",
            errorMessage: "Field 'PO' required",
            errorScreenshotUrl: "https://x/inv1.png",
            errorClassification: { category: "VALIDATION", severity: "medium" },
          },
        ],
      },
    },
  },
  screenshots: [{ bucket: "monto-shots", key: "s1.png" }],
  videos: [{ bucket: "monto-vids", key: "v1.mp4" }],
  // Heavy fields that MUST be dropped by curation:
  jobPayload: { invoice: { lineItems: Array.from({ length: 200 }, (_, i) => ({ i })) } },
  draftPayload: { huge: "x".repeat(5000) },
  buyer: { _id: "b1", giant: "y".repeat(5000) },
};

// --- A representative Sentry event-detail payload ----------------------------
const RAW_EVENT_DETAIL = {
  eventID: "abc123def456abc123def456abc12300",
  title: "TimeoutError: waiting for selector",
  message: "TimeoutError: waiting for selector #login",
  culprit: "uploadInvoice(app/upload.ts)",
  dateCreated: "2026-07-19T10:00:50.000Z",
  tags: [
    { key: "level", value: "error" },
    { key: "upload_job_id", value: VALID_ID },
    { key: "environment", value: "production" },
  ],
  entries: [
    {
      type: "exception",
      data: {
        values: [
          {
            type: "TimeoutError",
            value: "waiting for selector #login",
            stacktrace: {
              // Real Sentry event-detail shape: source is a `context` array of
              // [lineNo, sourceText] pairs — there is NO scalar `contextLine`.
              frames: [
                { filename: "app/upload.ts", function: "uploadInvoice", lineNo: 42, colNo: 5, context: [[41, "async function uploadInvoice() {"], [42, "await page.click('#login')"], [43, "}"]] },
                { filename: "app/portal.ts", function: "login", lineNo: 88, colNo: 3, context: [[87, "async function login() {"], [88, "await waitFor('#login')"], [89, "}"]] },
              ],
            },
          },
        ],
      },
    },
    {
      type: "breadcrumbs",
      data: {
        values: [
          { category: "navigation", level: "info", message: "goto /login", timestamp: "2026-07-19T10:00:40.000Z" },
          { category: "http", level: "warning", message: "GET /login 500", timestamp: "2026-07-19T10:00:45.000Z" },
        ],
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// validateUploadJobId
// ---------------------------------------------------------------------------
test("validateUploadJobId accepts a 24-char hex id", () => {
  assert.doesNotThrow(() => validateUploadJobId(VALID_ID));
});

test("validateUploadJobId rejects a non-hex / wrong-length id", () => {
  assert.throws(() => validateUploadJobId("not-an-object-id"));
  assert.throws(() => validateUploadJobId("123")); // too short
  assert.throws(() => validateUploadJobId(""));
});

// ---------------------------------------------------------------------------
// renderSentryQuery
// ---------------------------------------------------------------------------
test("renderSentryQuery substitutes {id} (free-text default)", () => {
  assert.equal(renderSentryQuery("{id}", VALID_ID), VALID_ID);
});

test("renderSentryQuery supports a tag-scoped template with multiple {id}", () => {
  assert.equal(
    renderSentryQuery("upload_job_id:{id} OR message:{id}", VALID_ID),
    `upload_job_id:${VALID_ID} OR message:${VALID_ID}`,
  );
});

// ---------------------------------------------------------------------------
// curateJob
// ---------------------------------------------------------------------------
test("curateJob keeps debugging fields and drops heavy payloads", () => {
  const c = curateJob(RAW_JOB) as any;
  assert.equal(c.id, VALID_ID);
  assert.equal(c.status, "Failed");
  assert.equal(c.portalName, "Coupa");
  assert.equal(c.customerName, "Acme Corp");
  assert.equal(c.ai, true);
  assert.equal(c.sfExecutionArn, RAW_JOB.sfExecutionArn);
  assert.equal(c.lambdaInvokeId, "lambda-invoke-xyz");
  assert.equal(c.errorMessage, "Portal login failed");
  assert.equal(c.errorDetail, "TimeoutError: waiting for selector #login");
  assert.equal(c.lastErrorClassification.category, "AUTH");
  // aiResults flattened to the useful bits
  assert.equal(c.aiResult.status, "FAILED");
  assert.equal(c.aiResult.loginStatus, "FAILED");
  assert.equal(c.aiResult.uploadInvoiceResults[0].errorMessage, "Field 'PO' required");
  assert.equal(c.aiResult.uploadInvoiceResults[0].errorClassification.category, "VALIDATION");
  // media references keep keys only
  assert.equal(c.screenshots[0].key, "s1.png");
  assert.equal(c.videos[0].key, "v1.mp4");
  assert.equal(c.lastErrorScreenshot.key, "shots/last.png");
  // heavy fields dropped
  assert.equal((c as any).jobPayload, undefined);
  assert.equal((c as any).draftPayload, undefined);
  assert.equal((c as any).buyer, undefined);
  // whole curated blob stays small
  assert.ok(JSON.stringify(c).length < 2000, "curated job should be compact");
});

test("curateJob handles errorMessage given as an object {message}", () => {
  const c = curateJob({ _id: VALID_ID, errorMessage: { message: "boom" } }) as any;
  assert.equal(c.errorMessage, "boom");
});

test("curateJob surfaces errorDetail when `error` is a bare string", () => {
  const c = curateJob({ _id: VALID_ID, error: "raw boom" }) as any;
  assert.equal(c.errorDetail, "raw boom");
});

test("curateJob tolerates a minimal document", () => {
  const c = curateJob({ _id: VALID_ID }) as any;
  assert.equal(c.id, VALID_ID);
  assert.equal(c.status, undefined);
});

// ---------------------------------------------------------------------------
// normalizeSentryEvent
// ---------------------------------------------------------------------------
test("normalizeSentryEvent flattens tags, frames, and breadcrumbs", () => {
  const ev = normalizeSentryEvent(RAW_EVENT_DETAIL, "9001", "https://monto-e1c13a9a2.sentry.io/issues/9001/");
  assert.equal(ev.id, RAW_EVENT_DETAIL.eventID);
  assert.equal(ev.issueId, "9001");
  assert.equal(ev.permalink, "https://monto-e1c13a9a2.sentry.io/issues/9001/");
  assert.equal(ev.level, "error");
  assert.equal(ev.tags.upload_job_id, VALID_ID);
  assert.equal(ev.tags.environment, "production");
  assert.equal(ev.frames.length, 2);
  assert.equal(ev.frames[0].function, "uploadInvoice");
  assert.equal(ev.frames[0].lineNo, 42);
  assert.equal(ev.frames[0].contextLine, "await page.click('#login')");
  assert.equal(ev.breadcrumbs.length, 2);
  assert.equal(ev.breadcrumbs[1].message, "GET /login 500");
});

test("normalizeSentryEvent tolerates an event with no entries", () => {
  const ev = normalizeSentryEvent({ eventID: "e1", title: "boom", tags: [] }, "1");
  assert.equal(ev.frames.length, 0);
  assert.equal(ev.breadcrumbs.length, 0);
  assert.equal(ev.title, "boom");
});

// ---------------------------------------------------------------------------
// fetchSentryForJob  (dependency-injected HTTP get)
// ---------------------------------------------------------------------------
function fakeGet(calls: string[]) {
  return async (path: string) => {
    calls.push(path);
    if (path.includes("/issues/?") || (path.includes("/issues/") && path.includes("query="))) {
      // issue search
      return [
        { id: "9001", title: "Timeout", culprit: "upload", level: "error", permalink: "https://s/issues/9001/" },
      ];
    }
    if (path.match(/\/issues\/\d+\/events\/\?/)) {
      // events list for an issue
      return [{ eventID: RAW_EVENT_DETAIL.eventID, id: RAW_EVENT_DETAIL.eventID }];
    }
    if (path.includes("/events/") && path.endsWith(`/${RAW_EVENT_DETAIL.eventID}/`)) {
      return RAW_EVENT_DETAIL;
    }
    throw new Error(`unexpected path ${path}`);
  };
}

test("fetchSentryForJob searches, resolves events, and normalizes them", async () => {
  const calls: string[] = [];
  const ctxs = await fetchSentryForJob(VALID_ID, CFG, fakeGet(calls));
  assert.equal(ctxs.length, 1);
  assert.equal(ctxs[0].project, "upload-invoice");
  assert.equal(ctxs[0].query, VALID_ID);
  assert.equal(ctxs[0].events.length, 1);
  assert.equal(ctxs[0].events[0].tags.upload_job_id, VALID_ID);
  // the search query carried the job id, url-encoded
  assert.ok(calls[0].includes(encodeURIComponent(VALID_ID)));
});

test("fetchSentryForJob isolates a per-project failure instead of throwing", async () => {
  const cfg2: FetchConfig = { ...CFG, sentry: { ...CFG.sentry, projects: ["upload-invoice", "broken"] } };
  const get = async (path: string) => {
    if (path.includes("/projects/monto-e1c13a9a2/broken/")) throw new Error("403 forbidden");
    return fakeGet([])(path);
  };
  const ctxs = await fetchSentryForJob(VALID_ID, cfg2, get);
  assert.equal(ctxs.length, 2);
  const broken = ctxs.find((c) => c.project === "broken")!;
  assert.equal(broken.events.length, 0);
  assert.match(broken.error ?? "", /403/);
});

test("fetchSentryForJob caps events per issue and flags truncation", async () => {
  const cfg3: FetchConfig = { ...CFG, sentry: { ...CFG.sentry, maxIssues: 1, maxEventsPerIssue: 1 } };
  const get = async (path: string) => {
    if (path.includes("/issues/?") || path.includes("query=")) {
      // return MORE issues than maxIssues to force truncation
      return [
        { id: "1", permalink: "p1" },
        { id: "2", permalink: "p2" },
      ];
    }
    if (path.match(/\/issues\/\d+\/events\/\?/)) {
      return [{ eventID: RAW_EVENT_DETAIL.eventID }, { eventID: "second" }];
    }
    return RAW_EVENT_DETAIL;
  };
  const ctxs = await fetchSentryForJob(VALID_ID, cfg3, get);
  assert.equal(ctxs[0].truncated, true);
  assert.equal(ctxs[0].events.length, 1); // 1 issue * 1 event
});

test("fetchSentryForJob reports truncated=false when results are under the caps", async () => {
  // fakeGet returns 1 issue / 1 event; default caps are 25 / 5 -> nothing dropped.
  const ctxs = await fetchSentryForJob(VALID_ID, CFG, fakeGet([]));
  assert.equal(ctxs[0].truncated, false);
});

test("fetchSentryForJob flags truncation when an issue exceeds the per-issue event cap", async () => {
  const cfg: FetchConfig = { ...CFG, sentry: { ...CFG.sentry, maxIssues: 25, maxEventsPerIssue: 1 } };
  const get = async (path: string) => {
    if (path.includes("/issues/?") || path.includes("query=")) {
      return [{ id: "1", permalink: "p1" }]; // 1 issue, well under maxIssues
    }
    if (path.match(/\/issues\/\d+\/events\/\?/)) {
      return [{ eventID: RAW_EVENT_DETAIL.eventID }, { eventID: "second" }]; // 2 > cap of 1
    }
    return RAW_EVENT_DETAIL;
  };
  const ctxs = await fetchSentryForJob(VALID_ID, cfg, get);
  assert.equal(ctxs[0].truncated, true, "per-issue event cap must set truncated");
  assert.equal(ctxs[0].events.length, 1);
});

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------
test("withRetry retries transient failures then succeeds", async () => {
  let n = 0;
  const sleeps: number[] = [];
  const result = await withRetry(
    async () => {
      n++;
      if (n < 3) throw new Error("transient");
      return "ok";
    },
    { retries: 3, sleep: async (ms) => { sleeps.push(ms); }, shouldRetry: () => true },
  );
  assert.equal(result, "ok");
  assert.equal(n, 3);
  // Backoff must actually increase (base 300 -> 600), not stay constant / be zero.
  assert.deepEqual(sleeps, [300, 600]);
});

test("withRetry gives up after exhausting retries", async () => {
  let n = 0;
  await assert.rejects(
    withRetry(
      async () => { n++; throw new Error("always"); },
      { retries: 2, sleep: async () => {}, shouldRetry: () => true },
    ),
    /always/,
  );
  assert.equal(n, 3); // initial + 2 retries
});

test("withRetry does not retry when shouldRetry is false", async () => {
  let n = 0;
  await assert.rejects(
    withRetry(
      async () => { n++; throw new Error("fatal 401"); },
      { retries: 5, sleep: async () => {}, shouldRetry: () => false },
    ),
    /fatal 401/,
  );
  assert.equal(n, 1);
});

// ---------------------------------------------------------------------------
// renderContextMarkdown
// ---------------------------------------------------------------------------
function sampleContext(): JobContext {
  return {
    uploadJobId: VALID_ID,
    fetchedAtIso: "2026-07-20T00:00:00.000Z",
    mongo: curateJob(RAW_JOB),
    sentry: [
      {
        project: "upload-invoice",
        query: VALID_ID,
        truncated: false,
        events: [normalizeSentryEvent(RAW_EVENT_DETAIL, "9001", "https://s/issues/9001/")],
      },
    ],
  };
}

test("renderContextMarkdown surfaces the id, status, error, and a sentry event", () => {
  const md = renderContextMarkdown(sampleContext());
  assert.match(md, new RegExp(VALID_ID));
  assert.match(md, /Failed/);
  assert.match(md, /Portal login failed/);
  assert.match(md, /upload-invoice/);
  assert.match(md, /TimeoutError/);
});

test("renderContextMarkdown notes when there are no matching Sentry events", () => {
  const ctx = sampleContext();
  ctx.sentry = [{ project: "upload-invoice", query: VALID_ID, truncated: false, events: [] }];
  const md = renderContextMarkdown(ctx);
  assert.match(md, /no matching sentry events/i);
});

test("renderContextMarkdown renders a per-project fetch error, not a false 'no events'", () => {
  const ctx = sampleContext();
  ctx.sentry = [{ project: "upload-invoice", query: VALID_ID, truncated: false, events: [], error: "403 forbidden" }];
  const md = renderContextMarkdown(ctx);
  assert.match(md, /fetch error:.*403/i);
  assert.doesNotMatch(md, /no matching sentry events/i);
});

// ---------------------------------------------------------------------------
// writeContextArtifacts
// ---------------------------------------------------------------------------
test("writeContextArtifacts nests both files in a per-id subfolder", () => {
  const dir = mkdtempSync(join(tmpdir(), "fetchctx-"));
  const { mdPath, jsonPath } = writeContextArtifacts(sampleContext(), dir);
  // Both artifacts live under context/<id>/, with source-agnostic basenames.
  assert.ok(jsonPath.endsWith(`${VALID_ID}/context.json`), jsonPath);
  assert.ok(mdPath.endsWith(`${VALID_ID}/context.md`), mdPath);
  const parsed = JSON.parse(readFileSync(jsonPath, "utf8"));
  assert.equal(parsed.uploadJobId, VALID_ID);
  const md = readFileSync(mdPath, "utf8");
  assert.match(md, new RegExp(VALID_ID));
});

// ---------------------------------------------------------------------------
// fetchUploadJobContext  (both fetchers injected)
// ---------------------------------------------------------------------------
test("fetchUploadJobContext combines curated Mongo + Sentry context", async () => {
  const ctx = await fetchUploadJobContext(VALID_ID, CFG, {
    mongoFind: async (db, coll, id) => {
      assert.equal(db, "MontoProd");
      assert.equal(coll, "upload_jobs");
      assert.equal(id, VALID_ID);
      return RAW_JOB;
    },
    sentryGet: fakeGet([]),
  });
  assert.equal(ctx.uploadJobId, VALID_ID);
  assert.equal(ctx.mongo!.status, "Failed");
  assert.equal(ctx.sentry[0].events[0].tags.upload_job_id, VALID_ID);
});

test("fetchUploadJobContext hard-fails when the job id is not found", async () => {
  await assert.rejects(
    fetchUploadJobContext(VALID_ID, CFG, {
      mongoFind: async () => null,
      sentryGet: fakeGet([]),
    }),
    /No upload job found/,
  );
});

test("fetchUploadJobContext validates the id before any I/O", async () => {
  let touched = false;
  await assert.rejects(
    fetchUploadJobContext("bad-id", CFG, {
      mongoFind: async () => { touched = true; return RAW_JOB; },
      sentryGet: fakeGet([]),
    }),
  );
  assert.equal(touched, false);
});

// ---------------------------------------------------------------------------
// exported constant used by run.ts preflight
// ---------------------------------------------------------------------------
test("REQUIRED_FETCH_ENV names both credentials", () => {
  assert.deepEqual([...REQUIRED_FETCH_ENV].sort(), ["MONGODB_URI", "SENTRY_AUTH_TOKEN"]);
});
