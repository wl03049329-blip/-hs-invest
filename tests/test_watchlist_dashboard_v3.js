"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
const css=fs.readFileSync(path.join(__dirname,"..","formal-black-gold.css"),"utf8");
const formalSource=html.match(/const LONG_RADAR_SCORED_CODES=new Set\((\[[^\]]+\])\)/);assert.ok(formalSource,"production Formal source must exist");
const formalSymbols=new Set(JSON.parse(formalSource[1]));
const validation=require(path.join(__dirname,"..","c4-validation-metadata.js")).createResolver({formalC4Source:{isFormalC4Symbol:symbol=>formalSymbols.has(symbol)}});
const panel=html.slice(html.indexOf('<article id="watchPanel"'),html.indexOf('<div class="sectionHead radarDetailHeading"'));
const modal=html.slice(html.indexOf('<div id="watchModal"'),html.indexOf('<div id="watchDiagnosticModal"'));

assert.ok(panel.indexOf('id="watchDiagnostics"')<panel.indexOf('id="watchManagePanel"'));
assert.ok(panel.indexOf('id="watchManagePanel"')<panel.indexOf('id="watchAdHocForm"'));
assert.match(panel,/id="watchCount"/);
assert.match(panel,/id="manageWatchBtn"/);
assert.match(panel,/id="watchManagePanel"[^>]*hidden/);
assert.doesNotMatch(panel+modal,/watchStrategyMode|data-buy-plan-mode|data-watch-strategy|使用核心|長期核心|波段操作|使用預設模型|積極|均衡|保守|AD_HOC/);
assert.match(html,/確定要移除全部自選嗎/);
assert.match(html,/此操作只會移除追蹤清單，不會影響個人持股資料/);
assert.match(html,/allowListedAsset:true/);
assert.match(css,/#watchModal\{z-index:100\}/,"add sheet must stay above mobile bottom navigation (z-index 80)");
assert.match(html,/currentFormalCoreScoreForSymbol\(symbol\)/);

function source(name,next){const start=html.indexOf(`function ${name}(`);assert.ok(start>=0,name);return html.slice(start,html.indexOf(`function ${next}(`,start))}
const context={
  HSFinalCoreProduction:{SUPPORTED_TICKERS:["0050","00662","00757","00830","00935"]},
  window:{HSC4ValidationMetadata:validation},
  currentFormalCoreScoreForSymbol:symbol=>({available:true,score:39.4,display_score:39,trading_date:"2026-09-24"}),
  esc:value=>String(value??""),fmt:value=>String(value),signed:value=>String(value),
  watchDirectionIcon:()=>"↑",adHocReasonText:()=>"歷史行情不足，尚無法完整計算 C4。"
};
context.HSFinalCoreProduction.labelFor=()=>({label:"回檔訊號出現"});
vm.createContext(context);
vm.runInContext(source("watchUnavailableState","adHocComponentRow"),context);
vm.runInContext(source("watchDiagnosticCard","renderWatchDiagnostics"),context);
assert.equal(validation.resolve("00830").label,"正式");
assert.equal(validation.resolve("009815").label,"參考");
assert.equal(validation.resolve("00635U").label,"參考");
assert.equal(context.watchUnavailableState("INSUFFICIENT_DAILY_HISTORY"),"DATA_INSUFFICIENT");
assert.equal(context.watchUnavailableState("PRICE_DATA_UNAVAILABLE"),"DATA_UNAVAILABLE");
assert.equal(context.watchScoreForDisplay("00830",{available:true,score:55,displayScore:55}).score,39.4,"formal watchlist score must use canonical selection");
assert.equal(context.watchScoreForDisplay("00635U",{available:true,score:23,displayScore:23}).score,23);

const diagnostic={price:70.15,changePct:1.45,dataAsOf:"2026-09-24",maturityState:"MATURE",trend:{state:"轉弱"},pullback:{state:"正常拉回"},weekly:{j:108.46,direction:"RISING"},recovery:{available:true,state:"確認回升"},rs:{available:false,state:"—"},summary:"趨勢轉弱。"};
const reference=context.watchDiagnosticCard({id:"00635U",name:"黃金ETF"},{kind:"ready",diagnostic,adHoc:{available:true,displayScore:23,tier:"一般持有",score:23}});
assert.match(reference,/HS C4/);assert.match(reference,/一般持有/);assert.match(reference,/參考 ⓘ/);
assert.match(reference,/趨勢/);assert.match(reference,/拉回/);assert.match(reference,/週 J/);assert.match(reference,/止跌/);
assert.doesNotMatch(reference,/<dt>RS<\/dt>|不支援此資產類型|AD_HOC/);
const insufficient=context.watchDiagnosticCard({id:"00635U",name:"黃金ETF"},{kind:"ready",diagnostic,adHoc:{available:false,reason:"INSUFFICIENT_DAILY_HISTORY"}});
assert.match(insufficient,/HS C4 暫無分數/);assert.match(insufficient,/data-score-state="DATA_INSUFFICIENT"/);
console.log("PASS watchlist dashboard order, legacy UI removal, validation status, canonical formal source, reference score, incomplete history, optional metrics");
