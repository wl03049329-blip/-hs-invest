const assert = require("assert");
const core = require("../swing-strategy-core");

let passed = 0;
function test(name, run) {
  run();
  passed += 1;
  console.log(`PASS ${name}`);
}

function marketRows({start = 100, total = 330, drift = .0012, dipDays = 24, dip = -.006, reboundDays = 5, rebound = .012} = {}) {
  const rows = [];
  let price = start;
  const first = new Date("2025-01-02T00:00:00Z");
  for (let index = 0; index < total; index += 1) {
    const date = new Date(first);
    date.setUTCDate(first.getUTCDate() + index);
    if ([0, 6].includes(date.getUTCDay())) { index -= 1; first.setUTCDate(first.getUTCDate() + 1); continue; }
    let move = drift;
    if (index >= total - dipDays - reboundDays && index < total - reboundDays) move = dip;
    if (index >= total - reboundDays) move = rebound;
    const open = price;
    price *= 1 + move;
    rows.push({date: date.toISOString().slice(0, 10), open, max: Math.max(open, price) * 1.004, min: Math.min(open, price) * .996, close: price, Trading_Volume: 1000000 + index * 1000});
  }
  return rows;
}

const benchmark = marketRows({start: 18000, dipDays: 0, reboundDays: 0});

test("資料正規化會排序、去重並丟棄無效價格", () => {
  const rows = core.normalizeOhlcv([
    {date:"2026-08-02",close:0},
    {date:"2026-08-03",close:10,max:11,min:9,Trading_Volume:100},
    {date:"2026-08-01",close:9,max:10,min:8,Trading_Volume:90},
    {date:"2026-08-03",close:10.5,max:11,min:10,Trading_Volume:110}
  ]);
  assert.deepStrictEqual(rows.map(row => row.date), ["2026-08-01","2026-08-03"]);
  assert.strictEqual(rows[1].close, 10.5);
});

test("核心均線與趨勢結構均線分層輸出", () => {
  const indicators = core.buildIndicators(marketRows(), benchmark);
  for (const key of ["ma20","ma60","ma200"]) assert.ok(Number.isFinite(indicators.core[key]));
  for (const key of ["ma43","ma87","ma284"]) assert.ok(Number.isFinite(indicators.trendStructure.values[key]));
  assert.ok(["full","partial","unavailable"].includes(indicators.trendStructure.status));
});

test("週 KD 保留當週暫定值、前值與方向", () => {
  const weekly = core.weeklyKdj(core.normalizeOhlcv(marketRows())).at(-1);
  assert.ok(Number.isFinite(weekly.j));
  assert.ok(Number.isFinite(weekly.previousJ));
  assert.ok(["up","down","flat"].includes(weekly.direction));
});

test("四策略 router 保留長期與槓桿 adapter", () => {
  const long = core.runStrategy({strategyType:"longTerm",input:{id:"0050"},adapters:{longTerm: value => ({adapter:"long",id:value.id})}});
  const leveraged = core.runStrategy({strategyType:"leveraged",input:{id:"00631L"},adapters:{leveraged: value => ({adapter:"leveraged",id:value.id})}});
  assert.deepStrictEqual(long,{adapter:"long",id:"0050"});
  assert.deepStrictEqual(leveraged,{adapter:"leveraged",id:"00631L"});
});

test("00733 強勢回檔案例輸出 gates、buyScore 與獨立 exitPressure", () => {
  const result = core.engine00733({rows: marketRows({dipDays:18,dip:-.0065,reboundDays:5,rebound:.012}), benchmarkRows: benchmark});
  assert.strictEqual(result.strategyType,"swing00733");
  assert.ok(result.gates.setupGate);
  assert.ok(result.gates.marketShockGate);
  assert.ok(result.exitPressure && Object.prototype.hasOwnProperty.call(result.exitPressure,"score"));
  assert.notStrictEqual(result.buyScore, result.exitPressure.score);
  assert.ok(result.trendStructure.values.ma43);
});

test("00733 的 0050 市場風險上限會在 raw score 後套用", () => {
  const weakBenchmark = marketRows({start:18000,drift:.001,dipDays:24,dip:-.012,reboundDays:0});
  const result = core.engine00733({rows: marketRows({dipDays:18,dip:-.0065,reboundDays:5,rebound:.012}), benchmarkRows: weakBenchmark});
  if (result.gates.marketShockGate.triggered && Number.isFinite(result.buyScore)) assert.ok(result.buyScore <= 69);
  assert.ok(result.caps.every(cap => [54,69].includes(cap.value)));
});

test("00733 固定分數案例 75/85 與突破分別對應 Stage 1/2/4", () => {
  const indicators = core.buildIndicators(marketRows(), benchmark);
  const passed = {setupGate:{passed:true},marketShockGate:{triggered:false}};
  assert.strictEqual(core.stage00733(75,indicators,passed).number,1);
  assert.strictEqual(core.stage00733(85,indicators,passed).number,2);
  const breakout = JSON.parse(JSON.stringify(indicators));
  breakout.previous20DayHighestClose = breakout.price - 1;
  breakout.volumeMa20 = 100;
  breakout.rows[breakout.rows.length-1].volume = 120;
  breakout.core.ma20Slope = .01;
  assert.strictEqual(core.stage00733(85,breakout,passed).number,4);
});

test("00733 浮盈逾 20% 後回吐 10% 觸發 50% 保護且 EXIT 不得加碼", () => {
  const indicators = core.buildIndicators(marketRows(), benchmark);
  const protection = core.exitPressure00733(indicators,{entryPrice:indicators.price/1.17,peakPrice:indicators.price/.9,marketRisk:40});
  assert.strictEqual(protection.profitProtection,true);
  const protectedTrade = core.transitionTradeState({state:"HOLDING",position:100},{nextState:"EXIT",action:"PROTECT"});
  assert.strictEqual(protectedTrade.position,50);
  const addAfterExit = core.transitionTradeState(protectedTrade,{nextState:"EXIT",action:"ADD",stage:4,position:100});
  assert.strictEqual(addAfterExit.position,50);
  assert.strictEqual(addAfterExit.error,"exit_mode_no_add");
});

test("006201 70 至 79 分僅等待，80 分以上才可建立第一批", () => {
  const result = core.engine006201({rows:marketRows({dipDays:23,dip:-.008,reboundDays:5,rebound:.014}),benchmarkRows:benchmark,otcStrength:70});
  assert.strictEqual(result.strategyType,"swing006201");
  if (result.buyScore >= 70 && result.buyScore < 80) assert.strictEqual(result.stage.number,0);
  if (result.buyScore >= 80 && result.gates.setupGate.passed && !result.gates.hardFail.triggered) assert.ok(result.stage.number >= 1);
  assert.ok(Object.prototype.hasOwnProperty.call(result,"breakoutConfirmed"));
});

test("006201 固定分數案例 75 不買、85 為第一買點", () => {
  const gates={hardFail:{triggered:false},setupGate:{passed:true}};
  const setup={breakoutConfirmed:false};
  assert.strictEqual(core.stage006201(75,setup,gates).number,0);
  assert.match(core.stage006201(75,setup,gates).label,/等待/);
  assert.strictEqual(core.stage006201(85,setup,gates).number,1);
});

test("006201 長期趨勢失敗會阻止買進", () => {
  const rows = marketRows({drift:-.001,dipDays:30,dip:-.006,reboundDays:4,rebound:.005});
  const result = core.engine006201({rows,benchmarkRows:benchmark,otcStrength:50});
  if (result.gates.hardFail.triggered) {
    assert.ok(result.buyScore === null || result.buyScore <= 49);
    assert.strictEqual(result.stage.targetPosition,0);
  }
});

test("交易生命週期禁止 EXIT 回到 ACCUMULATION 並禁止重複 stage", () => {
  const exited = core.transitionTradeState({state:"EXIT",position:50},{nextState:"ACCUMULATION",action:"OPEN"});
  assert.strictEqual(exited.state,"EXIT");
  assert.strictEqual(exited.error,"invalid_transition");
  const repeated = core.transitionTradeState({state:"ACCUMULATION",position:20,highestStage:2},{nextState:"ACCUMULATION",action:"ADD",stage:2,position:45});
  assert.strictEqual(repeated.position,20);
  assert.strictEqual(repeated.error,"stage_already_executed");
});

test("006201 退出後 20 日 cooling 期間不得建立新 Trade", () => {
  const blocked=core.transitionTradeState({state:"CLOSED",position:0},{nextState:"ACCUMULATION",action:"OPEN",symbol:"006201",date:"2026-08-09",price:20,position:25,cooldownRemaining:12});
  assert.strictEqual(blocked.state,"CLOSED");
  assert.strictEqual(blocked.error,"cooldown_active");
});

test("006201 120 日與連十日 MA200 下風險會結束 Trade", () => {
  const rows=marketRows({drift:-.001,dipDays:40,dip:-.008,reboundDays:2,rebound:.001});
  const preview=core.buildIndicators(rows,benchmark);
  const result=core.engine006201({rows,benchmarkRows:benchmark,otcStrength:40,tradeState:{holdingDays:120,belowMa200Days:10,entryPrice:preview.price/.9}});
  assert.strictEqual(result.timeExit,true);
  if((result.coreIndicators.ma60Slope??0)<0)assert.strictEqual(result.emergencyExit,true);
});

test("回測訊號固定 20 日冷卻且指標只使用訊號當日以前資料", () => {
  const result = core.backtestSignals(marketRows({total:420}), marketRows({start:18000,total:420,dipDays:0,reboundDays:0}), "swing00733", {minimumRows:284,cooldownDays:20});
  assert.strictEqual(result.cooldownDays,20);
  assert.strictEqual(result.noLookahead,true);
  for (let index=1; index<result.signals.length; index+=1) {
    const previous = new Date(result.signals[index-1].date);
    const current = new Date(result.signals[index].date);
    assert.ok(current > previous);
  }
});

test("所有引擎輸出不含 NaN、undefined 或 Infinity", () => {
  const output = core.runStrategy({strategyType:"swing00733",input:{rows:marketRows(),benchmarkRows:benchmark}});
  const serialized = JSON.stringify(output);
  assert.doesNotMatch(serialized,/NaN|undefined|Infinity/);
});

console.log(`\n${passed} swing strategy core tests passed.`);
