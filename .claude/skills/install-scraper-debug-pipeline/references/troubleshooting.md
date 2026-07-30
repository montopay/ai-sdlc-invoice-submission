# Troubleshooting

Match the developer's actual error to a row before guessing. Each entry is
symptom → why → fix.

## Scraper `npm install` fails with `EBADENGINE`

**Why:** the scraper's `.npmrc` sets `engine-strict=true` and it pins
`node >=22 <23`, so npm refuses to install on Node 23/24.
**Fix:** switch to Node 22 (`nvm use 22`, confirm `node -v` → `v22.x`), then
reinstall. Use Node 22 for the pipeline too, so there's nothing to switch back.

## A stage hangs, or errors with `claude: command not found`

**Why:** the orchestrator invokes the `claude` CLI headlessly for every agent
stage. If it isn't installed, on `PATH`, or authenticated, stages can't run.
**Fix:** install Claude Code, confirm `claude --version` (PowerShell:
`where.exe claude`), and run `claude` once interactively to log in. This is the
developer's to do — don't attempt to authenticate for them.

## `reproduce` exits: "needs a TTY for the portal password"

**Why:** `reproduce` prompts for the portal password strictly over the terminal
(never file-channelled) and opens a **headed** browser.
**Fix:** run it from a real interactive terminal on a machine with a display —
not from a dashboard-triggered pause and not headless. In the connected
`reproduce` stage a decline/failure never blocks the pipeline.

## Something already bound `port 3000`

**Why:** the scraper's `PlaywrightMCPServer` binds `3000` during a run.
**Fix:** stop whatever is using 3000 (a stray dev server, a previous run) before
reproducing. On Windows: `netstat -ano | findstr :3000` to find the PID, then
stop it.

## Learning loop logs: "KB repo … has uncommitted changes"

**Why:** the curator creates a `kb/<jobId>` branch and commits onto it, so it
refuses to operate on a dirty KB working tree (it would entangle the developer's
edits). It's a clean skip, not a failure.
**Fix:** `cd` into `Scrapers/scraper-knowledge-base`, commit or stash the pending
changes, then re-run. The retrospector still runs; only the curator is gated.

## Startup error: missing MCP credential

**Why:** a stage enables MCP but a `${ENV}` required by `mcp.json` is unset. The
orchestrator fails fast on purpose rather than letting an agent run half-blind.
**Fix:** set the named variable in the pipeline `.env` (today: `MONGODB_URI`).

## An OAuth / claude.ai / Desktop connector "isn't available" in a run

**Why:** OAuth-brokered connectors can't be exported to a token and don't survive
the pipeline's headless `--strict-mcp-config` runs, which ignore desktop/user/
claude.ai connectors for reproducibility.
**Fix:** define a token-authenticated server in `mcp.json` with its credential in
`.env` instead.

## `fetch` errors on credentials

**Why:** `MONGODB_URI` or `SENTRY_AUTH_TOKEN` is missing/wrong, or the Sentry
token is the wrong type (an Org token `sntryo_…` lacks `event:read`).
**Fix:** re-check both in the pipeline `.env` against
[credentials.md](credentials.md); use a User Auth Token (`sntryu_…`) with
`event:read`, `project:read`, `org:read`.
