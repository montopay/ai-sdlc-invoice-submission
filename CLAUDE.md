# CLAUDE.md

<!--
WHAT THIS FILE IS:
Instructions for a Claude Code session working ON this repo — the pipeline
itself. NOTE: this file is NOT injected into stage-agent prompts. Stage
agents run with their cwd set to the PRODUCT repo and are given the
PRODUCT's own CLAUDE.md (see buildPrompt in pipeline/run.ts); the role
prompts in agents/*.md are deliberately product-agnostic. So keep this file
about the pipeline, not about any product it happens to be pointed at.
-->

## What this repo is

An AI-SDLC pipeline: an orchestrator (`pipeline/run.ts`) that drives a
feature ticket through stages, each run by a headless Claude Code agent,
with deterministic gates between the model and the pipeline proceeding.

This repo is a TEMPLATE you fork per project. It contains ZERO product code
and hardcodes no toolchain. You point it at a product by setting two paths
in `sdlc.config.json`:

- `project.productPath` — the product repo the pipeline operates on. Agents
  that touch code (implement, test) run with their cwd here, on an isolated
  `feature/<ticketId>` branch, never on the product's main.
- `project.knowledgePath` — a knowledge repo (validated to exist today;
  written to in a later step).

The product describes how IT builds and tests via its own
`.sdlc/product.json` (component `check` commands, an `e2e.run` command, and
`e2e.testDir`). The pipeline reads that descriptor and never assumes a
stack.

## Stack (of the pipeline itself)

- TypeScript, run via `tsx` — `npm run sdlc run <ticketId> [stageName]`.
- Node only, no framework. Gates are plain scripts (`pipeline/gates.ts`).
- Windows-first: the claude/npm shims are `.cmd`, launched via `shell: true`
  with a pre-built command string (not an args array — avoids DEP0190);
  process trees are killed with `taskkill /T`. Preserve these when editing
  `callAgent`/`ensureBranch`/`runCommand`. Any new `claude` CLI flag (e.g.
  `--add-dir`, `--mcp-config`) must be woven into the `args` array *before* the
  win32/POSIX fork in `callAgent`, so `quoteCommandLine` quotes it (spaces-safe).

## Stages

`parse -> spec -> implement -> review -> test -> qa` (deploy is a later,
deterministic step, not a stage). Order and the auto-resume logic both walk
`STAGE_ORDER` in `run.ts`. Per-stage autonomy is set in `sdlc.config.json`
(see its `_comment`). Each stage's role prompt is in `agents/<stage>.md`.

- **parse** — turns a fuzzy request into tasks + acceptance criteria, each
  with a stable `AC-N` ID. Appends to `tickets/<id>.md`.
- **spec** — turns the criteria into a technical spec, carrying the `AC-N`
  IDs forward. Writes `specs/<id>.md`.
- **implement** — writes real code in the product repo. Gated by the
  product's deterministic `check` (syntax only). Self-corrects against
  syntax up to a cap.
- **review** — empirical fix verification. The orchestrator RE-RUNS the
  reproduction against the fix (implement left it on `feature/<id>`; the scraper
  runs from source via `reproduce.cwd == productPath`, no build) and an agent
  judges the outcome, writing `reviews/<id>.md` led by `Verdict: FIXED |
  NOT-FIXED | INCONCLUSIVE`. A hard gate, `checkVerification`, reads only that
  verdict: FIXED passes; NOT-FIXED belts back to implement (bounded, then a
  human) with the verdict as the fix brief; INCONCLUSIVE (the reproduction
  couldn't confirm — a setup crash, or a prod-only failure) stops for a human.
  Needs the portal password (reused in-memory from the reproduce stage).
- **test** — writes E2E scenarios in the product repo, each tagged
  `// COVERS: AC-N`.
- **qa** — the authoritative gate, now fully deterministic (no agent). The
  orchestrator writes a `qa/<id>.md` summary, then `runQaGate` decides: the
  full E2E suite, plus `checkCoverage` (every `AC-N` needs a live covering
  test) *only when the `test` stage is enabled* — with `test` off, QA gates on
  E2E alone.

## Conventions

- **Files are the handoff protocol.** Process artifacts — `tickets/`,
  `specs/`, `reviews/`, `qa/` — live in THIS repo. Code and tests live in
  the product repo, on the feature branch.
- **Model proposes, script decides.** Agents never gate themselves: the
  orchestrator runs the checks (agents have no Bash access at all, since
  Claude Code's sandbox can silently block a tool call). The review agent can't
  run the reproduction either — the orchestrator runs it and hands over the
  result; the agent only writes a verdict. `checkVerification` and
  `checkCoverage` read files the model was not allowed to write.
- **Gate failures route to the stage that owns the fix.** A failing E2E test
  or a `NOT-FIXED` verification verdict → implement (fix the code, with the
  failure/verdict threaded in). A coverage gap → test (add the missing tagged
  test). A failing test is never routed back to "make it pass". An infra-failure
  (harness didn't come up) retries the gate, never an agent, then escalates to a
  human; an `INCONCLUSIVE` verification (the reproduction couldn't decide) also
  stops for a human — never a silent pass. Each belt is bounded, and a belt to a
  disabled stage (`enabled:false`) stops for a human instead.
- **Role prompts stay generic.** Anything product-specific comes from the
  product's own `CLAUDE.md` (loaded per run) and its `.sdlc/product.json` —
  never hardcode a product's stack, file layout, or domain into `agents/*`.
- **MCP access is per-stage, config-driven, and pipeline-side.** Stages can be
  given read-only MCP tools (a DB, error tracker, metrics) via `sdlc.config.json`'s
  optional `mcp` block: `mcp.json` holds the server defs (`${ENV}` placeholders,
  never literal secrets), a gitignored `.env` holds each user's credentials, and
  `mcp.stages` maps a stage → the `mcp__<server>__*` tool patterns it may call.
  All of this lives in THIS repo — never the product repo. Wiring is centralized
  in `mcpForStage` (`run.ts`) and applied at every agent call site (`runStage`
  plus the direct calls in implement/review). Servers always load with
  `--strict-mcp-config` (reproducible; ignores desktop/user/claude.ai connectors),
  and a preflight in `main()` fails fast if a required `${ENV}` credential is
  unset. This adds read *context* for the model to propose from; it does not let
  agents gate themselves — gates stay deterministic. Note claude.ai/Desktop OAuth
  connectors are NOT usable here (not exportable, absent in headless strict runs);
  use token-authenticated servers.
