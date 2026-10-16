"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),vm=require("node:vm"),workflow=fs.readFileSync(".github/workflows/update-radar-daily.yml","utf8").replace(/\r\n/g,"\n");
assert.match(workflow,/cron: "15 10,12,14 \* \* 1-5"/);assert.match(workflow,/concurrency:[\s\S]*group: hs-radar-raw-daily[\s\S]*cancel-in-progress: false/);
assert.match(workflow,/--verify-public/);assert.match(workflow,/steps.collect.outcome != 'success'/);assert.match(workflow,/continue-on-error: true/);
assert.match(workflow,/pages: write/);assert.match(workflow,/gh api --method POST "repos\/\$GITHUB_REPOSITORY\/pages\/builds"/);
assert.match(workflow,/steps.publish.outputs.changed == 'true' \|\| inputs.revalidate == true/);
assert.match(workflow,/--revalidate/);assert.match(workflow,/retention-days: 30/);assert.match(workflow,/if: always\(\)/);assert.match(workflow,/git pull --rebase origin main/);
assert.doesNotMatch(workflow,/force.push|--force|railway|finmind|git add \.|git add -A|git add \*/i);
const add=workflow.match(/git add -- (.+)/)[1].trim().split(/\s+/);
assert.equal(add.length,7);assert.ok(add.every(p=>/^data\/radar-history\/(?:twse\/\d+\.json|tpex\/009815\.json|status-v1\.json)$/.test(p)));
const script=workflow.split("          script: |\n")[1].trimEnd().split("\n").map(l=>l.replace(/^            /,"")).join("\n");
const issues=[],updates=[],created=[],summary=[];
let healthy=false;
const context={repo:{owner:"fixture",repo:"test"},runId:123,eventName:"schedule"},github={paginate:async()=>issues,rest:{issues:{
 listForRepo(){},async create(arg){created.push(arg);issues.push({number:1,user:{login:"github-actions[bot]"},body:arg.body})},async update(arg){updates.push(arg);if(arg.body)issues[0].body=arg.body}
}}};
const status={expected_completed_bar:"2026-10-16",symbols:Object.fromEntries(["0050","00662","00757","00830","00935","009815"].map(s=>[s,{status:"CURRENT",latest_verified_date:"2026-10-16",reason:null}]))};
const sandbox={require:()=>({readFileSync:()=>JSON.stringify(status)}),process:{env:{get PREVIOUS_STATUS(){return healthy?"success":"failure"}}},context,github,core:{summary:{addHeading(){return this},addCodeBlock(value){summary.push(value);return this},async write(){}}}};
(async()=>{
 const run=()=>vm.runInNewContext("(async()=>{"+script+"})()",sandbox);
 await run();await run();assert.equal(created.length,1,"same failure must not create duplicate issues");
 healthy=true;await run();assert.equal(updates.at(-1).state,"closed","only full successful publication resolves alert");
 status.symbols["00830"].status="STALE";status.symbols["00830"].reason="OFFICIAL_SOURCE_DELAY";await run();
 assert.ok(JSON.parse(summary.at(-1)).healthy===false,"workflow SUCCESS alone cannot mark source healthy");
 console.log("PASS radar workflow schedule/gates/allowlist/retry/private evidence/publication and deduplicated alerts");
})().catch(e=>{console.error(e);process.exitCode=1});
