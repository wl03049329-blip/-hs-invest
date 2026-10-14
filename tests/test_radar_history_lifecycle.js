"use strict";
// Synthetic DOM/chart/source doubles only for deterministic lifecycle contracts.
// No fixture is imported by the production page or persisted as market data.
const assert=require("node:assert/strict"),fs=require("node:fs"),vm=require("node:vm");
const C=require("../radar-history-core"),P=require("../final-core-production");
const dates=["2026-10-12","2026-10-13"];
const artifact={schema_version:1,core_score_version:P.LONG_TERM_CORE_SCORE_VERSION,snapshots:dates.map((date,i)=>({date,finalized:true,snapshot_type:"FINALIZED_CLOSE",source:{status:"official_closing_data",provider:"FIXTURE_ONLY"},rows:["0050","00662"].map(symbol=>({symbol,final_core_score:29.1+i,core_score_version:P.LONG_TERM_CORE_SCORE_VERSION,data_as_of:date+"T13:30:00+08:00"}))}))};
class Host{
  constructor(){this.dataset={};this.nodes=new Map();this.listeners=new Map();}
  querySelector(key){if(!this.nodes.has(key))this.nodes.set(key,{textContent:"",innerHTML:"",dataset:{},children:[],append(node){this.children.push(node)}});return this.nodes.get(key);}
  querySelectorAll(){return [];}
  addEventListener(key,fn){this.listeners.set(key,fn);}
  removeEventListener(key,fn){if(this.listeners.get(key)===fn)this.listeners.delete(key);}
  click(dataset){return this.listeners.get("click")({target:{closest:()=>({dataset,focus(){}})}});}
  input(type='mousedown',values={}){return this.listeners.get(type)({type,target:{closest:()=>({})},...values});}
}
const bus=()=>({handlers:new Set(),addEventListener(k,f){this.handlers.add(f)},removeEventListener(k,f){this.handlers.delete(f)}});
let pendingResolve,charts=[],sourceMode="NORMAL",sourceCalls=[];
class Source{
  constructor(){this.cache=new Map();}
  async sessions(){if(sourceMode==="CALENDAR_FAIL")throw Error("SOURCE_HTTP_402");return{dates,fetchedAt:"2026-10-13T12:00Z"};}
  async savedSessions(){return{dates,observedOnly:true,fetchedAt:"2026-10-13T12:00Z"};}
  async year(symbol,year,calendar,cutoff,signal){
    sourceCalls.push({symbol,signal});
    if(sourceMode==="DELAY"&&symbol==="0050")await new Promise(resolve=>pendingResolve=resolve);
    if(sourceMode==="FAIL")throw Error("SOURCE_FIXTURE_OUTAGE");
    return{rows:dates.map((time,i)=>({time,open:100+i,high:102+i,low:99+i,close:101+i,volume:1000,source:"FIXTURE_ONLY",fetchedAt:"2026-10-13T12:00Z"})),events:[],invalid:[],fetchedAt:"2026-10-13T12:00Z",dividendStatus:"VERIFIED"};
  }
}
function createChart(host,options){
  const c={options,series:[],removed:false,range:null,axis:[],crosshair:null,cleared:0};
  c.addSeries=(type,options,pane)=>{const s={type,options,pane,rows:[],lines:[],setData(rows){this.rows=rows;if(this===c.series[0])c.axis=rows.map(r=>r.time)},data(){return this.rows},applyOptions(o){Object.assign(this.options,o)},createPriceLine(o){const line={options:{...o},applyOptions(next){Object.assign(this.options,next)}};this.lines.push(line);return line;},removePriceLine(line){this.lines.splice(this.lines.indexOf(line),1)},priceScale(){return{applyOptions(){}}}};c.series.push(s);return s;};
  const addSeries=c.addSeries;
  c.addSeries=(...args)=>{const s=addSeries(...args);s.primitives=[];s.coordinateFactor=2;
    s.priceToCoordinate=value=>value*s.coordinateFactor;
    s.attachPrimitive=p=>{s.primitives.push(p);p.attached({requestUpdate(){c.requestedUpdates=(c.requestedUpdates||0)+1}});};
    s.detachPrimitive=p=>{s.primitives.splice(s.primitives.indexOf(p),1);p.detached();};
    return s;};
  c.removeSeries=s=>{assert.equal(s.primitives.length,0,'selection primitive must detach before its series');c.series.splice(c.series.indexOf(s),1);};
  c.clearCrosshairPosition=()=>{c.cleared++;c.crosshair?.({});};
  c.setCrosshairPosition=(value,time,series)=>{c.cursor={value,time,series};c.crosshair?.({time});};
  c.subscribeClick=fn=>c.onClick=fn;
  c.timeScale=()=>({getVisibleRange:()=>c.range&&{from:c.axis[Math.max(0,Math.ceil(c.range.from))],to:c.axis[Math.min(c.axis.length-1,Math.floor(c.range.to))]},getVisibleLogicalRange:()=>c.range,setVisibleLogicalRange:r=>{c.range=r;c.onRange?.(r)},setVisibleRange:r=>{c.range={from:c.axis.indexOf(r.from),to:c.axis.indexOf(r.to)};c.onRange?.(c.range)},subscribeVisibleLogicalRangeChange:fn=>c.onRange=fn});
  c.subscribeCrosshairMove=fn=>c.crosshair=fn;c.panes=()=>[{setHeight(){}},{setHeight(){}}];c.applyOptions=()=>{};c.remove=()=>{c.removed=true};charts.push(c);return c;
}
class SheetNode extends Host{
  constructor(){super();this.open=false;this.removed=false;this.focused=false;this.innerHTML='';}
  querySelector(key){if(!this.nodes.has(key))this.nodes.set(key,new SheetNode());return this.nodes.get(key);}
  setAttribute(){}setPointerCapture(){}focus(){this.focused=true;}
  showModal(){this.open=true;}close(){this.open=false;this.listeners.get('close')?.();}
  remove(){this.removed=true;}
  press(action){return this.listeners.get('click')({target:{closest:()=>({dataset:{sheetAction:action}})}});}
}
const sheets=[];
const document={...bus(),visibilityState:"visible",documentElement:{style:{overflow:'auto'}},createElement:()=>new SheetNode(),body:{append:s=>sheets.push(s)}},window={...bus(),HSRadarHistory:C,HSRadarHistorySource:{Source},LightweightCharts:{createChart,LineSeries:"line",CandlestickSeries:"candle",HistogramSeries:"histogram",CrosshairMode:{Normal:0},TrackingModeExitMode:{OnNextTap:0},createSeriesMarkers:()=>({setMarkers(){},detach(){}})}};
const storage=new Map(),context={window,document,console,AbortController,Intl,Date:class extends Date{constructor(...args){super(...(args.length?args:["2026-10-13T12:00:00Z"]))}static now(){return Date.parse("2026-10-13T12:00:00Z")}},ResizeObserver:class{observe(){}disconnect(){}},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)}};
vm.runInNewContext(fs.readFileSync(require.resolve("../radar-history-view"),"utf8"),require("./c4-display-context")(context));
const V=window.HSRadarHistoryView,args=symbol=>({symbol,name:symbol,artifact,contract:P,thresholds:[],completed:()=>true,headers:()=>({})});
(async()=>{
  const h=new Host();await V.mount(h,args("0050"));
  assert.equal(charts.length,1);assert.equal(charts[0].series.filter(s=>s.type==="candle"&&s.pane===1).length,1);
  const labels=chart=>chart.series.flatMap(s=>s.primitives.flatMap(p=>p.priceAxisViews().map(v=>({pane:s.pane,price:Number(v.text().split('：')[1]),view:v,primitive:p,series:s}))));
  assert.deepEqual(labels(charts[0]).map(l=>[l.pane,l.price]),[[1,102],[0,30.1]]);
  const formatter=charts[0].options.localization.timeFormatter;
  for(const input of ['2026-10-12',{year:2026,month:10,day:12},Date.parse('2026-10-12T00:00:00Z')/1000])assert.equal(formatter(input),'2026/10/12');
  assert.equal(formatter({year:2026,month:1,day:2}),'2026/01/02');
  assert.equal(charts[0].options.crosshair.horzLine.labelVisible,false,'cursor mouse Y must not impersonate selected close');
  assert.ok(labels(charts[0]).every(l=>l.view.visible()&&l.view.tickVisible()&&!l.primitive.paneViews&&!l.primitive.hitTest));
  const scoreLabel=labels(charts[0]).find(l=>l.pane===0);
  assert.equal(scoreLabel.view.fixedCoordinate(),60.2);
  scoreLabel.series.coordinateFactor=3;assert.equal(scoreLabel.view.fixedCoordinate(),90.30000000000001,'zoom/resize uses current native coordinates, not stale pixels');
  scoreLabel.primitive.select(29.123456);assert.equal(scoreLabel.view.text(),'C4：29.1');
  assert.equal(scoreLabel.view.fixedCoordinate(),29.123456*3,'one-decimal text must not round the plotted coordinate');
  scoreLabel.primitive.select(27);assert.equal(scoreLabel.view.text(),'C4：27.0');
  scoreLabel.primitive.select(30.1);
  assert.ok(charts[0].series.filter(s=>s.type==='candle').every(s=>s.options.lastValueVisible===false&&s.options.priceLineVisible===false));
  assert.match(h.querySelector(".radarHistoryDetail").innerHTML,/2026-10-13/);
  const beforeClear=charts[0].cleared;
  charts[0].crosshair({time:"2026-10-12"});assert.match(h.querySelector(".radarHistoryDetail").innerHTML,/30.1 分/,"programmatic redraw cannot replace latest selection");
  assert.equal(charts[0].cleared,beforeClear+1,"stale visual crosshair is cleared rather than disagreeing with detail date");
  const input={localX:10,localY:10};
  h.input('mousemove',{movementX:0,movementY:0});charts[0].crosshair({time:"2026-10-12",sourceEvent:input});assert.match(h.querySelector(".radarHistoryDetail").innerHTML,/30.1 分/,"stationary pointer/layout change cannot select historical day");
  h.input('mousemove',{movementX:1,movementY:0});
  charts[0].crosshair({time:"2026-10-12",sourceEvent:input});assert.match(h.querySelector(".radarHistoryDetail").innerHTML,/29.1 分/);
  assert.deepEqual(labels(charts[0]).map(l=>[l.pane,l.price]),[[1,101],[0,29.1]],'both panes use same selected date, not latest/high/low/mouse Y');
  charts[0].crosshair({});assert.deepEqual(labels(charts[0]).map(l=>l.price),[101,29.1],'mouseleave retains labels');
  assert.equal(labels(charts[0]).find(l=>l.pane===0).view.text(),'C4：29.1');
  charts[0].crosshair({time:"2026-10-13"});assert.match(h.querySelector(".radarHistoryDetail").innerHTML,/29.1 分/,"programmatic redraw preserves actual user selection");
  const beforeLatest=charts[0].cleared;
  await h.click({historyAction:"latest"});assert.match(h.querySelector(".radarHistoryDetail").innerHTML,/30.1 分/);assert.equal(charts[0].cleared,beforeLatest+1,"latest clears historical crosshair even when viewport range is unchanged");
  charts[0].crosshair({time:"2026-10-12",sourceEvent:{...input}});assert.match(h.querySelector(".radarHistoryDetail").innerHTML,/30.1 分/,"replayed pointer event cannot undo latest");
  h.input('touchstart');charts[0].crosshair({time:"2026-10-12",sourceEvent:input});assert.match(h.querySelector(".radarHistoryDetail").innerHTML,/29.1 分/,"fresh touch input selects real historical day");
  await h.click({historyAction:"latest"});assert.match(h.querySelector(".radarHistoryDetail").innerHTML,/30.1 分/);
  charts[0].crosshair({time:"2026-10-12"});assert.match(h.querySelector(".radarHistoryDetail").innerHTML,/30.1 分/,"latest remains latest after asynchronous redraw");
  await V.mount(h,args("0050"));assert.equal(charts.length,1,"same mounted symbol cannot duplicate chart/listeners");
  const sameChart=charts[0],sameRange={...sameChart.range};
  await h.click({historyAction:'details'});const sheet=sheets.at(-1);
  assert.equal(sheet.open,true);assert.equal(document.documentElement.style.overflow,'hidden');
  assert.equal(charts[0],sameChart);assert.deepEqual(sameChart.range,sameRange);
  assert.equal(sheet.querySelector('[data-sheet-action="next"]').disabled,true);
  await sheet.press('previous');assert.match(sheet.querySelector('h2 time').textContent,/2026\/10\/12/);
  assert.equal(sameChart.cursor.time,'2026-10-12');assert.deepEqual(sameChart.range,sameRange);
  assert.deepEqual(labels(sameChart).map(l=>l.price),[101,29.1],'sheet arrows update both native axis labels');
  assert.equal(sheet.querySelector('[data-sheet-action="previous"]').disabled,true);
  assert.match(sheet.querySelector('.radarHistorySheetBody').innerHTML,/該日未保存正式分項資料/);
  for(let i=0;i<30;i++){await sheet.press('next');await sheet.press('previous');}
  assert.equal(sameChart.cursor.time,'2026-10-12');assert.equal(sheet.open,true);
  sheet.listeners.get('cancel')({preventDefault(){}});
  assert.equal(sheet.open,false);assert.equal(document.documentElement.style.overflow,'auto');
  assert.match(h.querySelector('.radarHistoryDetail').innerHTML,/2026\/10\/12/);
  await h.click({historyAction:'details'});
  const handle=sheet.querySelector('.radarHistorySheetHandle');
  handle.listeners.get('pointerdown')({clientX:20,clientY:10,pointerId:1});
  handle.listeners.get('pointerup')({clientX:25,clientY:120,pointerId:1});assert.equal(sheet.open,false);
  await h.click({historyAction:'details'});
  console.log('PASS modal open/close/swipe, 60 day arrows, boundaries, focus and chart/range preservation');
  await h.click({historyRange:"60D"});assert.match(storage.values().next().value,/"range":"60D"/);
  const h2=new Host();await V.mount(h2,args("00662"));assert.ok(charts[0].removed);assert.equal(h.listeners.size,0);assert.match(h2.querySelector(".radarHistoryDetail").innerHTML,/00662/);assert.doesNotMatch(h2.querySelector(".radarHistoryDetail").innerHTML,/0050/);
  charts.at(-1).crosshair({time:"2026-10-12"});assert.match(h2.querySelector(".radarHistoryDetail").innerHTML,/30.1 分/,"new ETF starts at latest despite inherited pointer position");
  V.unmount();assert.equal(document.handlers.size,0);assert.equal(window.handlers.size,0);assert.equal(h2.listeners.size,0);
  assert.ok(sheet.removed);assert.equal(document.documentElement.style.overflow,'auto');
  console.log("PASS single instance, crosshair date, latest, preference, symbol and listener cleanup");
  sourceMode="DELAY";const stale=new Host(),late=V.mount(stale,args("0050"));
  await new Promise(resolve=>setImmediate(resolve));
  const fresh=new Host();await V.mount(fresh,args("00662"));assert.ok(sourceCalls.findLast(x=>x.symbol==="0050").signal.aborted);
  pendingResolve();await late;assert.equal(stale.querySelector(".radarHistoryDetail").innerHTML,"");assert.match(fresh.querySelector(".radarHistoryDetail").innerHTML,/00662/);
  console.log("PASS rapid ETF switch cancels/ignores stale result without cross-symbol contamination");
  V.unmount();sourceMode="FAIL";const failed=new Host();await V.mount(failed,args("0050"));
  assert.match(failed.querySelector(".radarHistoryStatus").textContent,/SOURCE_FIXTURE_OUTAGE/);
  assert.match(failed.querySelector(".radarHistoryDetail").innerHTML,/30.1 分/);
  assert.match(failed.querySelector(".radarHistoryDetail").innerHTML,/股價：資料不足/);
  assert.equal(charts.at(-1).series.find(s=>s.type==="candle").rows.filter(r=>r.close!==undefined).length,0);
  assert.equal(labels(charts.at(-1)).length,1);assert.equal(labels(charts.at(-1))[0].pane,0);
  assert.match(failed.querySelector('.radarHistoryCanvas').children.at(-1).textContent,/收盤：資料不足/);
  V.unmount();console.log("PASS source failure preserves independent finalized C4 and never invents candles");
  sourceMode="NORMAL";const reference=new Host();await V.mount(reference,args("009815"));assert.match(reference.querySelector(".radarHistoryDetail").innerHTML,/尚無正式分數/);assert.match(reference.querySelector(".radarHistoryDetail").innerHTML,/已驗證 RAW_UNADJUSTED/);
  assert.equal(labels(charts.at(-1)).length,1);assert.equal(labels(charts.at(-1))[0].pane,1);
  assert.match(reference.querySelector('.radarHistoryCanvas').children.at(-1).textContent,/無正式 C4/);V.unmount();
  console.log("PASS no official score still renders independent verified price");
  const {Source:RealSource}=require("../radar-history-source"),requests=[];
  const api=new RealSource({fetcher:async url=>{const p=new URL(url).searchParams;requests.push(p.get("dataset"));const y=p.get("start_date").slice(0,4);return{ok:true,json:async()=>({status:200,data:p.get("dataset")==="TaiwanStockPrice"?[{stock_id:"0050",date:y+"-10-13",open:100,max:102,min:99,close:101,Trading_Volume:1000}]:[]})}},now:()=>new Date("2026-10-13T12:00Z")});
  const calendar=["2025-10-13","2026-10-13"];
  await api.year("0050",2026,calendar,"2026-10-13");await api.year("0050",2025,calendar,"2026-10-13");
  assert.equal(requests.filter(x=>x==="TaiwanStockDividendResult").length,1);
  assert.equal(requests.filter(x=>x==="TaiwanStockPrice").length,2);
  assert.deepEqual(C.calendar([{date:"2000-01-08"}],"2026-10-13"),["2000-01-08"],"historical Saturday sessions come from calendar, not a weekday guess");
  console.log("PASS segmented price queries reuse one dividend query; calendar preserves historical Saturday sessions");
  sourceMode="CALENDAR_FAIL";storage.set('hsRadar.history.preferences.v1',JSON.stringify({ma5:true,ma10:true}));
  const degraded=new Host();await V.mount(degraded,args('0050'));
  assert.match(degraded.querySelector('.radarHistoryStatus').textContent,/交易日曆不可用/);
  assert.match(degraded.querySelector('.radarHistoryStatus').textContent,/MA 暫停/);
  assert.match(degraded.querySelector('.radarHistoryDetail').innerHTML,/30.1 分/);
  assert.equal(charts.at(-1).series.filter(s=>s.pane===1&&s.type==='line').length,0);
  V.unmount();console.log('PASS calendar outage keeps saved prices/formal C4 but disables calendar-dependent MA');
  sourceMode='NORMAL';
  for(let cycle=0;cycle<100;cycle++){
    const host=new Host();await V.mount(host,args(cycle%2?'0050':'00662'));
    assert.equal(charts.filter(c=>!c.removed).length,1);
    assert.equal(host.listeners.size,6);assert.equal(document.handlers.size,1);assert.equal(window.handlers.size,1);
    for(const range of ['10D','20D','60D','120D','1Y','ALL']){await host.click({historyRange:range});assert.equal(labels(charts.at(-1)).length,2,'redraw must not leak duplicate price labels');}
    V.unmount();assert.equal(host.listeners.size,0);assert.equal(document.handlers.size,0);assert.equal(window.handlers.size,0);
    assert.equal(charts.filter(c=>!c.removed).length,0);
  }
  console.log('PASS 100 mount/unmount cycles and 600 range switches leave no live chart or listener');
  console.log("RESULT 7/7 lifecycle/source groups PASS");
})().catch(e=>{console.error(e);process.exitCode=1});
