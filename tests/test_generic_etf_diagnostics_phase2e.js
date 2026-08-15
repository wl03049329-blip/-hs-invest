"use strict";
const assert=require("assert");
const fs=require("fs");
const path=require("path");
const diagnostics=require("../generic-etf-diagnostics.js");

function sessions(count,{start="2024-01-02",base=100,drift=.001,shock=0}={}){
  const rows=[],date=new Date(`${start}T00:00:00Z`);let price=base;
  while(rows.length<count){
    if(date.getUTCDay()!==0&&date.getUTCDay()!==6){
      const index=rows.length,wave=Math.sin(index/11)*.003,drop=index>count-18?shock:0;
      price=Math.max(1,price*(1+drift+wave-drop));
      rows.push({date:date.toISOString().slice(0,10),open:price*.997,max:price*1.008,min:price*.992,close:price,Trading_Volume:1000000+index*100});
    }
    date.setUTCDate(date.getUTCDate()+1);
  }
  return rows;
}

const market=sessions(330,{base:100,drift:.0006});
const equity=sessions(330,{base:35,drift:.00075});
const meta=(id,name=id,category="equity_broad")=>({id,name,category,strategyType:"equity",type:"台灣股票"});

function run(){
  assert.deepStrictEqual(diagnostics.REQUIREMENTS,{ma43:43,ma87:87,ma200:200,weeklyKdjWeeks:9,dd52:252,rs20:21,rs60:61,volumeMa20:20});

  const t0050=diagnostics.evaluate({symbol:"0050",metadata:meta("0050"),rows:market,benchmark:"MARKET_BASELINE"});
  assert.strictEqual(t0050.maturityState,"MATURE");
  assert.ok(Number.isFinite(t0050.trend.ma43)&&Number.isFinite(t0050.trend.ma87)&&Number.isFinite(t0050.trend.ma200));
  assert.strictEqual(t0050.rs.state,"市場基準");

  for(const id of ["0056","00919","00935"]){
    const result=diagnostics.evaluate({symbol:id,metadata:meta(id),rows:equity,benchmark:"0050",benchmarkRows:market});
    assert.strictEqual(result.maturityState,"MATURE",`${id} should be mature`);
    assert.ok(result.trend&&result.pullback&&result.weekly&&result.rs&&result.recovery);
    assert.ok(!Object.hasOwn(result,"score")&&!Object.hasOwn(result,"genericSwingScore"));
  }

  for(const id of ["00757","00830"]){
    const result=diagnostics.evaluate({symbol:id,metadata:meta(id,"海外科技","equity_overseas"),rows:equity});
    assert.strictEqual(result.maturityState,"BENCHMARK_UNAVAILABLE");
    assert.strictEqual(result.rs.state,"—");
    assert.strictEqual(result.rs.benchmark,null);
    assert.match(result.rs.reason,/尚未完成驗證/);
  }

  const bond=diagnostics.evaluate({symbol:"00679B",metadata:{id:"00679B",name:"元大美債20年",category:"bond_government_long",strategyType:"bond",type:"債券ETF"},rows:equity});
  assert.strictEqual(bond.maturityState,"UNSUPPORTED_ASSET_CLASS");
  const young=diagnostics.evaluate({symbol:"00410A",metadata:meta("00410A","新掛牌主動ETF","active_equity"),rows:sessions(30)});
  assert.strictEqual(young.maturityState,"INSUFFICIENT_HISTORY");
  const partial=diagnostics.evaluate({symbol:"00999",metadata:meta("00999"),rows:sessions(120)});
  assert.strictEqual(partial.maturityState,"PARTIAL");
  assert.strictEqual(partial.summary,null);
  const waiting=diagnostics.evaluate({symbol:"009815",metadata:meta("009815"),rows:equity});
  assert.strictEqual(waiting.maturityState,"WAIT_NATIVE");

  assert.strictEqual(diagnostics.APPROVED_BENCHMARKS["00757"],undefined);
  assert.strictEqual(diagnostics.APPROVED_BENCHMARKS["00830"],undefined);
  assert.strictEqual(diagnostics.APPROVED_BENCHMARKS["0056"],"0050");

  const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
  assert.match(html,/generic-etf-diagnostics\.js/);
  assert.match(html,/Promise\.allSettled\(ids\.map\(one\)\)/);
  assert.match(html,/watchDiagnosticModal/);
  assert.match(html,/加入你想追蹤的 ETF，查看趨勢、拉回、動能與相對強弱狀態/);
  assert.doesNotMatch(html,/Generic Swing Score/);
  const production=fs.readFileSync(path.join(__dirname,"..","backtest","long-term","final-core-score-v1.js"),"utf8");
  assert.match(production,/weeklyJ[^\n]{0,80}30|WEEKLY_J[^\n]{0,80}30/i);
  assert.match(production,/dd52[^\n]{0,80}55|DD52[^\n]{0,80}55/);
  assert.match(production,/crash[^\n]{0,80}15|CRASH[^\n]{0,80}15/i);
  console.log("Phase 2E diagnostics fixtures: 0050/0056/00757/00830/00919/00935/00679B/00410A PASS");
}
run();
