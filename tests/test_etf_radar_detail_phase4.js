"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const root=path.resolve(__dirname,".."),html=fs.readFileSync(path.join(root,"index.html"),"utf8"),css=fs.readFileSync(path.join(root,"formal-black-gold.css"),"utf8");
const decision=require(path.join(root,"hs-decision-layer-v1.js"));
const official=html.slice(html.indexOf("function officialArtifactCoreScoreHistory"),html.indexOf("function localCoreScoreHistory"));
const phase4=html.slice(html.indexOf("const RADAR_TREND_PHASE4_PERIODS"),html.indexOf("function featuredDiagnosticFor"));
assert.ok(official.startsWith("function")&&phase4.startsWith("const"));
const context={Number,Math,String,Map,Object,window:{HSDecisionLayerV1:decision},LONG_TERM_CORE_SCORE_VERSION:"FINAL_CORE_WEIGHT_V1",HSFinalCoreProduction:require(path.join(root,"final-core-production.js")),isCompletedTradingDate:date=>/^\d{4}-\d{2}-\d{2}$/.test(date),esc:value=>String(value),coreScoreTrendRanges:new Map(),radarOfficialFactorPair:(symbol,artifact)=>{const row=artifact.snapshots.find(snapshot=>snapshot.finalized&&snapshot.snapshot_type==="FINALIZED_CLOSE")?.rows.find(item=>item.symbol===symbol);return{current:row?{date:row.data_as_of.slice(0,10),factors:[{key:"dd52",available:true,raw:row.factors.dd52.raw}]}:null}},finalizedCoreScoreHistoryArtifact:null};
vm.createContext(context);vm.runInContext(`${official}\n${phase4}\nthis.api={state:radarTrendPhase4State,events:radarTrendPhase4Events,thresholds:radarTrendPhase4Thresholds,priceRows:radarTrendPhase4PriceRows,render:radarScoreTrendHtml,chart:radarTrendPhase4Chart,extrema:radarTrendPhase4Extrema,domain:radarTrendPhase4Domain};`,context);
const dates=[];for(let day=new Date("2026-09-17T00:00:00Z");dates.length<125;day.setUTCDate(day.getUTCDate()-1))if(day.getUTCDay()>=1&&day.getUTCDay()<=5)dates.unshift(day.toISOString().slice(0,10));
const snapshots=dates.map((date,index)=>({date,snapshot_type:"FINALIZED_CLOSE",finalized:true,rows:[{symbol:"00830",final_core_score:30+index*.21,core_score_version:"FINAL_CORE_WEIGHT_V1",data_as_of:`${date}T13:30:00+08:00`,tier:"回檔訊號出現",factors:{dd52:{raw:-21.28}}}]}));
const artifact={schema_version:1,core_score_version:"FINAL_CORE_WEIGHT_V1",snapshots:[...snapshots].reverse()};
const prices=dates.map((date,index)=>({date,close:100+index,max:102+index,min:98+index}));
const item={id:"00830",officialRows:prices,officialRowsAdjusted:true};context.finalizedCoreScoreHistoryArtifact=artifact;
for(const [period,count] of Object.entries({"10D":10,"20D":20,"60D":60,"120D":120})){const state=context.api.state(item,period,artifact);assert.equal(state.kind,"READY");assert.equal(state.rows.length,count);assert.equal(state.current.tradingDate,dates.at(-1));assert.equal(state.first.tradingDate,dates.at(-count));assert.equal(state.delta,state.current.displayScore-state.first.displayScore);assert.equal(state.high,Math.max(...state.rows.map(row=>row.displayScore)));assert.equal(state.low,Math.min(...state.rows.map(row=>row.displayScore)))}
for(const period of ["10D","20D","60D","120D"]){
  context.coreScoreTrendRanges.set("00830",period);
  const selected=context.api.state(item,period,artifact),extrema=context.api.extrema(selected),rendered=context.api.render(item);
  assert.equal(extrema.amplitude,selected.high-selected.low);
  assert.equal(extrema.highDate,selected.rows[extrema.highIndex].tradingDate.slice(5).replace("-","/"));
  assert.equal(extrema.lowDate,selected.rows[extrema.lowIndex].tradingDate.slice(5).replace("-","/"));
  assert.match(rendered,new RegExp(`aria-pressed="true" data-core-trend-range="${period}"`));
  assert.match(rendered,new RegExp(`區間高點</small><b>${selected.high}<time>（${extrema.highDate}）`));
  assert.match(rendered,new RegExp(`區間低點</small><b>${selected.low}<time>（${extrema.lowDate}）`));
  assert.match(rendered,new RegExp(`區間振幅</small><b>${extrema.amplitude} 分`));
  assert.match(rendered,/class="radarTrendP4Line" d="M[^\"]+ H[^\"]+ V/);
  assert.doesNotMatch(rendered,/<polyline/);
  assert.match(rendered,new RegExp(`${selected.first.tradingDate} 至 ${selected.current.tradingDate}`));
}
context.coreScoreTrendRanges.set("00830","10D");
const base=context.api.state(item,"10D",artifact),flatAt=score=>{const rows=[{displayScore:score,tradingDate:"2026-09-16"},{displayScore:score,tradingDate:"2026-09-17"}];return{...base,high:score,low:score,rows,first:rows[0],current:rows[1]}};
for(const score of [0,24,100]){
  const flat=flatAt(score),domain=context.api.domain(flat),chart=context.api.chart(flat);
  assert.equal(domain.max-domain.min,20);
  assert.ok(domain.min>=0&&domain.max<=100);
  assert.doesNotMatch(chart,/NaN|Infinity/);
  assert.match(chart,new RegExp(`區間持平 ${score}｜09/16–09/17`));
  assert.equal((chart.match(/radarTrendP4Extremum/g)||[]).length,1);
  assert.equal(context.api.extrema(flat).amplitude,0);
}
const narrowRows=[0,1,2].map((displayScore,index)=>({displayScore,tradingDate:`2026-09-${16+index}`})),narrow={...base,high:2,low:0,rows:narrowRows,first:narrowRows[0],current:narrowRows[2]};
assert.equal(context.api.domain(narrow).max-context.api.domain(narrow).min,20);
const narrowPath=context.api.chart(narrow).match(/class="radarTrendP4Line" d="M[\d.]+ ([\d.]+) H[\d.]+ V([\d.]+)/);
assert.ok(narrowPath&&Math.abs(Number(narrowPath[1])-Number(narrowPath[2]))<10,"one-point move must not be exaggerated");
const volatile={...base,high:51,low:24};assert.ok(context.api.domain(volatile).max-context.api.domain(volatile).min>=27);
console.log("PASS ETF Radar trend chart step line, 20-point minimum span, 0/100 boundaries and flat series");
const productionArtifact=JSON.parse(fs.readFileSync(path.join(root,"finalized-core-score-snapshots-v1.json"),"utf8"));
const productionCases=[];
for(const symbol of ["00830","0050","00662","00757","00935"]){
  for(const period of symbol==="00830"?["10D","20D","60D","120D"]:["10D","20D"]){
    const state=context.api.state({id:symbol,officialRows:[],officialRowsAdjusted:false},period,productionArtifact);
    assert.equal(state.kind,"READY",`${symbol} ${period} official rows`);
    const domain=context.api.domain(state),extrema=context.api.extrema(state),chart=context.api.chart(state);
    assert.ok(domain.min>=0&&domain.max<=100&&domain.max-domain.min>=20,`${symbol} ${period} safe domain`);
    assert.equal(extrema.amplitude,state.high-state.low);
    assert.ok(extrema.highDate&&extrema.lowDate&&state.first.tradingDate<=state.current.tradingDate);
    assert.match(chart,/class="radarTrendP4Line" d="M[^"]+ H[^"]+ V/);
    assert.doesNotMatch(chart,/NaN|Infinity/);
    assert.equal((chart.match(/class="radarTrendP4Extremum/g)||[]).length,state.high===state.low?1:2);
    productionCases.push(`${symbol} ${period}: ${state.rows.length}日 ${state.low}–${state.high} 振幅${extrema.amplitude} 軸${domain.min}–${domain.max}`);
  }
}
console.log("PASS existing production ETF snapshots: "+productionCases.join("; "));
const state=context.api.state(item,"10D",artifact);for(const days of [1,5,20,60])assert.ok(Math.abs(state.priceReturns[days]-((prices.at(-1).close/prices.at(-days-1).close-1)*100))<1e-9);assert.equal(state.dd52,-21.28);assert.ok(Math.abs(state.distance60-((prices.at(-1).close/Math.max(...prices.slice(-60).map(row=>row.max))-1)*100))<1e-9);assert.ok(Math.abs(state.rebound20-((prices.at(-1).close/Math.min(...prices.slice(-20).map(row=>row.min))-1)*100))<1e-9);
const thresholds=context.api.thresholds();assert.deepEqual(Array.from(thresholds,row=>row.value),decision.NEXT_THRESHOLDS);
const crossing=(a,b)=>context.api.events([{displayScore:a,tradingDate:"2026-09-16"},{displayScore:b,tradingDate:"2026-09-17"}],thresholds);
assert.match(crossing(46,51)[0].label,/進入「正式加碼訊號」/);assert.match(crossing(51,49)[0].label,/退出「正式加碼訊號」，回到「試探加碼」/);assert.match(crossing(29,32)[0].label,/進入「回檔訊號出現」/);assert.match(crossing(39,42)[0].label,/進入「加碼條件浮現」/);assert.match(crossing(44,46)[0].label,/進入「試探加碼」/);assert.match(crossing(48,67)[0].label,/進入「積極加碼訊號」/);assert.match(crossing(48,67)[0].detail,/正式加碼訊號/);assert.match(crossing(72,48)[0].label,/由「強力加碼訊號」回到「試探加碼」/);assert.equal(crossing(45,46).length,0);
let rendered=context.api.render(item);assert.match(rendered,/data-radar-trend-phase="4"/);assert.match(rendered,/近期沒有跨級事件/);assert.match(rendered,/價格表現/);assert.match(rendered,/目前位置/);assert.match(rendered,/距52週高點/);assert.match(rendered,/距20日低點/);assert.doesNotMatch(rendered,/距60日高點/);
context.coreScoreTrendRanges.set("00830","120D");rendered=context.api.render(item);assert.match(rendered,/aria-pressed="true" data-core-trend-range="120D"/);
const short={...artifact,snapshots:artifact.snapshots.slice(0,7)};assert.equal(context.api.state(item,"120D",short).rows.length,7);context.finalizedCoreScoreHistoryArtifact=short;assert.match(context.api.render(item),/可用資料 7 日／目標 120 日/);
const invalid={...artifact,snapshots:artifact.snapshots.map(snapshot=>({...snapshot,finalized:false}))};assert.equal(context.api.state(item,"10D",invalid).kind,"UNAVAILABLE");assert.equal(context.api.state({id:"009815"},"10D",artifact).kind,"WAIT_NATIVE");
assert.equal(context.api.state({...item,officialRows:prices.slice(0,3)},"10D",artifact).priceReturns[1],null);assert.equal(context.api.state({...item,officialRowsAdjusted:false},"10D",artifact).distance60,null);
assert.match(css,/@media\(max-width:600px\)[\s\S]*\.radarTrendP4Scores\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
assert.match(css,/@media\(max-width:600px\)[\s\S]*\.radarTrendP4Prices\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
console.log("PASS ETF Radar Detail Phase 4 periods, finalized-only inputs, metrics, events, missing data and responsive guards");
