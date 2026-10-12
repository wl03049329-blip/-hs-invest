"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),vm=require("node:vm");
const workflow=fs.readFileSync(".github/workflows/c4-operations-monitor.yml","utf8");
const script=workflow.split("          script: |\n")[1].split("\n      - uses:")[0]
  .split("\n").map(line=>line.replace(/^            /,"")).join("\n");
assert.match(workflow,/if: vars\.HS_OPS_RUNTIME_PROFILE == 'hobby-always-on'/);
assert.match(workflow,/contents: read/);
assert.doesNotMatch(workflow,/contents: write|git push|railway up|send_test|workflow run/);
async function main(){
  const issues=[],updates=[],created=[];
  let report={alerts:["HEALTH_ENDPOINT_UNAVAILABLE","NO_VALID_SNAPSHOT_OVER_600S"],publication_verification:"PAGES_DEPLOYMENT_UNVERIFIED"};
  const sandbox={require:()=>({readFileSync:()=>JSON.stringify(report)}),process:{env:{RUNNER_TEMP:"fixture"}},
    context:{repo:{owner:"test",repo:"fixture"}},core:{summary:{addHeading(){return this},addCodeBlock(){return this},async write(){}}},
    github:{paginate:async()=>issues,rest:{issues:{
      listForRepo(){},
      async create(arg){created.push(arg);issues.push({number:1,user:{login:"github-actions[bot]"},body:arg.body});},
      async update(arg){updates.push(arg);if(arg.body)issues[0].body=arg.body;}
    }}}};
  const run=()=>vm.runInNewContext("(async()=>{"+script+"})()",sandbox);
  await run();await run();
  assert.equal(created.length,1,"one incident notification, no duplicate issue");
  assert.equal(updates.length,0,"unchanged outage must not generate timestamp/comment noise");
  report={alerts:["SCHEDULER_STOPPED"],publication_verification:"PUBLIC_ARTIFACT_UNVERIFIED"};
  await run();assert.equal(updates.length,1,"changed operational cause updates evidence");
  report={alerts:[],publication_verification:"PAGES_DEPLOYMENT_UNVERIFIED"};
  await run();assert.equal(updates.length,1,"Actions success without publication proof cannot close incident");
  report.publication_verification="PUBLISHED_VERIFIED";
  await run();assert.equal(updates.at(-1).state,"closed");
  console.log("PASS isolated monitor notification behavior: opt-in, dedupe, changed cause, verified recovery; zero external writes");
}
main().catch(e=>{console.error(e);process.exitCode=1});
