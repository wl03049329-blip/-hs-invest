const assert=require("assert");
const fs=require("fs");
const path=require("path");
const vm=require("vm");

const root=path.resolve(__dirname,"..");
const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
const css=fs.readFileSync(path.join(root,"formal-black-gold.css"),"utf8");
const production=require(path.join(root,"final-core-production.js"));
const start=html.indexOf("function coreStatusTier");
const end=html.indexOf("function longRankRow",start);
assert.ok(start>=0&&end>start,"shared coreStatusTier mapping must exist");
const context={Number,HSFinalCoreProduction:production};vm.createContext(context);vm.runInContext(html.slice(start,end),context);

const boundaries=[0,30,40,45,50,65,70,80,90];
assert.deepStrictEqual(boundaries.map(score=>context.coreStatusTier(score)),boundaries.map((_,index)=>`status-tier-${index+1}`));
assert.strictEqual(context.coreStatusTier(NaN,"資料不足"),"status-tier-na");
console.log("TEST 1 PASS: canonical score bands map to nine shared visual tiers plus N/A");

for(let tier=1;tier<=9;tier++)assert.match(css,new RegExp(`\\.status-tier-${tier}\\{[^}]*--status-border:[^;]+;[^}]*--status-bg:[^;]+;[^}]*--status-text:`));
assert.match(css,/\.status-tier-na\{[^}]*--status-border:[^;]+;[^}]*--status-bg:[^;]+;[^}]*--status-text:/);
console.log("TEST 2 PASS: all tiers use one black-gold token system");

assert.match(html,/longRankStage \$\{statusTier\}/);assert.match(html,/coreStatusTier\(Number\.isFinite\(decision\?\.coreScore\)/);
console.log("TEST 3 PASS: homepage badge uses the shared status tier mapping");

assert.match(html,/class="status-tier-\$\{index\+1\} \$\{Number\.isFinite\(score\)/);assert.match(html,/coreScoreHero \$\{statusTier\}/);
assert.match(css,/\.coreScoreLadder li\[class\*="status-tier-"\]\.current/);
console.log("TEST 4 PASS: ladder rows and current hero share tier tokens with extra current emphasis");

assert.match(css,/#homeEtfBrief \.longRankStage\{[\s\S]*?white-space:nowrap!important/);assert.match(css,/\.status-tier-na\{/);
console.log("TEST 5 PASS: P1 nowrap remains and WAIT_NATIVE is visually independent");

console.log("Status tier UI tests: 5/5 PASS");
