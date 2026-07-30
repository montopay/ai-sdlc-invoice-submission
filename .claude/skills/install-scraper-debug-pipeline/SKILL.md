---
name: install-scraper-debug-pipeline
description: >-
  Step-by-step setup of the AI-SDLC scraper-debugging pipeline (the
  `ai-sdlc-invoice-submission` repo) on a developer's own machine — the three
  sibling repos, Node 22, the `claude` CLI, the four credentials, config, a
  verify pass, and the first run. Use this whenever someone wants to install,
  set up, onboard to, or "get started with" the invoice-upload / scraper-
  debugging / AI-SDLC pipeline; when they hit setup errors like EBADENGINE or a
  missing/unauthenticated `claude` CLI; or when they ask how to get
  `npm run sdlc debug` / `fetch` / `reproduce` running — even if they don't name
  the repo exactly.
---

# Install the AI-SDLC scraper-debugging pipeline

You are setting up this pipeline on a developer's own computer. The pipeline
turns a failed production invoice-upload job into a diagnosed, fixable ticket
(`fetch → reproduce → investigate → spec → implement → review → learn`). Getting
it running means wiring up **three sibling repos**, four credentials, and the
`claude` CLI.

Your job is to *drive* the install: run each command in the developer's shell,
confirm it worked before moving on, and pause only for the things you cannot or
must not do yourself (see below). Don't just print the guide and walk away — a
new teammate is relying on you to actually get them to a green first run.

## Operating principles

- **Verify before advancing.** After each step, check the exit code / output and
  confirm the expected result before starting the next. A silent failure early
  (wrong Node, missing token) causes a confusing error three steps later.
- **Never handle secrets directly.** Do not ask the developer to paste tokens
  into the chat, and never print the contents of a `.env` or a token value. When
  a step needs a secret, open the `.env` in their editor and let *them* type it
  in, or have them set an environment variable themselves. You guide; they enter.
- **Confirm before anything irreversible.** Before overwriting an existing
  `.env`, cloning over a non-empty directory, or running `git init` in a folder,
  check what's already there and ask. Installs and read-only commands can proceed
  without asking.
- **Windows-first, cross-platform.** This is usually run on Windows with both
  PowerShell and Git Bash available. Command blocks below give the POSIX form;
  PowerShell equivalents are noted where they differ. Detect the shell and use
  the right one rather than assuming.
- **Meet them where they are.** Some developers know npm and nvm cold; others
  are new. Watch the cues and explain a step briefly when it seems needed,
  without over-explaining to someone who clearly knows.

## Step 0 — Preflight (check prerequisites first)

Run these read-only checks and read the results before touching anything. Fixing
a missing prerequisite now is far cheaper than a cryptic failure mid-install.

```bash
node -v          # need v22.x  (the scraper is engine-strict: node >=22 <23)
git --version    # any recent Git
claude --version # the Claude Code CLI must be installed AND on PATH
python --version # optional — only for the KB's okf_lint.py health check
```

PowerShell: `where.exe claude` (instead of `which claude`) to confirm it's on PATH.

- **Node is not 22.x** → the scraper's `npm install` will fail with `EBADENGINE`.
  Get them on Node 22 before continuing (`nvm install 22 && nvm use 22`;
  Windows uses `nvm-windows`). Node 22 runs the pipeline fine too, so use it for
  everything.
- **`claude` missing or not found** → the pipeline shells out to it for *every*
  agent stage, so nothing works without it. Have them install Claude Code and run
  `claude` once interactively to authenticate — this is theirs to do, not yours.
- **Python missing** → fine; it's only for the optional KB lint. Note it and move on.

## Step 1 — Get the three repos (sibling layout)

The pipeline finds the other two repos by **relative** paths in
`sdlc.config.json` (`../Scrapers/...`), so the layout matters:

```
Monto/
├── ai-sdlc-invoice-submission/      # the pipeline — you run commands here
└── Scrapers/
    ├── ariba-scraper-main/          # productPath  — fixes land on feature/<jobId>
    └── scraper-knowledge-base/      # knowledgePath → its wiki/ subfolder
```

Clone all three into that structure (use the developer's own remotes/org):

```bash
git clone <pipeline-remote> ai-sdlc-invoice-submission
git clone <scraper-remote>  Scrapers/ariba-scraper-main
git clone <kb-remote>       Scrapers/scraper-knowledge-base
```

All three must be **git repos**: the pipeline branches the scraper per job
(`feature/<jobId>`), and the curator commits KB proposals onto a `kb/<jobId>`
branch. If a scraper arrived as a zip rather than a clone, initialize it:
`git init && git add -A && git commit -m "baseline"`. If a target directory
already exists and is non-empty, stop and ask before cloning over it.

## Step 2 — Node 22, then install the pipeline

```bash
nvm use 22           # confirm: node -v  → v22.x
cd ai-sdlc-invoice-submission
npm install
```

The pipeline is TypeScript run via `tsx`; there's nothing exotic here.

## Step 3 — Install the scraper

The scraper depends on the private `@montopay/base-scraper` package from GitHub
Packages, so npm needs a token to authenticate to `npm.pkg.github.com` (the
repo's `.npmrc` reads it). Have the developer provide their own token — do not
supply or echo one.

```bash
export NPM_TOKEN=<github PAT with read:packages>   # PowerShell: $env:NPM_TOKEN="..."
cd ../Scrapers/ariba-scraper-main
npm install                                         # must be on Node 22
```

If `node_modules` already exists here you can skip this — the implement stage's
`tsc --noEmit` gate only runs when it's present, so the core flow doesn't require
the scraper install. It IS required for `reproduce` (running the real scraper).

## Step 4 — Credentials

Two gitignored `.env` files. Copy each `.env.example`, then have the developer
fill in their **own** values — see [references/credentials.md](references/credentials.md)
for exactly what each credential is, where it goes, and how to obtain it.

```bash
# pipeline repo
cp .env.example .env               # then let the developer edit it
# scraper repo
cp ../Scrapers/ariba-scraper-main/.env.example ../Scrapers/ariba-scraper-main/.env
```

Before copying, check whether a `.env` already exists — don't clobber one that
may hold working credentials; ask first.

## Step 5 — Point the pipeline at the repos

Confirm the two paths in `sdlc.config.json` resolve to the developer's scraper
and KB (already set for Ariba). Note `knowledgePath` points at the KB's `wiki/`
subfolder, not its root:

```json
"project": {
  "productPath":   "../Scrapers/ariba-scraper-main",
  "knowledgePath": "../Scrapers/scraper-knowledge-base/wiki"
}
```

The per-stage autonomy dial, the `learning` toggle, and optional `mcp` wiring
also live in this file; the defaults are already set for the debugging flow.

## Step 6 — Verify the install

Run these from the pipeline repo. `fetch` is read-only, needs no scraper, and
writes nothing but a local `context/` folder, so it's a safe end-to-end check
that the Mongo + Sentry credentials actually work:

```bash
npm run build                     # tsc — expect exit 0
npm test                          # pipeline unit tests
npm run sdlc fetch <uploadJobId>  # pulls Mongo + Sentry → context/<id>/
python ../Scrapers/scraper-knowledge-base/scripts/okf_lint.py   # optional
```

Good signs: `fetch` prints `Artifacts: N/N (screenshot + page.html) from Sentry`
and writes `context/<id>/context.md`; the lint reports `0 errors / 0 broken
links`. If `fetch` errors on credentials, revisit Step 4 before going further.

## Step 7 — First run

`debug` fetches the job then walks the pipeline. Start the dashboard in a second
terminal to watch it live:

```bash
npm run sdlc debug <uploadJobId>   # fetch + full pipeline
npm run dashboard                  # second terminal — live view
```

`reproduce` (optional) runs the real scraper headed against the live portal to
reproduce a failure or validate a fix:

```bash
npm run sdlc reproduce <uploadJobId>
```

It needs a **real interactive terminal** (it prompts for the portal password)
and opens a **headed browser**, so it must run locally, not headless. It never
submits a live invoice — draft-only. If it can't run in the current context, say
so rather than forcing it.

## When something breaks

Consult [references/troubleshooting.md](references/troubleshooting.md) — it maps
each common symptom (`EBADENGINE`, missing `claude`, the `reproduce` TTY
requirement, port 3000, a skipped curator, missing MCP creds, OAuth connectors)
to its cause and fix. Match the developer's error to a row before guessing.

## Done

The developer is set up once `npm run sdlc fetch <jobId>` succeeds and a
`debug` run reaches the investigate stage. Point them at the pipeline's
`PLAN.md` and the KB (`Scrapers/scraper-knowledge-base/wiki/adlc/`) to learn the
flow itself.
