# Credentials

Four secrets across two gitignored `.env` files. Never commit them, never print
their values, and never ask the developer to paste them into chat — open the
`.env` in their editor and let them type each value in themselves. A **read-only**
Mongo user is strongly recommended: the pipeline only ever reads production data.

| Credential | Lives in | Used for | How to get it |
|---|---|---|---|
| `MONGODB_URI` | pipeline `.env` | `fetch` reads the `upload_jobs` doc; the read-only MongoDB MCP server | An Atlas **read-only** user. Form: `mongodb+srv://<user>:<pass>@<cluster>/<db>?readPreference=secondary` |
| `SENTRY_AUTH_TOKEN` | pipeline `.env` | `fetch`'s Sentry REST calls + downloading the error `screenshot.png` and `page.html` from the event | A Sentry **User Auth Token** (`sntryu_…`) with scopes `event:read`, `project:read`, `org:read`. An Internal Integration token (`sntrys_…`) also works. Do **not** use an Org Auth Token (`sntryo_…`) — it lacks `event:read`. |
| `NPM_TOKEN` | shell env at scraper install time | Authenticating npm to GitHub Packages for `@montopay/base-scraper` | A GitHub **Personal Access Token** with the `read:packages` scope. The scraper's `.npmrc` reads `${NPM_TOKEN}`. |
| `ANTHROPIC_API_KEY` | scraper `.env` | The scraper's built-in Haiku validation agent during `reproduce` | The Anthropic Console (console.anthropic.com). Only needed for `reproduce`. |

## Which file gets what

- **Pipeline `.env`** (`ai-sdlc-invoice-submission/.env`): `MONGODB_URI`,
  `SENTRY_AUTH_TOKEN`. This is all the *core* pipeline (`fetch` / `debug`) needs.
- **Scraper `.env`** (`Scrapers/ariba-scraper-main/.env`): `ANTHROPIC_API_KEY`,
  and `HEADED="true"` (already in the example). Leave `MONGODB_URI` empty here —
  `reproduce` passes a self-contained input and runs the scraper with no DB of
  its own.
- **`NPM_TOKEN`** is not a `.env` value the pipeline reads — it's a shell
  environment variable present *at install time* so `npm install` in the scraper
  can pull the private package.

## MCP note

If a stage enables MCP (see `sdlc.config.json` → `mcp`), every `${ENV}`
placeholder in `mcp.json` must be set before a run, or the orchestrator fails
fast at startup naming the missing variable. Today that's `MONGODB_URI` (the
read-only MongoDB server). OAuth-brokered connectors (Sentry/Datadog connected
through the Claude Desktop or claude.ai UI) do **not** work here — they can't be
exported to a token and don't survive the headless `--strict-mcp-config` runs.
Use token-authenticated servers with credentials from `.env`.
