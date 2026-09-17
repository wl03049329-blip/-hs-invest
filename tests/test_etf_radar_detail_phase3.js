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
assert.match(output,/今日分數下降主要來自52週回檔與週 J 值轉弱。/);

output=render(row(50,{dd52:43.05,weekly:6.5,crash:.45}),row(45.8,{dd52:39.05,weekly:6.3,crash:.45}));
assert.match(output,/class="is-positive">\+4\.00/);assert.match(output,/class="is-positive">\+0\.20/);assert.match(output,/今日分數上升主要由52週回檔帶動。/);

output=render(row(45.35,{dd52:39.08,weekly:6.27,crash:0}),row(45.35,{dd52:39.05,weekly:6.3,crash:0}));
assert.match(output,/今日分數變化不大，三因子整體維持穩定。/);

output=render(row(45.35),null);assert.match(output,/因子變化資料暫缺/);assert.match(output,/今日變化[\s\S]*—/);
output=render(row(45.35,{missing:"dd52"}),row(49.35,{dd52:41.85,weekly:7.5,crash:0}));assert.match(output,/分數拆解資料不完整/);assert.doesNotMatch(output,/約占目前總分/);assert.match(output,/52週回檔[\s\S]*>—</);
output=render(row(0,{dd52:0,weekly:0,crash:0}),row(0,{dd52:0,weekly:0,crash:0}));assert.doesNotMatch(output,/約占目前總分/);

context.finalizedCoreScoreHistoryArtifact={schema_version:1,core_score_version:"FINAL_CORE_WEIGHT_V1",snapshots:[snapshot("2026-09-17",{symbol:"00830",status:"WAIT_NATIVE",final_core_score:null,core_score_version:"FINAL_CORE_WEIGHT_V1",data_as_of:"2026-09-17T13:30:00+08:00"})]};
assert.match(context.render({id:"00830"},{}),/資料暫缺/);

assert.match(css,/\.radarExplainFactorMetrics\{display:grid;grid-template-columns:/);assert.match(css,/@media\(max-width:430px\)[\s\S]*?\.radarExplainLead\{grid-template-columns:1fr\}/);assert.match(css,/@media\(max-width:430px\)[\s\S]*?\.radarExplainFactorMetrics\{grid-template-columns:1fr/);assert.match(css,/\.radarExplainFactorMetrics>span\{display:flex;align-items:baseline;justify-content:space-between/);assert.match(css,/\.radarExplainFactor h4\{font-size:15px;line-height:1\.25;word-break:keep-all/);assert.match(css,/@media\(max-width:375px\)/);assert.doesNotMatch(html.slice(start,end),/fetch\(|localStorage|intraday|provisional/i);
assert.match(html.slice(start,end),/snapshot\?\.snapshot_type!=="FINALIZED_CLOSE"/);assert.match(html.slice(start,end),/snapshot\?\.finalized!==true/);assert.match(html.slice(start,end),/current\.factors\.map\(factor=>/);
console.log("PASS ETF Radar Detail Phase 3 finalized-only score explainability, attribution, missing-data and mobile guards");
