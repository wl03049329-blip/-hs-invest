(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HSValuationCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const clamp = (value, min = 0, max = 100) => Math.min(max, Math.max(min, value));
  const finite = value => {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };

  function positiveMetric(value, maximum) {
    const number = finite(value);
    return number !== null && number > 0 && number <= maximum ? number : null;
  }

  function interpolate(value, points) {
    const number = finite(value);
    if (number === null) return null;
    const ordered = [...points].sort((a, b) => a[0] - b[0]);
    if (number <= ordered[0][0]) return ordered[0][1];
    if (number >= ordered.at(-1)[0]) return ordered.at(-1)[1];
    for (let index = 1; index < ordered.length; index++) {
      const left = ordered[index - 1], right = ordered[index];
      if (number <= right[0]) {
        const ratio = (number - left[0]) / (right[0] - left[0]);
        return left[1] + (right[1] - left[1]) * ratio;
      }
    }
    return null;
  }

  function validateValuationItem(raw) {
    if (!raw || typeof raw !== "object") return null;
    const currentPe = positiveMetric(raw.current_pe, 300);
    const forwardPe = positiveMetric(raw.forward_pe, 300);
    const pb = positiveMetric(raw.pb, 100);
    const earningsGrowth = finite(raw.earnings_growth);
    const peg = positiveMetric(raw.peg, 20);
    const score = finite(raw.valuation_score);
    const sourceDate = String(raw.source_date || "");
    const sourceUpdated = Date.parse(`${sourceDate}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sourceDate) || !Number.isFinite(sourceUpdated)) return null;
    if (sourceUpdated > Date.now() + 2 * 86400000 || Date.now() - sourceUpdated > 120 * 86400000) return null;
    const scoreStatus = String(raw.score_status || "unavailable");
    if ([currentPe, forwardPe, pb, peg].every(value => value === null) && scoreStatus !== "benchmark_background") return null;
    return {
      benchmark: String(raw.benchmark || ""),
      primaryProxy: String(raw.primary_proxy || ""),
      secondaryProxy: String(raw.secondary_proxy || ""),
      currentPe,
      forwardPe,
      pb,
      earningsGrowth: earningsGrowth !== null && earningsGrowth >= -100 && earningsGrowth <= 500 ? earningsGrowth : null,
      peg,
      score: score !== null && score >= 0 && score <= 100 ? Math.round(score) : null,
      pePercentile: finite(raw.pe_percentile),
      forwardPePercentile: finite(raw.forward_pe_percentile),
      historySampleCount: Math.max(0, Math.trunc(finite(raw.history_sample_count) || 0)),
      historyStatus: String(raw.history_status || "building"),
      sourceName: String(raw.source_name || ""),
      sourceUrl: /^https:\/\//.test(String(raw.source_url || "")) ? String(raw.source_url) : "",
      sourceDate,
      isProxy: raw.is_proxy === true,
      proxyNote: String(raw.proxy_note || ""),
      proxyLevel: String(raw.proxy_level || "primary"),
      scoreStatus,
      valuationCoverage: Math.max(0, Math.min(100, finite(raw.valuation_coverage) || 0)),
      returnOnEquity: finite(raw.return_on_equity)
    };
  }

  function technicalLowScore(input = {}) {
    const j = finite(input.j);
    const jPercentile = finite(input.jPercentile);
    const fromHigh = finite(input.fromHigh);
    const drawdownPercentile = finite(input.drawdownPercentile);
    const price = positiveMetric(input.price, Number.MAX_SAFE_INTEGER);
    const ma60 = positiveMetric(input.ma60, Number.MAX_SAFE_INTEGER);
    const ma200 = positiveMetric(input.ma200, Number.MAX_SAFE_INTEGER);
    const values = {
      jLevel: j === null ? null : clamp((30 - j) / 60 * 100),
      jHistory: jPercentile === null ? null : clamp(100 - jPercentile),
      drawdown: fromHigh === null ? null : clamp(Math.abs(Math.min(0, fromHigh)) / 35 * 100),
      drawdownHistory: drawdownPercentile === null ? null : clamp(drawdownPercentile),
      belowMa60: price === null || ma60 === null ? null : clamp(50 + (ma60 / price - 1) * 200),
      belowMa200: price === null || ma200 === null ? null : clamp(50 + (ma200 / price - 1) * 200)
    };
    const weights = {jLevel:20, jHistory:20, drawdown:20, drawdownHistory:20, belowMa60:10, belowMa200:10};
    const available = Object.entries(weights).filter(([key]) => values[key] !== null);
    const availableWeight = available.reduce((sum, [, weight]) => sum + weight, 0);
    const score = availableWeight >= 50
      ? Math.round(available.reduce((sum, [key, weight]) => sum + values[key] * weight, 0) / availableWeight)
      : null;
    return {
      score,
      coverage: availableWeight,
      components: Object.entries(weights).map(([key, weight]) => ({key, weight, value: values[key]}))
    };
  }

  function valuationScore(input = {}) {
    const currentPe = positiveMetric(input.currentPe, 300);
    const forwardPe = positiveMetric(input.forwardPe, 300);
    const pb = positiveMetric(input.pb, 100);
    const growth = finite(input.earningsGrowth);
    const peg = positiveMetric(input.peg, 20);
    const pePercentile = finite(input.pePercentile);
    const forwardPePercentile = finite(input.forwardPePercentile);
    const values = {
      currentPe: currentPe === null ? null : interpolate(currentPe, [[8,95],[15,82],[25,65],[40,45],[60,25],[100,10]]),
      forwardPe: forwardPe === null ? null : interpolate(forwardPe, [[8,95],[15,82],[25,66],[35,50],[50,32],[80,12]]),
      peHistory: pePercentile === null ? null : clamp(100 - pePercentile),
      forwardPeHistory: forwardPePercentile === null ? null : clamp(100 - forwardPePercentile),
      earningsGrowth: growth === null ? null : interpolate(growth, [[-20,10],[0,30],[10,48],[20,62],[40,78],[80,90],[150,95]]),
      peg: peg === null ? null : interpolate(peg, [[0.4,95],[0.8,85],[1.2,74],[1.8,58],[2.5,40],[4,20],[8,8]]),
      pb: pb === null ? null : interpolate(pb, [[0.8,95],[1.5,85],[3,70],[6,50],[10,32],[20,12],[40,5]])
    };
    const weights = {currentPe:15, forwardPe:25, peHistory:15, forwardPeHistory:10, earningsGrowth:20, peg:10, pb:5};
    const available = Object.entries(weights).filter(([key]) => values[key] !== null);
    const availableWeight = available.reduce((sum, [, weight]) => sum + weight, 0);
    return {
      score: availableWeight >= 50
        ? Math.round(available.reduce((sum, [key, weight]) => sum + values[key] * weight, 0) / availableWeight)
        : null,
      coverage: availableWeight,
      components: Object.entries(weights).map(([key, weight]) => ({key, weight, value: values[key]}))
    };
  }

  return {validateValuationItem, technicalLowScore, valuationScore, positiveMetric};
});
