// Pre-fetch debugging context for a single invoice-submission upload job.
//
// Given an upload job _id, this module pulls that job's MongoDB document and its
// matching Sentry events, then writes a local artifact (context/<id>/context.md +
// context/<id>/context.json) that a later phase injects into stage prompts.
//
// Design: PURE normalizers (curateJob, normalizeSentryEvent, renderSentryQuery,
// renderContextMarkdown) are separated from thin I/O wrappers. All I/O is
// dependency-injected (HttpGet, mongoFind) so the orchestration is unit-tested
// without live Sentry/Mongo — matching this repo's "model proposes, script
// decides / deterministic and testable" ethos. No MCP: MCP is for agents; this
// is deterministic orchestrator code, so it calls Sentry (REST) and Mongo
// (driver) directly.

import { mkdirSync, writeFileSync } from "node:fs";

// Credentials the fetch requires from the environment. run.ts's fetch preflight
// reads this so there is a single source of truth. SENTRY_AUTH_TOKEN is a Sentry
// User Auth Token (sntryu_) or Internal Integration token (sntrys_) with scopes
// event:read, project:read, org:read. MONGODB_URI is the same connection string
// the Mongo MCP uses (prefer a read-only user).
export const REQUIRED_FETCH_ENV = ["SENTRY_AUTH_TOKEN", "MONGODB_URI"] as const;

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------
export type FetchConfig = {
  sentry: {
    org: string;
    regionUrl: string;
    projects: string[];
    queryTemplate: string; // {id} is substituted with the upload job id
    statsPeriod: string; // e.g. "90d"
    maxIssues: number;
    maxEventsPerIssue: number;
  };
  mongo: { database: string; collection: string };
};

export type UploadInvoiceResult = {
  invoiceId?: string;
  status?: string;
  errorMessage?: string;
  errorScreenshotUrl?: string;
  errorClassification?: unknown;
};

export type CuratedJob = {
  id: string;
  status?: string;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  portalName?: string;
  customerName?: string;
  buyerId?: string;
  // The dynamic-form field KEYS present in the job's jobPayload (keys only, no
  // values) — the schema-declared fields the automation fills. Lets the investigate
  // stage see which field failed and cross-check the buyer's upload_invoice_schemas
  // + upload_jobs history without re-querying Mongo.
  jobPayloadFields?: string[];
  ai?: boolean | null;
  autoLaunch?: boolean | null;
  sfExecutionArn?: string;
  lambdaInvokeId?: string;
  errorMessage?: string;
  errorDetail?: string;
  lastErrorClassification?: unknown;
  lastErrorScreenshot?: { bucket?: string; key?: string };
  aiResult?: {
    status?: string;
    loginStatus?: string;
    uploadInvoiceResults?: UploadInvoiceResult[];
  };
  screenshots?: Array<{ bucket?: string; key?: string }>;
  videos?: Array<{ bucket?: string; key?: string }>;
};

export type SentryFrame = {
  filename?: string;
  function?: string;
  lineNo?: number;
  colNo?: number;
  contextLine?: string;
};

export type SentryBreadcrumb = {
  category?: string;
  level?: string;
  message?: string;
  timestamp?: string;
};

export type SentryEvent = {
  id: string;
  issueId: string;
  title?: string;
  message?: string;
  level?: string;
  timestamp?: string;
  culprit?: string;
  permalink?: string;
  tags: Record<string, string>;
  frames: SentryFrame[];
  breadcrumbs: SentryBreadcrumb[];
};

export type SentryContext = {
  project: string;
  query: string;
  events: SentryEvent[];
  truncated: boolean;
  error?: string;
};

export type JobContext = {
  uploadJobId: string;
  fetchedAtIso: string;
  mongo: CuratedJob | null;
  sentry: SentryContext[];
  artifacts?: DownloadedArtifact[];
};

// A failure artifact the scraper attached to the job's Sentry event (base-scraper
// captureExceptionWithScope adds "screenshot.png" + "page.html"). Downloaded locally so
// the investigate stage can open the PNG or Grep/Read the DOM snapshot.
export type DownloadedArtifact = {
  eventId: string;
  name: string; // Sentry attachment filename, e.g. "screenshot.png" or "page.html"
  localPath?: string; // relative to context/<id>/, when the download succeeded
  error?: string; // set instead of localPath when the download failed (best-effort)
};

// One attachment listed on a Sentry event.
export type SentryAttachment = {
  eventId: string;
  attachmentId: string;
  name: string;
  mimetype?: string;
  size?: number;
};

// Downloads raw bytes from a Sentry API path (an attachment ?download). Injected in tests.
export type SentryBinaryGet = (path: string) => Promise<Uint8Array>;

// A minimal HTTP GET returning parsed JSON, keyed by API path. Injected in tests.
export type HttpGet = (path: string) => Promise<any>;
// A minimal Mongo finder returning the raw document (or null). Injected in tests.
export type MongoFind = (database: string, collection: string, id: string) => Promise<any | null>;

export type FetchDeps = {
  sentryGet?: HttpGet;
  mongoFind?: MongoFind;
  authToken?: string;
  mongoUri?: string;
};

const MAX_FRAMES = 40;
const MAX_BREADCRUMBS = 25;

// -------------------------------------------------------------------------
// Pure helpers
// -------------------------------------------------------------------------
export function validateUploadJobId(id: string): void {
  if (typeof id !== "string" || !/^[a-f0-9]{24}$/i.test(id)) {
    throw new Error(
      `Invalid upload job id "${id}": expected a 24-character hex MongoDB ObjectId.`,
    );
  }
}

export function renderSentryQuery(template: string, id: string): string {
  return template.split("{id}").join(id);
}

function asString(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v;
  // errorMessage can be either a string or an object { message }
  if (typeof v === "object" && typeof (v as any).message === "string") return (v as any).message;
  return undefined;
}

function pickMedia(arr: unknown): Array<{ bucket?: string; key?: string }> | undefined {
  if (!Array.isArray(arr)) return undefined;
  return arr
    .filter((x) => x && typeof x === "object")
    .map((x: any) => ({ bucket: x.bucket, key: x.key }));
}

export function curateJob(doc: Record<string, any>): CuratedJob {
  const result = doc?.aiResults?.body?.result;
  const curated: CuratedJob = {
    id: String(doc._id),
    status: doc.status,
    createdAt: doc.createdAt ? String(doc.createdAt) : undefined,
    startedAt: doc.startedAt ? String(doc.startedAt) : undefined,
    finishedAt: doc.finishedAt ? String(doc.finishedAt) : undefined,
    portalName: doc.portalName,
    customerName: doc.customerName,
    buyerId:
      doc.buyerId != null ? String(doc.buyerId) : doc.buyer?._id != null ? String(doc.buyer._id) : undefined,
    jobPayloadFields:
      doc.jobPayload && typeof doc.jobPayload === "object" && !Array.isArray(doc.jobPayload)
        ? Object.keys(doc.jobPayload)
        : undefined,
    ai: doc.ai ?? undefined,
    autoLaunch: doc.autoLaunch ?? undefined,
    sfExecutionArn: doc.sfExecutionArn,
    lambdaInvokeId: doc.lambdaInvokeId,
    errorMessage: asString(doc.errorMessage),
    errorDetail: asString(doc.error?.message ?? doc.error),
    lastErrorClassification: doc.lastErrorClassification,
    lastErrorScreenshot: doc.lastErrorScreenshot
      ? { bucket: doc.lastErrorScreenshot.bucket, key: doc.lastErrorScreenshot.key }
      : undefined,
    screenshots: pickMedia(doc.screenshots),
    videos: pickMedia(doc.videos),
  };

  if (result) {
    curated.aiResult = {
      status: result.status,
      loginStatus: result.loginResult?.status,
      uploadInvoiceResults: Array.isArray(result.uploadInvoiceResults)
        ? result.uploadInvoiceResults.map((r: any) => ({
            invoiceId: r.invoiceId,
            status: r.status,
            errorMessage: r.errorMessage,
            errorScreenshotUrl: r.errorScreenshotUrl,
            errorClassification: r.errorClassification,
          }))
        : undefined,
    };
  }

  return curated;
}

function tagsToMap(tags: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  if (Array.isArray(tags)) {
    for (const t of tags) {
      if (t && typeof t.key === "string") map[t.key] = String(t.value);
    }
  }
  return map;
}

// Sentry's project-event-detail endpoint serves each frame's source line as a
// `context` array of [lineNo, sourceText] pairs (there is no scalar
// `contextLine`). Pick the pair matching the frame's own lineNo; tolerate the
// scalar form too in case a different endpoint/SDK supplies it.
function frameContextLine(f: any): string | undefined {
  if (typeof f.contextLine === "string") return f.contextLine;
  if (Array.isArray(f.context)) {
    const hit = f.context.find((p: any) => Array.isArray(p) && p[0] === f.lineNo);
    if (hit && hit[1] != null) return String(hit[1]);
  }
  return undefined;
}

export function normalizeSentryEvent(
  raw: Record<string, any>,
  issueId: string,
  permalink?: string,
): SentryEvent {
  const entries: any[] = Array.isArray(raw.entries) ? raw.entries : [];
  const tags = tagsToMap(raw.tags);

  const exception = entries.find((e) => e?.type === "exception");
  const frames: SentryFrame[] = [];
  for (const value of exception?.data?.values ?? []) {
    for (const f of value?.stacktrace?.frames ?? []) {
      frames.push({
        filename: f.filename,
        function: f.function,
        lineNo: f.lineNo,
        colNo: f.colNo,
        contextLine: frameContextLine(f),
      });
    }
  }

  const crumbEntry = entries.find((e) => e?.type === "breadcrumbs");
  const breadcrumbs: SentryBreadcrumb[] = (crumbEntry?.data?.values ?? [])
    .map((b: any) => {
      let message: string | undefined = b.message ?? undefined;
      // Sentry `http` breadcrumbs carry the request in b.data (url/method/status_code),
      // NOT b.message — the old code read only b.message, so every http crumb rendered
      // as a blank "[info] http" line (they were the bulk of context.md). Surface the
      // request instead so the line actually says something.
      if (!message && b.data && (b.data.url || b.data.method || b.data.status_code != null)) {
        const method = b.data.method ? String(b.data.method) : "";
        const url = b.data.url ? String(b.data.url) : "";
        const status = b.data.status_code ?? b.data.statusCode;
        message = [method, url, status != null ? `→ ${status}` : ""].filter(Boolean).join(" ");
      }
      return {
        category: b.category,
        level: b.level,
        message,
        timestamp: b.timestamp ? String(b.timestamp) : undefined,
      };
    })
    // Drop breadcrumbs that still carry no text — pure noise for the investigate agent
    // (and wasted tokens). Cap AFTER filtering so the kept slots are real breadcrumbs.
    .filter((b: SentryBreadcrumb) => !!(b.message && b.message.trim()));

  return {
    id: String(raw.eventID ?? raw.id ?? ""),
    issueId,
    title: raw.title ?? raw.metadata?.value ?? raw.message,
    message: raw.message,
    level: tags.level ?? raw.level,
    timestamp: raw.dateCreated ?? raw.dateReceived,
    culprit: raw.culprit,
    permalink,
    tags,
    frames: frames.slice(0, MAX_FRAMES),
    breadcrumbs: breadcrumbs.slice(0, MAX_BREADCRUMBS),
  };
}

// -------------------------------------------------------------------------
// Retry (deterministically testable: sleep + shouldRetry injected)
// -------------------------------------------------------------------------
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    retries: number;
    sleep: (ms: number) => Promise<void>;
    shouldRetry: (err: unknown) => boolean;
    baseDelayMs?: number;
  },
): Promise<T> {
  const base = opts.baseDelayMs ?? 300;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= opts.retries || !opts.shouldRetry(err)) throw err;
      await opts.sleep(base * (attempt + 1));
    }
  }
}

// -------------------------------------------------------------------------
// Sentry fetch (HttpGet injected)
// -------------------------------------------------------------------------
async function fetchSentryProject(
  project: string,
  query: string,
  sentry: FetchConfig["sentry"],
  get: HttpGet,
): Promise<SentryContext> {
  // Over-fetch by one on each cap so we can distinguish "exactly the cap"
  // (complete — nothing dropped) from "more than the cap" (genuinely truncated);
  // a plain limit=cap cannot tell those apart. `truncated` reflects BOTH the
  // issue-count cap and the per-issue events cap, then we slice down to the caps.
  const issuesRaw = await get(
    `/api/0/projects/${sentry.org}/${project}/issues/` +
      `?query=${encodeURIComponent(query)}&statsPeriod=${sentry.statsPeriod}&limit=${sentry.maxIssues + 1}`,
  );
  const issues: any[] = Array.isArray(issuesRaw) ? issuesRaw : [];
  let truncated = issues.length > sentry.maxIssues;

  const events: SentryEvent[] = [];
  for (const issue of issues.slice(0, sentry.maxIssues)) {
    const evListRaw = await get(
      `/api/0/organizations/${sentry.org}/issues/${issue.id}/events/?limit=${sentry.maxEventsPerIssue + 1}`,
    );
    const evList: any[] = Array.isArray(evListRaw) ? evListRaw : [];
    if (evList.length > sentry.maxEventsPerIssue) truncated = true;
    for (const ev of evList.slice(0, sentry.maxEventsPerIssue)) {
      const eventId = ev.eventID ?? ev.id;
      const detail = await get(`/api/0/projects/${sentry.org}/${project}/events/${eventId}/`);
      events.push(normalizeSentryEvent(detail, String(issue.id), issue.permalink));
    }
  }
  return { project, query, events, truncated };
}

export async function fetchSentryForJob(
  id: string,
  cfg: FetchConfig,
  get: HttpGet,
): Promise<SentryContext[]> {
  const query = renderSentryQuery(cfg.sentry.queryTemplate, id);
  const out: SentryContext[] = [];
  // Sentry is best-effort context: a failing project must not kill the fetch.
  for (const project of cfg.sentry.projects) {
    try {
      out.push(await fetchSentryProject(project, query, cfg.sentry, get));
    } catch (err) {
      out.push({
        project,
        query,
        events: [],
        truncated: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

// -------------------------------------------------------------------------
// Real I/O builders (used when deps are not injected)
// -------------------------------------------------------------------------
class SentryHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "SentryHttpError";
  }
}

export function makeSentryGet(regionUrl: string, authToken: string): HttpGet {
  const base = regionUrl.replace(/\/+$/, "");
  return (path: string) =>
    withRetry(
      async () => {
        const res = await fetch(base + path, {
          headers: { Authorization: `Bearer ${authToken}`, Accept: "application/json" },
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          const hint =
            res.status === 401 || res.status === 403
              ? " — check SENTRY_AUTH_TOKEN has scopes event:read, project:read, org:read"
              : "";
          throw new SentryHttpError(
            res.status,
            `Sentry ${res.status} for ${path}${hint}: ${body.slice(0, 300)}`,
          );
        }
        return res.json();
      },
      {
        retries: 3,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        // Only transient failures are retried; auth/4xx fail fast.
        shouldRetry: (e) => e instanceof SentryHttpError && (e.status === 429 || e.status >= 500),
      },
    );
}

export function makeMongoFind(uri: string): MongoFind {
  return async (database: string, collection: string, id: string) => {
    // Lazy import so tests that inject mongoFind never load the driver.
    const { MongoClient, ObjectId } = await import("mongodb");
    const client = new MongoClient(uri);
    try {
      await client.connect();
      return await client.db(database).collection(collection).findOne({ _id: new ObjectId(id) });
    } finally {
      await client.close();
    }
  };
}

// Mirrors the Ariba scraper's UPLOAD_JOBS_AGGREGATION_PIPELINE (src/constants.ts):
// joins upload_jobs -> upload_invoice_schemas to assemble the FULL engine input. The
// `reproduce` step runs this from the pipeline (which owns the Mongo connection) and
// hands the scraper a complete, self-contained input, so the scraper never
// re-hydrates and needs no MongoDB of its own. Keep in sync with the scraper.
const REPRODUCE_INPUT_PIPELINE: any[] = [
  {
    $project: {
      _id: 0,
      engine: "uploadInvoice",
      portalName: "$portalUser.portal_name",
      uploadJob: { _id: "$_id" },
      portalUser: {
        _id: "$portalUser._id",
        name: "$portalUser.customer_name",
        rootUrl: "https://service.ariba.com",
        username: "$portalUser.username",
        password: "",
        totpUri: "$portalUser.totp_uri",
      },
      buyer: { _id: "$buyer._id", name: "$buyer.buyer_name" },
      purchaseOrder: {
        $cond: {
          if: {
            $and: [
              { $eq: [{ $type: "$jobPayload.contractInvoice" }, "object"] },
              { $gt: [{ $size: { $objectToArray: "$jobPayload.contractInvoice" } }, 0] },
            ],
          },
          then: "$$REMOVE",
          else: {
            _id: { $toString: "$portalPo._id" },
            portal_id: "$portalPo.id_on_portal",
            number: "$portalPo.po_number",
          },
        },
      },
      invoiceFormValues: "$jobPayload",
    },
  },
  { $lookup: { from: "upload_invoice_schemas", localField: "buyer._id", foreignField: "buyerId", as: "invoiceFormSchema" } },
  {
    $addFields: {
      "uploadJob._id": { $toString: "$uploadJob._id" },
      "portalUser._id": { $toString: "$portalUser._id" },
      "buyer._id": { $toString: "$buyer._id" },
      invoiceFormSchema: { $arrayElemAt: ["$invoiceFormSchema", 0] },
    },
  },
  { $addFields: { invoiceFormSchema: "$invoiceFormSchema.schema" } },
];

// Build the full self-contained scraper input for one job (or null if not found).
export async function buildReproduceInput(
  uri: string,
  database: string,
  collection: string,
  jobId: string,
): Promise<any | null> {
  const { MongoClient, ObjectId } = await import("mongodb");
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const docs = await client
      .db(database)
      .collection(collection)
      .aggregate([{ $match: { _id: new ObjectId(jobId) } }, ...REPRODUCE_INPUT_PIPELINE])
      .toArray();
    return docs[0] ?? null;
  } finally {
    await client.close();
  }
}

function requireEnv(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required for the fetch (set it in this repo's .env; see .env.example).`);
  }
  return value;
}

// -------------------------------------------------------------------------
// Sentry failure-artifact download (screenshot + page.html DOM snapshot on the event)
// -------------------------------------------------------------------------
// The scraper attaches "screenshot.png" AND "page.html" to the Sentry event on error
// (base-scraper captureExceptionWithScope). We fetch both with the SAME
// SENTRY_AUTH_TOKEN used for the events — no S3, no extra credentials.
export function makeSentryBinaryGet(regionUrl: string, authToken: string): SentryBinaryGet {
  const base = regionUrl.replace(/\/+$/, "");
  return async (path: string) => {
    const res = await fetch(base + path, { headers: { Authorization: `Bearer ${authToken}` } });
    if (!res.ok) throw new Error(`Sentry ${res.status} for ${path}`);
    return new Uint8Array(await res.arrayBuffer());
  };
}

// List the attachments on one event. Best-effort: returns [] on any failure.
export async function listEventAttachments(
  get: HttpGet,
  org: string,
  project: string,
  eventId: string,
): Promise<SentryAttachment[]> {
  try {
    const raw = await get(`/api/0/projects/${org}/${project}/events/${eventId}/attachments/`);
    if (!Array.isArray(raw)) return [];
    return raw.map((a: any) => ({
      eventId,
      attachmentId: String(a.id),
      name: String(a.name ?? ""),
      mimetype: a.mimetype,
      size: a.size,
    }));
  } catch {
    return [];
  }
}

// Download the failure artifacts the scraper attached to the job's Sentry events —
// the error "screenshot.png" AND the "page.html" DOM snapshot (base-scraper's
// captureExceptionWithScope attaches both, sentry.ts) — into <jobDir>/artifacts/. The
// HTML is the richer signal for selector/DOM bugs: it's the exact markup at failure
// time, which the investigate stage can Grep/Read. Best-effort: never throws;
// de-duplicates by attachment id and caps how many are pulled. Returns what to attach
// to JobContext.artifacts.
export async function downloadJobArtifacts(
  ctx: JobContext,
  cfg: FetchConfig,
  deps: { jsonGet: HttpGet; binGet: SentryBinaryGet },
  jobDir: string,
  max = 10,
): Promise<DownloadedArtifact[]> {
  const org = cfg.sentry.org;
  const events: Array<{ project: string; eventId: string }> = [];
  const seenEv = new Set<string>();
  for (const s of ctx.sentry) {
    for (const ev of s.events) {
      if (ev.id && !seenEv.has(ev.id)) {
        seenEv.add(ev.id);
        events.push({ project: s.project, eventId: ev.id });
      }
    }
  }
  const out: DownloadedArtifact[] = [];
  const seenAtt = new Set<string>();
  // Want the DOM snapshot + the screenshot. page.html is served as text/plain, so match
  // HTML by filename; images by filename or mimetype.
  const wanted = (a: SentryAttachment) =>
    /\.html?$/i.test(a.name) || /\.png$/i.test(a.name) || (a.mimetype ?? "").startsWith("image/");
  for (const { project, eventId } of events) {
    if (out.length >= max) break;
    const atts = await listEventAttachments(deps.jsonGet, org, project, eventId);
    for (const a of atts.filter(wanted)) {
      if (out.length >= max || seenAtt.has(a.attachmentId)) continue;
      seenAtt.add(a.attachmentId);
      mkdirSync(`${jobDir}/artifacts`, { recursive: true });
      const rel = `artifacts/${eventId}-${a.name || "attachment"}`;
      try {
        const bytes = await deps.binGet(
          `/api/0/projects/${org}/${project}/events/${eventId}/attachments/${a.attachmentId}/?download=1`,
        );
        writeFileSync(`${jobDir}/${rel}`, Buffer.from(bytes));
        out.push({ eventId, name: a.name, localPath: rel });
      } catch (err) {
        out.push({ eventId, name: a.name, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return out;
}

// -------------------------------------------------------------------------
// Orchestration
// -------------------------------------------------------------------------
export async function fetchUploadJobContext(
  id: string,
  cfg: FetchConfig,
  deps: FetchDeps = {},
): Promise<JobContext> {
  validateUploadJobId(id); // before any I/O

  const sentryGet =
    deps.sentryGet ?? makeSentryGet(cfg.sentry.regionUrl, requireEnv(deps.authToken, "SENTRY_AUTH_TOKEN"));
  const mongoFind = deps.mongoFind ?? makeMongoFind(requireEnv(deps.mongoUri, "MONGODB_URI"));

  const rawDoc = await mongoFind(cfg.mongo.database, cfg.mongo.collection, id);
  if (!rawDoc) {
    throw new Error(
      `No upload job found with _id ${id} in ${cfg.mongo.database}.${cfg.mongo.collection}.`,
    );
  }

  const mongo = curateJob(rawDoc);
  const sentry = await fetchSentryForJob(id, cfg, sentryGet);

  return { uploadJobId: id, fetchedAtIso: new Date().toISOString(), mongo, sentry };
}

// -------------------------------------------------------------------------
// Rendering + artifact writing
// -------------------------------------------------------------------------
export function renderContextMarkdown(ctx: JobContext): string {
  const L: string[] = [];
  L.push(`# Debug context — upload job ${ctx.uploadJobId}`);
  L.push("");
  L.push(`_Fetched ${ctx.fetchedAtIso}_`);
  L.push("");

  L.push("## Upload job (MongoDB)");
  const m = ctx.mongo;
  if (!m) {
    L.push("");
    L.push("_Job document not found._");
  } else {
    L.push("");
    L.push(`- **Status:** ${m.status ?? "(unknown)"}`);
    L.push(`- **Portal:** ${m.portalName ?? "(unknown)"} · **Customer:** ${m.customerName ?? "(unknown)"}`);
    if (m.buyerId)
      L.push(`- **Buyer id:** \`${m.buyerId}\` (key for \`upload_invoice_schemas\` + \`upload_jobs\` history lookups)`);
    if (m.jobPayloadFields?.length)
      L.push(`- **Payload fields** (\`jobPayload\` keys): ${m.jobPayloadFields.map((k) => `\`${k}\``).join(", ")}`);
    L.push(`- **AI:** ${m.ai ?? "?"} · **Auto-launch:** ${m.autoLaunch ?? "?"}`);
    L.push(`- **Timing:** created ${m.createdAt ?? "?"} · started ${m.startedAt ?? "?"} · finished ${m.finishedAt ?? "?"}`);
    if (m.sfExecutionArn) L.push(`- **sfExecutionArn:** \`${m.sfExecutionArn}\``);
    if (m.lambdaInvokeId) L.push(`- **lambdaInvokeId:** \`${m.lambdaInvokeId}\``);
    if (m.errorMessage) L.push(`- **Error:** ${m.errorMessage}`);
    if (m.errorDetail) L.push(`- **Error detail:** ${m.errorDetail}`);
    if (m.lastErrorClassification)
      L.push(`- **Last error classification:** \`${JSON.stringify(m.lastErrorClassification)}\``);
    if (m.aiResult) {
      L.push("");
      L.push("### AI result");
      L.push(`- status: ${m.aiResult.status ?? "?"} · login: ${m.aiResult.loginStatus ?? "?"}`);
      for (const r of m.aiResult.uploadInvoiceResults ?? []) {
        L.push(`  - invoice ${r.invoiceId ?? "?"}: ${r.status ?? "?"}${r.errorMessage ? ` — ${r.errorMessage}` : ""}`);
      }
    }
  }

  // Failure artifacts: the screenshot(s) + page.html DOM snapshot(s) attached to the
  // job's Sentry events, downloaded into artifacts/ so the investigate agent can open
  // the PNG or Grep/Read the HTML.
  const arts = ctx.artifacts ?? [];
  if (arts.length) {
    L.push("");
    L.push("## Failure artifacts (from Sentry)");
    L.push("");
    for (const a of arts) {
      if (a.localPath) L.push(`- **${a.name}** — \`${a.localPath}\` (event ${a.eventId})`);
      else L.push(`- **${a.name}** — download failed${a.error ? ` (${a.error})` : ""} (event ${a.eventId})`);
    }
  }

  L.push("");
  L.push("## Sentry");
  for (const s of ctx.sentry) {
    L.push("");
    L.push(`### Project \`${s.project}\` (query: \`${s.query}\`)`);
    if (s.error) {
      L.push(`_Fetch error: ${s.error}_`);
      continue;
    }
    if (!s.events.length) {
      L.push("_No matching Sentry events._");
      continue;
    }
    if (s.truncated) L.push("_(results truncated to configured caps)_");
    for (const ev of s.events) {
      L.push("");
      L.push(`#### ${ev.title ?? "(no title)"} \`${ev.level ?? "?"}\``);
      L.push(`- event ${ev.id} · issue ${ev.issueId} · ${ev.timestamp ?? "?"}`);
      if (ev.permalink) L.push(`- ${ev.permalink}`);
      if (ev.culprit) L.push(`- culprit: \`${ev.culprit}\``);
      const tagKeys = Object.keys(ev.tags);
      if (tagKeys.length) L.push(`- tags: ${tagKeys.map((k) => `${k}=${ev.tags[k]}`).join(", ")}`);
      if (ev.frames.length) {
        L.push("- stack:");
        L.push("  ```");
        for (const f of ev.frames) {
          L.push(`  at ${f.function ?? "?"} (${f.filename ?? "?"}:${f.lineNo ?? "?"})${f.contextLine ? `  | ${f.contextLine}` : ""}`);
        }
        L.push("  ```");
      }
      if (ev.breadcrumbs.length) {
        L.push("- breadcrumbs:");
        for (const b of ev.breadcrumbs) {
          L.push(`  - [${b.level ?? "?"}] ${b.category ?? ""} ${b.message ?? ""}`.trimEnd());
        }
      }
    }
  }
  L.push("");
  return L.join("\n");
}

export function writeContextArtifacts(
  ctx: JobContext,
  outDir = "context",
): { mdPath: string; jsonPath: string } {
  // One folder per upload job, named by its id, holding both artifacts — keeps a
  // job's context self-contained and the context/ root uncluttered. The two files
  // still each combine Mongo + Sentry (source split by section/key, not by file).
  const dir = `${outDir}/${ctx.uploadJobId}`;
  mkdirSync(dir, { recursive: true });
  const jsonPath = `${dir}/context.json`;
  const mdPath = `${dir}/context.md`;
  writeFileSync(jsonPath, JSON.stringify(ctx, null, 2));
  writeFileSync(mdPath, renderContextMarkdown(ctx));
  return { mdPath, jsonPath };
}
