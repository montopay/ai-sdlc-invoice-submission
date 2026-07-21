# Design: Pre-fetch debugging context for invoice-submission jobs

- **Date:** 2026-07-20
- **Author:** ayalon@montopay.com
- **Status:** Approved for planning
- **Repo:** `ai-sdlc-invoice-submission` (the AI-SDLC pipeline template)

## Goal

Repurpose the pipeline to investigate failed invoice submissions. Given an
**upload job id**, deterministically fetch all of that job's debugging context —
its MongoDB `upload_jobs` document **plus** its matching Sentry events — and
write it to a local artifact that a later phase will inject into stage prompts.

**This spec covers the FETCH + ARTIFACT only.** Re-roling the agents, injecting
the artifact into `buildPrompt`, and auto-running the fetch inside `run` are
explicitly deferred to later phases (see [Out of scope](#out-of-scope)).

## Scope

**In scope**
- A new deterministic module that connects to Sentry (REST API) and Mongo
  (driver) and pulls context for one upload job id.
- A standalone CLI command to run the fetch in isolation.
- Config additions (`sdlc.config.json` `fetch` block) and a new secret
  (`SENTRY_AUTH_TOKEN`); reuse the existing `MONGODB_URI`.
- A fail-fast preflight for the fetch's credentials.
- The written artifact (`context/<id>.md` + `context/<id>.json`).
- Unit tests for the data normalizers (fixture-driven, no live calls).

**Out of scope (later phases)**
- Changing agent roles / stage order for debugging.
- Injecting the artifact into stage prompts (`buildPrompt`, run.ts ~line 206).
- Auto-invoking the fetch at the start of `npm run sdlc run`.
- Downloading Sentry error screenshots / videos or S3 attachments.

## Background

The pipeline (`pipeline/run.ts`) drives a ticket through stages via headless
Claude Code agents, with deterministic gates. MCP access is per-stage and only
applies to **agents** (the spawned CLI connects to servers listed in
`mcp.json`). The pre-fetch here is **not** an agent — it is deterministic
orchestrator code that runs before the pipeline — so it does not use MCP; it
calls Sentry and Mongo directly.

Concrete environment (discovered, not assumed):
- **Sentry org slug:** `monto-e1c13a9a2`; **region URL:** `https://us.sentry.io`
- **Sentry project (invoice submission):** `upload-invoice`
- **Mongo:** database `MontoProd`, collection `upload_jobs`
- The upload job `_id` is expected to appear in Sentry events (as a tag or in
  the message); the exact tag key is not yet confirmed, so the query is a
  configurable template defaulting to free-text.

## Connection design

### Sentry — token-authenticated REST API

The OAuth Sentry connector cannot run headless (per `CLAUDE.md`), so we use the
REST API directly with a bearer token.

- **Auth:** `Authorization: Bearer ${SENTRY_AUTH_TOKEN}`
- **Token type:** a **User Auth Token** (`sntryu_…`) or **Internal Integration**
  token (`sntrys_…`) with scopes **`event:read`, `project:read`, `org:read`**.
  (Organization Auth Tokens `sntryo_…` are for CI/releases and lack
  `event:read` — do not use.)
- **Endpoints (Sentry Cloud, us region):**
  - Search matching issues in a project:
    `GET {regionUrl}/api/0/projects/{org}/{project}/issues/?query={q}&statsPeriod={period}&limit={maxIssues}`
  - List events for an issue:
    `GET {regionUrl}/api/0/organizations/{org}/issues/{issueId}/events/?limit={maxEventsPerIssue}`
  - Full event detail (stacktrace/breadcrumbs/tags/contexts) for an event:
    `GET {regionUrl}/api/0/projects/{org}/{project}/events/{eventId}/`
- **Query:** `queryTemplate` with `{id}` substituted. Confirmed live: the job id
  is carried on upload-invoice events as the Sentry tag `uploadJobId`, so the
  template is `"uploadJobId:{id}"` (free-text `"{id}"` does NOT match — the id is
  a tag value, not in the message). Tunable in config with no code change.
- **statsPeriod:** the issues endpoint accepts ONLY `''`, `'24h'`, or `'14d'`
  (Sentry limitation; `'90d'` returns HTTP 400). Default `'14d'`.

### Mongo — official driver, read-only

- **Credential:** reuse the existing connection string as `MONGODB_URI` (same
  value the connected Mongo MCP uses). No new "token" — Mongo authenticates via
  the connection string. Prefer a **read-only** user / `readPreference=secondary`.
- **Driver:** add the `mongodb` npm package (the pipeline currently has zero
  runtime deps). Operation is a single `db(database).collection(collection)
  .findOne({ _id: new ObjectId(uploadJobId) })`, then close the client.

## Inputs

- `uploadJobId: string` — a Mongo `ObjectId` hex string, passed on the CLI.
  Validated as a 24-char hex; invalid → hard fail before any network call.

## Module layout

New file: `pipeline/fetch-context.ts`. No changes to `callAgent`, `mcpForStage`,
or stage runners in this phase.

Exported surface (names indicative):

```ts
type FetchConfig = {
  sentry: {
    org: string; regionUrl: string; projects: string[];
    queryTemplate: string; statsPeriod: string;
    maxIssues: number; maxEventsPerIssue: number;
  };
  mongo: { database: string; collection: string };
};

type CuratedJob = { /* curated upload_jobs subset, see below */ };
type SentryEvent = {
  id: string; issueId: string; title: string; level: string;
  timestamp: string; culprit: string; permalink: string;
  tags: Record<string, string>;
  stacktrace?: unknown;      // normalized exception frames
  breadcrumbs?: unknown[];
};
type JobContext = { uploadJobId: string; mongo: CuratedJob | null;
                    sentry: { query: string; events: SentryEvent[]; truncated: boolean }; };

async function fetchMongoJob(id: string, cfg: FetchConfig): Promise<CuratedJob | null>;
async function fetchSentryForJob(id: string, cfg: FetchConfig): Promise<SentryEvent[]>;
async function fetchUploadJobContext(id: string, cfg: FetchConfig): Promise<JobContext>;
function renderContextMarkdown(ctx: JobContext): string;
function writeContextArtifacts(ctx: JobContext): { mdPath: string; jsonPath: string };
```

A new `fetch` branch is added to the CLI command switch in `run.ts` `main()`
(alongside `run`), calling `fetchUploadJobContext` → `writeContextArtifacts`.

## Data flow

1. Parse + validate `uploadJobId`.
2. **Preflight:** if `config.fetch` is present, require `SENTRY_AUTH_TOKEN` and
   `MONGODB_URI` in the environment (after `loadEnvFile(".env")`); missing →
   fail fast with a clear message (mirrors the existing MCP credential check).
3. **Mongo:** `findOne({_id})` → curate fields → `CuratedJob` (or `null` if not
   found; not-found is a hard fail — you can't debug a job that doesn't exist).
4. **Sentry:** render query from `queryTemplate`; for each configured project,
   search issues → for each issue, list events (capped) → fetch full event
   detail → normalize. Aggregate, cap total, set `truncated`.
5. **Write:** `context/<id>.json` (raw normalized `JobContext`) and
   `context/<id>.md` (human-readable, injection-ready).

## Curated Mongo fields

From `MontoProd.upload_jobs`, keep only debugging-relevant fields; drop heavy
payloads (`draftPayload`, full `jobPayload.lineItems`, full `buyer`/`po`/
`portalPo` blobs) to keep the artifact small:

- Identity/status: `_id`, `status`, `createdAt`, `startedAt`, `finishedAt`,
  `portalName`, `customerName`, `ai`, `autoLaunch`
- Correlation ids: `sfExecutionArn`, `lambdaInvokeId`
- Errors: `errorMessage` (string or `{message}`), `error.message`,
  `lastErrorClassification` (category/severity/description/isRetryable/…),
  `lastErrorScreenshot` (bucket/key only)
- AI results: `aiResults.body.result.status`, `.loginResult.status`, and
  `.uploadInvoiceResults[]` → `{invoiceId, status, errorMessage,
  errorScreenshotUrl, errorClassification}`
- Media references (keys only, not downloaded): `screenshots[].{bucket,key}`,
  `videos[].{bucket,key}`

## Sentry normalization

Per event keep: `id`, `issueId`, `title`, `level`, `timestamp`, `culprit`,
`permalink`, a flattened `tags` map, the exception/stacktrace entry (frames:
filename, function, lineNo, context), and breadcrumbs. Cap frame/breadcrumb
counts to keep size sane.

## Config schema (`sdlc.config.json`)

Add an optional top-level `fetch` block (its own concern, separate from `mcp`):

```json
"fetch": {
  "sentry": {
    "org": "monto-e1c13a9a2",
    "regionUrl": "https://us.sentry.io",
    "projects": ["upload-invoice"],
    "queryTemplate": "uploadJobId:{id}",
    "statsPeriod": "14d",
    "maxIssues": 25,
    "maxEventsPerIssue": 5
  },
  "mongo": { "database": "MontoProd", "collection": "upload_jobs" }
}
```

The `Config` type in `run.ts` gains an optional `fetch?: FetchConfig`.

## Secrets & environment

`.env.example` (and each user's gitignored `.env`) gains:

```
# Sentry API token (User Auth Token sntryu_… or Internal Integration sntrys_…)
# with scopes: event:read, project:read, org:read
SENTRY_AUTH_TOKEN=

# Existing — reuse your read-only connection string
MONGODB_URI=
```

`SENTRY_AUTH_TOKEN` is read by the fetch module directly (not via `mcp.json`
`${ENV}` substitution), so the preflight for it is fetch-specific, not the
existing `requiredMcpEnvVars` path.

## CLI

New standalone command so the fetch can be iterated in isolation:

```
npm run sdlc fetch <uploadJobId>
```

Writes `context/<uploadJobId>.md` + `.json` and prints the two paths. Later
phases will call the same function automatically at the start of `run`.

## Error handling

- Invalid `uploadJobId` (not 24-hex) → fail before any I/O.
- Missing `SENTRY_AUTH_TOKEN` / `MONGODB_URI` → fail fast at preflight.
- Mongo job not found → hard fail with the id echoed.
- Sentry `401`/`403` → message: check token type + `event:read` scope.
- Sentry `429` / transient `5xx` → bounded retry with backoff, then continue
  with whatever was gathered (Sentry is best-effort context).
- **Zero** matching Sentry events → NOT a failure; artifact records "no matching
  Sentry events" and the Mongo doc alone is written.
- Result caps hit → artifact notes `truncated: true`.

## Security & data sensitivity

The artifact contains **real customer invoice data and stack traces**. It stays
local and is **gitignored**. Add to `.gitignore`:

```
/context/*
!/context/.gitkeep
```

Never log the full connection string or token. Prefer a read-only Mongo user.

## Testing

- **Unit (primary):** fixture-driven tests for `curate(upload_jobs doc)` and
  `normalize(sentry event json)` — given a sample document / API payload, assert
  the curated/normalized output. No network. Fixtures live under
  `pipeline/__fixtures__/`.
- **Rendering:** `renderContextMarkdown` snapshot on a fixture `JobContext`.
- **Manual smoke:** `npm run sdlc fetch <realFailedJobId>` against a known
  failed job; eyeball `context/<id>.md`.

## Out of scope

Deferred to subsequent specs/phases:
1. Inject the artifact into stage prompts — new section in `buildPrompt`
   (`run.ts` between the KB index ~line 206 and the input ~line 208).
2. Auto-run the fetch at the start of `run` (before the stage loop, ~line 1701),
   extending the main preflight to require the fetch credentials there too.
3. Re-role/re-order agents for debugging (`agents/*.md`, `STAGE_ORDER`,
   `sdlc.config.json` stages).
4. Optionally resolve/download Sentry screenshots and S3 media.

## Open items to tune after first real run

- ~~Confirm the Sentry tag key for the job id~~ — DONE (live): tag is
  `uploadJobId`; `queryTemplate` is `"uploadJobId:{id}"`.
- Confirm `statsPeriod` covers the jobs you investigate (Sentry event retention
  is typically 90 days).
- Decide whether `ai-upload` / `automations` projects should join `projects`.
