"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const root=path.resolve(__dirname,"..");
const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
const css=fs.readFileSync(path.join(root,"formal-black-gold.css"),"utf8");

assert.match(html,/const watchDiagnosticState=new Map\(\)/);
assert.match(html,/const etfDataPromises=new Map\(\)/);
assert.match(html,/if\(etfDataPromises\.has\(symbol\)\)return etfDataPromises\.get\(symbol\)/);
assert.match(html,/Promise\.allSettled\(ids\.map\(one\)\)/);
assert.match(html,/watchDiagnosticState\.set\(meta\.id,\{kind:"error"/);
assert.match(html,/ETF 已保留在自選清單/);
assert.match(html,/正在取得歷史資料/);
assert.match(html,/if\(watchlist\.length>=20\)/);
assert.match(html,/function moveWatch\(index,delta\)/);
assert.match(html,/watchlist\.splice\(index,1\)/);
assert.doesNotMatch(html,/清單至少要保留 1 檔 ETF/);
assert.match(html,/localStorage\.setItem\(WATCHLIST_STORAGE_KEY,JSON\.stringify\(watchlist\)\)/);

const modeHandler=html.match(/document\.querySelectorAll\("\[data-radar-mode\]"\)[\s\S]*?\}\)\);/);
assert.ok(modeHandler);
assert.doesNotMatch(modeHandler[0],/\bload\s*\(/);
const modalBody=html.slice(html.indexOf("function openWatchDiagnostic"),html.indexOf("function closeWatchDiagnostic"));
assert.match(modalBody,/MA43/);assert.match(modalBody,/MA87/);assert.match(modalBody,/MA200/);assert.doesNotMatch(modalBody,/MA284/);
assert.match(modalBody,/尚無經驗證的比較基準/);
assert.doesNotMatch(modalBody,/genericSwingScore|Generic Swing|\/100/);

assert.match(css,/\.watchDiagnostics\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
assert.match(css,/@media\(max-width:760px\)\{\.watchDiagnostics\{grid-template-columns:1fr\}/);
assert.match(css,/\.watchDiagnosticSheet\{width:min\(100%,720px\)\}/);
assert.match(html,/coreScoreSheet watchDiagnosticSheet/);

const oneSource=html.match(/function one\(id\)\{[\s\S]*?\n\}/)?.[0];
assert.ok(oneSource,"session request wrapper must exist");
const context={etfDataPromises:new Map(),calls:0,loadEtfData:async id=>{context.calls++;await new Promise(resolve=>setTimeout(resolve,5));return{id}}};
vm.createContext(context);vm.runInContext(`${oneSource};this.one=one`,context);
Promise.all([context.one("0050"),context.one("0050"),context.one("0050")]).then(()=>{
  assert.equal(context.calls,1,"same symbol must share one in-flight request");
  console.log("PASS Phase 2E watchlist add/remove/reorder/limit/storage/mode/loading/error/isolation/RWD/dedupe guards");
}).catch(error=>{console.error(error);process.exitCode=1});
