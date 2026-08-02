import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkVerification } from "./gates";

// checkVerification reads reviews/<id>.md relative to cwd, so run these in an isolated
// temp cwd with its own reviews/ dir (never touch the repo's).
let dir: string;
let prevCwd: string;
before(() => {
  prevCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "sdlc-gates-"));
  process.chdir(dir);
  mkdirSync("reviews", { recursive: true });
});
after(() => {
  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });
});

function gate(id: string, body: string) {
  writeFileSync(join("reviews", `${id}.md`), body);
  return checkVerification(id);
}

test("FIXED verdict -> pass", () => {
  const r = gate("a1", "Verdict: FIXED\n\n## Reasoning\nThe run got past the failing step.\n");
  assert.equal(r.passed, true);
  assert.equal(r.kind, "pass");
  assert.equal(r.source, "review");
});

test("NOT-FIXED verdict -> real-failure, with the report as the fix brief", () => {
  const r = gate("a2", "Verdict: NOT-FIXED\n\n## Fix brief\nStill times out at createDraft.\n");
  assert.equal(r.passed, false);
  assert.equal(r.kind, "real-failure");
  assert.match(r.output, /Still times out at createDraft/);
});

test("INCONCLUSIVE verdict -> inconclusive", () => {
  const r = gate("a3", "Verdict: INCONCLUSIVE\n\nThe scraper crashed during setup.\n");
  assert.equal(r.passed, false);
  assert.equal(r.kind, "inconclusive");
});

test("anchor robustness: bold marker + 'not fixed' spelling -> real-failure", () => {
  const r = gate("a4", "**Verdict:** not fixed\n\nnope\n");
  assert.equal(r.kind, "real-failure");
});

test("no verdict line at all -> inconclusive (never a silent pass)", () => {
  const r = gate("a5", "The fix looks great to me and should work.\n");
  assert.equal(r.passed, false);
  assert.equal(r.kind, "inconclusive");
});

test("prose mention of 'fixed' without a Verdict: line -> inconclusive", () => {
  const r = gate("a6", "I think this is fixed now, the error is gone.\n");
  assert.equal(r.kind, "inconclusive");
});

test("two conflicting verdict lines -> inconclusive (a human decides)", () => {
  const r = gate("a7", "Verdict: NOT-FIXED\nVerdict: FIXED\n");
  assert.equal(r.kind, "inconclusive");
});

test("a list-marker verdict bullet is still recognized", () => {
  const r = gate("a8", "- Verdict: FIXED\n");
  assert.equal(r.kind, "pass");
});

test("missing report file -> inconclusive", () => {
  const r = checkVerification("no-such-ticket");
  assert.equal(r.passed, false);
  assert.equal(r.kind, "inconclusive");
});
