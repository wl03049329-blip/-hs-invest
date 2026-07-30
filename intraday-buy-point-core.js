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
  const rowVolume = row => row?.Trading_Volume ?? row?.trading_volume ?? row?.volume ?? null;

  function buildProvisionalRows(officialRows, quote, formalDate) {
    const rows = Array.isArray(officialRows) ? officialRows.map(row => ({...row})) : [];
    const price = finite(quote?.price);
    const quoteDate = /^\d{4}-\d{2}-\d{2}$/.test(String(quote?.date || "")) ? String(quote.date) : formalDate;
    if (price === null || price <= 0 || !quoteDate || !rows.length) return null;
    const high = finite(quote?.high), low = finite(quote?.low), volume = finite(quote?.volume);
    const hasHighLow = high !== null && high > 0 && low !== null && low > 0 &&
      high >= low && price <= high * 1.001 && price >= low * 0.999;
    const hasVolume = volume !== null && volume >= 0;
    const provisional = {
      date: quoteDate,
      close: price,
      max: hasHighLow ? high : price,
      min: hasHighLow ? low : price,
      Trading_Volume: hasVolume ? volume : null,
      quote_time: String(quote?.quoteTime || "")
    };
    const last = rows.at(-1);
    if (last.date === quoteDate) {
      provisional.max = hasHighLow ? high : Math.max(Number(last.max ?? last.close), price);
      provisional.min = hasHighLow ? low : Math.min(Number(last.min ?? last.close), price);
      if (!hasVolume) provisional.Trading_Volume = rowVolume(last);
      rows[rows.length - 1] = {...last, ...provisional};
    } else if (quoteDate > last.date) {
      rows.push(provisional);
    } else {
      return null;
    }
    return {rows, hasHighLow, hasVolume, quoteDate, coverage: 70 + (hasHighLow ? 16 : 0) + (hasVolume ? 14 : 0)};
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

  return {buildProvisionalRows, mergeStopConfirmation, scoreDelta};
});
