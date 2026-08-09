const fs = require("fs");
const assert = require("assert");
const html = fs.readFileSync("index.html", "utf8");
const proxy = JSON.parse(fs.readFileSync("valuation-proxy-map.json", "utf8"));

for (const code of ["0050","00830","00662","009815","00935","00631L","00733","006201"]) {
  assert(html.includes(`id:"${code}"`), `featured list missing ${code}`);
}
for (const text of [
  "長期核心","波段操作","高點回檔價位","查看回檔價位",
  "盤中暫定新高","正式 52 週高點待收盤後確認","drawdownApplyCustom"
]) assert(html.includes(text), `missing integration text: ${text}`);
assert(fs.readFileSync("strategy-mode-core.js", "utf8").includes("仍在下跌，採較小批次加碼"));

assert(html.includes("localStorage.setItem(WATCHLIST_STORAGE_KEY"));
assert(html.includes("latestPublicQuotes=new Map(quotes)"));
assert(html.includes("x.high52=x.formalState?.high52??x.high52"));
assert(html.includes("quoteDate<x.formalState.date"));

assert.strictEqual(proxy.items["00662"].benchmark, "NASDAQ-100 Index");
assert.strictEqual(proxy.items["009815"].benchmark, "彭博TPEx Magnificent 7 Plus美國大型科技指數");
assert(proxy.items["009815"].proxy_note.includes("不代表指數完全一致"));
assert(proxy.items["00935"].benchmark.includes("臺灣創新科技50指數"));
assert.strictEqual(proxy.items["00935"].source_type, "reference_only");

for (const forbidden of ["必買","抄底","穩賺","最低點"]) {
  assert(!fs.readFileSync("strategy-mode-core.js", "utf8").includes(forbidden));
}

console.log("PASS strategy, valuation proxy and drawdown UI integration");
