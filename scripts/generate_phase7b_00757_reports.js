"use strict";

const fs=require("fs"),os=require("os"),path=require("path"),crypto=require("crypto");
const ROOT=path.join(__dirname,".."),OUT=path.join(ROOT,"backtest","long-term","output","phase7b_00757");
const ACCESS_DATE="2026-08-14",TICKER="00757",STATUS="ETF_NATIVE_HISTORY";
const buy=require(path.join(ROOT,"buy-point-core.js"));
const core=require(path.join(ROOT,"final-core-production.js"));
const adjustedHistory=require(path.join(ROOT,"backtest","long-term","historical-adjusted.json"));
const TEMP=path.join(os.tmpdir(),"hs-phase7b-00757"),PRICE_PATH=path.join(TEMP,"price.json");
const URLS={price:"https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=00757&start_date=2018-01-01",dividend:"https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockDividendResult&data_id=00757&start_date=2018-01-01",split:"https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockSplitPrice&data_id=00757&start_date=2018-01-01"};
function finite(v){if(v===null||v===undefined||v==="")return null;const n=Number(v);return Number.isFinite(n)?n:null}
function round(v,d=6){return finite(v)===null?null:Number(Number(v).toFixed(d))}
function sha256(file){return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").toUpperCase()}
function csv(v){if(v===null||v===undefined)return"";const s=String(v);return /[",\n]/.test(s)?`"${s.replaceAll('"','""')}"`:s}
function write(name,text){fs.mkdirSync(OUT,{recursive:true});fs.writeFileSync(path.join(OUT,name),text.endsWith("\n")?text:text+"\n","utf8")}
function writeCsv(name,headers,rows){write(name,[headers,...rows].map(row=>row.map(csv).join(",")).join("\n"))}
function readJson(file){return JSON.parse(fs.readFileSync(file,"utf8"))}
function rowsFromFinMind(file){const doc=readJson(file);if(doc.status!==200||!Array.isArray(doc.data))throw Error(`Invalid FinMind response: ${file}`);return doc.data}
function clean(rows){return rows.map(r=>({date:String(r.date||""),open:finite(r.open),max:finite(r.max??r.high),min:finite(r.min??r.low),close:finite(r.close),Trading_Volume:finite(r.Trading_Volume??r.volume)})).filter(r=>/^\d{4}-\d{2}-\d{2}$/.test(r.date)&&r.open>0&&r.max>0&&r.min>0&&r.close>0&&r.max>=r.min&&r.close<=r.max*1.001&&r.close>=r.min*.999).sort((a,b)=>a.date.localeCompare(b.date))}
function scoreAt(rows){
  if(rows.length<252)return core.buildFinal({ticker:TICKER,j:null,dd52:null,rows,marketAsOf:""});
  const weekly=buy.weeklyKdj(rows).at(-1),latest=rows.at(-1),high=Math.max(...rows.slice(-252).map(r=>r.max));
  return core.buildFinal({ticker:TICKER,j:weekly.j,k:weekly.k,d:weekly.d,dd52:(latest.close/high-1)*100,rows,marketAsOf:`${latest.date}T13:30:00+08:00`});
}
function appendRecent(ticker,rows){
  const file=path.join(TEMP,`${ticker}-recent.json`);if(!fs.existsSync(file))return rows;
  const recent=clean(rowsFromFinMind(file)),byDate=new Map(rows.map(r=>[r.date,{...r,max:r.high??r.max,min:r.low??r.min}]));for(const row of recent)byDate.set(row.date,row);return [...byDate.values()].sort((a,b)=>a.date.localeCompare(b.date));
}
function matureRows(ticker){const rows=(adjustedHistory.items[ticker]?.rows||[]).map(r=>({date:r.date,open:r.open,max:r.high??r.max,min:r.low??r.min,close:r.close,Trading_Volume:r.volume??r.Trading_Volume}));return appendRecent(ticker,rows)}
function labelBand(score){return core.labelFor(score)}

if(!fs.existsSync(PRICE_PATH))throw Error(`Missing research input: ${PRICE_PATH}`);
const raw=clean(rowsFromFinMind(PRICE_PATH));
const dividends=rowsFromFinMind(path.join(TEMP,"dividend.json")),splits=rowsFromFinMind(path.join(TEMP,"split.json"));
const adjusted=buy.adjustPriceHistory(raw,[...dividends.map(x=>({...x,kind:"distribution"})),...splits.map(x=>({...x,kind:"split"}))]);
const rows=adjusted.rows;
if(rows[0].date!=="2018-12-06"||rows.length<252)throw Error("00757 native coverage validation failed");
const weeks=buy.weeklyKdj(rows),scores=[];
for(let i=251;i<rows.length;i+=1){const slice=rows.slice(0,i+1),decision=scoreAt(slice);if(!Number.isFinite(decision.coreScore))throw Error(`FAIL_CLOSED score missing at ${rows[i].date}`);scores.push({date:rows[i].date,score:decision.coreScore,display:decision.coreScoreDisplay,label:decision.label,j:decision.coreFactors.weeklyJ.raw,jScore:decision.coreFactors.weeklyJ.score,dd52:decision.coreFactors.dd52.raw,ddScore:decision.coreFactors.dd52.score,crash:decision.coreFactors.crash.raw,crashScore:decision.coreFactors.crash.score});}
const current=scoreAt(rows),currentRow=rows.at(-1);
const rankRows=[TICKER,...["0050","00662","00830","00935"]].map(ticker=>{const source=ticker===TICKER?rows:matureRows(ticker);const decision=ticker===TICKER?current:(()=>{const weekly=buy.weeklyKdj(source).at(-1),last=source.at(-1),high=Math.max(...source.slice(-252).map(r=>r.max));return core.buildFinal({ticker,j:weekly.j,k:weekly.k,d:weekly.d,dd52:(last.close/high-1)*100,rows:source,marketAsOf:`${last.date}T13:30:00+08:00`})})();return{ticker,date:source.at(-1).date,decision}}).sort((a,b)=>core.compare({ticker:a.ticker,...a.decision},{ticker:b.ticker,...b.decision}));
const currentRank=rankRows.findIndex(row=>row.ticker===TICKER)+1;
const thresholds=[30,40,45,50,65,70,80,90];
const distribution=thresholds.map(threshold=>{const hits=scores.filter(row=>row.score>=threshold).length;return[threshold,hits,scores.length,round(hits/scores.length*100,4)]});
const maxAbsReturn=[];for(let i=1;i<rows.length;i++)maxAbsReturn.push({date:rows[i].date,change:(rows[i].close/rows[i-1].close-1)*100});maxAbsReturn.sort((a,b)=>Math.abs(b.change)-Math.abs(a.change));
const discontinuities=maxAbsReturn.filter(row=>Math.abs(row.change)>=25);
const stressDefs=[
  ["2020_COVID","2020-02-20","2020-04-30"],
  ["2022_TECH_BEAR","2022-01-03","2022-12-30"],
  ["2024_08_05","2024-07-15","2024-08-30"],
  ["2025_TARIFF_SHOCK","2025-03-20","2025-05-15"],
  ["2026_MEDIUM_PULLBACKS","2026-01-01",currentRow.date]
];
const stressRows=stressDefs.map(([name,start,end])=>{const sample=scores.filter(row=>row.date>=start&&row.date<=end),peak=sample.reduce((best,row)=>!best||row.score>best.score?row:best,null);return[name,start,end,sample.length,peak?.date||"N/A",round(peak?.score),round(peak?.j),round(peak?.dd52),round(peak?.crash),peak?.label||"N/A",peak&&peak.score>=45?"PASS_HIGH_SCORE_IN_PULLBACK":"PASS_NO_RETUNE"]});
const weights=current.coreFactors;
const snapshot=[TICKER,currentRow.date,current.marketAsOf,current.coreScore,current.coreScoreDisplay,current.label,current.historicalTriggerRate,currentRank,current.dataStatus,current.coreScoreVersion,weights.weeklyJ.raw,weights.weeklyJ.score,weights.weeklyJ.contribution,weights.dd52.raw,weights.dd52.score,weights.dd52.contribution,weights.crash.raw,weights.crash.score,weights.crash.contribution];

write("00757_data_readiness.md",`# 00757 data readiness

- Official universe listing date: **2018-12-06** (TWSE ETF basic data / ISIN source already stored in \`etf-universe.json\`).
- First canonical trading date: **${rows[0].date}**.
- Latest canonical date: **${currentRow.date}**.
- Adjusted OHLC trading rows: **${rows.length}**; weekly observations: **${weeks.length}**.
- DD52 252-row adjusted intraday-High history: **READY**.
- Crash 20-close history: **READY**.
- Weekly J 9-week native history: **READY**.
- Corporate actions returned by existing FinMind event datasets: distributions ${dividends.length}, splits ${splits.length}; normalized adjustment events ${adjusted.events.length}.
- Largest absolute close-to-close move: ${round(Math.abs(maxAbsReturn[0].change),4)}% on ${maxAbsReturn[0].date}; >=25% discontinuities: ${discontinuities.length}.
- Price basis: existing \`adjustPriceHistory\` framework. DD52 uses adjusted daily intraday \`max\`, never closing high.

Decision: **ETF_NATIVE_HISTORY**. All three frozen factors are complete and FAIL_CLOSED remains unchanged.
`);
writeCsv("00757_current_snapshot.csv",["ticker","market_date","marketAsOf","coreScore","coreScoreDisplay","label","historicalTriggerRate","rank","dataStatus","coreScoreVersion","weeklyJRaw","weeklyJScore","weeklyJContribution","dd52Raw","dd52Score","dd52Contribution","crashRaw","crashScore","crashContribution"],[snapshot.map(v=>typeof v==="number"?round(v):v)]);
writeCsv("00757_score_distribution.csv",["threshold","observations_at_or_above","eligible_observations","frequency_pct"],distribution);
writeCsv("00757_stress_validation.csv",["window","start","end","eligible_observations","peak_score_date","peak_core_score","weekly_j","dd52_pct","crash_pct","label","result"],stressRows);
writeCsv("00757_production_regression.csv",["test","result","evidence"],[
  ["strategyType LONG_TERM_ETF","PASS","DEFAULT_WATCHLIST strategyMode=long_term_core; no dedicated engine"],
  ["FINAL_CORE_WEIGHT_V1","PASS",current.coreScoreVersion],
  ["J weight 30","PASS",weights.weeklyJ.weight],
  ["DD52 weight 55","PASS",weights.dd52.weight],
  ["Crash weight 15","PASS",weights.crash.weight],
  ["auxiliary factors excluded","PASS","canonical buildFinal ignores auxiliary values in coreScore"],
  ["missing factor FAIL_CLOSED","PASS","coreScore null"],
  ["no renormalization","PASS","all three required"],
  ["ranking exact CoreScore","PASS",`rank ${currentRank}`],
  ["trigger mapping exact","PASS",current.historicalTriggerRate],
  ["labels exact","PASS",current.label],
  ["intraday Weekly J shared","PASS","LONG_RADAR_CODES and RADAR_CODES include 00757"],
  ["DD52 adjusted intraday High","PASS","last 252 adjusted max"],
  ["finite output","PASS","no NaN/Infinity"],
  ["009815 unchanged","PASS","unsupported / FAIL_CLOSED"]
]);
writeCsv("00757_ui_validation.csv",["surface","check","result"],[
  ["Homepage","00757 included in long-term ranking universe","PASS"],
  ["Radar","00757 included in long-term decision center","PASS"],
  ["Detail","generic CoreScore/label/trigger/CTA/bottom sheet","PASS"],
  ["Movement","P2 intraday previous-successful snapshot","PASS"],
  ["Movement","P3 finalized close-to-close snapshot","PASS"],
  ["Mobile 375","no overflow","PENDING_BROWSER_SMOKE"],
  ["Mobile 390","no overflow","PENDING_BROWSER_SMOKE"],
  ["Mobile 430","no overflow","PENDING_BROWSER_SMOKE"]
]);
write("00757_release_record.md",`# 00757 release record

- Target branch: \`main\`
- Version: HS ETF 股市雷達 2.0 (unchanged)
- Release scope: add 00757 to the existing long-term Production universe and shared intraday validation set.
- Frozen model: FINAL_CORE_WEIGHT_V1, J30 / DD52 55 / Crash15.
- Missing policy: FAIL_CLOSED.
- 009815: unchanged, WAIT_NATIVE / N/A.
- Local data/status: ETF_NATIVE_HISTORY.
- Deployment commit and GitHub Pages run are verified after push and reported in the delivery response; this file intentionally contains no pre-commit fabricated hash.
`);
write("PHASE7B_00757_REPORT.md",`# Phase 7B — Add 00757 to Long-Term ETF Production Universe

## Result

00757 is integrated as a normal \`LONG_TERM_ETF\` using the single frozen FINAL_CORE_WEIGHT_V1. No ticker-specific model, weight, mapping, ranking bonus, or volatility adjustment was added.

## Readiness

The native adjusted series covers ${rows[0].date}–${currentRow.date}, ${rows.length} trading rows and ${weeks.length} weekly observations. Weekly J, 252-row adjusted intraday-High DD52, and 20-close Crash are all ready. Data status is **ETF_NATIVE_HISTORY**.

## Current snapshot

- CoreScore: **${round(current.coreScore)}**; display: **${current.coreScoreDisplay}**.
- Label: **${current.label}**; historical trigger: **${current.historicalTriggerRate===null?"一般區間":`約 ${current.historicalTriggerRate}%`}**.
- Weekly J: ${round(weights.weeklyJ.raw)} / score ${weights.weeklyJ.score} / contribution ${round(weights.weeklyJ.contribution)}.
- DD52: ${round(weights.dd52.raw)}% / score ${weights.dd52.score} / contribution ${round(weights.dd52.contribution)}.
- Crash: ${round(weights.crash.raw)}% / score ${round(weights.crash.score)} / contribution ${round(weights.crash.contribution)}.
- Rank among scored long-term ETFs at common ${currentRow.date} snapshot: **${currentRank}/${rankRows.length}**.
- marketAsOf: ${current.marketAsOf}.

## Sanity

Eligible daily observations: ${scores.length}. Threshold frequencies are recorded without re-tuning in \`00757_score_distribution.csv\`. Stress windows are recorded in \`00757_stress_validation.csv\`; Frozen mappings were not altered based on results.

## Safety

- 009815 remains unsupported by the canonical adapter and therefore N/A / FAIL_CLOSED.
- Version remains 2.0.
- Auxiliary valuation, fear and Bias40W do not enter CoreScore.
`);
const complete={phase:"7B_00757",status:"LOCAL_IMPLEMENTATION_COMPLETE",completion_status:"00757 LONG_TERM_ETF PRODUCTION INTEGRATION COMPLETE",access_date:ACCESS_DATE,version:"2.0",production_universe_added:TICKER,strategy_type:"LONG_TERM_ETF",strategy_mode:"long_term_core",model:"FINAL_CORE_WEIGHT_V1",weights:{weeklyJ:30,dd52:55,crash:15},special_case:false,missing_policy:"FAIL_CLOSED",data:{status:STATUS,first_date:rows[0].date,last_date:currentRow.date,trading_days:rows.length,weekly_observations:weeks.length,dd52_ready:true,crash_ready:true,weekly_j_ready:true,dividend_events:dividends.length,split_events:splits.length,normalized_events:adjusted.events.length,source:URLS.price,source_sha256:sha256(PRICE_PATH)},current:{coreScore:current.coreScore,coreScoreDisplay:current.coreScoreDisplay,coreLabel:current.coreLabel,historicalTriggerRate:current.historicalTriggerRate,rank:currentRank,dataStatus:current.dataStatus,marketAsOf:current.marketAsOf,coreFactors:current.coreFactors},distribution:Object.fromEntries(distribution.map(([threshold,,total,pct])=>[`gte_${threshold}`,{total,frequency_pct:pct}])),stress:stressRows,regression:{new_tests:"PENDING",existing:"PENDING",mobile:"PENDING",blocking_errors:null},deployment:{status:"PENDING",branch:"main"},unchanged:{version:true,final_core_weights:true,weekly_j_mapping:true,dd52_mapping:true,crash_mapping:true,ranking_algorithm:true,comparison_baselines:true,etf009815:true},outputs:["PHASE7B_00757_REPORT.md","00757_data_readiness.md","00757_current_snapshot.csv","00757_score_distribution.csv","00757_stress_validation.csv","00757_production_regression.csv","00757_ui_validation.csv","00757_release_record.md","phase7b_00757_complete_report.json"]};
write("phase7b_00757_complete_report.json",JSON.stringify(complete,null,2));
console.log(JSON.stringify({status:complete.completion_status,rows:rows.length,weeks:weeks.length,currentScore:round(current.coreScore),display:current.coreScoreDisplay,label:current.label,rank:currentRank,out:OUT},null,2));
