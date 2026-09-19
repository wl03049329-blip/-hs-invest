"use strict";

const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const root=path.resolve(__dirname,".."),html=fs.readFileSync(path.join(root,"index.html"),"utf8"),css=fs.readFileSync(path.join(root,"formal-black-gold.css"),"utf8");
const start=html.indexOf("const RADAR_EXPLAIN_FACTOR_DEFINITIONS"),end=html.indexOf("function radarScoreTrendHtml",start);
assert.ok(start>=0&&end>start,"Phase 3 explainability helpers must exist");
const context={Number,Math,String,esc:value=>String(value),LONG_TERM_CORE_SCORE_VERSION:"FINAL_CORE_WEIGHT_V1",isCompletedTradingDate:date=>/^2026-\d{2}-\d{2}$/.test(String(date))};
vm.createContext(context);vm.runInContext(`${html.slice(start,end)}\nthis.render=radarWhyScoreHtml;this.pair=radarOfficialFactorPair;this.record=radarOfficialFactorRecord;this.attribute=radarFactorAttribution;this.summary=radarExplainSummary;`,context);

const factor=(raw,score,weight,contribution)=>({raw,score,weight,contribution});
const row=(score,{dd52=39.05,weekly=6.3,crash=0,missing=null}={})=>({symbol:"00830",final_core_score:score,core_score_version:"FINAL_CORE_WEIGHT_V1",data_as_of:"2026-09-17T13:30:00+08:00",factors:{dd52:missing==="dd52"?{raw:null,score:null,weight:55,contribution:null}:factor(-21.28,71,55,dd52),weekly_j:missing==="weekly_j"?{raw:null,score:null,weight:30,contribution:null}:factor(31.7,21,30,weekly),crash:missing==="crash"?{raw:null,score:null,weight:15,contribution:null}:factor(-4.05,0,15,crash)}});
const snapshot=(date,item)=>({date,snapshot_type:"FINALIZED_CLOSE",finalized:true,rows:[{...item,data_as_of:`${date}T13:30:00+08:00`}]});
const artifact=(current,previous=null)=>({schema_version:1,core_score_version:"FINAL_CORE_WEIGHT_V1",snapshots:[...(previous?[snapshot("2026-09-16",previous)]:[]),snapshot("2026-09-17",current)]});
const render=(current,previous=null)=>{context.finalizedCoreScoreHistoryArtifact=artifact(current,previous);return context.render({id:"00830"},{});};

let output=render(row(45.35),row(49.35,{dd52:41.85,weekly:7.5,crash:0}));
assert.match(output,/目前分數主要來自[\s\S]*52週回檔/);assert.match(output,/約占目前總分 86%/);
assert.ok(output.indexOf("52週回檔")<output.indexOf("週 J 值")&&output.indexOf("週 J 值")<output.indexOf("20日急跌因子"),"factor order must stay fixed");
assert.match(output,/原始總分[\s\S]*45\.35/);assert.match(output,/顯示分數[\s\S]*>45</);assert.match(output,/>49<[\s\S]*→[\s\S]*>45<[\s\S]*▼4/);
assert.match(output,/52週回檔<\/span><b class="is-negative">-2\.80/);assert.match(output,/週 J 值<\/span><b class="is-negative">-1\.20/);assert.match(output,/20日急跌因子<\/span><b class="is-neutral">0\.00/);assert.match(output,/合計<\/span><b class="is-negative">-4\.00/);
assert.match(output,/最新正式分數下降主要來自52週回檔與週 J 值轉弱。/);

output=render(row(50,{dd52:43.05,weekly:6.5,crash:.45}),row(45.8,{dd52:39.05,weekly:6.3,crash:.45}));
assert.match(output,/class="is-positive">\+4\.00/);assert.match(output,/class="is-positive">\+0\.20/);assert.match(output,/最新正式分數上升主要由52週回檔帶動。/);

output=render(row(45.35,{dd52:39.08,weekly:6.27,crash:0}),row(45.35,{dd52:39.05,weekly:6.3,crash:0}));
assert.match(output,/最新正式分數變化不大，三因子整體維持穩定。/);

output=render(row(45.35),null);assert.match(output,/因子變化資料暫缺/);assert.match(output,/最新正式分數變化[\s\S]*—/);
output=render(row(45.35,{missing:"dd52"}),row(49.35,{dd52:41.85,weekly:7.5,crash:0}));assert.match(output,/分數拆解資料不完整/);assert.doesNotMatch(output,/約占目前總分/);assert.match(output,/52週回檔[\s\S]*>—</);
output=render(row(0,{dd52:0,weekly:0,crash:0}),row(0,{dd52:0,weekly:0,crash:0}));assert.doesNotMatch(output,/約占目前總分/);

context.finalizedCoreScoreHistoryArtifact={schema_version:1,core_score_version:"FINAL_CORE_WEIGHT_V1",snapshots:[snapshot("2026-09-17",{symbol:"00830",status:"WAIT_NATIVE",final_core_score:null,core_score_version:"FINAL_CORE_WEIGHT_V1",data_as_of:"2026-09-17T13:30:00+08:00"})]};
assert.match(context.render({id:"00830"},{}),/資料暫缺/);

const renderedDom=render(row(45.35));
assert.match(renderedDom,/<div class="radarFactorStackV32" data-radar-factor-layout="mobile-stack-v32"><section class="radarFactorCardV32/);
assert.equal((renderedDom.match(/<section class="radarFactorCardV32/g)||[]).length,3,"production renderer must place exactly three vertically stacked factor sections under the V32 parent");
assert.doesNotMatch(renderedDom,/class="radarExplainFactors"|class="radarExplainFactor(?:\s|"|Metrics)/,"Phase 3.2 renderer must not emit the legacy three-column factor DOM");
assert.match(renderedDom,/radarFactorHeaderV32[\s\S]*radarFactorTitleV32[\s\S]*radarFactorValueV32/);
assert.equal((renderedDom.match(/class="radarFactorMetricV32/g)||[]).length,9,"each factor must render three full-width metric rows");
assert.match(css,/\.radarFactorStackV32\{display:flex;flex-direction:column;width:100%;min-width:0/);
assert.match(css,/\.radarFactorCardV32\{width:100%;min-width:0/);
assert.match(css,/\.radarFactorHeaderV32\{display:flex;align-items:baseline;justify-content:space-between;gap:16px/);
assert.match(css,/\.radarFactorTitleV32\{[^}]*word-break:keep-all;overflow-wrap:normal/);
assert.match(css,/\.radarFactorMetricV32\{display:flex;align-items:center;justify-content:space-between;gap:16px;width:100%/);
assert.doesNotMatch(css,/\.radarFactorStackV32\{[^}]*repeat\(/,"V32 base layout must never use a multi-column grid");
assert.match(css,/@media\(max-width:430px\)\{[\s\S]*?\.radarFactorModelV32\{display:none\}/);
const stylesheetAt=html.indexOf('formal-black-gold.css?v=20260919-radar-events-phase10'),criticalAt=html.indexOf('id="radarPhase32CriticalLayout"');
assert.ok(stylesheetAt>=0&&criticalAt>stylesheetAt,"fresh HTML must load the versioned CSS before the critical cache safeguard");
const critical=html.slice(criticalAt,html.indexOf("</style>",criticalAt));
assert.doesNotMatch(critical,/@media/);assert.match(critical,/\.radarFactorStackV32\{display:flex;flex-direction:column/);assert.match(critical,/\.radarFactorMetricV32\{display:flex;justify-content:space-between/);assert.match(critical,/word-break:keep-all;overflow-wrap:normal/);
assert.match(html,/<html[^>]*data-build-sha="PENDING"[^>]*data-radar-phase="3\.2-mobile-stack-v32"/);assert.match(html,/data-radar-factor-layout="mobile-stack-v32"/);assert.match(html,/function radarPhase31LayoutDiagnostics\(\)/);assert.match(html,/document\.documentElement\.dataset\.buildSha=LIVE_APP_BUILD_SHA/);
assert.doesNotMatch(html.slice(start,end),/fetch\(|localStorage|intraday|provisional/i);
assert.match(html.slice(start,end),/snapshot\?\.snapshot_type!=="FINALIZED_CLOSE"/);assert.match(html.slice(start,end),/snapshot\?\.finalized!==true/);assert.match(html.slice(start,end),/current\.factors\.map\(factor=>/);
console.log("PASS ETF Radar Detail Phase 3 finalized-only score explainability, attribution, missing-data and mobile guards");
