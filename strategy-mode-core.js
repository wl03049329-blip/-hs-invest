(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HSStrategyModeCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MODES = Object.freeze({
    long_term_core: "長期核心模式",
    swing: "波段模式",
    user_selected: "預設模型"
  });
  const LONG_TERM_WEIGHTS = Object.freeze({
    weeklyKdj: 45, drawdown: 20, weeklyBias: 15, marketFear: 15, valuation: 5
  });
  const SWING_WEIGHTS = Object.freeze({
    stopConfirmation: 30, trendStrength: 25, technicalLow: 15, momentum: 10,
    historicalStats: 10, valuationBackground: 5, marketLiquidity: 5
  });

  const finite = value => {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  const clamp = (value, minimum = 0, maximum = 100) => Math.min(maximum, Math.max(minimum, value));

  function weightedScore(metrics, weights, minimumCoverage = 70) {
    const entries = Object.entries(weights);
    const totalWeight = entries.reduce((sum, [, weight]) => sum + weight, 0);
    const available = entries.filter(([key]) => finite(metrics[key]) !== null);
    const availableWeight = available.reduce((sum, [, weight]) => sum + weight, 0);
    const coverage = totalWeight ? availableWeight / totalWeight * 100 : 0;
    const breakdown = available.map(([key, weight]) => ({
      key, weight, value: clamp(finite(metrics[key])),
      contribution: clamp(finite(metrics[key])) * weight / availableWeight
    }));
    return {
      score: coverage >= minimumCoverage ? Math.round(clamp(breakdown.reduce((sum, item) => sum + item.contribution, 0))) : null,
      coverage, availableWeight, totalWeight, breakdown,
      missing: entries.filter(([key]) => finite(metrics[key]) === null).map(([key]) => key)
    };
  }

  function drawdownFactor(fromHigh) {
    const value = finite(fromHigh);
    return value === null ? null : Math.round(clamp(Math.abs(Math.min(0, value)) / 30 * 100));
  }

  function weeklyKdjFactor(jValue, kValue, dValue) {
    const j = finite(jValue);
    if (j === null) return null;
    let score;
    if (j >= 50) score = 0;
    else if (j >= 20) score = (50 - j) / 30 * 35;
    else if (j >= 10) score = 55 + (20 - j) * 2;
    else if (j >= 0) score = 76 + (10 - j) * 1.8;
    else score = 94 + Math.min(6, Math.abs(j) * .6);
    const k = finite(kValue), d = finite(dValue);
    if (k !== null && d !== null && k < 20 && d < 20) score += 3;
    return Math.round(clamp(score));
  }

  function weeklyBiasFactor(biasValue) {
    const bias = finite(biasValue);
    if (bias === null) return null;
    if (bias >= 5) return 0;
    if (bias >= 0) return Math.round((5 - bias) / 5 * 20);
    if (bias >= -5) return Math.round(20 + Math.abs(bias) / 5 * 25);
    if (bias >= -10) return Math.round(45 + (Math.abs(bias) - 5) / 5 * 30);
    if (bias >= -15) return Math.round(75 + (Math.abs(bias) - 10) / 5 * 20);
    return Math.round(clamp(95 + Math.min(5, (Math.abs(bias) - 15) / 5 * 5)));
  }

  function longTermStage(score, stopConfirmation) {
    const value = finite(score);
    if (value === null) return {key:"unavailable", label:"模型資料不足", recommendation:"缺少必要資料，暫不提供長期加碼階段。", batchScale:0};
    let stage;
    if (value < 30) stage = {key:"high", label:"偏高勿追", recommendation:"目前低檔條件不足，避免追高並保留資金。", batchScale:0};
    else if (value < 45) stage = {key:"hold", label:"正常持有", recommendation:"尚未進入明顯加碼區。", batchScale:0};
    else if (value < 60) stage = {key:"watch", label:"開始觀察", recommendation:"可預留資金，等待更明確的回檔或估值條件。", batchScale:.15};
    else if (value < 75) stage = {key:"add", label:"分批加碼區", recommendation:"價格與情緒條件轉入低檔，可採小額分批並保留後續資金。", batchScale:.35};
    else stage = {key:"strong", label:"強力加碼區", recommendation:"多項長期低檔條件同時出現，仍須分批且不可一次投入。", batchScale:.5};
    if (finite(stopConfirmation) !== null && stopConfirmation < 40 && value >= 60) {
      return {...stage, recommendation:"仍在下跌，採較小批次加碼。", batchScale:Math.round(stage.batchScale * .5 * 100) / 100, stopAdjustment:true};
    }
    return stage;
  }

  function swingStage(score, input = {}) {
    const value = finite(score);
    if (value === null) return {key:"unavailable", label:"模型資料不足", recommendation:"缺少必要資料，暫不提供波段階段。"};
    const stop = finite(input.stopConfirmation) ?? 0;
    const blocked = input.breakingLow === true || input.kdDown === true || input.aboveMa5 === false || input.aboveMa10 === false;
    if (input.overheated === true) return {key:"overheated", label:"過熱暫停", recommendation:"價格與動能偏熱，避免追價。"};
    if (blocked || stop < 30) return value >= 42
      ? {key:"near", label:"接近買點", recommendation:"尚未站回短期均線，等待 KD 與趨勢轉強。"}
      : {key:"wait", label:"等待", recommendation:"仍有破底或動能下彎風險，先等待轉強。"};
    if (value >= 75 && stop >= 70 && input.trendImproving === true) return {key:"confirmed", label:"趨勢確認", recommendation:"趨勢與止跌條件同步改善，仍應控制單次部位。"};
    if (value >= 58 && stop >= 50) return {key:"first", label:"第一批試單", recommendation:"初步轉強，可用小部位觀察延續性。"};
    if (value >= 42) return {key:"near", label:"接近買點", recommendation:"條件正在改善，但尚未完成波段確認。"};
    return {key:"wait", label:"等待", recommendation:"波段確認不足，等待 KD 與短期均線轉強。"};
  }

  function longTermDecision(input = {}) {
    const metrics = {
      weeklyKdj: weeklyKdjFactor(input.j, input.k, input.d),
      weeklyBias: weeklyBiasFactor(input.weeklyBias),
      drawdown: drawdownFactor(input.fromHigh),
      marketFear: finite(input.marketFear),
      valuation: finite(input.valuation)
    };
    const requiredReady = metrics.weeklyKdj !== null && (metrics.weeklyBias !== null || metrics.drawdown !== null);
    const result = weightedScore(metrics, LONG_TERM_WEIGHTS, 50);
    if (!requiredReady) result.score = null;
    const scoreStatus = result.score === null ? "unavailable" : result.coverage >= 80 ? "complete" : "provisional";
    return {mode:"long_term_core", modeLabel:MODES.long_term_core, ...result, scoreStatus, metrics, stage:longTermStage(result.score, input.stopConfirmation)};
  }

  function swingDecision(input = {}) {
    const metrics = {
      stopConfirmation: finite(input.stopConfirmation), trendStrength: finite(input.trendStrength),
      technicalLow: finite(input.technicalLow), momentum: finite(input.momentum),
      historicalStats: finite(input.historicalStats), valuationBackground: finite(input.valuation),
      marketLiquidity: finite(input.marketLiquidity)
    };
    const result = weightedScore(metrics, SWING_WEIGHTS);
    return {mode:"swing", modeLabel:MODES.swing, ...result, metrics, stage:swingStage(result.score, {...input, stopConfirmation:metrics.stopConfirmation})};
  }

  function defaultDecision(input = {}) {
    const score = finite(input.defaultScore);
    return {
      mode:"user_selected", modeLabel:MODES.user_selected, score,
      coverage:finite(input.defaultCoverage) ?? 0, breakdown:[], metrics:{},
      stage:input.defaultStage || {key:"unavailable",label:"模型資料不足",recommendation:"缺少必要資料。"}
    };
  }

  function buildDecisions(input = {}) {
    return {
      long_term_core: longTermDecision(input),
      swing: swingDecision(input),
      user_selected: defaultDecision(input)
    };
  }

  return {MODES, LONG_TERM_WEIGHTS, SWING_WEIGHTS, weightedScore, drawdownFactor, weeklyKdjFactor, weeklyBiasFactor, longTermStage, swingStage, longTermDecision, swingDecision, defaultDecision, buildDecisions};
});
