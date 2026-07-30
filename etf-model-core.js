(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HSEtfModelCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MIN_DATA_COVERAGE = 70;
  const clamp = (value, min = 0, max = 100) => Math.min(max, Math.max(min, value));
  const finite = value => {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };

  const labels = {
    equity_broad: "台股／市場型股票 ETF",
    equity_sector: "產業主題股票 ETF",
    equity_dividend: "高股息／低波股票 ETF",
    equity_overseas: "海外股票 ETF",
    active_equity: "主動式股票 ETF",
    bond_government_short: "短天期公債 ETF",
    bond_government_long: "長天期公債 ETF",
    bond_investment_grade: "投資級債 ETF",
    bond_high_yield: "非投資級債 ETF",
    bond_emerging: "新興市場債 ETF",
    bond_floating: "浮動利率債 ETF",
    active_bond: "主動式債券 ETF",
    leveraged: "槓桿型 ETF",
    inverse: "反向型 ETF",
    commodity: "商品 ETF",
    futures: "期貨型 ETF",
    reit: "REITs／不動產 ETF",
    multi_asset: "多資產 ETF",
    offshore: "境外 ETF",
    other: "待確認類型"
  };

  const EQUITY = {
    technicalLow: 20, valuationAttractiveness: 15, stopConfirmation: 25, longTrend: 15,
    historicalStats: 15, marketSentiment: 5, liquidity: 5
  };
  const GOVERNMENT_BOND = {
    rateTrend: 25, durationFit: 15, longTrend: 20, oversold: 10,
    stopConfirmation: 15, historicalStats: 10, liquidity: 5
  };
  const INVESTMENT_GRADE_BOND = {
    rateTrend: 15, creditSpread: 25, longTrend: 20, oversold: 10,
    stopConfirmation: 15, historicalStats: 10, liquidity: 5
  };

  const ETF_MODEL_CONFIG = Object.freeze({
    equity_broad: {label: labels.equity_broad, family: "equity", weights: EQUITY},
    equity_sector: {label: labels.equity_sector, family: "equity", weights: EQUITY},
    equity_dividend: {label: labels.equity_dividend, family: "equity", weights: EQUITY},
    equity_overseas: {label: labels.equity_overseas, family: "equity", weights: EQUITY},
    active_equity: {label: labels.active_equity, family: "active_equity", weights: EQUITY},
    bond_government_short: {label: labels.bond_government_short, family: "government_bond", weights: GOVERNMENT_BOND},
    bond_government_long: {label: labels.bond_government_long, family: "government_bond", weights: GOVERNMENT_BOND},
    bond_investment_grade: {label: labels.bond_investment_grade, family: "credit_bond", weights: INVESTMENT_GRADE_BOND},
    bond_high_yield: {label: labels.bond_high_yield, family: "credit_bond", weights: {creditSpread:20,defaultRisk:15,marketSentiment:15,marketRisk:10,liquidity:10,longTrend:10,stopConfirmation:10,pricePosition:5,historicalStats:5}},
    bond_emerging: {label: labels.bond_emerging, family: "credit_bond", weights: {creditSpread:15,defaultRisk:10,fxRisk:15,marketSentiment:10,marketRisk:10,liquidity:10,longTrend:10,stopConfirmation:10,pricePosition:5,historicalStats:5}},
    bond_floating: {label: labels.bond_floating, family: "credit_bond", weights: {rateTrend:15,creditSpread:15,longTrend:20,pricePosition:10,stopConfirmation:15,historicalStats:10,marketSentiment:5,momentum:5,liquidity:5}},
    active_bond: {label: labels.active_bond, family: "active_bond", weights: INVESTMENT_GRADE_BOND},
    leveraged: {label: "槓桿型 ETF｜高波動模型", family: "high_volatility", weights: {stopConfirmation:25,technicalLow:15,valuationAttractiveness:5,volatilityControl:20,maxDrawdownControl:15,longTrend:10,historicalStats:5,liquidity:5}},
    inverse: {label: "反向型 ETF｜高波動模型", family: "high_volatility", weights: {stopConfirmation:25,oversold:15,volatilityControl:20,maxDrawdownControl:15,momentum:10,historicalStats:10,liquidity:5}},
    commodity: {label: labels.commodity, family: "commodity_futures", weights: {longTrend:25,momentum:20,stopConfirmation:20,volatilityControl:15,historicalStats:10,rollCost:10}},
    futures: {label: labels.futures, family: "commodity_futures", weights: {longTrend:25,momentum:20,stopConfirmation:20,volatilityControl:15,historicalStats:10,rollCost:10}},
    reit: {label: labels.reit, family: "real_asset", weights: {pricePosition:20,stopConfirmation:20,longTrend:20,historicalStats:15,marketSentiment:10,rateTrend:10,liquidity:5}},
    multi_asset: {label: labels.multi_asset, family: "multi_asset", weights: {pricePosition:15,stopConfirmation:20,longTrend:20,historicalStats:15,marketSentiment:15,volatilityControl:10,liquidity:5}},
    offshore: {label: labels.offshore, family: "offshore", weights: EQUITY},
    other: {label: labels.other, family: "unclassified", weights: {}}
  });

  function scoreModel(category, metrics = {}, confidence = "high") {
    const config = ETF_MODEL_CONFIG[category] || ETF_MODEL_CONFIG.other;
    const entries = Object.entries(config.weights);
    if (confidence === "low" || !entries.length) {
      return {
        score: null,
        availableWeight: 0,
        totalWeight: entries.reduce((total, [, weight]) => total + weight, 0),
        coverage: 0,
        status: "unavailable",
        message: confidence === "low" ? "ETF 類型待確認，不提供正式買點分數" : "此類型尚無正式買點模型",
        model: config,
        breakdown: [],
        missing: entries.map(([key]) => key)
      };
    }
    const totalWeight = entries.reduce((total, [, weight]) => total + weight, 0);
    const available = entries.filter(([key]) => finite(metrics[key]) !== null);
    const availableWeight = available.reduce((total, [, weight]) => total + weight, 0);
    const coverage = totalWeight ? availableWeight / totalWeight * 100 : 0;
    const missing = entries.filter(([key]) => finite(metrics[key]) === null).map(([key]) => key);
    const breakdown = available.map(([key, weight]) => ({
      key,
      weight,
      value: clamp(finite(metrics[key])),
      contribution: clamp(finite(metrics[key])) * weight / availableWeight
    }));
    if (coverage < MIN_DATA_COVERAGE) {
      return {
        score: null, availableWeight, totalWeight, coverage, status: "insufficient",
        message: `模型資料只有 ${Math.round(coverage)}%，低於 70% 門檻`,
        model: config, breakdown, missing
      };
    }
    return {
      score: Math.round(clamp(breakdown.reduce((total, item) => total + item.contribution, 0))),
      availableWeight, totalWeight, coverage, status: "available",
      message: missing.length ? "缺少資料的權重已按可用項目等比例正規化" : "模型資料完整",
      model: config, breakdown, missing
    };
  }

  function applyTypePercentiles(items = []) {
    const groups = new Map();
    for (const item of items) {
      if (!item || finite(item.score) === null) continue;
      const key = item.strategyCategory || item.strategy_category || "other";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    for (const group of groups.values()) {
      const ordered = [...group].sort((a, b) => finite(b.score) - finite(a.score));
      const denominator = Math.max(1, ordered.length);
      ordered.forEach((item, index) => {
        item.sameTypeRank = index + 1;
        item.sameTypeCount = ordered.length;
        item.sameTypeTopPercent = Math.max(1, Math.round((index + 1) / denominator * 100));
      });
    }
    return items;
  }

  function categoryLabel(category) {
    return labels[category] || labels.other;
  }

  return {ETF_MODEL_CONFIG, MIN_DATA_COVERAGE, scoreModel, applyTypePercentiles, categoryLabel};
});
