# Design — teach `investigate` to catch bad per-buyer schema configs

_Date: 2026-07-29 · Author: Omer Brudner (+ Claude) · Status: approved, pre-implementation_

## Problem

The last pipeline run (upload job `6a4f97892872e6998a1e67b3`, buyer **imagine /
Target Procurement LLC**, Ariba) produced an over-scoped fix ticket. The
`freight` dynamic-form handler timed out (30 s) because the buyer's Ariba portal
never exposes the "Charge" menu item the handler clicks. The investigate agent
diagnosed this as a **scraper code-fix** and proposed four acceptance criteria —
including **AC-2, building an entire new "Shipping Cost" alternative pathway**.

That is the wrong resolution. The real problem is a **bad per-buyer schema
config**: the buyer's `upload_invoice_schemas` document requires `freight`, but
this buyer's portal has never supported it. The agent had read-only MongoDB MCP
access the whole time (`sdlc.config.json` → `mcp.stages.investigate`) and never
used it to check the buyer's upload history.

### Decisive evidence (already gathered, read-only)

For buyer `6799223e5c217c55ba9b9ee4` (imagine, Ariba), in `MontoProd.upload_jobs`:

| Query | Count |
|---|---|
| `status:"finished"` for this buyer **with** `jobPayload.freight` | **0** |
| `status:"finished"` for this buyer (baseline) | **970** |
| `freight` in `finished` jobs for **other** buyers/portals (Taulia, Tungsten, other Ariba buyers) | many ✓ |

**0 of 970** successful uploads for this buyer have *ever* carried freight, while
freight succeeds elsewhere ⇒ freight is a bad config **for this buyer**, not a
scraper capability gap. The failing job's payload was `jobPayload.freight = 58.23`.

## Goal

On a re-run of the same ticket, the investigate agent should:

1. Recognize the failure as a **bad per-buyer schema config**, not a scraper bug.
2. **Verify** it against `upload_jobs` history for this buyer (the query above).
3. Conclude the fix is **remove `freight` from the buyer's
   `upload_invoice_schemas` document** — a human/ops action.
4. Emit **no scraper acceptance criteria** (AC-1..AC-4 all dropped), verdict
   **`no-fix: schema-config`**, so the pipeline skips the fix stages and the
   learning loop records the case.

Decisions taken during brainstorming:
- **Schema fix handling:** diagnose & hand off to a human (the pipeline does NOT
  write to Mongo — MCP is read-only, and fix stages only touch the scraper repo).
- **Scraper AC:** none — schema removal is the whole fix.
- **Scope:** general technique (any required field whose control is structurally
  absent), grounded with the freight example, plus a seeded reusable case.
- **Fetch enhancement:** included (surface `buyerId` + `jobPayload` field keys).
- **KB schema concept:** included — a keystone reference page so the durable
  "schema-as-config and how it can be wrong" knowledge has a real home, and the
  playbook/case/glossary **link** to it rather than restating it.

## Non-goals

- No change to the scraper (`ariba-scraper-main`). No AC-3 fail-fast hardening.
- No new Mongo **write** capability. The pipeline stays read-only against Mongo.
- No change to the orchestrator's verdict-parsing code (see item 3 — not needed).
- The new concept page does **not** re-document the input/aggregation flow — that
  stays owned by `architecture/input-schema-and-flow.md`; we cross-link.

## Design

Five changes across two repos. The pipeline repo is `ai-sdlc-invoice-submission`;
the KB repo is `scraper-knowledge-base` (path from `sdlc.config.json` →
`project.knowledgePath` = `../Scrapers/scraper-knowledge-base/wiki`).

### 1. Keystone KB concept page (new) — the durable schema-config knowledge

File: `wiki/handlers/invoice-form-schema.md` (KB repo, new). `type: Reference`.
Placed under `handlers/` because its audience is whoever is debugging or
developing handlers, alongside `field-catalog` and `error-mapping`.

Contents (link out, don't restate the flow):
- **What it is** — the per-buyer invoice-form schema stored in
  `upload_invoice_schemas` (MongoDB), keyed by `buyerId`, joined into the job by
  the aggregation. Authored **upstream** (backoffice / schema-builder /
  schema-research), **not** by the scraper. Link
  `architecture/input-schema-and-flow.md` for the flow mechanics.
- **How it drives a run** — the schema's fields decide which `jobPayload` /
  `invoiceFormValues` keys get populated upstream, and at runtime the draft routine
  dispatches a handler per *payload* key (the schema itself is read at runtime only
  for an optional per-field `prompt` override — so the schema's influence is
  upstream). Link `handlers/handler-pattern.md`.
- **Per-buyer, not per-portal (key nuance)** — a handler existing for a portal
  (see `field-catalog`) means the portal *can* support that field; it does **not**
  mean every buyer's tenant/config exposes the control. The schema is the
  buyer-specific truth. Example: `freight` is a valid Ariba handler, yet a given
  buyer's Ariba tenant may not offer the freight/"Charge" control at all.
- **Failure mode — bad schema config** — the schema requires a field the buyer's
  portal doesn't support (or shouldn't have). The handler runs, the control is
  absent, and it hangs/times out. This is a **configuration defect, not a scraper
  bug**: the fix is editing the buyer's schema (removing the field), not code.
- **Telling a bad config from a scraper bug (verification)** —
  1. Structural absence in `page.html` (the control never exists) is *necessary*
     but not sufficient — it could be selector drift.
  2. Decisive evidence: **`upload_jobs` history for this buyer.** If **0**
     `finished` jobs ever carried the field, the buyer has a **healthy baseline**
     of `finished` jobs, and the field **succeeds for other buyers/portals** ⇒
     bad schema config. **Any** prior success with the field for this buyer ⇒ NOT
     a config issue (portal variant / transient / selector drift).
     ```json
     { "status": "finished", "buyerId": {"$oid": "<BUYER_ID>"},
       "jobPayload.<field>": {"$exists": true, "$nin": [null, ""]} }
     ```
- **Fixing it** — a data edit in `upload_invoice_schemas` (remove the field from
  the buyer's schema). The scraper-debug pipeline can't write Mongo ⇒ hand off to
  a human/ops. Verdict `no-fix: schema-config`.
- **Citations** — `input-schema-and-flow.md`, `handler-pattern.md`,
  `field-catalog.md`, `glossary.md`, and the freight case (item 4).

Supporting edits so the page is discoverable:
- `wiki/handlers/index.md` — add a one-line entry.
- `wiki/standards/glossary.md` — add an `upload_invoice_schemas` term linking the
  new page (the existing `invoiceFormSchema` row can also point to it).
- `wiki/architecture/input-schema-and-flow.md` — one cross-link from its "Why
  this matters" section to the new page (mechanics ↔ config, no duplication).

### 2. Thin root-cause step in the KB playbook

File: `wiki/adlc/investigate.md` (KB repo). Now that the depth lives in item 1,
these edits stay small and just **link**:
- **`# Technique`** — add a bullet after "Name the failure MODE": when a required
  dynamic-form field's control is **structurally absent** in `page.html`, suspect
  a **bad per-buyer schema config** and verify via `upload_jobs` history — see
  [buyer invoice-form schema](/wiki/handlers/invoice-form-schema.md). State the
  decision rule inline in one sentence (0-with-field + healthy baseline +
  works-elsewhere ⇒ bad config; any prior success ⇒ not a config issue), and link
  the page for the query + depth.
- **`# Which repo changes`** — add a fourth target after **None**: *Config / data
  (`upload_invoice_schemas`)* — a bad per-buyer schema; the fix is a data edit
  (remove the field), not code; name the exact buyer + field and hand to a human.
- **`# Produce (the ticket)`** — add `no-fix: schema-config` to the verdict enum.
- **`# Read first`** — add a pointer to
  [buyer invoice-form schema](/wiki/handlers/invoice-form-schema.md).
- **`# Checklist before handing off`** — add: "For a required-field / missing-
  control failure, checked `upload_jobs` history for this buyer before concluding
  a code fix."

### 3. New verdict in the role prompt

File: `agents/investigate.md` (pipeline repo).
Add `no-fix: schema-config` to the `Resolution: <verdict>` enum. The existing
AC-N note already says *any* `no-fix` verdict writes `_None — no code change_`,
so it applies automatically.

**No orchestrator code change.** `investigateIsNoFix` (`pipeline/run.ts:1945`)
matches on the `no[-\s]?fix\b` prefix and ignores the suffix, so
`Resolution: no-fix: schema-config` already skips `FIX_STAGES` and routes to the
learning loop. Verified against the regex.

### 4. Seed a reusable case

Files (KB repo): `wiki/cases/ariba-freight-header-charge.md` (new),
`wiki/cases/index.md` (add one line under `# Ariba`), `wiki/log.md` (append).

Follows the KB case template: `type: Case`, `portals: [Ariba]`,
`fields: [freight, freightDate]`, `outcome: no-fix`, `status: proposal`,
`source:` the uploadJob id + Sentry issue 7023964512. Body documents the trigger
(freight required but the Charge control absent), the 0/970 evidence + the query,
and the resolution (remove `freight` from the buyer's schema; verdict
`no-fix: schema-config`). **Links** the concept page (item 1) for the "how you
know" reasoning rather than restating it. Makes the playbook's "read prior cases
first" step match on a re-run and short-circuit.

### 5. Deterministic fetch enhancement

File: `pipeline/fetch-context.ts` (pipeline repo).
`context.md`/`context.json` today carry a curated subset that **omits `buyerId`
and `jobPayload`**. Add to `curateJob` (`CuratedJob` type + population) and
`renderContextMarkdown`:
- `buyerId` (string).
- The **list of `jobPayload` dynamic-form field keys** present (keys only, not
  values — small, secret-free), e.g. `freight, invoiceDate, invoiceNumber,
  lineLevelTaxation, lineItems, …`.

This gives the agent the two facts the history check needs (which buyer, which
fields were sent) without relying on it to re-query, every run.

## Acceptance test — a re-run of `6a4f97892872e6998a1e67b3`

The ticket the agent writes should have:
- **TL;DR:** not a scraper bug; imagine's Ariba schema wrongly includes
  `freight`; 0/970 successful uploads for this buyer carried freight while freight
  works elsewhere; fix = remove `freight` from buyer `6799223e5c217c55ba9b9ee4`'s
  `upload_invoice_schemas` document. Ends `Resolution: no-fix: schema-config`.
- **Root cause:** cites both the `page.html` "Charge" absence *and* the
  `upload_jobs` history query result.
- **Failure mode:** bad schema config.
- **Tasks:** the human/ops action to edit the schema (no code).
- **Acceptance Criteria:** `_None — no code change (see Resolution)_`.
- **Pipeline behavior:** skips spec/implement/review; retrospector + curator run;
  the seeded case is matched (or a fresh one proposed).

Explicitly **absent:** any "Shipping Cost" alternative-pathway work (old AC-2),
any Charge-pathway change (old AC-1), any fail-fast/freightDate AC (old AC-3/AC-4).

## Verification plan

- **Static:** `no-fix: schema-config` matches `investigateIsNoFix`'s regex
  (confirmed). `fetch-context.ts` still type-checks / builds (`npm run build`).
- **KB conformance:** the new concept page **and** the new case pass
  `pipeline/kb-conformance.ts` shape rules (frontmatter, `type` vocabulary,
  source citation, folder placement) — the same gate the curator's proposals
  must pass. (`Reference` and `Case` are both in the accepted `type` vocabulary.)
- **Link integrity:** every new cross-link resolves to a real page.
- **End-to-end (optional, user-run):** re-run `npm run sdlc run
  6a4f97892872e6998a1e67b3 investigate` and confirm the produced ticket matches
  the acceptance test above.

## Risks & mitigations

- **False positives** (recommending removal of a legitimately-needed field):
  mitigated by the three-part decision rule — zero-with-field **and** healthy
  baseline **and** works-elsewhere — plus the structural-absence precondition
  (not a timing/race) and the explicit "any prior success ⇒ not a config issue"
  stop. The concept page states these as the gating conditions.
- **Concept page duplicating `input-schema-and-flow.md`:** mitigated by an
  explicit boundary — that page owns the flow, the new page owns config +
  failure modes; they cross-link.
- **Agent skips the Mongo check:** mitigated by item 5 (buyerId + payload keys
  pre-loaded) and the new checklist item.
