"use strict";

// Isolated observation calculator. No publisher, ranking, file writes or LIVE state.
const { cleanRows, scoreRows, SCORE_VERSION, validIntradaySlot } = require("../scripts/build_intraday_core_snapshots.js");
const SYMBOLS = ["0050","00662","00757","00830","00935"];
const SUSPENSION_SOURCE = "https://www.twse.com.tw/zh/ETFortune/announcement?company=A00010&date=20260910&fund=00662&seq=1&type=all";
const SOURCE = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp";
const positive = x => typeof x === "number" && Number.isFinite(x) && x > 0;

function observations({ tradingDate, slot, now, marketState, rows, histories, previousSession }) {
  const taipei = new Date(Date.parse(now) + 28800000);
  if (typeof now !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/.test(now)
      || !Number.isFinite(+taipei) || taipei.toISOString().slice(0,10) !== tradingDate) throw Error("INVALID_OBSERVATION_DATE");
  const clock = taipei.toISOString().slice(11,19);
  const items = { "009815": { status:"WAIT_NATIVE" } };
  for (const symbol of SYMBOLS) {
    const set = status => { items[symbol] = {status}; };
    if (symbol === "00662" && tradingDate >= "2026-11-11" && tradingDate <= "2026-11-16") {
      items[symbol] = {status:"SPLIT_SUSPENDED", source:SUSPENSION_SOURCE};
      continue;
    }
    // This candidate has no reviewed resumed-split input gate yet.
    if (symbol === "00662" && tradingDate >= "2026-11-17") { set("SPLIT_RESUMPTION_UNVERIFIED"); continue; }
    if (marketState !== "OPEN" || clock < "09:00:00" || clock >= "13:25:00" || !validIntradaySlot(slot)) { set("OFF_SESSION"); continue; }
    const q = rows?.[symbol];
    if (!q) { set("QUOTE_UNAVAILABLE"); continue; }
    if (q.code !== symbol || q.market !== "TWSE" || q.source !== SOURCE || q.price_field !== "z") { set("QUOTE_SOURCE_INVALID"); continue; }
    if (q.date !== tradingDate) { set("QUOTE_DATE_INVALID"); continue; }
    if (q.volume === 0) { set("WAITING_FIRST_TRADE"); continue; }
    if (![q.price,q.open,q.high,q.low,q.volume].every(positive) || q.low > Math.min(q.open,q.price) || q.high < Math.max(q.open,q.price)) { set("QUOTE_INCOMPLETE"); continue; }
    if (!/^\d{2}:[0-5]\d:[0-5]\d$/.test(q.quote_time || "") || q.quote_time < "09:00:00" || q.quote_time >= "13:25:00") { set("QUOTE_TIME_INVALID"); continue; }
    const asOf = tradingDate + "T" + q.quote_time + "+08:00", age = Date.parse(now)-Date.parse(asOf);
    if (!Number.isFinite(age) || age < 0) { set("QUOTE_TIME_INVALID"); continue; }
    if (age > 600000) { set("QUOTE_STALE"); continue; }
    try {
      const history = cleanRows(histories?.[symbol], previousSession);
      if (!(previousSession < tradingDate) || history.length < 252 || history.at(-1)?.date !== previousSession
          || history.some((r,i)=>(i && r.date<=history[i-1].date) || r.min>Math.min(r.open,r.close) || r.max<Math.max(r.open,r.close))) { set("HISTORY_UNVERIFIED"); continue; }
      const result = scoreRows(symbol,history,{...q,quoteTime:q.quote_time},slot,now);
      if (result?.score_version !== SCORE_VERSION || !Number.isFinite(result.score) || result.score<0 || result.score>100) { set("CALCULATION_FAILED"); continue; }
      items[symbol] = {status:"OBSERVED",score:result.score,quote_as_of:asOf,source:"MIS_Z",trading_date:tradingDate};
    } catch { set("CALCULATION_FAILED"); }
  }
  return {schema_version:1,kind:"INTRADAY_OBSERVATION",trading_date:tradingDate,calculated_at:now,
          score_version:SCORE_VERSION,formal_eligible:false,items};
}

module.exports = { observations };
