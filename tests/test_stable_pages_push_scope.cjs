"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {shouldDeploy,previousPagesBlob} = require("../scripts/stable_pages_push_scope.cjs");
const ref = "refs/heads/main";
const push = {event:"push",ref};
const audit = ".github/workflows/audit-twse-close-capture.yml";
const pages = ".github/workflows/hs-stable-pages.yml";
const gate = "scripts/stable_pages_push_scope.cjs";
test("standalone audit push skips deployment, mixed and unknown pushes do not", () => {
  assert.equal(shouldDeploy({...push,changed:[audit]}),false);
  assert.equal(shouldDeploy({...push,changed:[audit,"index.html"]}),true);
  assert.equal(shouldDeploy({...push,changed:null}),true);
  assert.equal(shouldDeploy({...push,changed:[audit,"data/c4-close-observations-v1.json"]}),true);
});
test("introduction can skip once, future Pages or guard changes still deploy", () => {
  const introduction = {...push,changed:[audit,pages,gate],oldPagesBlob:previousPagesBlob,oldGateAbsent:true};
  assert.equal(shouldDeploy(introduction),false);
  assert.equal(shouldDeploy({...introduction,oldGateAbsent:false}),true);
  assert.equal(shouldDeploy({...introduction,oldPagesBlob:"other"}),true);
  assert.equal(shouldDeploy({...introduction,changed:[...introduction.changed,"version.json"]}),true);
});
test("PRs never deploy and existing dispatch and publication triggers stay unchanged", () => {
  assert.equal(shouldDeploy({event:"pull_request",ref}),false);
  assert.equal(shouldDeploy({event:"workflow_run",ref}),true);
  assert.equal(shouldDeploy({event:"workflow_dispatch",ref}),true);
  assert.equal(shouldDeploy({...push,ref:"refs/heads/candidate"}),false);
});
