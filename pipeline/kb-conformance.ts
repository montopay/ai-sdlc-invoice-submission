// WHAT THIS FILE IS:
// The deterministic SHAPE gate for a knowledge bundle. The Curator agent
// proposes concept files; this script decides whether they conform to the
// bundle's format BEFORE anything is pushed for a human to merge. Same
// determinism boundary as the QA gates: a model proposes, a dumb script
// decides. It gates SHAPE (frontmatter, type vocabulary, source citation,
// folder placement, index files having no frontmatter) — NOT judgment. Whether
// a recorded fact is TRUE and WORTH recording is the human merge's job.
//
// The rules encoded here mirror OKF's CONVENTIONS.md (sections 3-5, 7-8) for
// the product bundle. A second spec (PIPELINE_KB_SPEC) will be added when the
// pipeline KB repo exists; the checker itself is spec-driven and generic.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, basename, dirname, sep } from "node:path";

export type Violation = { rule: string; file: string; detail: string };
export type ConformanceResult = { passed: boolean; violations: Violation[] };

// A bundle's format rules. Everything product-specific about OKF lives in the
// spec value below; the checker reads the spec, so a different bundle just
// needs a different spec, not different code.
export type KbSpec = {
  name: string;
  // Closed `type` vocabulary (CONVENTIONS §3). A concept's frontmatter `type`
  // must be one of these.
  conceptTypes: string[];
  // type -> the folder (immediately under the bundle root) a concept of that
  // type must live in (CONVENTIONS §4: concept ID = path).
  typeToFolder: Record<string, string>;
  // Frontmatter keys every concept must carry, non-empty (CONVENTIONS §5).
  requiredFrontmatter: string[];
  // Cite-the-source rule (CONVENTIONS §7.1): every concept must carry at least
  // one of these keys, non-empty. An empty [] DISABLES the citation check — for a
  // KB whose own linter does not machine-enforce a source key.
  sourceKeys: string[];
  // Extra required frontmatter keys for a specific `type`, beyond
  // requiredFrontmatter. Lets a KB enforce shape on ONE content type (e.g. a Case
  // needs use_case/outcome/source) without demanding those of every concept.
  perTypeRequired?: Record<string, string[]>;
  // Bundle-root-relative files that are NOT concepts and are exempt from the
  // concept rules (CONVENTIONS §4: index.md files, plus the reserved root
  // files). index.md is handled specially everywhere; these are the rest.
  reservedRootFiles: string[];
  // STRICT-KB: content patterns forbidden anywhere in the bundle (frontmatter
  // OR body OR index/log), because they reference pipeline PROCESS artifacts
  // rather than the product. Optional so a future PIPELINE_KB_SPEC — whose
  // subject legitimately IS tickets/branches — simply omits them.
  pipelineRefRules?: { rule: string; pattern: RegExp; detail: string }[];
  // Bundle-relative files exempt from pipelineRefRules (docs that legitimately
  // NAME the forbidden patterns as examples, e.g. CONVENTIONS.md/README.md).
  pipelineRefExempt?: string[];
};

// The knowledge bundle this fork is pointed at: the scraper KB's OKF LLM-wiki
// (project.knowledgePath = .../scraper-knowledge-base/wiki). Its vocabulary and
// area-based folder layout come from wiki/standards/metadata-standard.md, and this
// spec deliberately mirrors what the KB's OWN linter (scripts/okf_lint.py)
// hard-enforces — non-empty `type` + valid frontmatter — so it never bounces a
// valid legacy page, while adding a per-type shape check for the Cases the curator mints.
export const PRODUCT_KB_SPEC: KbSpec = {
  name: "Scraper KB (OKF LLM-wiki)",
  conceptTypes: [
    "Reference", "Standard", "Architecture", "Handler", "Handler Pattern",
    "Portal", "Playbook", "Catalog", "Glossary", "Case", "Template",
  ],
  // Only types with a single, unambiguous home folder are enforced. `Reference`
  // is DELIBERATELY unmapped: it legitimately appears in BOTH standards/ and
  // handlers/, so a single-folder rule would false-positive on valid pages.
  typeToFolder: {
    Portal: "portals",
    Case: "cases",
    Playbook: "adlc",
    Architecture: "architecture",
    Handler: "handlers",
    "Handler Pattern": "handlers",
    Catalog: "handlers",
    Standard: "standards",
    Glossary: "standards",
  },
  // Match the KB's own linter: only a non-empty `type` is hard-required
  // (title/description/status/owner are recommended there, so requiring them would
  // bounce valid legacy pages).
  requiredFrontmatter: ["type"],
  // The KB does not machine-enforce a source key — leave empty to disable the
  // global citation check. A Case still MUST cite its origin (perTypeRequired).
  sourceKeys: [],
  // A Case is the one content type the curator mints from a run: require the fields
  // that make it reusable + traceable. A Case's `source` IS the prod incident
  // (uploadJob id / Sentry issue) — see the curator playbook (adlc/curator.md).
  perTypeRequired: {
    Case: ["use_case", "outcome", "source", "portals"],
  },
  // Within the wiki bundle only index.md (special-cased) and log.md (reserved by
  // basename) are non-concepts; README/GOVERNANCE/CONVENTIONS live at the KB repo
  // ROOT, outside this bundle, so nothing else needs reserving here.
  reservedRootFiles: [],
  // Keep durable pages about the product/portals: a fix's pipeline feature branch
  // (feature/<jobId>, a 24-hex id) must never leak into the KB. No ticket-ref rule
  // — this flow keys off uploadJob ids, which a Case legitimately cites.
  pipelineRefRules: [
    {
      rule: "no-pipeline-branch-ref",
      pattern: /\bfeature\/[0-9a-f]{8,}/i,
      detail:
        'references a pipeline feature branch (e.g. "feature/<jobId>"). Cite the product ' +
        "artifact instead — a code path/commit, or the uploadJob id / Sentry issue.",
    },
  ],
  pipelineRefExempt: [],
};

// Extracts the leading `---`-delimited frontmatter block as a flat key->value
// map, or null if the file has no frontmatter. Deliberately dependency-free and
// line-based (no YAML lib): OKF frontmatter is simple `key: value` pairs, and
// we only need key presence + the scalar value of `type`. A value's surrounding
// quotes are stripped; list/complex values are returned verbatim (their mere
// presence is what the required-key checks need).
function parseFrontmatter(text: string): Record<string, string> | null {
  // Tolerate a leading BOM but nothing else before the opening fence.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const m = body.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return null;
  const out: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    // Accept optionally-quoted keys (`"type":` / `'type':`) so a valid YAML
    // quoted key is not silently dropped.
    const kv = line.match(/^["']?([A-Za-z_][\w-]*)["']?:[ \t]*(.*)$/);
    if (!kv) continue; // skip blank / continuation / list-item lines
    let value = kv[2].trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted) {
      value = value.slice(1, -1).trim();
    } else {
      // Strip an unquoted trailing "# comment" (YAML treats " #" as a comment),
      // so `type: Decision # note` yields "Decision", not "Decision # note".
      value = value.replace(/\s+#.*$/, "").trim();
    }
    out[kv[1]] = value;
  }
  return out;
}

// Recursively collect every .md file under dir, skipping .git.
function collectMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectMarkdown(full));
    } else if (entry.toLowerCase().endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

// Checks a knowledge bundle rooted at bundleRoot against spec. Scans the whole
// bundle (bundles are small, and every committed file was conformant when its
// PR merged, so a whole-bundle scan also catches drift). Returns every
// violation so the Curator's belt can feed them all back at once.
export function checkBundle(bundleRoot: string, spec: KbSpec): ConformanceResult {
  const violations: Violation[] = [];
  const add = (rule: string, file: string, detail: string) => violations.push({ rule, file, detail });

  if (!existsSync(bundleRoot)) {
    return { passed: false, violations: [{ rule: "bundle-missing", file: bundleRoot, detail: "bundle root does not exist" }] };
  }

  // House rule (CONVENTIONS §7 item 5 / §8), stricter than the OKF spec (which
  // makes log.md optional): the audit log must exist. Whether THIS run appended
  // an entry is behavioral (curator prompt + human review); its mere existence
  // is the deterministic part. Case-insensitive on basename for portability.
  const hasLog = readdirSync(bundleRoot).some((e) => /^log\.md$/i.test(e));
  if (!hasLog) {
    add("log-present", "log.md", "bundle has no log.md (required audit trail — CONVENTIONS §7 item 5 / §8).");
  }

  const rootIndex = join(bundleRoot, "index.md");
  const reserved = new Set(spec.reservedRootFiles.map((f) => f.toLowerCase()));
  const pipelineExempt = new Set((spec.pipelineRefExempt ?? []).map((f) => f.toLowerCase()));

  for (const file of collectMarkdown(bundleRoot)) {
    const rel = relative(bundleRoot, file).split(sep).join("/");
    const base = basename(file);
    const text = readFileSync(file, "utf8");
    const fm = parseFrontmatter(text);

    // STRICT-KB: forbid pipeline PROCESS references anywhere in bundle content
    // (frontmatter AND body), so the KB stays about the product. Runs for every
    // file — concepts, index.md, log.md — except docs that legitimately name the
    // patterns as examples (pipelineRefExempt).
    if (spec.pipelineRefRules && !pipelineExempt.has(rel.toLowerCase())) {
      const lines = text.split(/\r?\n/);
      for (const r of spec.pipelineRefRules) {
        for (let i = 0; i < lines.length; i++) {
          if (r.pattern.test(lines[i])) {
            add(r.rule, rel, `line ${i + 1}: "${lines[i].trim().slice(0, 100)}" — ${r.detail}`);
            break; // one violation per rule per file
          }
        }
      }
    }

    // --- index.md files are NOT concepts (CONVENTIONS §4) ---
    if (base === "index.md") {
      if (file === rootIndex) {
        // Root index MAY declare only okf_version, nothing else.
        if (fm) {
          const extra = Object.keys(fm).filter((k) => k !== "okf_version");
          if (extra.length) {
            add("root-index-frontmatter", rel, `root index.md may only declare okf_version; found extra keys: ${extra.join(", ")}.`);
          }
        }
      } else if (fm) {
        add("index-frontmatter", rel, "index.md files must not have frontmatter (they are listings, not concepts — CONVENTIONS §4).");
      }
      continue;
    }

    // --- reserved files are exempt from concept rules. log.md is reserved by
    // basename ANYWHERE (OKF §7, like index.md above); README/CONVENTIONS are
    // reserved at the bundle root. ---
    if (base.toLowerCase() === "log.md" || reserved.has(rel.toLowerCase())) continue;

    // --- everything else is a concept and must conform ---
    if (!fm) {
      add("concept-frontmatter", rel, "concept file has no `---` frontmatter block.");
      continue;
    }

    for (const key of spec.requiredFrontmatter) {
      if (!fm[key] || fm[key].length === 0) {
        add("required-key", rel, `missing or empty required frontmatter key \`${key}\` (CONVENTIONS §5).`);
      }
    }

    const type = fm.type;
    if (type && !spec.conceptTypes.includes(type)) {
      add("type-vocabulary", rel, `type "${type}" is not in the closed vocabulary [${spec.conceptTypes.join(", ")}] (CONVENTIONS §3).`);
    }

    if (spec.sourceKeys.length) {
      const hasSource = spec.sourceKeys.some((k) => fm[k] && fm[k].length > 0);
      if (!hasSource) {
        add("cite-source", rel, `no source citation — a concept must carry at least one of [${spec.sourceKeys.join(", ")}].`);
      }
    }

    // Extra required keys for this concept's `type` (e.g. a Case needs
    // use_case/outcome/source), enforced only on that type — not every concept.
    for (const key of (type && spec.perTypeRequired?.[type]) || []) {
      if (!fm[key] || fm[key].length === 0) {
        add("required-key", rel, `a "${type}" concept must carry non-empty frontmatter key \`${key}\`.`);
      }
    }

    // Folder placement: concept ID = path (CONVENTIONS §4). A concept's
    // immediate parent folder must match its type's folder.
    if (type && spec.typeToFolder[type]) {
      const parent = basename(dirname(file));
      const expected = spec.typeToFolder[type];
      if (parent !== expected) {
        add("folder-placement", rel, `a "${type}" concept must live in ${expected}/, but this is under ${parent}/ (CONVENTIONS §4).`);
      }
    }
  }

  return { passed: violations.length === 0, violations };
}
