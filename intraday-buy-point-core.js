(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HSIntradayBuyPointCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const finite = value => {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  function quoteAsOf(quote) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(quote?.date || "")) ? String(quote.date) : "";
    const rawTime = String(quote?.quoteTime || "");
    const time = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(rawTime)
      ? rawTime.length === 5 ? `${rawTime}:00` : rawTime : "";
    return date && time ? `${date}T${time}+08:00` : "";
  }

  function isFreshIntradayQuote(quote, now = new Date(), maxAgeMinutes = 20) {
    const asOf = quoteAsOf(quote);
    const timestamp = Date.parse(asOf), current = now instanceof Date ? now.getTime() : Date.parse(now);
    if (!asOf || !Number.isFinite(timestamp) || !Number.isFinite(current)) return false;
    const age = current - timestamp;
    return age >= -60_000 && age <= Math.max(1, Number(maxAgeMinutes) || 20) * 60_000;
  }

  function buildProvisionalRows(officialRows, quote, formalDate) {
    const sourceRows = Array.isArray(officialRows) ? officialRows.map(row => ({...row})) : [];
    const price = finite(quote?.price);
    const quoteDate = /^\d{4}-\d{2}-\d{2}$/.test(String(quote?.date || "")) ? String(quote.date) : formalDate;
    if (price === null || price <= 0 || !quoteDate || !sourceRows.length) return null;
    const rows = sourceRows.filter(row => String(row?.date || "") < quoteDate);
    if (!rows.length) return null;
    const open = finite(quote?.open), high = finite(quote?.high), low = finite(quote?.low), volume = finite(quote?.volume);
    const hasHighLow = high !== null && high > 0 && low !== null && low > 0 &&
      high >= low && price <= high * 1.001 && price >= low * 0.999;
    const hasVolume = volume !== null && volume >= 0;
    const provisional = {
      date: quoteDate,
      open: open !== null && open > 0 ? open : null,
      close: price,
      max: hasHighLow ? high : price,
      min: hasHighLow ? low : price,
      Trading_Volume: hasVolume ? volume : null,
      quote_time: String(quote?.quoteTime || ""),
      as_of: quoteAsOf({...quote, date: quoteDate})
    };
    rows.push(provisional);
    return {rows, hasHighLow, hasVolume, quoteDate, asOf: provisional.as_of, finalizedThrough: rows.at(-2)?.date || "", coverage: 70 + (hasHighLow ? 16 : 0) + (hasVolume ? 14 : 0)};
  }

  function mergeStopConfirmation(formal, provisional, options = {}) {
    const hasHighLow = options.hasHighLow === true;
    const hasVolume = options.hasVolume === true;
    const formalByKey = new Map((formal?.components || []).map(item => [item.key, item]));
    const priceKeys = new Set(["j_rebound", "kd_turn", "ma5", "ma10", "momentum"]);
    const components = (provisional?.components || []).map(item => {
      if (priceKeys.has(item.key) || item.key === "low_stable" && hasHighLow ||
          item.key === "volume_contract" && hasVolume) return {...item};
      return {...(formalByKey.get(item.key) || item)};
    });
    const score = Math.round(Math.min(100, Math.max(0, components.reduce((sum, item) => {
      const points = finite(item.points);
      return sum + (points === null ? 0 : points);
    }, 0))));
    return {
      ...provisional,
      score,
      label: typeof options.stopLabel === "function" ? options.stopLabel(score) : "",
      components,
      intradayCoverage: 70 + (hasHighLow ? 16 : 0) + (hasVolume ? 14 : 0)
    };
  }

  function scoreDelta(intradayScore, formalScore) {
    const intraday = finite(intradayScore), formal = finite(formalScore);
    return intraday === null || formal === null ? null : Math.round(intraday - formal);
  }

  function buildCoreAudit(input = {}) {
    const decision = input.decision || {};
    const factors = decision.coreFactors || {};
    const snapshotSlot = String(input.snapshotSlot || "");
    const tradingDate = String(input.tradingDate || "");
    const symbol = String(input.symbol || "");
    return {
      symbol,
      snapshot_slot: snapshotSlot,
      cache_key: symbol && tradingDate && snapshotSlot
        ? `${symbol}:${tradingDate}:${snapshotSlot.replace(":", "")}` : "",
      price: finite(input.price),
      price_as_of: String(input.priceAsOf || ""),
      weekly_j_raw: finite(input.weeklyJRaw),
      weekly_j_score: finite(factors.weeklyJ?.score),
      bias40w_raw: finite(input.bias40wRaw),
      bias40w_score: finite(input.bias40wScore),
      drawdown_52w_raw: finite(input.drawdown52wRaw),
      drawdown_52w_score: finite(factors.dd52?.score),
      crash_raw: finite(factors.crash?.raw),
      crash_score: finite(factors.crash?.score),
      core_factors: factors,
      available_weight: finite(decision.availableWeight),
      final_core_score: finite(decision.coreScore),
      rank: finite(input.rank),
      calculated_at: String(input.calculatedAt || ""),
      data_as_of: String(input.dataAsOf || input.priceAsOf || ""),
      status: input.status === "SUCCESS" ? "SUCCESS" : "UPDATE_FAILED"
    };
  }

  function validateCoreBatch(entries, expectedSymbols, tradingDate, snapshotSlot) {
    const expected = [...new Set((expectedSymbols || []).map(String))].sort();
    const rows = Array.isArray(entries) ? entries : [];
    if (!expected.length || rows.length !== expected.length) return {verified:false, status:"UPDATE_FAILED", dataAsOf:""};
    const symbols = rows.map(item => String(item?.symbol || "")).sort();
    if (symbols.some((symbol, index) => symbol !== expected[index])) return {verified:false, status:"UPDATE_FAILED", dataAsOf:""};
    const times = [];
    for (const item of rows) {
      const audit = item?.audit || {};
      const asOf = Date.parse(audit.data_as_of);
      if (audit.status !== "SUCCESS" || audit.snapshot_slot !== snapshotSlot ||
          !audit.cache_key.startsWith(`${item.symbol}:${tradingDate}:`) || !Number.isFinite(asOf)) {
        return {verified:false, status:"UPDATE_FAILED", dataAsOf:""};
      }
      times.push(asOf);
    }
    return {verified:true, status:"SUCCESS", dataAsOf:new Date(Math.min(...times)).toISOString()};
  }

  return {quoteAsOf, isFreshIntradayQuote, buildProvisionalRows, mergeStopConfirmation, scoreDelta, buildCoreAudit, validateCoreBatch};
});
