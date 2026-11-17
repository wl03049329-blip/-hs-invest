"use strict";
const {execFileSync} = require("node:child_process");
const workflow = ".github/workflows/hs-stable-pages.yml";
const gate = "scripts/stable_pages_push_scope.cjs";
const previousPagesBlob = "02a5331dd493cfd68ce5b9c380722954eaeef91c";
const auditOnly = new Set([
  ".github/workflows/audit-twse-close-capture.yml",
  "scripts/audit_twse_close_capture.cjs",
  "scripts/audit_twse_close_watchdog.cjs",
  "scripts/c4_openapi_close_candidate.cjs",
  "tests/stable_app_update_browser.cjs",
  "tests/test_audit_twse_close_capture.cjs",
  "tests/test_c4_openapi_close_candidate.cjs",
  "tests/test_stable_pages_push_scope.cjs"
]);
function shouldDeploy({event,ref,changed,oldPagesBlob,oldGateAbsent}) {
  if (event === "pull_request" || ref !== "refs/heads/main") return false;
  if (event !== "push" || !changed?.length) return true;
  if (changed.every(p => auditOnly.has(p))) return false;
  // One-time introduction of this guard. Future Pages/guard edits still deploy.
  const introducing = oldGateAbsent && oldPagesBlob === previousPagesBlob &&
    changed.includes(workflow) && changed.includes(gate);
  return !(introducing && changed.every(p => p === workflow || p === gate || auditOnly.has(p)));
}
function main() {
  const {GITHUB_EVENT_NAME:event,GITHUB_REF:ref,HS_PUSH_BEFORE:before,GITHUB_SHA:head} = process.env;
  const opts = {event,ref};
  if (event === "push" && ref === "refs/heads/main" &&
      /^[a-f0-9]{40}$/.test(before ?? "") && /^[a-f0-9]{40}$/.test(head ?? "")) {
    const git = (...args) => execFileSync("git", args, {encoding:"utf8",stdio:["ignore","pipe","pipe"]});
    try {
      opts.changed = git("diff","--name-only","--no-renames","-z",before,head,"--").split("\0").filter(Boolean);
      opts.oldPagesBlob = git("rev-parse","--verify",before+":"+workflow).trim();
      opts.oldGateAbsent = !git("ls-tree",before,"--",gate).trim();
    } catch {
      // Unknown range must retain the existing release behavior.
      opts.changed = null;
    }
  }
  console.log("deploy=" + shouldDeploy(opts));
}
if (require.main === module) main();
module.exports = {shouldDeploy,previousPagesBlob};
