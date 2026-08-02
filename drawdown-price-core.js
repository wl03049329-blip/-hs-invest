(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HSDrawdownPriceCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const LEVELS = Object.freeze([5,10,15,20,25,30,35,40,45,50,60,70]);
  const finite = value => {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };

  function targetPrice(referenceHigh, drawdownPercent) {
    const high = finite(referenceHigh), level = finite(drawdownPercent);
    if (high === null || high <= 0 || level === null || level < 0 || level >= 100) return null;
    return high * (1 - level / 100);
  }

  function targets(referenceHigh) {
    return LEVELS.map(level => ({level, price:targetPrice(referenceHigh, level), label:level === 20 ? "技術性熊市幅度" : level === 50 ? "腰斬區" : ""}));
  }

  function drawdownPercent(price, referenceHigh) {
    const current = finite(price), high = finite(referenceHigh);
    return current === null || current <= 0 || high === null || high <= 0 ? null : (current / high - 1) * 100;
  }

  function labelFor(drawdown, instrumentType = "security") {
    const value = finite(drawdown);
    if (value === null) return "資料不足";
    if (value > -5) return "高檔附近";
    if (value > -10) return "一般回檔";
    if (value > -15) return "修正區";
    if (value > -20) return "深度修正";
    if (value > -30) return instrumentType === "index" ? "技術性熊市" : "進入技術性熊市幅度";
    if (value > -40) return "重大跌勢";
    if (value > -50) return "極端熊市幅度";
    return "腰斬區";
  }

  function currentLevel(drawdown) {
    const value = finite(drawdown);
    if (value === null || value > -5) return 0;
    const magnitude = Math.abs(value);
    return LEVELS.filter(level => magnitude >= level).at(-1) || 0;
  }

  function nextLevel(drawdown) {
    const current = currentLevel(drawdown);
    return LEVELS.find(level => level > current) ?? null;
  }

  function priceStats(rows, currentPrice) {
    const clean = (Array.isArray(rows) ? rows : []).filter(row => /^\d{4}-\d{2}-\d{2}$/.test(String(row?.date || "")))
      .map(row => ({date:String(row.date), high:finite(row.max ?? row.high ?? row.close), close:finite(row.close)}))
      .filter(row => row.high !== null && row.high > 0 && row.close !== null && row.close > 0)
      .sort((a,b) => a.date.localeCompare(b.date));
    if (!clean.length) return null;
    const highRow = list => list.reduce((best,row) => !best || row.high > best.high ? row : best, null);
    const allTime = highRow(clean);
    const high52 = highRow(clean.slice(-252));
    const price = finite(currentPrice) ?? clean.at(-1).close;
    return {price, latestDate:clean.at(-1).date, high52:high52.high, high52Date:high52.date, allTimeHigh:allTime.high, allTimeHighDate:allTime.date};
  }

  function roundPrice(value, decimals = 2) {
    const number = finite(value);
    if (number === null) return null;
    const places = Number.isInteger(decimals) && decimals >= 0 && decimals <= 4 ? decimals : 2;
    return Number(number.toFixed(places));
  }

  return {LEVELS, targetPrice, targets, drawdownPercent, labelFor, currentLevel, nextLevel, priceStats, roundPrice};
});
