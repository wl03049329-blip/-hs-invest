"use strict";
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HSHomeTaiex = factory();
})(globalThis, function () {
  const schema = "HS_HOME_TAIEX_V1";
  const source = "TWSE/FMTQIK";
  const reportUrl = month => "https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?response=json&date=" + month.replace("-", "") + "01";
  const key = "hs.publicDisplay.taiex.v1";
  const day = s => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
  const stamp = s => typeof s === "string" && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
  const integer = Number.isSafeInteger;
  function valid(x, now = Date.now()) {
    if (!x || x.schema !== schema || x.indicator !== "TAIEX" || x.source !== source || x.validation !== "VERIFIED" ||
        !day(x.trade_date) || !day(x.previous_trade_date) || x.previous_trade_date >= x.trade_date ||
        ![x.close_cents, x.previous_close_cents, x.change_cents].every(integer) ||
        x.close_cents <= 0 || x.previous_close_cents <= 0 || x.close_cents - x.previous_close_cents !== x.change_cents ||
        !stamp(x.retrieved_at) || !stamp(x.updated_at) || x.retrieved_at > x.updated_at ||
        Date.parse(x.retrieved_at) < Date.parse(x.trade_date + "T13:30:00+08:00") || Date.parse(x.updated_at) > now) return false;
    const urls = [...new Set([x.trade_date, x.previous_trade_date].map(d => reportUrl(d.slice(0, 7))))];
    return Array.isArray(x.evidence) && x.evidence.length === urls.length && urls.every(url =>
      x.evidence.filter(e => e?.url === url && typeof e.sha256 === "string" && /^[0-9a-f]{64}$/.test(e.sha256)).length === 1);
  }
  function select(old, incoming, now = Date.now()) {
    if (!valid(old, now)) old = null;
    if (!valid(incoming, now)) return old;
    // Treat conflicting values for the same official trade date as an audit
    // incident. Never replace a last-known-good observation implicitly.
    return !old || incoming.trade_date > old.trade_date ? incoming : old;
  }
  const fmt = new Intl.NumberFormat("zh-TW", {minimumFractionDigits: 2, maximumFractionDigits: 2});
  function view(x, now = Date.now()) {
    if (!valid(x, now)) return null;
    const delta = x.change_cents, sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
    const percent = Math.abs(delta) / x.previous_close_cents * 100;
    return {
      value: fmt.format(x.close_cents / 100),
      change: (delta > 0 ? "▲ " : delta < 0 ? "▼ " : "") + sign + fmt.format(Math.abs(delta) / 100) +
        " 點（" + sign + fmt.format(percent) + "%）",
      tone: delta > 0 ? "rise" : delta < 0 ? "fall" : "flat",
      date: x.trade_date,
    };
  }
  return { schema, source, reportUrl, day, key, valid, select, view };
});
