/* HS personal V2 — LOCAL_ONLY; production financial writer OFF. */
(function(host){'use strict';
const module=undefined,window={crypto:host.crypto},globalThis=window;

/* sealed source: portfolio-core.js */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.HSPortfolioCore = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const CODE_PATTERN = /^[0-9A-Z]{4,10}$/;
  const MAX_HOLDINGS = 30;
  const MAX_SHARES = 1e12;
  const MAX_COST = 1e9;
  const QUOTE_MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000;
  const STRATEGY_TYPES = new Set(["longTerm", "leveraged", "swing00733", "swing006201", "userSelected", ""]);

  function finitePositive(value, max) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 && number <= max ? number : null;
  }

  function sanitizeName(value) {
    return String(value ?? "")
      .replace(/[\u0000-\u001f\u007f<>]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40);
  }

  function normalizeCode(value) {
    const raw = String(value ?? "").trim().toUpperCase();
    const matched = raw.match(/^(?:TSE_|OTC_)?([0-9A-Z]{4,10})(?:\.TW)?$/);
    return matched ? matched[1] : raw;
  }

  function validateHolding(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("持股資料格式不正確。");
    }
    const code = normalizeCode(input.code);
    const shares = finitePositive(input.shares, MAX_SHARES);
    const averageCost = finitePositive(input.averageCost, MAX_COST);
    if (!CODE_PATTERN.test(code)) throw new Error("股票代號需為 4～10 碼英數字。");
    if (shares === null) throw new Error("股數必須大於 0，且不可超過 1 兆股。");
    if (averageCost === null) throw new Error("平均成本必須大於 0，且不可超過 10 億元。");
    if(input.positionCorrectedAt!==undefined&&input.positionCorrectedAt!==null&&input.positionCorrectedAt!==""&&!Number.isFinite(Date.parse(input.positionCorrectedAt)))throw new Error("持股校正時間無法驗證。");
    const strategyType = STRATEGY_TYPES.has(String(input.strategyType || "")) ? String(input.strategyType || "") : "";
    const rawTarget = input.targetAllocation;
    const targetAllocation = rawTarget === null || rawTarget === undefined || String(rawTarget).trim() === ""
      ? null
      : Number(rawTarget);
    if (targetAllocation !== null && (!Number.isFinite(targetAllocation) || targetAllocation < 0 || targetAllocation > 100)) {
      throw new Error("目標配置必須介於 0 到 100%。");
    }
    return {
      code,
      shares,
      averageCost,
      customName: sanitizeName(input.customName),
      name: sanitizeName(input.name),
      strategyType,
      targetAllocation,
      ...(input.positionCorrectedAt && Number.isFinite(Date.parse(input.positionCorrectedAt)) ? {positionCorrectedAt: new Date(input.positionCorrectedAt).toISOString()} : {}),
      updatedAt: new Date().toISOString()
    };
  }

  // Quick editing changes the position, not its metadata or transaction history.
  function updateHoldingPosition(holding, shares, averageCost, correctedAt = new Date().toISOString()) {
    const validated = validateHolding({...holding, shares, averageCost, positionCorrectedAt: correctedAt});
    return {...holding, ...validated};
  }

  function validateImportPayload(payload) {
    const rows = Array.isArray(payload) ? payload : payload?.holdings;
    if (!Array.isArray(rows)) throw new Error("JSON 必須包含 holdings 陣列。");
    if (rows.length > MAX_HOLDINGS) throw new Error(`持股最多 ${MAX_HOLDINGS} 檔。`);
    const seen = new Set();
    const holdings = rows.map(validateHolding);
    for (const item of holdings) {
      if (seen.has(item.code)) throw new Error(`代號 ${item.code} 重複，請先整理備份檔。`);
      seen.add(item.code);
    }
    return holdings;
  }

  function mergeHolding(existing, incoming) {
    const oldItem = validateHolding(existing);
    const newItem = validateHolding(incoming);
    if (oldItem.code !== newItem.code) throw new Error("只能合併相同代號。");
    const shares = oldItem.shares + newItem.shares;
    if (!Number.isFinite(shares) || shares > MAX_SHARES) throw new Error("合併後股數超過上限。");
    const totalCost = oldItem.shares * oldItem.averageCost + newItem.shares * newItem.averageCost;
    return {
      ...oldItem,
      shares,
      averageCost: totalCost / shares,
      customName: newItem.customName || oldItem.customName,
      name: newItem.name || oldItem.name,
      strategyType: newItem.strategyType || oldItem.strategyType,
      targetAllocation: newItem.targetAllocation ?? oldItem.targetAllocation,
      updatedAt: new Date().toISOString()
    };
  }

  function validateTargetAllocations(holdings) {
    const values = (Array.isArray(holdings) ? holdings : []).map(validateHolding);
    const allSet = values.length > 0 && values.every(item => Number.isFinite(item.targetAllocation));
    const total = values.reduce((sum, item) => sum + (Number.isFinite(item.targetAllocation) ? item.targetAllocation : 0), 0);
    const roundedTotal = Number(total.toFixed(2));
    return {ok: total <= 100 + 1e-9, complete: allSet && Math.abs(total - 100) <= .01, total: roundedTotal};
  }

  const REBALANCE_PROFILES = Object.freeze({
    conservative: Object.freeze({label: "保守型", relativeTolerance: .1, minimum: 1, maximum: 3}),
    balanced: Object.freeze({label: "平衡型", relativeTolerance: .15, minimum: 1.5, maximum: 4}),
    trend: Object.freeze({label: "趨勢型", relativeTolerance: .2, minimum: 2, maximum: 5}),
    custom: Object.freeze({label: "自訂", relativeTolerance: null, minimum: null, maximum: null})
  });

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function allocationBand(targetAllocation, profile = "trend", customTolerance = null) {
    if (!Number.isFinite(targetAllocation) || targetAllocation < 0 || targetAllocation > 100) return null;
    const selected = REBALANCE_PROFILES[profile] || REBALANCE_PROFILES.trend;
    const custom = Number(customTolerance);
    const tolerance = profile === "custom"
      ? (Number.isFinite(custom) && custom > 0 && custom <= 20 ? custom : null)
      : clamp(targetAllocation * selected.relativeTolerance, selected.minimum, selected.maximum);
    if (!Number.isFinite(tolerance)) return null;
    return {
      tolerance: Number(tolerance.toFixed(2)),
      lower: Number(Math.max(0, targetAllocation - tolerance).toFixed(2)),
      upper: Number(Math.min(100, targetAllocation + tolerance).toFixed(2))
    };
  }

  function calculateRebalanceAdvice(input = {}) {
    const sourceRows = Array.isArray(input.rows) ? input.rows : [];
    const profile = REBALANCE_PROFILES[input.profile] ? input.profile : "trend";
    const cash = Number(input.cash ?? 0);
    const cashFirst = input.cashFirst !== false;
    const trendProtection = input.trendProtection !== false;
    if (!Number.isFinite(cash) || cash < 0) return {status: "invalid_cash", formal: false, rows: [], health: null};
    const rows = sourceRows.map(raw => ({
      code: normalizeCode(raw?.code),
      marketValue: Number(raw?.marketValue),
      targetAllocation: raw?.targetAllocation === null || raw?.targetAllocation === undefined || raw?.targetAllocation === "" ? null : Number(raw.targetAllocation),
      trend: ["strong", "weak", "neutral"].includes(raw?.trend) ? raw.trend : "neutral"
    }));
    if (!rows.length || rows.some(row => !CODE_PATTERN.test(row.code) || !Number.isFinite(row.marketValue) || row.marketValue < 0)) {
      return {status: "quotes_pending", formal: false, rows: [], health: null};
    }
    const allocation = validateTargetAllocations(rows.map(row => ({code: row.code, shares: 1, averageCost: 1, targetAllocation: row.targetAllocation})));
    if (!allocation.ok || !allocation.complete) {
      return {
        status: allocation.total > 100 ? "target_over" : "target_incomplete",
        formal: false,
        totalTarget: allocation.total,
        gap: Number((100 - allocation.total).toFixed(2)),
        rows: [],
        health: null
      };
    }
    const totalMarketValue = rows.reduce((sum, row) => sum + row.marketValue, 0);
    const projectedTotal = totalMarketValue + cash;
    if (!Number.isFinite(projectedTotal) || projectedTotal <= 0) return {status: "quotes_pending", formal: false, rows: [], health: null};
    const working = rows.map(row => {
      const band = allocationBand(row.targetAllocation, profile, input.customTolerance);
      return {...row, band, cashAmount: 0, suggestedSell: 0, afterValue: row.marketValue};
    });
    if (working.some(row => !row.band)) return {status: "invalid_tolerance", formal: false, rows: [], health: null};
    let remainingCash = cash;
    if (cashFirst && remainingCash > 0) {
      const needs = working.map(row => Math.max(0, projectedTotal * row.targetAllocation / 100 - row.marketValue));
      const totalNeed = needs.reduce((sum, value) => sum + value, 0);
      if (totalNeed > 0) {
        working.forEach((row, index) => {
          const amount = Math.min(needs[index], cash * needs[index] / totalNeed);
          row.cashAmount = Number.isFinite(amount) ? amount : 0;
          row.afterValue += row.cashAmount;
          remainingCash -= row.cashAmount;
        });
      }
    }
    let activeCount = 0;
    let observationCount = 0;
    const outputRows = working.map(row => {
      const actualWeight = totalMarketValue > 0 ? row.marketValue / totalMarketValue * 100 : null;
      let afterWeight = row.afterValue / projectedTotal * 100;
      let level = "配置正常";
      let action = "維持目前配置";
      let amount = row.cashAmount;
      if (afterWeight < row.band.lower - 1e-9) {
        level = row.cashAmount > 0 ? "現金流再平衡" : "觀察性再平衡";
        action = row.cashAmount > 0 ? `新增資金優先補入` : "低於容忍區間，等待新增資金補足";
        observationCount += row.cashAmount > 0 ? 0 : 1;
      } else if (afterWeight > row.band.upper + 1e-9) {
        if (trendProtection && row.trend === "strong") {
          level = "觀察性再平衡";
          action = "暫停加碼，暫不賣出；優先用新增資金補其他低配標的";
          observationCount += 1;
        } else if (row.trend === "weak") {
          level = "主動再平衡";
          row.suggestedSell = Math.max(0, row.afterValue - projectedTotal * row.band.upper / 100);
          amount = -row.suggestedSell;
          afterWeight = (row.afterValue - row.suggestedSell) / projectedTotal * 100;
          action = "配置偏離明顯且趨勢轉弱，可部分調回容忍區間";
          activeCount += 1;
        } else {
          level = "觀察性再平衡";
          action = "配置偏高，先暫停新增並觀察趨勢";
          observationCount += 1;
        }
      } else if (row.cashAmount > 0) {
        level = "現金流再平衡";
        action = "使用新增資金補足低配部位";
      }
      return {
        code: row.code,
        targetAllocation: row.targetAllocation,
        actualWeight: Number.isFinite(actualWeight) ? Number(actualWeight.toFixed(2)) : null,
        difference: Number((afterWeight - row.targetAllocation).toFixed(2)),
        lower: row.band.lower,
        upper: row.band.upper,
        trend: row.trend,
        level,
        action,
        suggestedAmount: Number.isFinite(amount) ? Number(amount.toFixed(0)) : null,
        afterWeight: Number(afterWeight.toFixed(2))
      };
    });
    let transferPool = outputRows.reduce((sum, row) => sum + Math.max(0, -(row.suggestedAmount ?? 0)), 0);
    if (transferPool > 0) {
      const recipients = outputRows.filter(row => row.afterWeight < row.lower - 1e-9);
      const needs = recipients.map(row => Math.max(0, projectedTotal * (row.lower - row.afterWeight) / 100));
      const totalNeed = needs.reduce((sum, value) => sum + value, 0);
      const transferAvailable = transferPool;
      recipients.forEach((row, index) => {
        if (transferPool <= 0 || totalNeed <= 0) return;
        const amount = Math.min(needs[index], transferAvailable * needs[index] / totalNeed);
        if (!Number.isFinite(amount) || amount <= 0) return;
        row.suggestedAmount = Number(((row.suggestedAmount ?? 0) + amount).toFixed(0));
        row.afterWeight = Number((row.afterWeight + amount / projectedTotal * 100).toFixed(2));
        row.difference = Number((row.afterWeight - row.targetAllocation).toFixed(2));
        row.level = "主動再平衡";
        row.action = "承接高配弱勢部位的調整資金，補至容忍區間";
        transferPool -= amount;
      });
    }
    const meanRelativeDeviation = outputRows.reduce((sum, row) => sum + Math.abs(row.difference) / Math.max(row.targetAllocation, 5), 0) / outputRows.length;
    const health = Number(clamp(100 - meanRelativeDeviation * 100, 0, 100).toFixed(0));
    return {
      status: "ready",
      formal: true,
      profile,
      profileLabel: REBALANCE_PROFILES[profile].label,
      totalTarget: allocation.total,
      totalMarketValue,
      cash,
      cashUsed: Number((cash - Math.max(0, remainingCash)).toFixed(0)),
      cashRemaining: Number(Math.max(0, remainingCash).toFixed(0)),
      health,
      level: activeCount ? "主動再平衡" : observationCount ? "觀察性再平衡" : cash > 0 ? "現金流再平衡" : "配置正常",
      rows: outputRows
    };
  }

  function rebalanceDecision({actualWeight, targetAllocation, trendProtected = false} = {}) {
    if (!Number.isFinite(targetAllocation)) return {state: "unset", label: "尚未設定目標配置"};
    if (!Number.isFinite(actualWeight)) return {state: "pending", label: "行情更新後計算配置差異"};
    const difference = actualWeight - targetAllocation;
    if (difference > 1 && trendProtected) return {state: "trend_protected", difference, label: "趨勢保護中，暫緩單純因漲幅超標減碼"};
    if (difference > 1) return {state: "overweight", difference, label: "高於目標配置，可依策略檢視部位"};
    if (difference < -1) return {state: "underweight", difference, label: "低於目標配置，可搭配買點與風險評估"};
    return {state: "balanced", difference, label: "配置接近目標"};
  }

  function buildRebalanceReadout({rows = [], advice = null} = {}) {
    const adviceRows = new Map((advice?.formal && Array.isArray(advice.rows) ? advice.rows : []).map(row => [normalizeCode(row.code), row]));
    const items = (Array.isArray(rows) ? rows : []).map(raw => {
      const code = normalizeCode(raw?.code);
      const currentWeight = Number(raw?.weight);
      const targetWeight = raw?.targetAllocation === null || raw?.targetAllocation === undefined || raw?.targetAllocation === "" ? null : Number(raw.targetAllocation);
      if (!CODE_PATTERN.test(code) || !Number.isFinite(currentWeight) || !Number.isFinite(targetWeight)) return null;
      const allocationGap = Number((currentWeight - targetWeight).toFixed(2));
      const adviceRow = adviceRows.get(code);
      const hasBand = Number.isFinite(adviceRow?.lower) && Number.isFinite(adviceRow?.upper);
      const state = hasBand
        ? currentWeight > adviceRow.upper + 1e-9 ? "over" : currentWeight < adviceRow.lower - 1e-9 ? "under" : "near"
        : Math.abs(allocationGap) <= .1 ? "near" : allocationGap > 0 ? "over" : "under";
      return {
        code,
        currentWeight: Number(currentWeight.toFixed(2)),
        targetWeight: Number(targetWeight.toFixed(2)),
        allocationGap,
        fundingNeed: Number(Math.max(0, targetWeight - currentWeight).toFixed(2)),
        state,
        stateLabel: state === "over" ? "超配" : state === "under" ? "低配" : "接近目標"
      };
    }).filter(Boolean);
    const fundingPriority = items.filter(item => item.fundingNeed > 0).sort((a, b) => b.fundingNeed - a.fundingNeed || a.code.localeCompare(b.code));
    const overCount = items.filter(item => item.state === "over").length;
    const outOfBandCount = items.filter(item => item.state !== "near").length;
    const priorityCodes = fundingPriority.slice(0, 3).map(item => item.code);
    const health = Number(advice?.health);
    let recommendation = "完成目標配置後，系統會整理配置差異與下一筆資金方向。";
    if (advice?.formal && items.length) {
      if (priorityCodes.length) {
        const condition = Number.isFinite(health) && health < 60 ? "目前配置偏離較大" : outOfBandCount ? "目前配置仍有偏離" : "目前配置大致接近目標";
        recommendation = `${condition}，下一筆新增資金優先補足 ${priorityCodes.join("、")}${overCount ? "，暫不需主動賣出超配部位" : ""}。`;
      } else if (overCount) {
        recommendation = "目前有超配部位，下一筆新增資金依目標比例投入，暫不需主動賣出。";
      } else {
        recommendation = "目前配置接近目標，維持即可，下一筆資金依目標比例投入。";
      }
    }
    return {
      items,
      fundingPriority,
      recommendation,
      fundingMode: fundingPriority.length ? "以新增資金再平衡" : advice?.formal ? "接近目標" : "等待完整目標配置"
    };
  }

  // Presentation-only health indicator: 100 means current weights match targets.
  // Total absolute deviation is halved because an overweight and an underweight
  // describe the same allocation shift from opposite sides of the portfolio.
  function allocationHealthScore(rows = []) {
    const pairs = (Array.isArray(rows) ? rows : []).map(row => {
      const currentRaw = row?.weight ?? row?.actualWeight;
      const targetRaw = row?.targetAllocation ?? row?.targetWeight;
      if (currentRaw === null || currentRaw === undefined || targetRaw === null || targetRaw === undefined || targetRaw === "") return null;
      const current = Number(currentRaw);
      const target = Number(targetRaw);
      return Number.isFinite(current) && Number.isFinite(target) ? {current, target} : null;
    }).filter(Boolean);
    if (!pairs.length) return null;
    const deviation = pairs.reduce((sum, row) => sum + Math.abs(row.current - row.target), 0) / 2;
    return Number(clamp(100 - deviation, 0, 100).toFixed(0));
  }

  function buildPortfolioAttention(rows = [], {deviationThreshold = 3, highScoreThreshold = 40} = {}) {
    const threshold = Number.isFinite(Number(deviationThreshold)) ? Math.max(0, Number(deviationThreshold)) : 3;
    const scoreThreshold = Number.isFinite(Number(highScoreThreshold)) ? Number(highScoreThreshold) : 40;
    return (Array.isArray(rows) ? rows : []).map(raw => {
      const code = normalizeCode(raw?.code);
      const current = raw?.weight === null || raw?.weight === undefined || raw?.weight === "" ? NaN : Number(raw.weight);
      const target = raw?.targetAllocation === null || raw?.targetAllocation === undefined || raw?.targetAllocation === "" ? NaN : Number(raw.targetAllocation);
      const score = Number(raw?.coreScore);
      const gap = Number.isFinite(current) && Number.isFinite(target) ? Number((current - target).toFixed(2)) : null;
      const under = Number.isFinite(gap) && gap <= -threshold;
      const over = Number.isFinite(gap) && gap >= threshold;
      const highScore = Number.isFinite(score) && score >= scoreThreshold;
      if (!CODE_PATTERN.test(code) || (!under && !over && !highScore)) return null;
      const priority = highScore && under ? 1 : under ? 2 : highScore ? 3 : 4;
      return {
        code,
        name: sanitizeName(raw?.name),
        priority,
        gap,
        allocationState: under ? "under" : over ? "over" : "near",
        coreScore: Number.isFinite(score) ? score : null,
        coreLabel: sanitizeName(raw?.coreLabel)
      };
    }).filter(Boolean).sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.priority === 1 || a.priority === 3) {
        const byScore = (b.coreScore ?? -Infinity) - (a.coreScore ?? -Infinity);
        if (byScore) return byScore;
      }
      const byGap = Math.abs(b.gap ?? 0) - Math.abs(a.gap ?? 0);
      return byGap || a.code.localeCompare(b.code);
    });
  }

  function sortPortfolioRows(rows = [], mode = "marketValue") {
    const allowed = new Set(["marketValue", "weight", "totalPnl", "coreScore", "code"]);
    const selected = allowed.has(mode) ? mode : "marketValue";
    const output = [...(Array.isArray(rows) ? rows : [])];
    if (selected === "code") return output.sort((a, b) => normalizeCode(a?.code).localeCompare(normalizeCode(b?.code)));
    return output.sort((a, b) => {
      const leftRaw = a?.[selected], rightRaw = b?.[selected];
      const left = leftRaw === null || leftRaw === undefined || leftRaw === "" ? NaN : Number(leftRaw);
      const right = rightRaw === null || rightRaw === undefined || rightRaw === "" ? NaN : Number(rightRaw);
      const leftValue = Number.isFinite(left) ? left : -Infinity;
      const rightValue = Number.isFinite(right) ? right : -Infinity;
      return rightValue - leftValue || normalizeCode(a?.code).localeCompare(normalizeCode(b?.code));
    });
  }

  function quoteAsOf(quote) {
    const date = String(quote?.date ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "";
    const time = /^\d{2}:\d{2}(?::\d{2})?$/.test(String(quote?.quoteTime ?? ""))
      ? String(quote.quoteTime)
      : "13:30:00";
    return `${date}T${time.length === 5 ? `${time}:00` : time}+08:00`;
  }

  function quoteFreshness(quote, {now = Date.now(), maxAgeMs = QUOTE_MAX_AGE_MS} = {}) {
    const price = Number(quote?.price);
    if (!Number.isFinite(price) || price <= 0) return {status: "missing", isCurrent: false, isFallback: false, asOf: "", reason: "missing_price"};
    const asOf = quoteAsOf(quote);
    const asOfMs = Date.parse(asOf);
    if (!Number.isFinite(asOfMs)) return {status: "stale", isCurrent: false, isFallback: true, asOf, reason: "missing_asof"};
    if (quote?.stale === true || quote?.fallback === true || quote?.freshness === "stale") {
      return {status: "stale", isCurrent: false, isFallback: true, asOf, reason: String(quote?.staleReason || "last_known_good")};
    }
    const nowMs = now instanceof Date ? now.getTime() : Number(now);
    if (Number.isFinite(nowMs) && asOfMs > nowMs + 6 * 60 * 60 * 1000) {
      return {status: "stale", isCurrent: false, isFallback: true, asOf, reason: "future_asof"};
    }
    if (Number.isFinite(nowMs) && Number.isFinite(maxAgeMs) && maxAgeMs >= 0 && nowMs - asOfMs > maxAgeMs) {
      return {status: "stale", isCurrent: false, isFallback: true, asOf, reason: "quote_age"};
    }
    return {status: "current", isCurrent: true, isFallback: false, asOf, reason: ""};
  }

  function validQuote(quote, freshnessOptions) {
    const price = Number(quote?.price);
    const previousClose = Number(quote?.previousClose);
    if (!Number.isFinite(price) || price <= 0) return null;
    const freshness = quoteFreshness(quote, freshnessOptions);
    return {
      price,
      previousClose: Number.isFinite(previousClose) && previousClose > 0 ? previousClose : null,
      name: sanitizeName(quote?.name),
      date: String(quote?.date ?? ""),
      fetchedAt: String(quote?.fetchedAt ?? ""),
      quoteMode: quote?.quoteMode === "delayed" ? "delayed" : "close",
      quoteTime: String(quote?.quoteTime ?? ""),
      officialMarketDate: String(quote?.officialMarketDate ?? ""),
      officialCheckedAt: String(quote?.officialCheckedAt ?? ""),
      stale: freshness.status === "stale",
      fallback: freshness.isFallback,
      staleReason: freshness.reason,
      freshness: freshness.status,
      asOf: freshness.asOf
    };
  }

  function calculatePortfolio(holdings, quotes, freshnessOptions) {
    const quoteLookup = quotes instanceof Map ? quotes : new Map(Object.entries(quotes || {}));
    const rows = holdings.map(raw => {
      const item = validateHolding(raw);
      const quote = validQuote(quoteLookup.get(item.code), freshnessOptions);
      const totalCost = item.shares * item.averageCost;
      if (!quote) return {...item, quote: null, totalCost, marketValue: null, allocationValue: totalCost, valueSource: "cost", totalPnl: null, returnRate: null, todayPnl: null, changeRate: null, weight: null};
      const marketValue = item.shares * quote.price;
      const totalPnl = marketValue - totalCost;
      const returnRate = totalCost > 0 ? totalPnl / totalCost * 100 : null;
      const todayPnl = quote.previousClose ? item.shares * (quote.price - quote.previousClose) : null;
      const changeRate = quote.previousClose ? (quote.price / quote.previousClose - 1) * 100 : null;
      return {...item, quote, quoteStatus: quote.freshness, totalCost, marketValue, allocationValue: marketValue, valueSource: quote.stale ? "market_fallback" : "market", totalPnl, returnRate, todayPnl, changeRate, weight: null};
    });
    const complete = rows.length > 0 && rows.every(row => row.quoteStatus === "current" && Number.isFinite(row.todayPnl));
    const quotedRows = rows.filter(row => Number.isFinite(row.marketValue));
    const totalMarketValue = quotedRows.reduce((sum, row) => sum + row.marketValue, 0);
    const allocationTotal = rows.reduce((sum, row) => sum + (Number.isFinite(row.allocationValue) && row.allocationValue > 0 ? row.allocationValue : 0), 0);
    const allocationEstimated = rows.some(row => row.valueSource === "cost");
    const fallbackCount = rows.filter(row => row.valueSource === "market_fallback").length;
    for (const row of rows) {
      row.weight = Number.isFinite(row.allocationValue) && allocationTotal > 0 ? row.allocationValue / allocationTotal * 100 : null;
    }
    if (!complete) {
      return {rows, complete: false, totalMarketValue: null, allocationTotal, allocationEstimated, fallbackCount, totalCost: null, totalPnl: null, returnRate: null, todayPnl: null, todayRate: null};
    }
    const totalCost = rows.reduce((sum, row) => sum + row.totalCost, 0);
    const totalPnl = totalMarketValue - totalCost;
    const todayPnl = rows.reduce((sum, row) => sum + row.todayPnl, 0);
    const previousMarketValue = rows.reduce((sum, row) => sum + row.shares * row.quote.previousClose, 0);
    return {
      rows,
      complete: true,
      totalMarketValue,
      allocationTotal,
      allocationEstimated,
      fallbackCount,
      totalCost,
      totalPnl,
      returnRate: totalCost > 0 ? totalPnl / totalCost * 100 : null,
      todayPnl,
      todayRate: previousMarketValue > 0 ? todayPnl / previousMarketValue * 100 : null
    };
  }

  function buildAllocation(rows) {
    const validRows = rows.map(row => ({...row, allocationValue: Number.isFinite(row.allocationValue) && row.allocationValue > 0 ? row.allocationValue : row.marketValue}))
      .filter(row => Number.isFinite(row.allocationValue) && row.allocationValue > 0)
      .sort((a, b) => b.allocationValue - a.allocationValue);
    const total = validRows.reduce((sum, row) => sum + row.allocationValue, 0);
    if (!total) return [];
    const direct = validRows.length > 8 ? validRows.slice(0, 7) : validRows;
    const result = direct.map(row => ({
      code: row.code,
      name: row.customName || row.quote?.name || row.name || row.code,
      value: row.allocationValue,
      weight: row.allocationValue / total * 100,
      pnl: row.totalPnl,
      estimated: row.valueSource === "cost",
      members: [row.code]
    }));
    if (validRows.length > 8) {
      const others = validRows.slice(7);
      const value = others.reduce((sum, row) => sum + row.allocationValue, 0);
      result.push({
        code: "其他",
        name: `${others.length} 檔較小部位`,
        value,
        weight: value / total * 100,
        pnl: others.every(row => Number.isFinite(row.totalPnl)) ? others.reduce((sum, row) => sum + row.totalPnl, 0) : null,
        estimated: others.some(row => row.valueSource === "cost"),
        members: others.map(row => row.code)
      });
    }
    return result;
  }

  function targetsFromAllocation(rows) {
    const validRows = (Array.isArray(rows) ? rows : []).filter(row => CODE_PATTERN.test(normalizeCode(row?.code)) && Number.isFinite(row?.weight) && row.weight >= 0);
    const total = validRows.reduce((sum, row) => sum + row.weight, 0);
    if (!validRows.length || !Number.isFinite(total) || total <= 0) return [];
    const normalized = validRows.map((row, index) => {
      const rawTenths = row.weight / total * 1000;
      return {index, code: normalizeCode(row.code), tenths: Math.floor(rawTenths), remainder: rawTenths - Math.floor(rawTenths)};
    });
    let remaining = 1000 - normalized.reduce((sum, row) => sum + row.tenths, 0);
    [...normalized].sort((a, b) => b.remainder - a.remainder || a.code.localeCompare(b.code)).forEach(row => {
      if (remaining <= 0) return;
      row.tenths += 1;
      remaining -= 1;
    });
    return normalized.sort((a, b) => a.index - b.index).map(row => ({code: row.code, targetAllocation: row.tenths / 10}));
  }

  function parseNumber(value) {
    const number = Number(String(value ?? "").replace(/,/g, "").trim());
    return Number.isFinite(number) ? number : null;
  }

  function rocDateToIso(value) {
    const digits = String(value ?? "").replace(/\D/g, "");
    if (digits.length !== 7) return "";
    const year = Number(digits.slice(0, 3)) + 1911;
    const month = digits.slice(3, 5);
    const day = digits.slice(5, 7);
    const iso = `${year}-${month}-${day}`;
    return Number.isFinite(Date.parse(`${iso}T00:00:00+08:00`)) ? iso : "";
  }

  function parseTwseRows(rows, fetchedAt) {
    const result = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const code = normalizeCode(row.Code);
      const price = parseNumber(row.ClosingPrice);
      const change = parseNumber(row.Change);
      if (!CODE_PATTERN.test(code) || price === null || price <= 0) continue;
      const previousClose = change === null ? null : price - change;
      result.set(code, {
        price,
        previousClose: previousClose > 0 ? previousClose : null,
        name: sanitizeName(row.Name),
        date: rocDateToIso(row.Date),
        fetchedAt,
        market: "TWSE"
      });
    }
    return result;
  }

  function parseTpexRows(rows, fetchedAt) {
    const result = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const code = normalizeCode(row.SecuritiesCompanyCode);
      const price = parseNumber(row.Close);
      const change = parseNumber(row.Change);
      if (!CODE_PATTERN.test(code) || price === null || price <= 0) continue;
      const previousClose = change === null ? null : price - change;
      result.set(code, {
        price,
        previousClose: previousClose > 0 ? previousClose : null,
        name: sanitizeName(row.CompanyName),
        date: rocDateToIso(row.Date),
        fetchedAt,
        market: "TPEx"
      });
    }
    return result;
  }

  function parseCachedQuotes(payload) {
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.items)) throw new Error("行情快取格式不正確。");
    const updatedAt = String(payload.updated_at || "");
    const updatedTime = Date.parse(updatedAt);
    if (!Number.isFinite(updatedTime) || updatedTime > Date.now() + 6 * 3600000 || Date.now() - updatedTime > 14 * 86400000) {
      throw new Error("行情快取更新時間不合理。");
    }
    const result = new Map();
    for (const row of payload.items) {
      const code = normalizeCode(row.code);
      const price = parseNumber(row.price);
      const previousClose = parseNumber(row.previous_close);
      const high = parseNumber(row.high);
      const low = parseNumber(row.low);
      const volume = parseNumber(row.volume);
      const date = String(row.date || "");
      if (!CODE_PATTERN.test(code) || price === null || price <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      result.set(code, {
        price,
        previousClose: previousClose !== null && previousClose > 0 ? previousClose : null,
        name: sanitizeName(row.name),
        date,
        fetchedAt: updatedAt,
        market: row.market === "TPEx" ? "TPEx" : "TWSE",
        officialMarketDate: String(payload.official_source_dates?.[row.market === "TPEx" ? "TPEx" : "TWSE"] || ""),
        officialCheckedAt: String(payload.official_last_checked_at || ""),
        quoteMode: row.quote_mode === "delayed" ? "delayed" : "close",
        quoteTime: String(row.quote_time || ""),
        high: high !== null && high > 0 ? high : null,
        low: low !== null && low > 0 ? low : null,
        volume: volume !== null && volume >= 0 ? volume : null,
        stale: false,
        fallback: false,
        sourceUpdatedAt: updatedAt
      });
    }
    if (!result.size) throw new Error("行情快取沒有有效資料。");
    return result;
  }

  function cloneQuote(quote, changes = {}) {
    return {...quote, ...changes};
  }

  function mergePortfolioQuoteRefresh({previous, incoming, holdings, applyPortfolio = true, sourceUpdatedAt = ""} = {}) {
    const prior = previous instanceof Map ? previous : new Map(Object.entries(previous || {}));
    const latest = incoming instanceof Map ? incoming : new Map(Object.entries(incoming || {}));
    const codes = new Set((Array.isArray(holdings) ? holdings : []).map(item => normalizeCode(typeof item === "string" ? item : item?.code)).filter(code => CODE_PATTERN.test(code)));
    const quotes = new Map(prior);
    let currentCount = 0;
    let staleCount = 0;
    let missingCount = 0;
    for (const code of codes) {
      const incomingQuote = latest.get(code);
      const previousQuote = prior.get(code);
      if (applyPortfolio && incomingQuote) {
        quotes.set(code, cloneQuote(incomingQuote, {stale: false, fallback: false, staleReason: "", sourceUpdatedAt: String(sourceUpdatedAt || incomingQuote.sourceUpdatedAt || incomingQuote.fetchedAt || "")}));
        currentCount += 1;
      } else if (previousQuote) {
        const reason = applyPortfolio ? "source_missing" : "auto_refresh_disabled";
        quotes.set(code, cloneQuote(previousQuote, {stale: true, fallback: true, staleReason: reason, sourceUpdatedAt: String(sourceUpdatedAt || previousQuote.sourceUpdatedAt || "")}));
        staleCount += 1;
      } else {
        quotes.delete(code);
        missingCount += 1;
      }
    }
    return {quotes, currentCount, staleCount, missingCount};
  }

  function taipeiParts(now) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Taipei",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(now);
    return Object.fromEntries(parts.map(part => [part.type, part.value]));
  }

  function isTaipeiMarketOpen(now = new Date()) {
    const parts = taipeiParts(now);
    if (!["Mon", "Tue", "Wed", "Thu", "Fri"].includes(parts.weekday)) return false;
    const minutes = Number(parts.hour) * 60 + Number(parts.minute);
    return minutes >= 9 * 60 && minutes <= 13 * 60 + 30;
  }

  function safeNumber(value) {
    return Number.isFinite(value) ? value : null;
  }

  return {
    CODE_PATTERN,
    MAX_HOLDINGS,
    QUOTE_MAX_AGE_MS,
    validateHolding,
    updateHoldingPosition,
    validateImportPayload,
    mergeHolding,
    validateTargetAllocations,
    REBALANCE_PROFILES,
    allocationBand,
    calculateRebalanceAdvice,
    rebalanceDecision,
    buildRebalanceReadout,
    allocationHealthScore,
    buildPortfolioAttention,
    sortPortfolioRows,
    calculatePortfolio,
    quoteFreshness,
    quoteAsOf,
    mergePortfolioQuoteRefresh,
    buildAllocation,
    targetsFromAllocation,
    parseTwseRows,
    parseTpexRows,
    parseCachedQuotes,
    rocDateToIso,
    isTaipeiMarketOpen,
    sanitizeName,
    normalizeCode,
    safeNumber
  };
});

;
/* sealed source: portfolio-ledger-core.js */
(function(root,factory){const api=factory();if(typeof module==="object"&&module.exports)module.exports=api;if(root)root.HSPortfolioLedgerCore=api;})(typeof window!=="undefined"?window:globalThis,function(){
  "use strict";
  const VERSION="HS_PORTFOLIO_LEDGER_V1",STORAGE_KEY="hsRadar.portfolio.ledger.v1",LEGACY_BACKUP_KEY="hsRadar.portfolio.legacyBackup.v1",MIGRATION_VERSION="LEGACY_HOLDINGS_TO_OPENING_V1";
  const TYPES=Object.freeze(["OPENING_POSITION","POSITION_CORRECTION","OPENING_CASH","BUY","SELL","DEPOSIT","WITHDRAWAL","DIVIDEND","FEE","TAX","SPLIT","REVERSE_SPLIT","STOCK_DIVIDEND"]),EXTERNAL=new Set(["DEPOSIT","WITHDRAWAL"]),CORPORATE_ACTIONS=new Set(["SPLIT","REVERSE_SPLIT","STOCK_DIVIDEND"]);
  const round=(value,digits=8)=>Number(Number(value).toFixed(digits));
  const finite=value=>{if(value===null||value===undefined||value==="")return null;const n=Number(value);return Number.isFinite(n)?n:null};
  const validDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value||""))?String(value):"";
  const validTimestamp=value=>{const text=String(value||""),ms=Date.parse(text);return Number.isFinite(ms)?new Date(ms).toISOString():""};
  const normalizeSymbol=value=>String(value||"").trim().toUpperCase().replace(/\s+/g,"");
  const hash=text=>{let value=2166136261;for(const char of String(text)){value^=char.charCodeAt(0);value=Math.imul(value,16777619)}return(value>>>0).toString(36)};
  function eventId(input){return`pl_${hash([input.type,input.tradeDate,input.timestamp,input.symbol,input.quantity,input.unitPrice,input.grossAmount,input.ratio,input.source,input.createdAt].join("|"))}`}
  function normalizeEvent(raw){
    if(!raw||typeof raw!=="object"||!TYPES.includes(String(raw.type||"")))return null;
    const type=String(raw.type),tradeDate=validDate(raw.tradeDate??raw.date),timestamp=validTimestamp(raw.timestamp||`${tradeDate}T00:00:00+08:00`),code=normalizeSymbol(raw.symbol),quantity=finite(raw.quantity),unitPrice=finite(raw.unitPrice??raw.unitCost),amount=finite(raw.grossAmount??raw.amount??raw.costBasis),fee=finite(raw.fee)??0,tax=finite(raw.tax)??0,sharesPerShare=finite(raw.sharesPerShare),suppliedRatio=finite(raw.ratio),ratio=type==="STOCK_DIVIDEND"?(sharesPerShare!==null?1+sharesPerShare:suppliedRatio):suppliedRatio;
    if(!tradeDate||!timestamp||fee<0||tax<0)return null;
    if(["OPENING_POSITION","POSITION_CORRECTION","BUY","SELL"].includes(type)&&(!/^[0-9A-Z]{4,10}$/.test(code)||quantity===null||quantity<=0||unitPrice===null||unitPrice<=0))return null;
    if(type==="POSITION_CORRECTION"&&(fee!==0||tax!==0||quantity>1e12||round(quantity)<=0||unitPrice>1e9||!Number.isFinite(quantity*unitPrice)||["cashImpact","externalCashFlow","grossAmount","amount","fee","tax"].some(key=>raw[key]!==undefined&&(finite(raw[key])===null||finite(raw[key])!==0))))return null;
    if(type==="DIVIDEND"&&(!/^[0-9A-Z]{4,10}$/.test(code)||amount===null||amount<=0))return null;
    if(CORPORATE_ACTIONS.has(type)&&(!/^[0-9A-Z]{4,10}$/.test(code)||ratio===null||ratio<=0||(type==="STOCK_DIVIDEND"&&ratio<=1)))return null;
    if(["OPENING_CASH","DEPOSIT","WITHDRAWAL","FEE","TAX"].includes(type)&&(amount===null||amount<=(type==="OPENING_CASH"?-1:0)))return null;
    const gross=["OPENING_POSITION","BUY","SELL"].includes(type)?round(quantity*unitPrice,2):CORPORATE_ACTIONS.has(type)||type==="POSITION_CORRECTION"?0:round(amount||0,2);
    const cashImpact=type==="OPENING_CASH"||type==="DEPOSIT"||type==="DIVIDEND"?gross:type==="SELL"?round(gross-fee-tax,2):(type==="OPENING_POSITION"||type==="POSITION_CORRECTION")?0:round(-(gross+(["BUY"].includes(type)?fee:0)),2);
    const externalCashFlow=type==="DEPOSIT"?gross:type==="WITHDRAWAL"?-gross:0,createdAt=validTimestamp(raw.createdAt)||timestamp,updatedAt=validTimestamp(raw.updatedAt)||createdAt;
    const event={id:String(raw.id||""),version:VERSION,type,tradeDate,timestamp,symbol:code||null,quantity:CORPORATE_ACTIONS.has(type)?null:quantity===null?null:round(quantity),unitPrice:CORPORATE_ACTIONS.has(type)?null:unitPrice===null?null:type==="POSITION_CORRECTION"?unitPrice:round(unitPrice,6),grossAmount:gross,fee:CORPORATE_ACTIONS.has(type)?0:round(fee,2),tax:CORPORATE_ACTIONS.has(type)?0:round(tax,2),cashImpact:CORPORATE_ACTIONS.has(type)?0:cashImpact,externalCashFlow:CORPORATE_ACTIONS.has(type)?0:round(externalCashFlow,2),ratio:CORPORATE_ACTIONS.has(type)?round(ratio):null,sharesPerShare:type==="STOCK_DIVIDEND"?round(ratio-1):null,note:String(raw.note??raw.notes??"").trim().slice(0,240),source:String(raw.source||"MANUAL").slice(0,64),importBatchId:String(raw.importBatchId||"").slice(0,80)||null,adapterId:String(raw.adapterId||"").slice(0,80)||null,createdAt,updatedAt};
    event.id=event.id||eventId(event);return event;
  }
  const sortEvents=events=>(Array.isArray(events)?events:[]).map(normalizeEvent).filter(Boolean).sort((a,b)=>a.tradeDate.localeCompare(b.tradeDate)||a.timestamp.localeCompare(b.timestamp)||a.id.localeCompare(b.id));
  function derivePortfolioStateFromLedger(events){
    const raw=Array.isArray(events)?events:[],ordered=sortEvents(raw);if(ordered.length!==raw.length)return{valid:false,status:"INVALID_EVENT",error:"交易紀錄格式不完整",events:ordered};
    const ids=new Set(),positions=new Map();let cash=0,realizedPnL=0,externalNetFlow=0,dividendIncome=0,totalFees=0,totalTax=0;
    for(const event of ordered){
      if(ids.has(event.id))return{valid:false,status:"DUPLICATE_ID",error:"交易識別碼重複",eventId:event.id,events:ordered};ids.add(event.id);
      let holding=event.symbol?positions.get(event.symbol)||{symbol:event.symbol,quantity:0,costBasis:0,realizedPnL:0}:null;
      if(event.type==="OPENING_POSITION"){holding.quantity=round(holding.quantity+event.quantity);holding.costBasis=round(holding.costBasis+event.grossAmount,2);positions.set(event.symbol,holding)}
      else if(event.type==="POSITION_CORRECTION"){if(!positions.has(event.symbol))return{valid:false,status:"NO_HOLDING_FOR_CORRECTION",error:"沒有可校正的持股",events:ordered};holding.quantity=event.quantity;holding.costBasis=round(event.quantity*event.unitPrice,2);positions.set(event.symbol,holding)}
      else if(event.type==="BUY"){cash=round(cash+event.cashImpact,2);holding.quantity=round(holding.quantity+event.quantity);holding.costBasis=round(holding.costBasis+event.grossAmount+event.fee,2);positions.set(event.symbol,holding);totalFees=round(totalFees+event.fee,2)}
      else if(event.type==="SELL"){if(!holding||holding.quantity+1e-8<event.quantity)return{valid:false,status:"OVERSELL",error:"賣出股數超過當時可用持股",eventId:event.id,events:ordered};const average=holding.quantity?holding.costBasis/holding.quantity:0,removed=round(average*event.quantity,2),gain=round(event.cashImpact-removed,2);holding.quantity=round(holding.quantity-event.quantity);holding.costBasis=round(Math.max(0,holding.costBasis-removed),2);holding.realizedPnL=round(holding.realizedPnL+gain,2);realizedPnL=round(realizedPnL+gain,2);cash=round(cash+event.cashImpact,2);totalFees=round(totalFees+event.fee,2);totalTax=round(totalTax+event.tax,2);if(holding.quantity<=1e-8)positions.delete(event.symbol);else positions.set(event.symbol,holding)}
      else if(CORPORATE_ACTIONS.has(event.type)){if(!holding||holding.quantity<=0)return{valid:false,status:"NO_HOLDING_FOR_ACTION",error:"公司行動當時沒有可調整的持股",eventId:event.id,events:ordered};holding.quantity=round(holding.quantity*event.ratio);positions.set(event.symbol,holding)}
      else{cash=round(cash+event.cashImpact,2);externalNetFlow=round(externalNetFlow+event.externalCashFlow,2);if(event.type==="DIVIDEND")dividendIncome=round(dividendIncome+event.grossAmount,2);if(event.type==="FEE")totalFees=round(totalFees+event.grossAmount,2);if(event.type==="TAX")totalTax=round(totalTax+event.grossAmount,2)}
    }
    const holdings=[...positions.values()].sort((a,b)=>a.symbol.localeCompare(b.symbol)).map(row=>({...row,quantity:round(row.quantity),costBasis:round(row.costBasis,2),averageCost:row.quantity?round(row.costBasis/row.quantity,6):0,realizedPnL:round(row.realizedPnL,2)}));
    return{valid:true,status:"VALID",events:ordered,holdings,cash:round(cash,2),totalCostBasis:round(holdings.reduce((sum,row)=>sum+row.costBasis,0),2),realizedPnL,externalNetFlow,dividendIncome,totalFees,totalTax,lastEventId:ordered.at(-1)?.id||null};
  }
  function migrateLegacyPortfolio({holdings=[],cash=0,tradeDate,timestamp}={}){
    const date=validDate(tradeDate);if(!date)throw new Error("績效起始日期無效");const time=validTimestamp(timestamp)||new Date(`${date}T00:00:00+08:00`).toISOString(),events=[];
    for(const row of [...(Array.isArray(holdings)?holdings:[])].sort((a,b)=>normalizeSymbol(a.code).localeCompare(normalizeSymbol(b.code)))){const code=normalizeSymbol(row.code),quantity=finite(row.shares),unitPrice=finite(row.averageCost);if(!/^[0-9A-Z]{4,10}$/.test(code)||quantity===null||quantity<=0||unitPrice===null||unitPrice<=0)throw new Error("既有持股資料無法建立期初部位");events.push(normalizeEvent({id:`opening-position-${date}-${code}`,type:"OPENING_POSITION",tradeDate:date,timestamp:time,symbol:code,quantity,unitPrice,source:"LEGACY_HOLDINGS_MIGRATION",createdAt:time}))}
    const openingCash=finite(cash);if(openingCash!==null&&openingCash>0)events.push(normalizeEvent({id:`opening-cash-${date}`,type:"OPENING_CASH",tradeDate:date,timestamp:time,grossAmount:openingCash,source:"LEGACY_CASH_MIGRATION",createdAt:time}));
    const replay=derivePortfolioStateFromLedger(events);if(!replay.valid)throw new Error(replay.error);return{version:VERSION,events:replay.events,ledgerInitializedAt:time,performanceStartDate:date,legacyMigrationVersion:MIGRATION_VERSION};
  }
  function validateLedger(raw){if(!raw||raw.version!==VERSION||!Array.isArray(raw.events))return null;const replay=derivePortfolioStateFromLedger(raw.events),start=validDate(raw.performanceStartDate),initialized=validTimestamp(raw.ledgerInitializedAt);if(!replay.valid||!start||!initialized)return null;return{version:VERSION,events:replay.events,ledgerInitializedAt:initialized,performanceStartDate:start,legacyMigrationVersion:String(raw.legacyMigrationVersion||"")}}
  function mutateLedger(ledger,operation){const valid=validateLedger(ledger);if(!valid)return{ok:false,status:"INVALID_LEDGER"};let next=valid.events.map(row=>({...row}));if(operation.type==="ADD"){const event=normalizeEvent(operation.event);if(!event)return{ok:false,status:"INVALID_EVENT"};next.push(event)}else if(operation.type==="EDIT"){const index=next.findIndex(row=>row.id===operation.id),event=normalizeEvent({...operation.event,id:operation.id,createdAt:next[index]?.createdAt});if(index<0||!event)return{ok:false,status:"INVALID_EVENT"};next[index]=event}else if(operation.type==="DELETE"){const index=next.findIndex(row=>row.id===operation.id);if(index<0)return{ok:false,status:"NOT_FOUND"};next.splice(index,1)}else return{ok:false,status:"INVALID_OPERATION"};const replay=derivePortfolioStateFromLedger(next);return replay.valid?{ok:true,status:"VALID",ledger:{...valid,events:replay.events},state:replay}:{ok:false,status:replay.status,error:replay.error,eventId:replay.eventId}}
  function hasPositionCorrection(events,endDate="9999-12-31"){return sortEvents(events).some(row=>row.type==="POSITION_CORRECTION"&&row.tradeDate<=endDate)}
  // Unknown capital flows cannot be inferred from a manual position correction.
  function detectLikelyDuplicate(events,candidate,windowMs=300000){const event=normalizeEvent(candidate);if(!event)return false;return sortEvents(events).some(row=>row.type===event.type&&row.tradeDate===event.tradeDate&&row.symbol===event.symbol&&row.quantity===event.quantity&&row.unitPrice===event.unitPrice&&row.ratio===event.ratio&&Math.abs(Date.parse(row.createdAt)-Date.parse(event.createdAt))<=windowMs)}
  function calculateTwr({snapshots=[],events=[],startDate="",period="ALL"}={}){let rows=(Array.isArray(snapshots)?snapshots:[]).filter(row=>validDate(row?.date)&&finite(row?.totalAssets)!==null&&finite(row?.totalAssets)>=0).sort((a,b)=>a.date.localeCompare(b.date));const start=validDate(startDate);if(start)rows=rows.filter(row=>row.date>=start);if(period!=="ALL"&&rows.length){const days={"1M":31,"3M":93,"1Y":366}[period];if(days){const end=new Date(`${rows.at(-1).date}T00:00:00Z`),from=new Date(end.getTime()-(days-1)*86400000).toISOString().slice(0,10);rows=rows.filter(row=>row.date>=from)}else if(period==="YTD")rows=rows.filter(row=>row.date.startsWith(rows.at(-1).date.slice(0,4)))}if(rows.length&&hasPositionCorrection(events,rows.at(-1).date))return{available:false,status:"POSITION_CORRECTION",value:null,observations:rows.length,method:"EOD_FLOW"};if(rows.length<2)return{available:false,status:"INSUFFICIENT_HISTORY",value:null,observations:rows.length,method:"EOD_FLOW"};const flows=new Map();for(const event of sortEvents(events))if(EXTERNAL.has(event.type))flows.set(event.tradeDate,round((flows.get(event.tradeDate)||0)+event.externalCashFlow,2));let factor=1;for(let i=1;i<rows.length;i+=1){const previous=finite(rows[i-1].totalAssets),current=finite(rows[i].totalAssets),flow=flows.get(rows[i].date)||0;if(previous===null||previous<=0)return{available:false,status:"INVALID_DATA",value:null,observations:i,method:"EOD_FLOW"};factor*=1+(current-flow)/previous-1}return{available:true,status:"COMPLETE",value:(factor-1)*100,observations:rows.length,method:"EOD_FLOW"}}
  function xnpv(rate,flows,base){return flows.reduce((sum,row)=>sum+row.amount/Math.pow(1+rate,(Date.parse(`${row.date}T00:00:00Z`)-base)/31536000000),0)}
  function calculateXirr(cashFlows){const flows=(Array.isArray(cashFlows)?cashFlows:[]).map(row=>({date:validDate(row?.date),amount:finite(row?.amount)})).filter(row=>row.date&&row.amount!==null).sort((a,b)=>a.date.localeCompare(b.date));if(flows.length<2||!flows.some(row=>row.amount<0)||!flows.some(row=>row.amount>0))return{available:false,status:"NO_ROOT",value:null};const base=Date.parse(`${flows[0].date}T00:00:00Z`);let rate=.1;for(let i=0;i<60;i+=1){const value=xnpv(rate,flows,base),epsilon=1e-6,derivative=(xnpv(rate+epsilon,flows,base)-value)/epsilon;if(!Number.isFinite(value)||!Number.isFinite(derivative)||Math.abs(derivative)<1e-12)break;const next=rate-value/derivative;if(next<=-.9999||next>1e6||!Number.isFinite(next))break;if(Math.abs(next-rate)<1e-9)return{available:true,status:"COMPLETE",value:next*100,iterations:i+1};rate=next}let low=-.9999,high=10,left=xnpv(low,flows,base),right=xnpv(high,flows,base);for(let expand=0;left*right>0&&expand<12;expand+=1){high*=10;right=xnpv(high,flows,base)}if(!Number.isFinite(left)||!Number.isFinite(right)||left*right>0)return{available:false,status:"NO_ROOT",value:null};for(let i=0;i<200;i+=1){const mid=(low+high)/2,value=xnpv(mid,flows,base);if(Math.abs(value)<1e-7||Math.abs(high-low)<1e-9)return{available:true,status:"COMPLETE",value:mid*100,iterations:i+1};if(left*value<=0){high=mid;right=value}else{low=mid;left=value}}return{available:false,status:"NO_CONVERGENCE",value:null}}
  function buildXirrCashFlows(ledger,terminal){const valid=validateLedger(ledger),date=validDate(terminal?.date),value=finite(terminal?.value);if(!valid||!date||value===null||value<0||hasPositionCorrection(valid.events,date))return[];const replay=derivePortfolioStateFromLedger(valid.events),baseline=round(valid.events.filter(row=>row.type==="OPENING_POSITION").reduce((sum,row)=>sum+row.grossAmount,0)+valid.events.filter(row=>row.type==="OPENING_CASH").reduce((sum,row)=>sum+row.grossAmount,0),2),flows=[];if(baseline>0)flows.push({date:valid.performanceStartDate,amount:-baseline});for(const event of valid.events)if(event.type==="DEPOSIT")flows.push({date:event.tradeDate,amount:-event.grossAmount});else if(event.type==="WITHDRAWAL")flows.push({date:event.tradeDate,amount:event.grossAmount});flows.push({date,amount:value});return flows}
  function reconcileLedgerWithSnapshot(derived,snapshot,tolerance=.01){try{if(!derived?.valid||!snapshot||!snapshot.holdings||typeof snapshot.holdings!=="object")return{status:"UNAVAILABLE",match:false,mismatches:[]};const ledger=new Map(derived.holdings.map(row=>[row.symbol,row.quantity])),snap=new Map(Object.entries(snapshot.holdings).map(([key,row])=>[normalizeSymbol(key),finite(row?.quantity??row?.shares)])),mismatches=[];for(const code of new Set([...ledger.keys(),...snap.keys()]))if(Math.abs((ledger.get(code)||0)-(snap.get(code)||0))>1e-8)mismatches.push({field:"quantity",symbol:code,ledger:ledger.get(code)||0,snapshot:snap.get(code)||0});const cash=finite(snapshot.cash);if(cash===null||Math.abs(derived.cash-cash)>tolerance)mismatches.push({field:"cash",ledger:derived.cash,snapshot:cash});return{status:mismatches.length?"UNRECONCILED_STATE":"RECONCILED",match:!mismatches.length,mismatches}}catch{return{status:"UNAVAILABLE",match:false,mismatches:[]}}}
  return Object.freeze({VERSION,STORAGE_KEY,LEGACY_BACKUP_KEY,MIGRATION_VERSION,TYPES,CORPORATE_ACTIONS,normalizeSymbol,normalizeEvent,sortEvents,derivePortfolioStateFromLedger,migrateLegacyPortfolio,validateLedger,mutateLedger,hasPositionCorrection,detectLikelyDuplicate,calculateTwr,calculateXirr,buildXirrCashFlows,reconcileLedgerWithSnapshot});
});

;
/* sealed source: portfolio-performance-core.js */
(function(root,factory){const api=factory();if(typeof module==="object"&&module.exports)module.exports=api;if(root)root.HSPortfolioPerformanceCore=api;})(typeof window!=="undefined"?window:globalThis,function(){
  "use strict";
  const VERSION="HS_PORTFOLIO_SNAPSHOT_V1";
  const STORAGE_KEY="hsRadar.portfolio.snapshotHistory.v1";
  const PERIOD_DAYS=Object.freeze({"1M":31,"3M":93,"YTD":null,"1Y":366,"ALL":Infinity});
  const finite=value=>{if(value===null||value===undefined||value==="")return null;const n=Number(value);return Number.isFinite(n)?n:null};
  const date=value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value||""))?String(value):"";
  const timestamp=value=>{const text=String(value||""),ms=Date.parse(text);return Number.isFinite(ms)?new Date(ms).toISOString():""};
  const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
  function validateSnapshot(raw){
    const tradingDate=date(raw?.date),time=timestamp(raw?.timestamp),market=finite(raw?.totalMarketValue),cash=finite(raw?.cash),assets=finite(raw?.totalAssets),pnl=finite(raw?.unrealizedPnL);
    if(!tradingDate||!time||market===null||market<0||cash===null||assets===null||pnl===null||!raw?.holdings||typeof raw.holdings!=="object"||Array.isArray(raw.holdings))return null;
    const holdings={};
    for(const [symbol,item] of Object.entries(raw.holdings)){
      const quantity=finite(item?.quantity),marketPrice=finite(item?.marketPrice),marketValue=finite(item?.marketValue);
      if(!/^[0-9A-Z]{4,10}$/.test(symbol)||quantity===null||quantity<=0||marketPrice===null||marketPrice<=0||marketValue===null||marketValue<0)return null;
      holdings[symbol]={quantity,marketPrice,marketValue};
    }
    const ledgerVersion=raw?.ledgerVersion?String(raw.ledgerVersion):null,ledgerLastEventId=raw?.ledgerLastEventId?String(raw.ledgerLastEventId):null,portfolioSignature=raw?.portfolioSignature?String(raw.portfolioSignature):null;
    return{version:VERSION,date:tradingDate,timestamp:time,totalMarketValue:market,investedMarketValue:market,cash,totalAssets:assets,unrealizedPnL:pnl,holdings,ledgerVersion,ledgerLastEventId,portfolioSignature};
  }
  function appendDailySnapshot(history,raw){
    const snapshot=validateSnapshot(raw),rows=(Array.isArray(history)?history:[]).map(validateSnapshot).filter(Boolean).sort((a,b)=>a.date.localeCompare(b.date)||a.timestamp.localeCompare(b.timestamp));
    if(!snapshot)return{status:"INVALID_SNAPSHOT",history:rows,changed:false};
    const index=rows.findIndex(row=>row.date===snapshot.date);
    if(index>=0){
      if(rows[index].timestamp>snapshot.timestamp)return{status:"OLDER_OR_IDENTICAL",history:rows,changed:false};
      if(rows[index].timestamp===snapshot.timestamp&&JSON.stringify(rows[index])===JSON.stringify(snapshot))return{status:"OLDER_OR_IDENTICAL",history:rows,changed:false};
      rows[index]=snapshot;return{status:"REPLACED_DAILY_LAST",history:rows,changed:true,snapshot};
    }
    rows.push(snapshot);rows.sort((a,b)=>a.date.localeCompare(b.date));return{status:"APPENDED",history:rows,changed:true,snapshot};
  }
  function selectPeriod(history,period="1M",asOf){
    const rows=(Array.isArray(history)?history:[]).map(validateSnapshot).filter(Boolean).sort((a,b)=>a.date.localeCompare(b.date));if(!rows.length)return[];
    const end=date(asOf)||rows.at(-1).date;if(period==="ALL")return rows.filter(row=>row.date<=end);
    const endDate=new Date(`${end}T00:00:00Z`);let start;
    if(period==="YTD")start=`${end.slice(0,4)}-01-01`;else{const days=PERIOD_DAYS[period]||31;start=new Date(endDate.getTime()-(days-1)*86400000).toISOString().slice(0,10);}
    return rows.filter(row=>row.date>=start&&row.date<=end);
  }
  function assetChange(rows){
    if(!Array.isArray(rows)||rows.length<2)return{available:false,amount:null,rate:null};const first=finite(rows[0]?.totalAssets),last=finite(rows.at(-1)?.totalAssets);if(first===null||first<=0||last===null)return{available:false,amount:null,rate:null};return{available:true,amount:last-first,rate:(last/first-1)*100};
  }
  function alignBenchmark(snapshotRows,benchmarkRows){
    const prices=new Map((Array.isArray(benchmarkRows)?benchmarkRows:[]).map(row=>[date(row?.date),finite(row?.close)]).filter(([d,p])=>d&&p!==null&&p>0));
    const aligned=(Array.isArray(snapshotRows)?snapshotRows:[]).map(row=>({date:row.date,portfolio:finite(row.totalAssets),benchmark:prices.get(row.date)})).filter(row=>row.date&&row.portfolio!==null&&row.portfolio>0&&row.benchmark>0);
    if(aligned.length<2)return{available:false,points:[],portfolioChange:null,benchmarkChange:null,gapPt:null};
    const p0=aligned[0].portfolio,b0=aligned[0].benchmark,points=aligned.map(row=>({date:row.date,portfolio:Number((row.portfolio/p0*100).toFixed(4)),benchmark:Number((row.benchmark/b0*100).toFixed(4))})),portfolioChange=points.at(-1).portfolio-100,benchmarkChange=points.at(-1).benchmark-100;
    return{available:true,points,portfolioChange,benchmarkChange,gapPt:portfolioChange-benchmarkChange};
  }
  const CAPITAL_EVENT_TYPES=Object.freeze(["CASH_CHANGED","HOLDING_QUANTITY_CHANGED","HOLDING_ADDED","HOLDING_REMOVED"]);
  function portfolioSignature(snapshot){
    const valid=validateSnapshot(snapshot);if(!valid)return"";
    return Object.entries(valid.holdings).sort(([a],[b])=>a.localeCompare(b)).map(([symbol,item])=>`${symbol}:${Number(item.quantity).toFixed(8)}`).join("|");
  }
  function analyzePortfolioContinuity(snapshotRows,{tradingDates=[],invalidCount=0}={}){
    const source=Array.isArray(snapshotRows)?snapshotRows:[],validated=source.map(validateSnapshot),invalid=Number(invalidCount)||validated.filter(row=>!row).length,rows=validated.filter(Boolean).sort((a,b)=>a.date.localeCompare(b.date)||a.timestamp.localeCompare(b.timestamp)),events=[];
    const expected=[...new Set((Array.isArray(tradingDates)?tradingDates:[]).map(date).filter(Boolean))].sort(),expectedIndex=new Map(expected.map((value,index)=>[value,index]));
    for(let index=1;index<rows.length;index+=1){
      const previous=rows[index-1],current=rows[index],from=previous.date,to=current.date,previousSymbols=new Set(Object.keys(previous.holdings)),currentSymbols=new Set(Object.keys(current.holdings));
      if(Math.abs(previous.cash-current.cash)>0.01)events.push({type:"CASH_CHANGED",from,to,previous:previous.cash,current:current.cash});
      for(const symbol of currentSymbols){
        if(!previousSymbols.has(symbol))events.push({type:"HOLDING_ADDED",from,to,symbol});
        else if(Math.abs(previous.holdings[symbol].quantity-current.holdings[symbol].quantity)>1e-8)events.push({type:"HOLDING_QUANTITY_CHANGED",from,to,symbol,previous:previous.holdings[symbol].quantity,current:current.holdings[symbol].quantity});
      }
      for(const symbol of previousSymbols)if(!currentSymbols.has(symbol))events.push({type:"HOLDING_REMOVED",from,to,symbol});
      const left=expectedIndex.get(from),right=expectedIndex.get(to);
      if(Number.isInteger(left)&&Number.isInteger(right)&&right-left>1)events.push({type:"DATA_GAP",from,to,missingTradingDays:right-left-1});
    }
    const capitalEvents=events.filter(event=>CAPITAL_EVENT_TYPES.includes(event.type)),dataGaps=events.filter(event=>event.type==="DATA_GAP");
    return{status:invalid?"INVALID_DATA":capitalEvents.length?"CAPITAL_EVENT":rows.length<2||dataGaps.length?"INSUFFICIENT_HISTORY":"COMPLETE",valid:invalid===0,rows,events,capitalEvents,dataGaps,hasCapitalEvent:Boolean(capitalEvents.length),hasDataGap:Boolean(dataGaps.length),complete:invalid===0&&!capitalEvents.length&&!dataGaps.length};
  }
  function guardBenchmark(comparison,continuity){
    if(continuity?.hasCapitalEvent)return{...(comparison||{}),available:false,gapPt:null,guarded:true,reason:"CAPITAL_EVENT"};
    return{...(comparison||{}),guarded:false,reason:null};
  }
  function calculateConcentration(inputRows){
    const valid=(Array.isArray(inputRows)?inputRows:[]).map(row=>({symbol:String(row?.code||row?.symbol||""),marketValue:finite(row?.marketValue),weight:finite(row?.weight)})).filter(row=>row.marketValue!==null&&row.marketValue>=0||row.weight!==null&&row.weight>=0),marketTotal=valid.reduce((sum,row)=>sum+(row.marketValue||0),0);
    const weights=valid.map(row=>({symbol:row.symbol,weight:row.weight!==null?row.weight:marketTotal>0?(row.marketValue||0)/marketTotal*100:0})).filter(row=>row.weight>=0).sort((a,b)=>b.weight-a.weight||a.symbol.localeCompare(b.symbol)),totalWeight=weights.reduce((sum,row)=>sum+row.weight,0);
    if(!weights.length||totalWeight<=0)return{available:false,largest:null,top3:null,hhi:null,effectiveHoldings:null,totalWeight,rows:weights};
    const normalized=weights.map(row=>({...row,normalizedWeight:row.weight/totalWeight})),hhi=normalized.reduce((sum,row)=>sum+row.normalizedWeight**2,0);
    return{available:true,largest:normalized[0].normalizedWeight*100,top3:normalized.slice(0,3).reduce((sum,row)=>sum+row.normalizedWeight,0)*100,hhi,effectiveHoldings:hhi>0?1/hhi:null,totalWeight,rows:normalized};
  }
  function calculateAllocationDeviation(inputRows){
    const rows=(Array.isArray(inputRows)?inputRows:[]).map(row=>({symbol:String(row?.code||row?.symbol||""),current:finite(row?.weight),target:finite(row?.targetAllocation)}));
    if(!rows.length||rows.some(row=>row.current===null||row.target===null))return{available:false,totalDeviation:null,largestUnderweight:null,largestOverweight:null,rows:[]};
    const output=rows.map(row=>({...row,gap:row.current-row.target})),under=[...output].sort((a,b)=>a.gap-b.gap)[0],over=[...output].sort((a,b)=>b.gap-a.gap)[0];
    return{available:true,totalDeviation:output.reduce((sum,row)=>sum+Math.abs(row.gap),0)/2,largestUnderweight:under?.gap<0?under:null,largestOverweight:over?.gap>0?over:null,rows:output};
  }
  function historicalGuard(snapshotRows,continuity,minimum){
    const rows=(Array.isArray(snapshotRows)?snapshotRows:[]).map(validateSnapshot);if(rows.some(row=>!row))return{available:false,status:"INVALID_DATA",rows:[]};
    const valid=rows.filter(Boolean).sort((a,b)=>a.date.localeCompare(b.date));if(continuity?.hasCapitalEvent)return{available:false,status:"CAPITAL_EVENT",rows:valid};if(continuity?.hasDataGap)return{available:false,status:"INSUFFICIENT_HISTORY",rows:valid};if(valid.length<minimum)return{available:false,status:"INSUFFICIENT_HISTORY",rows:valid};return{available:true,status:"COMPLETE",rows:valid};
  }
  function calculateMaxDrawdown(snapshotRows,{continuity,minimumSnapshots=10}={}){
    const guard=historicalGuard(snapshotRows,continuity,minimumSnapshots);if(!guard.available)return{available:false,status:guard.status,value:null,observations:guard.rows.length};
    let peak=0,maximum=0;for(const row of guard.rows){const value=finite(row.totalAssets);if(value===null||value<=0)return{available:false,status:"INVALID_DATA",value:null,observations:guard.rows.length};peak=Math.max(peak,value);maximum=Math.min(maximum,value/peak-1);}
    return{available:true,status:"COMPLETE",value:maximum*100,observations:guard.rows.length};
  }
  function calculateAnnualizedVolatility(snapshotRows,{continuity,minimumReturns=20}={}){
    const guard=historicalGuard(snapshotRows,continuity,minimumReturns+1);if(!guard.available)return{available:false,status:guard.status,value:null,observations:Math.max(0,guard.rows.length-1)};
    const returns=[];for(let index=1;index<guard.rows.length;index+=1){const previous=finite(guard.rows[index-1].totalAssets),current=finite(guard.rows[index].totalAssets);if(previous===null||previous<=0||current===null||current<=0)return{available:false,status:"INVALID_DATA",value:null,observations:returns.length};returns.push(current/previous-1);}
    const mean=returns.reduce((sum,value)=>sum+value,0)/returns.length,variance=returns.reduce((sum,value)=>sum+(value-mean)**2,0)/(returns.length-1);
    return{available:true,status:"COMPLETE",value:Math.sqrt(variance)*Math.sqrt(252)*100,observations:returns.length};
  }
  function buildCapitalAllocationPlan({rows=[],availableCash=0,allocationHealthScore}={}){
    const cash=Math.max(0,finite(availableCash)||0),valid=(Array.isArray(rows)?rows:[]).map(row=>{const symbol=String(row?.code||row?.symbol||"").toUpperCase(),marketValue=finite(row?.marketValue),current=finite(row?.weight),target=finite(row?.targetAllocation),price=finite(row?.price??row?.quote?.price),score=finite(row?.coreScore);return{symbol,marketValue,current,target,price,score};}).filter(row=>/^[0-9A-Z]{4,10}$/.test(row.symbol));
    if(!valid.length)return{status:"EMPTY_HOLDINGS",cash,allocated:0,remaining:cash,rows:[],healthBefore:null,healthAfter:null};
    const total=valid.reduce((sum,row)=>sum+(row.marketValue||0),0),projected=total+cash;
    const candidates=valid.map(row=>{const reasonCodes=[];if(row.target===null)reasonCodes.push("TARGET_MISSING");if(row.price===null||row.price<=0)reasonCodes.push("PRICE_UNAVAILABLE");const need=row.target===null||row.marketValue===null?0:Math.max(0,projected*row.target/100-row.marketValue);if(need>0)reasonCodes.push("UNDERWEIGHT");else if(row.target!==null)reasonCodes.push(row.current>row.target?"OVERWEIGHT":"NEAR_TARGET");if(row.score!==null&&row.score>=40)reasonCodes.push("HIGH_CORE_SCORE");const modifier=row.score===null?1:1+clamp(row.score,0,100)/100*.15;return{...row,need,weight:need*modifier,reasonCodes};});
    const eligible=candidates.filter(row=>row.need>0&&row.price>0&&row.target!==null),weightTotal=eligible.reduce((sum,row)=>sum+row.weight,0),shares=new Map();let remainingCash=Math.round(cash);
    eligible.forEach((row,index)=>{const proposed=index===eligible.length-1?remainingCash:Math.round(cash*row.weight/weightTotal),amount=Math.max(0,Math.min(Math.round(row.need),remainingCash,proposed));shares.set(row.symbol,amount);remainingCash-=amount;});
    const planned=candidates.map(row=>{const amount=shares.get(row.symbol)||0,afterValue=(row.marketValue||0)+amount,afterWeight=projected>0?afterValue/projected*100:null;return{symbol:row.symbol,allocationAmount:amount,estimatedUnits:row.price>0?amount/row.price:null,beforeAllocation:row.current,afterAllocation:afterWeight,targetAllocation:row.target,allocationGapBefore:row.current!==null&&row.target!==null?row.current-row.target:null,allocationGapAfter:afterWeight!==null&&row.target!==null?afterWeight-row.target:null,coreScore:row.score,reasonCodes:cash<=0?[...row.reasonCodes,"INSUFFICIENT_CASH"]:row.reasonCodes};});
    const allocated=Math.round(cash)-remainingCash,remaining=remainingCash,healthFn=typeof allocationHealthScore==="function"?allocationHealthScore:()=>null;
    return{status:cash<=0?"ZERO_CASH":eligible.length?"READY":"NO_ELIGIBLE_TARGET",cash,allocated,remaining,rows:planned.sort((a,b)=>b.allocationAmount-a.allocationAmount||a.symbol.localeCompare(b.symbol)),healthBefore:healthFn(valid.map(row=>({weight:row.current,targetAllocation:row.target}))),healthAfter:healthFn(planned.map(row=>({weight:row.afterAllocation,targetAllocation:row.targetAllocation})))};
  }
  function buildCashOnlyRebalancePlan({rows=[],availableCash=0}={}){
    const cash=finite(availableCash);
    const source=(Array.isArray(rows)?rows:[]).map(row=>({
      symbol:String(row?.code||row?.symbol||"").trim().toUpperCase(),
      target:finite(row?.targetAllocation),
      marketValue:finite(row?.marketValue),
      price:finite(row?.price)
    }));
    const configured=source.filter(row=>row.target!==null);
    if(!configured.length)return{status:"TARGET_MISSING",cash,allocated:0,remaining:cash,rows:[]};
    if(configured.some(row=>!/^[0-9A-Z]{4,10}$/.test(row.symbol)||row.target<0||row.target>100)||Math.abs(configured.reduce((sum,row)=>sum+row.target,0)-100)>.01)return{status:"TARGET_INCOMPLETE",cash,allocated:0,remaining:cash,rows:[]};
    if(configured.some(row=>row.marketValue===null||row.marketValue<0||row.price===null||row.price<=0))return{status:"PRICE_UNAVAILABLE",cash,allocated:0,remaining:cash,rows:configured.map(row=>({...row,status:row.marketValue===null||row.price===null||row.price<=0?"PRICE_UNAVAILABLE":"WAITING"}))};
    const currentTotal=configured.reduce((sum,row)=>sum+row.marketValue,0);
    const usableCash=Math.max(0,cash||0),projected=currentTotal+usableCash;
    const gaps=configured.map(row=>({...row,currentAllocation:currentTotal>0?row.marketValue/currentTotal*100:0,gap:Math.max(0,projected*row.target/100-row.marketValue)}));
    const gapTotal=gaps.reduce((sum,row)=>sum+row.gap,0),scale=gapTotal>usableCash&&gapTotal>0?usableCash/gapTotal:1;
    const planned=gaps.map(row=>{const budget=Math.max(0,Math.floor(row.gap*scale*100)/100),estimatedUnits=row.price>0?Math.floor((budget/row.price)+1e-8):0,allocationAmount=Math.round(estimatedUnits*row.price*100)/100;return{...row,budget,estimatedUnits,allocationAmount,status:row.gap<=0?"OVERWEIGHT":usableCash<=0?"NO_CASH":"READY"}});
    const allocated=Math.round(planned.reduce((sum,row)=>sum+row.allocationAmount,0)*100)/100;
    return{status:usableCash<=0?"NO_CASH":"READY",cash,allocated,remaining:Math.round((usableCash-allocated)*100)/100,rows:planned.sort((a,b)=>b.allocationAmount-a.allocationAmount||a.symbol.localeCompare(b.symbol))};
  }
  return Object.freeze({VERSION,STORAGE_KEY,PERIOD_DAYS,CAPITAL_EVENT_TYPES,validateSnapshot,appendDailySnapshot,selectPeriod,assetChange,alignBenchmark,portfolioSignature,analyzePortfolioContinuity,guardBenchmark,calculateConcentration,calculateAllocationDeviation,calculateMaxDrawdown,calculateAnnualizedVolatility,buildCapitalAllocationPlan,buildCashOnlyRebalancePlan});
});

;
/* sealed source: portfolio-dashboard-core.js */
(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.HSPortfolioDashboardCore=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  const finite=value=>value===null||value===undefined||String(value).trim()===""?null:Number.isFinite(Number(value))?Number(value):null;
  const validDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value||""))?String(value):"";
  const validCode=value=>/^[0-9A-Z]{4,10}$/.test(String(value||"").trim().toUpperCase());

  function effectiveHoldings(rows=[]){
    return(Array.isArray(rows)?rows:[]).filter(row=>validCode(row?.code??row?.symbol??row?.ticker)&&finite(row?.shares??row?.quantity)>0&&row?.deleted!==true&&row?.placeholder!==true);
  }

  function targetAllocationItems(holdings=[],targets={}){
    const actual=effectiveHoldings(holdings),seen=new Set(actual.map(row=>row.code));
    const additional=Object.entries(targets&&typeof targets==="object"&&!Array.isArray(targets)?targets:{}).filter(([code])=>validCode(code)&&!seen.has(code)).map(([code,targetAllocation])=>({code,shares:0,targetAllocation:normalizeTarget(targetAllocation).value}));
    return[...actual,...additional];
  }

  function hero(rows=[]){
    const source=effectiveHoldings(rows);
    const valuableHoldings=source.filter(row=>row?.quoteStatus==="current"&&finite(row.marketValue)!==null);
    const todayRows=valuableHoldings.filter(row=>finite(row.todayPnl)!==null&&finite(row.quote?.previousClose)>0);
    const costRows=source.filter(row=>finite(row.totalCost)!==null);
    const holdingsWithCost=valuableHoldings.filter(row=>finite(row.totalCost)!==null);
    const status=items=>items.length===0?"unavailable":items.length===source.length?"complete":"partial";
    const stockMarketValue=valuableHoldings.length?valuableHoldings.reduce((sum,row)=>sum+finite(row.marketValue),0):null;
    const todayPnl=todayRows.length?todayRows.reduce((sum,row)=>sum+finite(row.todayPnl),0):null;
    const previousMarketValue=todayRows.reduce((sum,row)=>sum+finite(row.shares)*finite(row.quote.previousClose),0);
    const remainingCostBasis=holdingsWithCost.length?holdingsWithCost.reduce((sum,row)=>sum+finite(row.totalCost),0):null;
    const unrealizedPnl=holdingsWithCost.length?holdingsWithCost.reduce((sum,row)=>sum+finite(row.marketValue)-finite(row.totalCost),0):null;
    return{complete:source.length>0&&valuableHoldings.length===source.length&&todayRows.length===source.length&&holdingsWithCost.length===source.length,holdingCount:source.length,valuableCount:valuableHoldings.length,marketValueStatus:status(valuableHoldings),todayStatus:status(todayRows),costStatus:status(costRows),unrealizedStatus:status(holdingsWithCost),unrealizedReason:valuableHoldings.length<source.length?"部分行情缺失":"部分成本缺失",todayPnl,todayRate:previousMarketValue>0?todayPnl/previousMarketValue*100:null,unrealizedPnl,unrealizedRate:remainingCostBasis>0?unrealizedPnl/remainingCostBasis*100:null,stockMarketValue,remainingCostBasis};
  }

  function allocation(rows=[],visibleLimit=6){
    const source=(Array.isArray(rows)?rows:[]).map(row=>({code:String(row?.code||""),name:String(row?.name||row?.customName||row?.quote?.name||row?.code||""),value:finite(row?.marketValue)})).filter(row=>row.code&&row.value>0).sort((a,b)=>b.value-a.value||a.code.localeCompare(b.code));
    const total=source.reduce((sum,row)=>sum+row.value,0);
    if(!total)return[];
    const direct=source.length>visibleLimit?source.slice(0,visibleLimit-1):source;
    const output=direct.map(row=>({...row,weight:row.value/total*100,members:[row.code]}));
    if(source.length>visibleLimit){const rest=source.slice(visibleLimit-1),value=rest.reduce((sum,row)=>sum+row.value,0);output.push({code:"其他",name:`${rest.length} 檔較小部位`,value,weight:value/total*100,members:rest.map(row=>row.code)});}
    return output;
  }

  function adjustedRows(rows=[]){
    const byDate=new Map();
    for(const row of Array.isArray(rows)?rows:[]){const date=validDate(row?.date),close=finite(row?.close);if(date&&close>0)byDate.set(date,{date,close});}
    return[...byDate.values()].sort((a,b)=>a.date.localeCompare(b.date));
  }

  function trailingReturn(rows,sessions){
    const valid=adjustedRows(rows),count=Math.max(1,Math.trunc(Number(sessions)||0));
    if(valid.length<=count)return null;
    const latest=valid.at(-1).close,base=valid[valid.length-1-count].close;
    return base>0?(latest/base-1)*100:null;
  }

  function ytdReturn(rows){
    const valid=adjustedRows(rows);if(!valid.length)return null;
    const latest=valid.at(-1),year=Number(latest.date.slice(0,4)),base=[...valid].reverse().find(row=>Number(row.date.slice(0,4))<year);
    return base?.close>0?(latest.close/base.close-1)*100:null;
  }

  function trends(rows){return{fiveDay:trailingReturn(rows,5),twentyDay:trailingReturn(rows,20),ytd:ytdReturn(rows)};}

  function fixedCost(value){
    if(value===null||value===undefined||String(value).trim()==="")return"—";
    const amount=finite(value);
    return amount===null?"—":new Intl.NumberFormat("zh-TW",{minimumFractionDigits:2,maximumFractionDigits:2}).format(amount);
  }

  function fixedOne(value){
    const amount=finite(value);
    return amount===null?"—":`${amount.toFixed(1)}%`;
  }

  function targetDisplay(value){
    const target=normalizeTarget(value);
    return!target.ok||target.value===null?"未設定":`${target.value.toFixed(1)}%`;
  }

  function normalizeTarget(value){
    if(value===null||value===undefined||String(value).trim()==="")return{ok:true,value:null};
    const target=Number(value);
    if(!Number.isFinite(target)||target<0||target>100||Math.abs(target*10-Math.round(target*10))>1e-8)return{ok:false,value:null};
    return{ok:true,value:Number(target.toFixed(1))};
  }

  function targetSummary(values=[]){
    const normalized=(Array.isArray(values)?values:[]).map(value=>normalizeTarget(value));
    const valid=normalized.every(item=>item.ok);
    const configured=normalized.filter(item=>item.ok&&item.value!==null).length;
    const total=normalized.reduce((sum,item)=>sum+(item.ok&&item.value!==null?item.value:0),0);
    const gap=Number((100-total).toFixed(1));
    return{valid,configured,total:Number(total.toFixed(1)),gap,complete:valid&&normalized.length>0&&configured===normalized.length&&Math.abs(gap)<=.01,status:Math.abs(gap)<=.01?"complete":gap>0?"under":"over"};
  }

  function sortRows(rows=[],mode="portfolioOrder",direction="desc"){
    const source=(Array.isArray(rows)?rows:[]).map((row,index)=>({...row,portfolioOrder:index}));
    if(mode==="portfolioOrder")return source;
    const key={todayPnl:"todayPnl",changeRate:"changeRate",totalPnl:"totalPnl",weight:"weight",fiveDay:"fiveDay",twentyDay:"twentyDay",ytd:"ytd"}[mode];
    if(!key)return source;
    const sign=direction==="asc"?1:-1;
    return source.sort((a,b)=>{const av=finite(a[key]),bv=finite(b[key]);if(av===null&&bv===null)return a.portfolioOrder-b.portfolioOrder;if(av===null)return 1;if(bv===null)return-1;return(av-bv)*sign||a.portfolioOrder-b.portfolioOrder;});
  }

  return Object.freeze({VERSION:"HS_PORTFOLIO_DASHBOARD_V1",effectiveHoldings,targetAllocationItems,hero,allocation,adjustedRows,trailingReturn,ytdReturn,trends,fixedCost,fixedOne,targetDisplay,normalizeTarget,targetSummary,sortRows});
});

;
/* sealed source: portfolio-investable-cash-core.js */
(function(root,factory){
  const ledger=typeof module==="object"&&module.exports?require("./portfolio-ledger-core.js"):root.HSPortfolioLedgerCore;
  const api=factory(ledger);
  if(typeof module==="object"&&module.exports)module.exports=api;
  if(root)root.HSPortfolioInvestableCashCore=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(ledger){
  "use strict";
  /*
   * Pure V1 contract; no holdings, storage, or Ledger writes.
   * Callers supply the complete authoritative current Ledger and an explicit
   * asOf clock. eventMetadata is a separate future adapter contract, NOT a
   * change to HS_PORTFOLIO_LEDGER_V1:
   *   {eventId: {recordedAt: offset-ISO, occurredAt: offset-ISO,
   *     availability: {state: "AVAILABLE"|"PENDING"|"UNKNOWN",
   *                    availableAt: offset-ISO, reference: uniquePaymentId,
   *                    receivedAmount: exactDecimalAmount}}}
   * recordedAt is the trustworthy recording instant; occurredAt is actual
   * execution/economic time. Existing Ledger.timestamp may be recording time,
   * so it is NEVER substituted for occurredAt. AVAILABLE needs credit proof.
   * receivedAmount is the absolute bank movement amount (a debit magnitude
   * for WITHDRAWAL). Gross/net mismatches require review, not inferred tax.
   * At confirmation, every old SELL/DIVIDEND needs an availability state:
   * AVAILABLE is already included; PENDING is explicitly excluded from the
   * confirmed cash and can be credited later. UNKNOWN requires owner review.
   * A baseline fingerprint detects changed bytes, not Owner authentication.
   */
  const SCHEMA="HS_INVESTABLE_CASH_BASELINE_V1",VERSION=1,MAX=BigInt(Number.MAX_SAFE_INTEGER);
  const CREDIT=new Set(["SELL","DIVIDEND","DEPOSIT"]),NO_CASH=new Set(["OPENING_POSITION","POSITION_CORRECTION","SPLIT","REVERSE_SPLIT","STOCK_DIVIDEND"]);
  const fail=code=>{throw new Error(code);};
  const plain=v=>v!==null&&typeof v==="object"&&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null);
  function canonical(v){
    if(v===null||typeof v==="string"||typeof v==="boolean")return JSON.stringify(v);
    if(typeof v==="number"){if(!Number.isFinite(v))fail("NON_FINITE_JSON");return JSON.stringify(v);}
    if(Array.isArray(v))return "["+v.map(canonical).join(",")+"]";
    if(plain(v))return "{"+Object.keys(v).sort().map(k=>JSON.stringify(k)+":"+canonical(v[k])).join(",")+"}";
    return fail("INVALID_JSON_VALUE");
  }
  // Synchronous SHA-256 for identical Node/browser fingerprints; no I/O.
  const K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  function sha256(text){
    const input=new TextEncoder().encode(text),size=Math.ceil((input.length+9)/64)*64,bytes=new Uint8Array(size);
    bytes.set(input);bytes[input.length]=128;
    const view=new DataView(bytes.buffer),bits=BigInt(input.length)*8n;
    view.setUint32(size-8,Number(bits>>32n));view.setUint32(size-4,Number(bits&0xffffffffn));
    const h=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19],w=new Uint32Array(64);
    const rot=(n,r)=>(n>>>r)|(n<<(32-r));
    for(let off=0;off<size;off+=64){
      for(let i=0;i<16;i++)w[i]=view.getUint32(off+i*4);
      for(let i=16;i<64;i++){const a=w[i-15],b=w[i-2];w[i]=(w[i-16]+(rot(a,7)^rot(a,18)^(a>>>3))+w[i-7]+(rot(b,17)^rot(b,19)^(b>>>10)))>>>0;}
      let [a,b,c,d,e,f,g,j]=h;
      for(let i=0;i<64;i++){const t1=(j+(rot(e,6)^rot(e,11)^rot(e,25))+((e&f)^(~e&g))+K[i]+w[i])>>>0,t2=((rot(a,2)^rot(a,13)^rot(a,22))+((a&b)^(a&c)^(b&c)))>>>0;j=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}
      [a,b,c,d,e,f,g,j].forEach((n,i)=>{h[i]=(h[i]+n)>>>0;});
    }
    return h.map(n=>n.toString(16).padStart(8,"0")).join("");
  }
  // Deduplicate only the pure SHA of identical canonical bytes during one
  // synchronous reader call. This never memoizes validation/authority, and
  // canonicalization still runs for every fingerprint (including invalid input).
  // Fresh scopes cannot survive await, a later read, another tab or a restore.
  let fingerprintScope=null;
  function withFingerprintScope(work){
    if(typeof work!=="function")fail("SYNCHRONOUS_FINGERPRINT_SCOPE_REQUIRED");
    const previous=fingerprintScope;fingerprintScope={values:new Map(),units:0};
    try{const result=work();if(result&&typeof result.then==="function")fail("SYNCHRONOUS_FINGERPRINT_SCOPE_REQUIRED");return result;}
    finally{fingerprintScope=previous;}
  }
  const fingerprint=v=>{
    const text=canonical(v),scope=fingerprintScope;
    if(scope?.values.has(text))return scope.values.get(text);
    const result=sha256(text);
    if(scope&&scope.values.size<256&&scope.units+text.length<=4000000){scope.values.set(text,result);scope.units+=text.length;}
    return result;
  };
  function scaled(value,digits){
    if(!["number","string"].includes(typeof value)||Object.is(value,-0))fail("INVALID_DECIMAL");
    const text=String(value);
    if(text.length>32||!new RegExp("^\\d+(?:\\.\\d{1,"+digits+"})?$").test(text))fail("INVALID_DECIMAL");
    const [whole,fraction=""]=text.split(".");
    return BigInt(whole)*10n**BigInt(digits)+BigInt(fraction.padEnd(digits,"0")||"0");
  }
  function safe(n){if(n>MAX||n< -MAX)fail("UNSAFE_MINOR_UNITS");return Number(n);}
  const toMinorUnits=value=>safe(scaled(value,2));
  const moneyText=n=>String(Math.floor(n/100))+"."+String(n%100).padStart(2,"0");
  function stamp(value){
    if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value))fail("OFFSET_TIMESTAMP_REQUIRED");
    const day=value.slice(0,10),ms=Date.parse(value);
    if(!Number.isFinite(ms)||new Date(day+"T00:00:00Z").toISOString().slice(0,10)!==day||Number(value.slice(11,13))>23||Number(value.slice(14,16))>59||Number(value.slice(17,19))>59)fail("INVALID_TIMESTAMP");
    return ms;
  }
  const taipeiDay=ms=>new Date(ms+8*3600000).toISOString().slice(0,10);
  const byId=([a],[b])=>a<b?-1:a>b?1:0;
  function availability(meta){
    const a=meta&&meta.availability;
    if(!a)return {state:"UNKNOWN",available_at:null,reference:null,received_amount_minor:null};
    if(!plain(a)||!["AVAILABLE","PENDING","UNKNOWN"].includes(a.state))fail("INVALID_AVAILABILITY");
    if(a.state==="AVAILABLE"){stamp(a.availableAt);if(typeof a.reference!=="string"||!a.reference.trim())fail("CREDIT_REFERENCE_REQUIRED");if(a.receivedAmount===undefined)fail("RECEIVED_AMOUNT_REQUIRED");}
    const received=a.state==="AVAILABLE"?toMinorUnits(a.receivedAmount):null;
    if(received!==null&&received<=0)fail("NON_POSITIVE_RECEIVED_AMOUNT");
    return {state:a.state,available_at:a.state==="AVAILABLE"?a.availableAt:null,reference:typeof a.reference==="string"&&a.reference.trim()?a.reference.trim():null,received_amount_minor:received};
  }
  function eventsMap(events){
    if(!ledger||!Array.isArray(events))fail("LEDGER_CORE_OR_EVENTS_UNAVAILABLE");
    const map=new Map();
    for(const raw of events){
      const text=canonical(raw);
      if(!plain(raw)||typeof raw.id!=="string"||!raw.id.trim()||!ledger.normalizeEvent(raw))fail("INVALID_LEDGER_EVENT");
      stamp(raw.timestamp);
      if(!/^\d{4}-\d{2}-\d{2}$/.test(raw.tradeDate)||new Date(raw.tradeDate+"T00:00:00Z").toISOString().slice(0,10)!==raw.tradeDate)fail("INVALID_TRADE_DATE");
      if(map.has(raw.id)&&map.get(raw.id).text!==text)fail("EVENT_ID_CONFLICT");
      map.set(raw.id,{raw,text});
    }
    if(!ledger.derivePortfolioStateFromLedger([...map.values()].map(v=>v.raw)).valid)fail("INVALID_LEDGER_REPLAY");
    return map;
  }
  const metaFor=(metadata,id)=>plain(metadata)&&Object.hasOwn(metadata,id)?metadata[id]:{};
  function createBaseline({baselineId,amount,confirmedAt,events=[],eventMetadata={},ledgerComplete=false}={}){
    if(typeof baselineId!=="string"||!baselineId.trim()||baselineId!==baselineId.trim())fail("BASELINE_ID_REQUIRED");
    if(ledgerComplete!==true)fail("COMPLETE_LEDGER_REQUIRED");
    const minor=toMinorUnits(amount),at=stamp(confirmedAt),map=eventsMap(events),pins=[],settlements=[],reasons=[];
    for(const [id,{raw,text}] of [...map].sort(byId)){
      if(stamp(raw.timestamp)>at||raw.tradeDate>taipeiDay(at))fail("BASELINE_FUTURE_EVENT");
      if(raw.createdAt!==undefined&&stamp(raw.createdAt)>at)fail("BASELINE_FUTURE_RECORDING");
      const meta=metaFor(eventMetadata,id);
      if(meta.recordedAt!==undefined&&stamp(meta.recordedAt)>at)fail("BASELINE_FUTURE_RECORDING");
      pins.push({event_id:id,canonical_event:text,sha256:sha256(text)});
      if(raw.type==="SELL"||raw.type==="DIVIDEND"){
        const a=availability(meta);
        if(a.state==="AVAILABLE"&&(stamp(a.available_at)>at||taipeiDay(stamp(a.available_at))<raw.tradeDate))fail("BASELINE_AVAILABILITY_CONFLICT");
        if(a.state==="AVAILABLE"&&a.received_amount_minor!==eventAmount(raw))fail("BASELINE_RECEIVED_AMOUNT_MISMATCH");
        if(a.state==="UNKNOWN")reasons.push("UNKNOWN_BASELINE_SETTLEMENT:"+id);
        settlements.push({event_id:id,...a});
      }
    }
    const body={schema:SCHEMA,version:VERSION,baseline_id:baselineId,currency:"TWD",minor_unit_scale:2,
      confirmed_amount_minor:minor,confirmed_at:confirmedAt,confirmed_at_utc:new Date(at).toISOString(),
      ledger:{version:ledger.VERSION,complete:true,event_count:pins.length,event_pins:pins,snapshot_sha256:fingerprint(pins)},
      settlement_at_baseline:settlements,integrity:{status:reasons.length?"RECONCILIATION_REQUIRED":"VERIFIED",reasons}};
    return {...body,baseline_sha256:fingerprint(body)};
  }
  function validateBaseline(b){
    if(!plain(b)||b.schema!==SCHEMA||b.version!==VERSION||!Number.isSafeInteger(b.confirmed_amount_minor)||b.confirmed_amount_minor<0)fail("INVALID_BASELINE");
    const meta=Object.create(null);
    for(const a of b.settlement_at_baseline)meta[a.event_id]={availability:{state:a.state,availableAt:a.available_at,reference:a.reference,receivedAmount:a.received_amount_minor===null?undefined:moneyText(a.received_amount_minor)}};
    const rebuilt=createBaseline({baselineId:b.baseline_id,amount:moneyText(b.confirmed_amount_minor),confirmedAt:b.confirmed_at,
      events:b.ledger.event_pins.map(p=>JSON.parse(p.canonical_event)),eventMetadata:meta,ledgerComplete:true});
    if(canonical(rebuilt)!==canonical(b))fail("BASELINE_INTEGRITY_MISMATCH");
    return b;
  }
  function eventAmount(raw){
    let gross;
    if(raw.type==="BUY"||raw.type==="SELL"){
      if(raw.fee===undefined||raw.type==="SELL"&&raw.tax===undefined)fail("ACTUAL_FEE_TAX_REQUIRED");
      const q=scaled(raw.quantity,8),p=scaled(raw.unitPrice,6),den=10n**14n;
      gross=safe((q*p*100n+den/2n)/den);
      if(gross<=0)fail("NON_POSITIVE_PRINCIPAL");
      if(raw.grossAmount!==undefined&&toMinorUnits(raw.grossAmount)!==gross)fail("PRINCIPAL_MISMATCH");
      const fee=toMinorUnits(raw.fee),tax=toMinorUnits(raw.tax??0);
      if(raw.type==="BUY"&&tax!==0)fail("BUY_TAX_REQUIRES_RECONCILIATION");
      const result=safe(BigInt(gross)+(raw.type==="BUY"?BigInt(fee):-BigInt(fee)-BigInt(tax)));
      if(result<=0)fail("NON_POSITIVE_NET_AMOUNT");
      return result;
    }
    gross=toMinorUnits(raw.grossAmount??raw.amount);
    if(gross<=0)fail("NON_POSITIVE_AMOUNT");
    return gross;
  }
  function deriveCash({baseline=null,events=[],eventMetadata={},asOf,ledgerComplete=false}={}){
    const unavailable=(reason)=>({status:"RECONCILIATION_REQUIRED",balance_minor:null,investable_minor:null,applied_event_ids:[],pending_event_ids:[],reasons:[reason]});
    if(baseline===null)return {status:"UNINITIALIZED",balance_minor:null,investable_minor:null,applied_event_ids:[],pending_event_ids:[],reasons:[]};
    try{
      validateBaseline(baseline);
      if(ledgerComplete!==true)return unavailable("COMPLETE_LEDGER_REQUIRED");
      const now=stamp(asOf),cut=stamp(baseline.confirmed_at);
      if(now<cut)return unavailable("CLOCK_BEFORE_BASELINE");
      const map=eventsMap(events),pins=new Map(baseline.ledger.event_pins.map(p=>[p.event_id,p])),states=new Map(baseline.settlement_at_baseline.map(a=>[a.event_id,a]));
      for(const [id,p] of pins)if(!map.has(id)||map.get(id).text!==p.canonical_event)return unavailable("BASELINE_EVENT_CHANGED_OR_REMOVED:"+id);
      if(baseline.integrity.status!=="VERIFIED")return unavailable("BASELINE_SETTLEMENT_RECONCILIATION_REQUIRED");
      let balance=BigInt(baseline.confirmed_amount_minor);
      const applied=[],pending=[],references=new Set(),problems=[];
      for(const [id,{raw}] of [...map].sort(byId)){
        const meta=metaFor(eventMetadata,id),pinned=pins.has(id);
        if(pinned){
          if(!states.has(id))continue;
          const old=states.get(id);
          if(old.state==="AVAILABLE"){
            if(meta.availability&&canonical(availability(meta))!==canonical({state:old.state,available_at:old.available_at,reference:old.reference,received_amount_minor:old.received_amount_minor}))problems.push("BASELINE_SETTLEMENT_CHANGED:"+id);
            if(references.has(old.reference))problems.push("CREDIT_REFERENCE_CONFLICT:"+id);references.add(old.reference);continue;
          }
          const current=availability(meta);
          if(current.state==="PENDING"){pending.push(id);continue;}
          if(current.state!=="AVAILABLE"){problems.push("SETTLEMENT_UNKNOWN:"+id);continue;}
          if(stamp(current.available_at)<=cut||old.reference&&old.reference!==current.reference){problems.push("BASELINE_SETTLEMENT_CONFLICT:"+id);continue;}
        }else{
          if(!meta.recordedAt||!meta.occurredAt){problems.push("RECORDING_AND_OCCURRENCE_TIME_REQUIRED:"+id);continue;}
          const recorded=stamp(meta.recordedAt),traded=stamp(meta.occurredAt);
          if(taipeiDay(traded)!==raw.tradeDate){problems.push("OCCURRENCE_TRADE_DATE_CONFLICT:"+id);continue;}
          if(traded<=cut||recorded<=cut||raw.tradeDate<taipeiDay(cut)){problems.push("BACKDATED_OR_UNPINNED_HISTORY:"+id);continue;}
          if(traded>now||recorded>now||recorded<traded||stamp(raw.timestamp)>now||raw.createdAt!==undefined&&stamp(raw.createdAt)>recorded){problems.push("EVENT_CLOCK_CONFLICT:"+id);continue;}
          if(NO_CASH.has(raw.type))continue;
          if(raw.type==="OPENING_CASH"){problems.push("NEW_OPENING_CASH_REQUIRES_RECONCILIATION:"+id);continue;}
        }
        const amount=eventAmount(raw);
        if(CREDIT.has(raw.type)){
          const a=availability(meta);
          if(a.state==="PENDING"){pending.push(id);continue;}
          if(a.state!=="AVAILABLE"){problems.push("SETTLEMENT_UNKNOWN:"+id);continue;}
          if(stamp(a.available_at)>now||(pinned?taipeiDay(stamp(a.available_at))<raw.tradeDate:stamp(a.available_at)<stamp(meta.occurredAt))){problems.push("AVAILABILITY_CLOCK_CONFLICT:"+id);continue;}
          if(a.received_amount_minor!==amount){problems.push("RECEIVED_AMOUNT_MISMATCH:"+id);continue;}
          if(references.has(a.reference)){problems.push("CREDIT_REFERENCE_CONFLICT:"+id);continue;}
          references.add(a.reference);balance+=BigInt(amount);
        }else{
          if(raw.type==="WITHDRAWAL"){
            const a=availability(meta);
            if(a.state!=="AVAILABLE"||stamp(a.available_at)>now||stamp(a.available_at)<stamp(meta.occurredAt)||a.received_amount_minor!==amount){problems.push("WITHDRAWAL_NOT_CONFIRMED:"+id);continue;}
          }
          balance-=BigInt(amount);
        }
        safe(balance);applied.push(id);
      }
      if(problems.length)return {...unavailable(problems[0]),reasons:problems};
      const value=safe(balance);
      return {status:value<0?"INSUFFICIENT_CASH":pending.length?"PENDING":"READY",balance_minor:value,
        investable_minor:value<0?null:value,applied_event_ids:applied,pending_event_ids:pending,
        reasons:value<0?["INSUFFICIENT_CASH"]:[],baseline_id:baseline.baseline_id};
    }catch(error){return unavailable(error.message);}
  }
  // Expose the unchanged exact minor-unit validator for opt-in sync adapters.
  return Object.freeze({SCHEMA,VERSION,createBaseline,validateBaseline,deriveCash,toMinorUnits,fingerprint,withFingerprintScope,eventAmountMinor:eventAmount});
});

;
/* sealed source: portfolio-analytics-core.js */
(function(root,factory){
  const ledgerCore=typeof module==="object"&&module.exports?require("./portfolio-ledger-core.js"):root?.HSPortfolioLedgerCore;
  const api=factory(ledgerCore);if(typeof module==="object"&&module.exports)module.exports=api;if(root)root.HSPortfolioAnalyticsCore=api;
})(typeof window!=="undefined"?window:globalThis,function(ledgerCore){
  "use strict";
  const VERSION="HS_PORTFOLIO_ANALYTICS_V1",PERIOD_DAYS={"1M":31,"3M":93,"1Y":366};
  const finite=value=>{const number=Number(value);return value===null||value===undefined||value===""||!Number.isFinite(number)?null:number};
  const validDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value||""))?String(value):"";
  const round=(value,digits=2)=>Number(Number(value||0).toFixed(digits));
  const monthOf=date=>String(date||"").slice(0,7);
  function validLedger(raw){return ledgerCore?.validateLedger?.(raw)||null}
  function eventsInRange(events,start,end,{includeStart=false}={}){return ledgerCore.sortEvents(events).filter(row=>(includeStart?row.tradeDate>=start:row.tradeDate>start)&&row.tradeDate<=end)}
  function periodStartDate(performanceStartDate,period,end){let start=validDate(performanceStartDate)||end;if(period==="YTD"){const yearStart=`${end.slice(0,4)}-01-01`;if(yearStart>start)start=yearStart}else if(PERIOD_DAYS[period]){const cutoff=new Date(Date.parse(`${end}T00:00:00Z`)-(PERIOD_DAYS[period]-1)*86400000).toISOString().slice(0,10);if(cutoff>start)start=cutoff}return start}
  function selectSnapshots(snapshots,period="ALL",asOf=""){
    let rows=(Array.isArray(snapshots)?snapshots:[]).filter(row=>validDate(row?.date)&&finite(row?.totalAssets)!==null).sort((a,b)=>a.date.localeCompare(b.date));
    const end=validDate(asOf)||rows.at(-1)?.date||"";rows=rows.filter(row=>row.date<=end);if(!rows.length||period==="ALL")return rows;
    if(period==="YTD")return rows.filter(row=>row.date>=`${end.slice(0,4)}-01-01`);
    const days=PERIOD_DAYS[period]||31,from=new Date(Date.parse(`${end}T00:00:00Z`)-(days-1)*86400000).toISOString().slice(0,10);return rows.filter(row=>row.date>=from);
  }
  function deriveAtDate(ledger,date){const valid=validLedger(ledger);if(!valid||!validDate(date))return null;return ledgerCore.derivePortfolioStateFromLedger(valid.events.filter(row=>row.tradeDate<=date))}
  function sellOutcomes(ledger){
    const valid=validLedger(ledger);if(!valid)return[];const positions=new Map(),out=[];
    for(const event of valid.events){
      if(event.type==="POSITION_CORRECTION"){positions.set(event.symbol,{quantity:event.quantity,costBasis:round(event.quantity*event.unitPrice)});continue}
      if(ledgerCore.CORPORATE_ACTIONS.has(event.type)){const holding=positions.get(event.symbol);if(holding)holding.quantity*=event.ratio;continue}
      if(!["OPENING_POSITION","BUY","SELL"].includes(event.type))continue;
      const holding=positions.get(event.symbol)||{quantity:0,costBasis:0};
      if(event.type==="OPENING_POSITION"){holding.quantity+=event.quantity;holding.costBasis+=event.grossAmount;positions.set(event.symbol,holding);continue}
      if(event.type==="BUY"){holding.quantity+=event.quantity;holding.costBasis+=event.grossAmount+event.fee;positions.set(event.symbol,holding);continue}
      const average=holding.quantity?holding.costBasis/holding.quantity:0,removed=average*event.quantity,realized=event.cashImpact-removed;
      out.push({id:event.id,date:event.tradeDate,symbol:event.symbol,quantity:event.quantity,grossAmount:event.grossAmount,netProceeds:event.cashImpact,costBasisRemoved:round(removed),realizedPnL:round(realized)});
      holding.quantity=round(holding.quantity-event.quantity,8);holding.costBasis=round(Math.max(0,holding.costBasis-removed));if(holding.quantity>1e-8)positions.set(event.symbol,holding);else positions.delete(event.symbol);
    }
    return out;
  }
  function marketMap(rows){return new Map((Array.isArray(rows)?rows:[]).map(row=>[String(row?.code||row?.symbol||""),finite(row?.marketValue)]).filter(([symbol,value])=>symbol&&value!==null))}
  function calculateProfitBreakdown({ledger,marketRows=[]}={}){
    const valid=validLedger(ledger);if(!valid)return{available:false,status:"LEDGER_UNAVAILABLE"};const state=ledgerCore.derivePortfolioStateFromLedger(valid.events),markets=marketMap(marketRows);
    let unrealized=0,complete=true;for(const holding of state.holdings){const value=markets.get(holding.symbol);if(value===undefined){complete=false;continue}unrealized+=value-holding.costBasis}
    const standaloneFees=valid.events.filter(row=>row.type==="FEE").reduce((sum,row)=>sum+row.grossAmount,0),standaloneTaxes=valid.events.filter(row=>row.type==="TAX").reduce((sum,row)=>sum+row.grossAmount,0);
    return{available:complete,status:complete?"COMPLETE":"MARKET_VALUE_UNAVAILABLE",realizedPnL:round(state.realizedPnL),unrealizedPnL:complete?round(unrealized):null,dividendIncome:round(state.dividendIncome),standaloneFees:round(standaloneFees),standaloneTaxes:round(standaloneTaxes),totalInvestmentPnL:complete?round(state.realizedPnL+unrealized+state.dividendIncome-standaloneFees-standaloneTaxes):null,note:"OPENING_POSITION_COST_BASELINE"};
  }
  function calculateHoldingProfitBreakdown({ledger,marketRows=[]}={}){
    const valid=validLedger(ledger);if(!valid)return[];const state=ledgerCore.derivePortfolioStateFromLedger(valid.events),markets=marketMap(marketRows),realized=new Map(),dividends=new Map();
    for(const row of sellOutcomes(valid))realized.set(row.symbol,round((realized.get(row.symbol)||0)+row.realizedPnL));
    for(const row of valid.events)if(row.type==="DIVIDEND")dividends.set(row.symbol,round((dividends.get(row.symbol)||0)+row.grossAmount));
    const holdings=new Map(state.holdings.map(row=>[row.symbol,row])),symbols=new Set([...holdings.keys(),...realized.keys(),...dividends.keys()]);
    return[...symbols].map(symbol=>{const holding=holdings.get(symbol),marketValue=holding?markets.get(symbol):0,costBasis=holding?.costBasis||0,unrealized=marketValue===undefined?null:round(marketValue-costBasis),realizedPnL=realized.get(symbol)||0,dividendIncome=dividends.get(symbol)||0;return{symbol,marketValue:marketValue??null,costBasis:round(costBasis),unrealizedPnL:unrealized,realizedPnL,dividendIncome,totalContribution:unrealized===null?null:round(unrealized+realizedPnL+dividendIncome)}}).sort((a,b)=>(b.totalContribution??-Infinity)-(a.totalContribution??-Infinity)||a.symbol.localeCompare(b.symbol));
  }
  function calculatePortfolioContribution({ledger,snapshots=[],period="ALL",asOf=""}={}){
    const valid=validLedger(ledger),rows=selectSnapshots(snapshots,period,asOf);if(!valid)return{available:false,status:"LEDGER_UNAVAILABLE",rows:[]};if(rows.length&&ledgerCore.hasPositionCorrection(valid.events,rows.at(-1).date))return{available:false,status:"POSITION_CORRECTION",rows:[]};if(rows.length<2)return{available:false,status:"INSUFFICIENT_START_SNAPSHOT",rows:[],observations:rows.length};
    const start=rows[0],end=rows.at(-1),events=eventsInRange(valid.events,start.date,end.date),symbols=new Set([...Object.keys(start.holdings||{}),...Object.keys(end.holdings||{}),...events.map(row=>row.symbol).filter(Boolean)]),output=[];
    for(const symbol of symbols){const startValue=finite(start.holdings?.[symbol]?.marketValue)||0,endValue=finite(end.holdings?.[symbol]?.marketValue)||0,relevant=events.filter(row=>row.symbol===symbol),buyCash=relevant.filter(row=>row.type==="BUY").reduce((sum,row)=>sum+row.grossAmount+row.fee,0),sellCash=relevant.filter(row=>row.type==="SELL").reduce((sum,row)=>sum+row.cashImpact,0),dividend=relevant.filter(row=>row.type==="DIVIDEND").reduce((sum,row)=>sum+row.grossAmount,0),amount=round(endValue-startValue-buyCash+sellCash+dividend);output.push({symbol,amount,startValue:round(startValue),endValue:round(endValue),buyCash:round(buyCash),sellCash:round(sellCash),dividend:round(dividend)})}
    output.sort((a,b)=>b.amount-a.amount||a.symbol.localeCompare(b.symbol));const standaloneCosts=events.filter(row=>row.type==="FEE"||row.type==="TAX").reduce((sum,row)=>sum+row.grossAmount,0);
    return{available:true,status:"COMPLETE",startDate:start.date,endDate:end.date,observations:rows.length,rows:output,standaloneCosts:round(standaloneCosts),totalContribution:round(output.reduce((sum,row)=>sum+row.amount,0)-standaloneCosts),externalFlowExcluded:true};
  }
  function calculateDividendAnalytics({ledger,year=""}={}){
    const valid=validLedger(ledger);if(!valid)return{available:false,status:"LEDGER_UNAVAILABLE"};const all=valid.events.filter(row=>row.type==="DIVIDEND"),years=[...new Set(all.map(row=>row.tradeDate.slice(0,4)))].sort().reverse(),selected=/^\d{4}$/.test(String(year))?String(year):(years[0]||String(new Date().getFullYear())),rows=all.filter(row=>row.tradeDate.startsWith(selected)),monthly=Array.from({length:12},(_,index)=>({month:`${selected}-${String(index+1).padStart(2,"0")}`,amount:0})),bySymbol=new Map();
    for(const event of rows){monthly[Number(event.tradeDate.slice(5,7))-1].amount=round(monthly[Number(event.tradeDate.slice(5,7))-1].amount+event.grossAmount);bySymbol.set(event.symbol,round((bySymbol.get(event.symbol)||0)+event.grossAmount))}
    const state=ledgerCore.derivePortfolioStateFromLedger(valid.events),cumulative=round(all.reduce((sum,row)=>sum+row.grossAmount,0)),yearTotal=round(rows.reduce((sum,row)=>sum+row.grossAmount,0)),latest=[...all].sort((a,b)=>b.tradeDate.localeCompare(a.tradeDate)||b.timestamp.localeCompare(a.timestamp))[0]||null;
    return{available:true,status:all.length?"COMPLETE":"EMPTY",year:selected,years,yearTotal,cumulative,latest,sourceCount:new Set(rows.map(row=>row.symbol)).size,monthly,bySymbol:[...bySymbol].map(([symbol,amount])=>({symbol,amount})).sort((a,b)=>b.amount-a.amount||a.symbol.localeCompare(b.symbol)),cumulativeDividendToCost:state.totalCostBasis>0?cumulative/state.totalCostBasis*100:null};
  }
  function calculateTradingAnalytics({ledger,period="ALL",asOf=""}={}){
    const valid=validLedger(ledger);if(!valid)return{available:false,status:"LEDGER_UNAVAILABLE"};const end=validDate(asOf)||valid.events.at(-1)?.tradeDate||valid.performanceStartDate,start=periodStartDate(valid.performanceStartDate,period,end),events=valid.events.filter(row=>row.tradeDate>=start&&row.tradeDate<=end&&!row.type.startsWith("OPENING_")),buys=events.filter(row=>row.type==="BUY"),sells=events.filter(row=>row.type==="SELL"),outcomes=sellOutcomes(valid).filter(row=>row.date>=start&&row.date<=end),deposits=events.filter(row=>row.type==="DEPOSIT").reduce((sum,row)=>sum+row.grossAmount,0),withdrawals=events.filter(row=>row.type==="WITHDRAWAL").reduce((sum,row)=>sum+row.grossAmount,0),months=new Map();
    for(const row of events.filter(row=>row.type==="BUY"||row.type==="SELL")){const month=monthOf(row.tradeDate),entry=months.get(month)||{month,buyAmount:0,sellAmount:0};if(row.type==="BUY")entry.buyAmount+=row.grossAmount+row.fee;else entry.sellAmount+=row.cashImpact;months.set(month,entry)}
    const profitable=outcomes.filter(row=>row.realizedPnL>0).length,loss=outcomes.filter(row=>row.realizedPnL<0).length;
    return{available:true,status:events.length?"COMPLETE":"EMPTY",startDate:start,endDate:end,buyCount:buys.length,sellCount:sells.length,cumulativeBuy:round(buys.reduce((sum,row)=>sum+row.grossAmount+row.fee,0)),cumulativeSell:round(sells.reduce((sum,row)=>sum+row.cashImpact,0)),averageBuy:buys.length?round(buys.reduce((sum,row)=>sum+row.grossAmount+row.fee,0)/buys.length):null,realizedPnL:round(outcomes.reduce((sum,row)=>sum+row.realizedPnL,0)),profitableSellCount:profitable,lossSellCount:loss,profitableSellRatio:sells.length>=5?profitable/sells.length*100:null,deposits:round(deposits),withdrawals:round(withdrawals),netExternalContributions:round(deposits-withdrawals),monthly:[...months.values()].sort((a,b)=>a.month.localeCompare(b.month)).map(row=>({...row,buyAmount:round(row.buyAmount),sellAmount:round(row.sellAmount)}))};
  }
  function calculateMaxDrawdown(rows){if(rows.length<2)return null;let peak=finite(rows[0].totalAssets),worst=0;for(const row of rows){const value=finite(row.totalAssets);if(value===null||value<0)return null;peak=Math.max(peak,value);if(peak>0)worst=Math.min(worst,(value/peak-1)*100)}return worst}
  function buildMonthlyPortfolioReport({ledger,snapshots=[],benchmarkRows=[],month=""}={}){
    const valid=validLedger(ledger),selected=/^\d{4}-\d{2}$/.test(String(month))?String(month):monthOf((snapshots||[]).at(-1)?.date);if(!valid||!selected)return{available:false,status:"UNAVAILABLE"};const rows=(snapshots||[]).filter(row=>monthOf(row?.date)===selected&&row.date>=valid.performanceStartDate).sort((a,b)=>a.date.localeCompare(b.date));if(!rows.length)return{available:false,status:"NO_SNAPSHOTS",month:selected};if(ledgerCore.hasPositionCorrection(valid.events,rows.at(-1).date))return{available:false,status:"POSITION_CORRECTION",month:selected};
    const start=rows[0],end=rows.at(-1),benchmark=new Map((benchmarkRows||[]).map(row=>[validDate(row?.date),finite(row?.close)]).filter(([date,value])=>date&&value>0)),expected=[...benchmark.keys()].filter(date=>date>=start.date&&date<=end.date),dates=new Set(rows.map(row=>row.date)),missingDates=expected.filter(date=>!dates.has(date)),complete=rows.length>=2&&!missingDates.length,twr=complete?ledgerCore.calculateTwr({snapshots:rows,events:valid.events,startDate:valid.performanceStartDate,period:"ALL"}):{available:false},firstBenchmark=benchmark.get(start.date),lastBenchmark=benchmark.get(end.date),benchmarkReturn=complete&&firstBenchmark>0&&lastBenchmark>0?(lastBenchmark/firstBenchmark-1)*100:null,monthEvents=valid.events.filter(row=>monthOf(row.tradeDate)===selected&&row.tradeDate<=end.date),outcomes=sellOutcomes(valid).filter(row=>monthOf(row.date)===selected&&row.date<=end.date),dividends=monthEvents.filter(row=>row.type==="DIVIDEND").reduce((sum,row)=>sum+row.grossAmount,0),deposits=monthEvents.filter(row=>row.type==="DEPOSIT").reduce((sum,row)=>sum+row.grossAmount,0),withdrawals=monthEvents.filter(row=>row.type==="WITHDRAWAL").reduce((sum,row)=>sum+row.grossAmount,0),state=deriveAtDate(valid,end.date),endMarket=Object.values(end.holdings||{}).reduce((sum,row)=>sum+(finite(row?.marketValue)||0),0),unrealized=state?endMarket-state.totalCostBasis:null,values=Object.values(end.holdings||{}).map(row=>finite(row?.marketValue)||0),totalMarket=values.reduce((a,b)=>a+b,0),largest=totalMarket>0?Math.max(...values)/totalMarket*100:null;
    const result={available:true,status:complete?"COMPLETE":"INCOMPLETE_SNAPSHOTS",month:selected,startDate:start.date,endDate:end.date,partialMonth:start.date>`${selected}-01`,missingDates,observations:rows.length,startAssets:finite(start.totalAssets),endAssets:finite(end.totalAssets),twr:twr.available?twr.value:null,benchmarkReturn,relativeDifference:twr.available&&benchmarkReturn!==null?twr.value-benchmarkReturn:null,netDeposits:round(deposits-withdrawals),dividends:round(dividends),realizedPnL:round(outcomes.reduce((sum,row)=>sum+row.realizedPnL,0)),unrealizedPnL:unrealized===null?null:round(unrealized),buyAmount:round(monthEvents.filter(row=>row.type==="BUY").reduce((sum,row)=>sum+row.grossAmount+row.fee,0)),sellAmount:round(monthEvents.filter(row=>row.type==="SELL").reduce((sum,row)=>sum+row.cashImpact,0)),largestPosition:largest,maxDrawdown:complete?calculateMaxDrawdown(rows):null};
    result.summary=[result.twr===null?`本月資料期間 ${start.date}–${end.date}，TWR 資料不完整。`:`本月投資組合 TWR ${round(result.twr,2)}%，0050 同期 ${benchmarkReturn===null?"資料不足":`${round(benchmarkReturn,2)}%`}。`,`本月淨投入 NT$${round(result.netDeposits,0).toLocaleString("en-US")}，收到股息 NT$${round(result.dividends,0).toLocaleString("en-US")}。`];return result;
  }
  function buildAnnualPortfolioSummary({ledger,snapshots=[],year=""}={}){const valid=validLedger(ledger),selected=/^\d{4}$/.test(String(year))?String(year):String((snapshots||[]).at(-1)?.date||valid?.performanceStartDate||"").slice(0,4);if(!valid||!selected)return{available:false};const rows=(snapshots||[]).filter(row=>row.date.startsWith(selected)&&row.date>=valid.performanceStartDate),twr=ledgerCore.calculateTwr({snapshots:rows,events:valid.events,startDate:valid.performanceStartDate,period:"ALL"}),terminal=rows.at(-1),xirr=terminal?ledgerCore.calculateXirr(ledgerCore.buildXirrCashFlows(valid,{date:terminal.date,value:terminal.totalAssets})):{available:false},events=valid.events.filter(row=>row.tradeDate.startsWith(selected)&&(!terminal||row.tradeDate<=terminal.date)),outcomes=sellOutcomes(valid).filter(row=>row.date.startsWith(selected)&&(!terminal||row.date<=terminal.date));return{available:rows.length>0,year:selected,startDate:rows[0]?.date||null,endDate:rows.at(-1)?.date||null,partialYear:valid.performanceStartDate>`${selected}-01-01`,twr:twr.available?twr.value:null,xirr:xirr.available?xirr.value:null,dividends:round(events.filter(row=>row.type==="DIVIDEND").reduce((sum,row)=>sum+row.grossAmount,0)),realizedPnL:round(outcomes.reduce((sum,row)=>sum+row.realizedPnL,0)),netDeposits:round(events.filter(row=>row.type==="DEPOSIT").reduce((sum,row)=>sum+row.grossAmount,0)-events.filter(row=>row.type==="WITHDRAWAL").reduce((sum,row)=>sum+row.grossAmount,0)),maxDrawdown:ledgerCore.hasPositionCorrection(valid.events,rows.at(-1)?.date)?null:calculateMaxDrawdown(rows)}}
  return Object.freeze({VERSION,selectSnapshots,calculateProfitBreakdown,calculateHoldingProfitBreakdown,calculatePortfolioContribution,calculateDividendAnalytics,calculateTradingAnalytics,buildMonthlyPortfolioReport,buildAnnualPortfolioSummary});
});

;
/* sealed source: portfolio-workflow-core.js */
(function(root,factory){
  const ledgerCore=typeof module==="object"&&module.exports?require("./portfolio-ledger-core.js"):root?.HSPortfolioLedgerCore;
  const analyticsCore=typeof module==="object"&&module.exports?require("./portfolio-analytics-core.js"):root?.HSPortfolioAnalyticsCore;
  const api=factory(ledgerCore,analyticsCore);if(typeof module==="object"&&module.exports)module.exports=api;if(root)root.HSPortfolioWorkflowCore=api;
})(typeof window!=="undefined"?window:globalThis,function(ledgerCore,analyticsCore){
  "use strict";
  const VERSION="HS_PORTFOLIO_WORKFLOW_V1",BACKUP_VERSION=5,GOAL_STORAGE_KEY="hsRadar.portfolio.goal.v1",PLAN_STORAGE_KEY="hsRadar.portfolio.monthlyPlan.v1",IMPORT_STORAGE_KEY="hsRadar.portfolio.importState.v1";
  const CSV_HEADERS=["date","type","symbol","quantity","price","amount","fee","tax","note"],IMPORT_TYPES=new Set(["BUY","SELL","DEPOSIT","WITHDRAWAL","DIVIDEND","FEE","TAX"]);
  const finite=value=>{if(value===null||value===undefined||String(value).trim()==="")return null;const text=String(value).trim();if(text.includes(","))return null;const number=Number(text);return Number.isFinite(number)?number:null};
  const validDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value||""))&&!Number.isNaN(Date.parse(`${value}T00:00:00Z`))?String(value):"";
  const round=(value,digits=2)=>Number(Number(value||0).toFixed(digits));
  const csvCell=value=>{const text=String(value??"");return /[",\r\n]/.test(text)?`"${text.replace(/"/g,'""')}"`:text};
  function parseCsv(text){
    const source=String(text??"").replace(/^\uFEFF/,""),rows=[];let row=[],cell="",quoted=false;
    for(let i=0;i<source.length;i+=1){const char=source[i];if(quoted){if(char==='"'&&source[i+1]==='"'){cell+='"';i+=1}else if(char==='"')quoted=false;else cell+=char}else if(char==='"')quoted=true;else if(char===","){row.push(cell);cell=""}else if(char==="\n"){row.push(cell.replace(/\r$/,"") );rows.push(row);row=[];cell=""}else cell+=char}
    if(quoted)throw new Error("CSV 引號未正確結束");if(cell!==""||row.length){row.push(cell.replace(/\r$/,"") );rows.push(row)}
    const useful=rows.filter(values=>values.some(value=>String(value).trim()!==""));if(!useful.length)return{headers:[],rows:[]};
    const headers=useful[0].map(value=>String(value).trim().toLowerCase());if(headers.join(",")!==CSV_HEADERS.join(","))throw new Error("CSV 欄位必須符合 HS 標準格式");
    return{headers,rows:useful.slice(1).map((values,index)=>Object.fromEntries(headers.map((header,column)=>[header,values[column]??""]))).map((value,index)=>({...value,__row:index+2}))};
  }
  function duplicateKey(event){return[event.type,event.tradeDate,event.symbol||"",event.quantity??"",event.unitPrice??"",event.grossAmount??""].join("|")}
  function normalizeCsvRow(row,index=0){
    const type=String(row?.type||"").trim().toUpperCase(),date=validDate(String(row?.date||"").trim()),symbol=String(row?.symbol||"").trim().toUpperCase(),quantity=finite(row?.quantity),price=finite(row?.price),amount=finite(row?.amount),fee=finite(row?.fee)??0,tax=finite(row?.tax)??0,note=String(row?.note||"").trim();
    const errors=[];if(!date)errors.push("日期必須為 YYYY-MM-DD");if(!IMPORT_TYPES.has(type))errors.push("不支援的交易類型");
    if(["BUY","SELL"].includes(type)){if(!/^[0-9A-Z]{4,10}$/.test(symbol))errors.push("ETF 代號缺漏或無效");if(quantity===null||quantity<=0)errors.push("股數必須大於 0");if(price===null||price<=0)errors.push("成交價必須大於 0")}
    if(type==="DIVIDEND"){if(!/^[0-9A-Z]{4,10}$/.test(symbol))errors.push("ETF 代號缺漏或無效");if(amount===null||amount<=0)errors.push("金額必須大於 0")}
    if(["DEPOSIT","WITHDRAWAL","FEE","TAX"].includes(type)&&(amount===null||amount<=0))errors.push("金額必須大於 0");if(fee<0||tax<0)errors.push("費用與稅額不可為負數");
    const timestamp=date?new Date(`${date}T12:00:${String(index%60).padStart(2,"0")}+08:00`).toISOString():"";
    const event=errors.length?null:ledgerCore.normalizeEvent({type,tradeDate:date,timestamp,symbol,quantity,unitPrice:price,grossAmount:amount,fee,tax,note,source:"CSV_IMPORT",createdAt:timestamp});if(!event&&!errors.length)errors.push("交易內容無法通過 Ledger 驗證");
    return{rowNumber:row?.__row||index+2,raw:row,event,errors};
  }
  function buildImportPreview(text,ledger){
    const parsed=parseCsv(text),existing=new Set((ledgerCore.validateLedger(ledger)?.events||[]).map(duplicateKey));let seen=new Set();
    const rows=parsed.rows.map((row,index)=>{const normalized=normalizeCsvRow(row,index);let status=normalized.errors.length?"ERROR":"VALID",messages=[...normalized.errors];if(normalized.event){const key=duplicateKey(normalized.event);if(existing.has(key)||seen.has(key)){status="DUPLICATE_CANDIDATE";messages.push("與既有或本次資料疑似重複")}seen.add(key)}return{...normalized,status,messages,selected:status==="VALID"}});
    const count=status=>rows.filter(row=>row.status===status).length;return{version:VERSION,rows,total:rows.length,valid:count("VALID"),warning:count("WARNING"),errors:count("ERROR"),duplicates:count("DUPLICATE_CANDIDATE")};
  }
  function atomicImport(ledger,preview,selectedRows){
    const valid=ledgerCore.validateLedger(ledger);if(!valid)return{ok:false,status:"INVALID_LEDGER"};const selected=new Set(selectedRows??preview.rows.map((_,index)=>index).filter(index=>preview.rows[index].selected)),events=[];
    for(const [index,row] of preview.rows.entries())if(selected.has(index)){if(!row.event||row.status==="ERROR")return{ok:false,status:"INVALID_SELECTION",rowNumber:row.rowNumber};events.push({...row.event,id:""})}
    const candidate={...valid,events:[...valid.events,...events]};const replay=ledgerCore.derivePortfolioStateFromLedger(candidate.events);if(!replay.valid)return{ok:false,status:replay.status,error:replay.error,eventId:replay.eventId};const next=ledgerCore.validateLedger({...candidate,events:replay.events});return next?{ok:true,status:"VALID",ledger:next,state:replay,imported:events.length}:{ok:false,status:"INVALID_LEDGER"};
  }
  function exportLedgerCsv(ledger){const valid=ledgerCore.validateLedger(ledger);if(!valid)throw new Error("交易帳本無效");const headers=["ID","Date","Type","Symbol","Quantity","Unit Price","Gross Amount","Fee","Tax","Net Amount","Note","Source"],rows=valid.events.map(event=>[event.id,event.tradeDate,event.type,event.symbol||"",event.quantity??"",event.unitPrice??"",event.grossAmount,event.fee,event.tax,event.cashImpact,event.note,event.source]);return[headers,...rows].map(row=>row.map(csvCell).join(",")).join("\r\n")}
  function csvTemplate(){return`${CSV_HEADERS.join(",")}\r\n2026-09-20,DEPOSIT,,,,30000,0,0,每月投入\r\n2026-09-20,BUY,0050,100,50,,20,0,分批投入\r\n`}
  function normalizeGoal(raw){if(!raw||raw.targetValue===null||raw.targetValue===undefined||raw.targetValue==="")return null;const targetValue=finite(raw.targetValue),targetDate=validDate(raw.targetDate);if(targetValue===null||targetValue<=0||!targetDate)return null;return{version:VERSION,targetValue:round(targetValue),targetDate,updatedAt:String(raw.updatedAt||new Date().toISOString())}}
  function goalProgress(goal,currentAssets,asOf=""){const normalized=normalizeGoal(goal),assets=finite(currentAssets);if(!normalized||assets===null||assets<0)return{available:false,status:"NO_GOAL"};const progress=normalized.targetValue?assets/normalized.targetValue*100:0;return{available:true,status:"VALID",goal:normalized,currentAssets:round(assets),progress:round(progress,1),remaining:round(Math.max(0,normalized.targetValue-assets)),reached:assets>=normalized.targetValue,pastDue:Boolean(validDate(asOf)&&normalized.targetDate<asOf)}}
  function normalizeMonthlyPlan(raw){if(raw===null||raw===undefined||raw==="")return null;const amount=finite(raw?.amount??raw);if(amount===null||amount<=0)return null;return{version:VERSION,amount:round(amount),updatedAt:String(raw?.updatedAt||new Date().toISOString())}}
  function monthKeys(asOf,count){const end=new Date(`${asOf.slice(0,7)}-01T00:00:00Z`),out=[];for(let i=count-1;i>=0;i-=1){const date=new Date(Date.UTC(end.getUTCFullYear(),end.getUTCMonth()-i,1));out.push(date.toISOString().slice(0,7))}return out}
  function recurringAnalytics(ledger,{asOf=new Date().toISOString().slice(0,10),monthlyPlan=null}={}){const valid=ledgerCore.validateLedger(ledger);if(!valid)return{available:false,status:"LEDGER_UNAVAILABLE"};const months=monthKeys(asOf,6),rows=Object.fromEntries(months.map(month=>[month,{month,deposits:0,buys:0}])),bySymbol={};for(const event of valid.events){const month=event.tradeDate.slice(0,7);if(event.type==="DEPOSIT"&&rows[month])rows[month].deposits+=event.grossAmount;if(event.type==="BUY"){if(rows[month])rows[month].buys+=event.grossAmount+event.fee;const item=bySymbol[event.symbol]||{symbol:event.symbol,months:new Set(),totalBuy:0};if(months.includes(month)){item.months.add(month);item.totalBuy+=event.grossAmount+event.fee}bySymbol[event.symbol]=item}}
    const values=months.map(month=>({...rows[month],deposits:round(rows[month].deposits),buys:round(rows[month].buys)})),average=(key,count)=>round(values.slice(-count).reduce((sum,row)=>sum+row[key],0)/count),year=asOf.slice(0,4),ytd=valid.events.filter(event=>event.tradeDate.startsWith(year)&&event.type==="DEPOSIT").reduce((sum,event)=>sum+event.grossAmount,0),maxMonth=values.reduce((best,row)=>row.deposits>best.deposits?row:best,{month:"",deposits:0}),plan=normalizeMonthlyPlan(monthlyPlan),current=values.at(-1)?.deposits||0;
    return{available:true,status:"VALID",months:values,averageDeposit3M:average("deposits",3),averageDeposit6M:average("deposits",6),averageBuy3M:average("buys",3),averageBuy6M:average("buys",6),ytdDeposits:round(ytd),maxDepositMonth:maxMonth,bySymbol:Object.values(bySymbol).map(row=>({symbol:row.symbol,months:row.months.size,totalBuy:round(row.totalBuy)})).sort((a,b)=>b.totalBuy-a.totalBuy),monthlyPlan:plan,planProgress:plan?{planned:plan.amount,deposited:round(current),remaining:round(Math.max(0,plan.amount-current))}:null};
  }
  function calendarMonth(ledger,month){const valid=ledgerCore.validateLedger(ledger);if(!valid||!/^\d{4}-\d{2}$/.test(String(month||"")))return{available:false,status:"INVALID_INPUT",month,days:[]};const map=new Map();for(const event of valid.events.filter(row=>row.tradeDate.startsWith(month))){const list=map.get(event.tradeDate)||[];list.push(event);map.set(event.tradeDate,list)}return{available:true,status:"VALID",month,days:[...map].sort(([a],[b])=>a.localeCompare(b)).map(([date,events])=>({date,events,totalCashImpact:round(events.reduce((sum,event)=>sum+event.cashImpact,0))}))}}
  function allocationFromSnapshot(snapshot){const entries=Object.entries(snapshot?.holdings||{}).map(([symbol,row])=>({symbol,value:finite(row?.marketValue)})).filter(row=>row.value!==null&&row.value>=0),total=entries.reduce((sum,row)=>sum+row.value,0);return entries.map(row=>({symbol:row.symbol,value:round(row.value),weight:total?round(row.value/total*100,1):0}))}
  function annualizedVolatility(rows){if(rows.length<3)return null;const returns=[];for(let i=1;i<rows.length;i+=1){const previous=finite(rows[i-1].totalAssets),current=finite(rows[i].totalAssets);if(previous>0&&current!==null)returns.push(current/previous-1)}if(returns.length<2)return null;const average=returns.reduce((sum,value)=>sum+value,0)/returns.length,variance=returns.reduce((sum,value)=>sum+(value-average)**2,0)/(returns.length-1);return round(Math.sqrt(variance)*Math.sqrt(252)*100)}
  function buildAnnualReport({ledger,snapshots=[],benchmarkRows=[],marketRows=[],year}={}){const valid=ledgerCore.validateLedger(ledger),target=String(year||new Date().getFullYear());if(!valid||!/^\d{4}$/.test(target))return{available:false,status:"INVALID_INPUT"};const rows=(Array.isArray(snapshots)?snapshots:[]).filter(row=>String(row?.date||"").startsWith(target)).sort((a,b)=>a.date.localeCompare(b.date));if(!rows.length)return{available:false,status:"NO_SNAPSHOTS",year:target};if(ledgerCore.hasPositionCorrection(valid.events,rows.at(-1).date))return{available:false,status:"POSITION_CORRECTION",year:target};const first=rows[0],last=rows.at(-1),annual=analyticsCore.buildAnnualPortfolioSummary({ledger:valid,snapshots,year:target}),contribution=analyticsCore.calculatePortfolioContribution({ledger:valid,snapshots:rows,period:"ALL"}),dividends=analyticsCore.calculateDividendAnalytics({ledger:valid,year:target}),trading=analyticsCore.calculateTradingAnalytics({ledger:valid,period:"YTD",asOf:last.date}),profit=analyticsCore.calculateProfitBreakdown({ledger:valid,marketRows}),benchmark=(Array.isArray(benchmarkRows)?benchmarkRows:[]).filter(row=>row.date>=first.date&&row.date<=last.date);let benchmarkReturn=null;if(benchmark.length>1){const a=finite(benchmark[0].close??benchmark[0].value),b=finite(benchmark.at(-1).close??benchmark.at(-1).value);if(a>0&&b!==null)benchmarkReturn=(b/a-1)*100}const partial=first.date!==`${target}-01-01`||last.date!==`${target}-12-31`;
    return{available:true,status:"VALID",year:target,startDate:first.date,endDate:last.date,partialYear:partial,startAssets:round(first.totalAssets),endAssets:round(last.totalAssets),twr:annual?.twr??null,xirr:annual?.xirr??null,benchmarkReturn:benchmarkReturn===null?null:round(benchmarkReturn),relativeReturn:annual?.twr===null||benchmarkReturn===null?null:round(annual.twr-benchmarkReturn),netExternal:annual?.netDeposits??0,dividends:dividends.yearTotal??0,realizedPnL:profit.realizedPnL??0,unrealizedPnL:profit.unrealizedPnL,maxDrawdown:annual?.maxDrawdown??null,annualizedVolatility:annualizedVolatility(rows),startAllocation:allocationFromSnapshot(first),endAllocation:allocationFromSnapshot(last),contribution:contribution.rows||[],dividendBySymbol:dividends.bySymbol||[],dividendMonthly:dividends.monthly||[],trading,summary:`${first.date.replaceAll("-","/")} 至 ${last.date.replaceAll("-","/")} 期間，投資組合 TWR ${annual?.twr===null?"資料不足":`${annual.twr>=0?"+":""}${round(annual.twr,1)}%`}。`};
  }
  function exportAnnualCsv(report){if(!report?.available)throw new Error("年度報告資料不足");const rows=[["Metric","Value"],["Period",`${report.startDate}–${report.endDate}`],["Start Assets",report.startAssets],["End Assets",report.endAssets],["TWR",report.twr??""],["XIRR",report.xirr??""],["0050 Return",report.benchmarkReturn??""],["Relative Return",report.relativeReturn??""],["Net External",report.netExternal],["Dividends",report.dividends],["Realized P/L",report.realizedPnL],["Unrealized P/L",report.unrealizedPnL??""],["Max Drawdown",report.maxDrawdown??""],["Annualized Volatility",report.annualizedVolatility??""]];return rows.map(row=>row.map(csvCell).join(",")).join("\r\n")}
  function createBackupV5({holdings=[],ledger=null,snapshots=[],rebalanceSettings={},goal=null,monthlyPlan=null,importState=null,exportedAt=new Date().toISOString()}={}){return{version:BACKUP_VERSION,exportedAt,holdings,ledger,ledgerVersion:ledger?.version||null,performanceStartDate:ledger?.performanceStartDate||null,snapshots,rebalanceSettings,goal:normalizeGoal(goal),monthlyPlan:normalizeMonthlyPlan(monthlyPlan),importState:importState?{lastImportAt:importState.lastImportAt||null,fileName:String(importState.fileName||""),importedCount:Number(importState.importedCount)||0}:null}}
  function restoreBackup(raw){if(!raw||![4,5].includes(Number(raw.version)))return{ok:false,status:"UNSUPPORTED_VERSION"};const ledger=raw.ledger?ledgerCore.validateLedger(raw.ledger):null;if(raw.ledger&&!ledger)return{ok:false,status:"INVALID_LEDGER"};return{ok:true,status:"VALID",version:BACKUP_VERSION,holdings:Array.isArray(raw.holdings)?raw.holdings:[],ledger,snapshots:Array.isArray(raw.snapshots)?raw.snapshots:[],rebalanceSettings:raw.rebalanceSettings&&typeof raw.rebalanceSettings==="object"?raw.rebalanceSettings:{},goal:Number(raw.version)>=5?normalizeGoal(raw.goal):null,monthlyPlan:Number(raw.version)>=5?normalizeMonthlyPlan(raw.monthlyPlan):null,importState:Number(raw.version)>=5?raw.importState||null:null}}
  return Object.freeze({VERSION,BACKUP_VERSION,GOAL_STORAGE_KEY,PLAN_STORAGE_KEY,IMPORT_STORAGE_KEY,CSV_HEADERS,parseCsv,normalizeCsvRow,buildImportPreview,atomicImport,exportLedgerCsv,csvTemplate,normalizeGoal,goalProgress,normalizeMonthlyPlan,recurringAnalytics,calendarMonth,buildAnnualReport,exportAnnualCsv,createBackupV5,restoreBackup,duplicateKey});
});

;
/* sealed source: portfolio-resilience-core.js */
(function(root,factory){const ledger=typeof module==="object"&&module.exports?require("./portfolio-ledger-core.js"):root.HSPortfolioLedgerCore,workflow=typeof module==="object"&&module.exports?require("./portfolio-workflow-core.js"):root.HSPortfolioWorkflowCore,api=factory(ledger,workflow);if(typeof module==="object"&&module.exports)module.exports=api;if(root)root.HSPortfolioResilienceCore=api;})(typeof window!=="undefined"?window:globalThis,function(ledgerCore,workflowCore){
  "use strict";
  const VERSION="HS_PORTFOLIO_RESILIENCE_V1",BACKUP_VERSION=6,MIGRATION_VERSION="HS_PORTFOLIO_BACKUP_V6",RECOVERY_STORAGE_KEY="hsRadar.portfolio.recoveryPoints.v1",IMPORT_HISTORY_STORAGE_KEY="hsRadar.portfolio.importHistory.v1",SUPPORTED_BACKUPS=Object.freeze([4,5,6]),AUDIT_STATUS=Object.freeze({HEALTHY:"HEALTHY",WARNING:"WARNING",REPAIR_REQUIRED:"REPAIR_REQUIRED",UNSUPPORTED_VERSION:"UNSUPPORTED_VERSION"});
  const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
  // One atomic storage value, append-only checkpoints; never a Ledger event.
  const cashCore=typeof module==="object"&&module.exports?require("./portfolio-investable-cash-core.js"):globalThis.HSPortfolioInvestableCashCore;
  const CASH_KEY="hsRadar.portfolio.investableCash.v1",CASH_LOCK="hsRadar.portfolio.investableCash.lock.v1",CASH_SCHEMA="HS_INVESTABLE_CASH_STORE_V1";
  function emptyCashStore(){const body={schema:CASH_SCHEMA,version:1,revision:0,checkpoints:[]};return{...body,sha256:cashCore.fingerprint(body)};}
  function cashSource(storage){
    const ledgerRaw=storage.getItem(ledgerCore.STORAGE_KEY),holdingsRaw=storage.getItem("hsRadar.portfolio.holdings");
    let events=[];
    if(ledgerRaw!==null){const raw=JSON.parse(ledgerRaw);if(!ledgerCore.validateLedger(raw)||!Array.isArray(raw.events))throw new Error("INVALID_LEDGER");events=raw.events;}
    return{ledger_raw:ledgerRaw,holdings_raw:ledgerRaw===null?holdingsRaw:null,events};
  }
  const sourcePin=s=>({ledger_raw:s.ledger_raw,holdings_raw:s.holdings_raw});
  function validateCashStore(value){
    if(!value||value.schema!==CASH_SCHEMA||value.version!==1||!Array.isArray(value.checkpoints)||value.revision!==value.checkpoints.length)throw new Error("INVALID_CASH_STORE");
    const ids=new Set();let prior=null,at=-Infinity,priorBaseline=null;
    for(const row of value.checkpoints){
      if(row.baseline?.schema==="HS_INVESTABLE_CASH_CHECKPOINT_V2"){
        const sync=typeof module==="object"&&module.exports?require("./portfolio-transaction-cash-sync-core.js"):globalThis.HSPortfolioTransactionCashSyncCore;
        if(!sync)throw Error("CHECKPOINT_V2_VALIDATOR_UNAVAILABLE");sync.validateCheckpoint(row.baseline);
      }else cashCore.validateBaseline(row.baseline);
      if(ids.has(row.baseline.baseline_id)||row.previous_sha256!==prior||Date.parse(row.baseline.confirmed_at)<at)throw new Error("INVALID_CHECKPOINT_CHAIN");
      if(!row.source||!["string","object"].includes(typeof row.source.ledger_raw)||row.source.ledger_raw!==null&&typeof row.source.ledger_raw!=="string"||row.source.holdings_raw!==null&&typeof row.source.holdings_raw!=="string")throw new Error("INVALID_CASH_SOURCE");
      const source=cashSource({getItem:key=>key===ledgerCore.STORAGE_KEY?row.source.ledger_raw:row.source.holdings_raw});
      if(row.baseline.schema==="HS_INVESTABLE_CASH_CHECKPOINT_V2"){
        if(row.baseline.ledger.raw_sha256!==cashCore.fingerprint(row.source.ledger_raw)||cashCore.fingerprint(source.events)!==cashCore.fingerprint(row.baseline.source_state.events))throw Error("CHECKPOINT_LEDGER_RAW_MISMATCH");
        if(priorBaseline===null||cashCore.fingerprint(priorBaseline)!==cashCore.fingerprint(row.baseline.source_state.baseline))throw Error("CHECKPOINT_PREDECESSOR_MISMATCH");
      }
      if(cashCore.fingerprint(source.events.map(e=>({event_id:e.id,sha256:cashCore.fingerprint(e)})).sort((a,b)=>a.event_id.localeCompare(b.event_id)))!==cashCore.fingerprint(row.baseline.ledger.event_pins.map(p=>({event_id:p.event_id,sha256:p.sha256})).sort((a,b)=>a.event_id.localeCompare(b.event_id))))throw new Error("BASELINE_SOURCE_MISMATCH");
      const {checkpoint_sha256,...body}=row;if(cashCore.fingerprint(body)!==checkpoint_sha256)throw new Error("CASH_CHECKPOINT_HASH_MISMATCH");
      ids.add(row.baseline.baseline_id);prior=checkpoint_sha256;at=Date.parse(row.baseline.confirmed_at);priorBaseline=row.baseline;
    }
    const {sha256,...body}=value;if(cashCore.fingerprint(body)!==sha256)throw new Error("CASH_STORE_HASH_MISMATCH");return value;
  }
  function readInvestableCash(storage,{asOf=new Date().toISOString()}={}){
    try{
      const coordinated=storage.getItem("hsRadar.portfolio.writeCoordination.v1")!==null||storage.getItem("hsRadar.portfolio.writeJournal.v1")!==null||storage.getItem("hsRadar.portfolio.transactionCashSync.v1")!==null;
      if(coordinated){const coordinator=typeof module==="object"&&module.exports?require("./portfolio-write-coordinator.js"):globalThis.HSPortfolioWriteCoordinator;
        if(!coordinator)return{status:"RECONCILIATION_REQUIRED",amount:null,reason:"COORDINATOR_UNAVAILABLE"};
        try{coordinator.capture(storage,{asOf});}catch(e){return{status:e.message.includes("RECOVERY")?"RECOVERY_REQUIRED":"RECONCILIATION_REQUIRED",amount:null,amountMinor:null,reason:e.message};}
        const raw=storage.getItem(coordinator.SYNC_KEY);if(raw!==null){const syncCore=typeof module==="object"&&module.exports?require("./portfolio-transaction-cash-sync-core.js"):globalThis.HSPortfolioTransactionCashSyncCore;if(!syncCore)return{status:"INVALID",amount:null,reason:"SYNC_CORE_UNAVAILABLE"};const state=syncCore.validateStore(JSON.parse(raw),{asOf}).state,result=syncCore.derive({...state,asOf});return{status:result.status,amount:result.status==="READY"?result.investable_minor/100:null,amountMinor:result.status==="READY"?result.investable_minor:null,confirmedAmountMinor:state.baseline.confirmed_amount_minor,confirmedAt:state.baseline.confirmed_at,baselineId:state.baseline.baseline_id,reason:result.reasons.join(",")};}
      }
      if(storage.getItem("hsRadar.portfolio.preRestoreJournal.v1")!==null)return{status:"INVALID",amount:null,reason:"RESTORE_IN_PROGRESS"};
      const raw=storage.getItem(CASH_KEY);if(raw===null)return{status:"UNINITIALIZED",amount:null,raw:null};
      const store=validateCashStore(JSON.parse(raw));
      if(!store.checkpoints.length)return{status:"UNINITIALIZED",amount:null,raw,revision:0};
      const row=store.checkpoints.at(-1),source=cashSource(storage);
      const result=cashCore.deriveCash({baseline:row.baseline,events:source.events,ledgerComplete:true,asOf});
      // No transaction/settlement adapter until Phase 2B-2: changed source is never spendable.
      const same=cashCore.fingerprint(sourcePin(source))===cashCore.fingerprint(row.source);
      const status=!same?"RECONCILIATION_REQUIRED":result.status==="READY"?"READY":result.status==="PENDING"?"PENDING":"RECONCILIATION_REQUIRED";
      return{status,amount:status==="READY"?result.investable_minor/100:null,amountMinor:status==="READY"?result.investable_minor:null,confirmedAmount:row.baseline.confirmed_amount_minor/100,confirmedAmountMinor:row.baseline.confirmed_amount_minor,confirmedAt:row.baseline.confirmed_at,baselineId:row.baseline.baseline_id,revision:store.revision,raw,reason:!same?"LEDGER_OR_HOLDINGS_CHANGED":result.reasons.join(",")};
    }catch(error){return{status:"INVALID",amount:null,reason:error.message};}
  }
  async function confirmInvestableCash(storage,{expectedRaw,expectedSource,baselineId,amount,confirmedAt,locks}={}){
    if(!locks?.request)return{ok:false,status:"LOCK_UNAVAILABLE"};
    try{return await locks.request(CASH_LOCK,{mode:"exclusive"},()=>{
      if(["hsRadar.portfolio.writeCoordination.v1","hsRadar.portfolio.writeJournal.v1","hsRadar.portfolio.transactionCashSync.v1"].some(k=>storage.getItem(k)!==null))throw new Error("COORDINATOR_REQUIRED");
      if(storage.getItem("hsRadar.portfolio.preRestoreJournal.v1")!==null)throw new Error("RESTORE_IN_PROGRESS");
      const raw=storage.getItem(CASH_KEY);if(raw!==expectedRaw)throw new Error("VERSION_CONFLICT");
      const source=cashSource(storage);if(cashCore.fingerprint(sourcePin(source))!==expectedSource)throw new Error("LEDGER_VERSION_CONFLICT");
      const previous=raw===null?null:validateCashStore(JSON.parse(raw));
      if(previous?.checkpoints.some(r=>r.baseline.baseline_id===baselineId))throw new Error("DUPLICATE_BASELINE_ID");
      const baseline=cashCore.createBaseline({baselineId,amount,confirmedAt,events:source.events,ledgerComplete:true});
      const body={baseline,source:sourcePin(source),previous_sha256:previous?.checkpoints.at(-1)?.checkpoint_sha256||null};
      const checkpoint={...body,checkpoint_sha256:cashCore.fingerprint(body)},nextBody={schema:CASH_SCHEMA,version:1,revision:(previous?.revision||0)+1,checkpoints:[...(previous?.checkpoints||[]),checkpoint]};
      const next={...nextBody,sha256:cashCore.fingerprint(nextBody)},text=JSON.stringify(validateCashStore(next));
      // No second persistent write: storage quota/interruption preserves the previous envelope.
      storage.setItem(CASH_KEY,text);
      if(storage.getItem(CASH_KEY)!==text)throw new Error("SAVE_VERIFY_FAILED");
      return{ok:true,status:"SAVED",state:readInvestableCash(storage,{asOf:confirmedAt})};
    });}catch(error){return{ok:false,status:error.message||"SAVE_FAILED"};}
  }
  function cashSourceFingerprint(storage){return cashCore.fingerprint(sourcePin(cashSource(storage)));}
  async function confirmInvestableCashCoordinated(storage,{expected,operationId,baselineId,amount,confirmedAt,locks,signal}={}){
    const coordinator=typeof module==="object"&&module.exports?require("./portfolio-write-coordinator.js"):globalThis.HSPortfolioWriteCoordinator;if(!coordinator)return{ok:false,status:"COORDINATOR_UNAVAILABLE"};
    return coordinator.service(storage,{locks}).execute({operationId,kind:"CASH_CHECKPOINT",intent:{baselineId,amount,confirmedAt},expected,asOf:confirmedAt,signal,plan:async entries=>{
      // Dry run against a private snapshot while the real shared lock is held.
      const data={...entries};delete data[coordinator.SYNC_KEY];delete data[coordinator.ARCHIVE_KEY];
      const memory={getItem:k=>data[k]??null,setItem:(k,v)=>{data[k]=String(v);}},inlineLocks={request:async(name,options,fn)=>fn()};
      const result=await confirmInvestableCash(memory,{expectedRaw:memory.getItem(CASH_KEY),expectedSource:cashSourceFingerprint(memory),baselineId,amount,confirmedAt,locks:inlineLocks});
      if(!result.ok)throw Error(result.status);return coordinator.replaceCheckpoint(entries,memory.getItem(CASH_KEY),{asOf:confirmedAt,archiveId:operationId});
    }});
  }
  const finite=value=>{const n=Number(value);return Number.isFinite(n)?n:null};
  const validDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value||""));
  const hash=text=>{let value=2166136261;for(const char of String(text)){value^=char.charCodeAt(0);value=Math.imul(value,16777619)}return(value>>>0).toString(36)};
  const issue=(code,severity,message,extra={})=>({code,severity,message,...extra});
  function auditPortfolioData({ledger,snapshots=[],targets={},backup=null,knownSymbols=[],metadata={}}={}){
    const issues=[];if(!ledger||ledger.version!==ledgerCore.VERSION)return{status:AUDIT_STATUS.UNSUPPORTED_VERSION,issues:[issue("UNSUPPORTED_LEDGER_VERSION","ERROR","交易帳本版本不支援")],checkedAt:null};
    if(!Array.isArray(ledger.events))issues.push(issue("INVALID_EVENTS","ERROR","交易紀錄不是陣列"));else{
      const ids=new Set();let previous="";for(const [index,raw] of ledger.events.entries()){
        if(raw?.id&&ids.has(raw.id))issues.push(issue("DUPLICATE_EVENT_ID","ERROR","交易識別碼重複",{eventId:raw.id,index}));if(raw?.id)ids.add(raw.id);
        const event=ledgerCore.normalizeEvent(raw);if(!event)issues.push(issue("INVALID_EVENT","ERROR","交易欄位無效",{index,eventId:raw?.id||null}));else{const key=`${event.tradeDate}|${event.timestamp}|${event.id}`;if(previous&&key<previous)issues.push(issue("NON_CHRONOLOGICAL_ORDER","WARNING","交易記錄未依時間排序",{eventId:event.id}));previous=key}
      }
    }
    const replay=ledgerCore.derivePortfolioStateFromLedger(ledger.events);if(!replay.valid)issues.push(issue(replay.status||"REPLAY_FAILED","ERROR",replay.error||"交易重播失敗",{eventId:replay.eventId||null}));
    if(ledgerCore.hasPositionCorrection(ledger.events))issues.push(issue("POSITION_CORRECTION","WARNING","持股曾手動校正；無現金流，相關期間績效暫不計算"));
    if(!validDate(ledger.performanceStartDate))issues.push(issue("INVALID_PERFORMANCE_START","ERROR","績效起始日期無效"));
    const targetRows=Object.entries(targets||{}),targetTotal=targetRows.reduce((sum,[,value])=>sum+(finite(value)||0),0);for(const [symbol,value] of targetRows)if(finite(value)===null||Number(value)<0||Number(value)>100)issues.push(issue("INVALID_TARGET","ERROR","目標配置無效",{symbol}));if(targetRows.length&&Math.abs(targetTotal-100)>.01)issues.push(issue("TARGET_TOTAL","WARNING","目標配置合計不是 100%",{total:targetTotal}));
    const known=new Set(knownSymbols.map(ledgerCore.normalizeSymbol));for(const event of replay.events||[])if(event.symbol&&known.size&&!known.has(event.symbol))issues.push(issue("UNKNOWN_SYMBOL","WARNING","交易帳本含未識別代號",{symbol:event.symbol,eventId:event.id}));
    const rows=Array.isArray(snapshots)?snapshots:[];if(rows.length&&replay.valid){const latest=[...rows].sort((a,b)=>String(a?.date||"").localeCompare(String(b?.date||""))).at(-1),reconciliation=ledgerCore.reconcileLedgerWithSnapshot(replay,latest);if(reconciliation.status==="UNRECONCILED_STATE")issues.push(issue("SNAPSHOT_MISMATCH","WARNING","最新績效快照與帳本狀態不一致",{mismatches:reconciliation.mismatches}))}
    if(backup&&!SUPPORTED_BACKUPS.includes(Number(backup.version)))issues.push(issue("UNSUPPORTED_BACKUP_VERSION","ERROR","備份版本不支援"));
    const eventIds=new Set((replay.events||[]).map(row=>row.id));for(const key of Object.keys(metadata||{}))if(key.startsWith("event:")&&!eventIds.has(key.slice(6)))issues.push(issue("ORPHAN_METADATA","WARNING","存在無對應交易的附加資料",{key}));
    const status=issues.some(row=>row.severity==="ERROR")?AUDIT_STATUS.REPAIR_REQUIRED:issues.length?AUDIT_STATUS.WARNING:AUDIT_STATUS.HEALTHY;return{status,issues,checkedAt:null,summary:{events:ledger.events.length,snapshots:rows.length,holdings:replay.valid?replay.holdings.length:null,cash:replay.valid?replay.cash:null}};
  }
  function createBackupV6({exportedAt=new Date().toISOString(),holdings=[],ledger=null,snapshots=[],rebalanceSettings={},goal=null,monthlyPlan=null,importState=null,corporateActions=null,importHistory=[],audit=null,migration={}}={}){return{version:BACKUP_VERSION,schema:"HS_PORTFOLIO_BACKUP_V6",exportedAt,holdings:clone(holdings),ledger:clone(ledger),ledgerVersion:ledger?.version||null,performanceStartDate:ledger?.performanceStartDate||null,snapshots:clone(snapshots),rebalanceSettings:clone(rebalanceSettings),goal:workflowCore.normalizeGoal(goal),monthlyPlan:workflowCore.normalizeMonthlyPlan(monthlyPlan),importState:clone(importState),corporateActions:clone(corporateActions||ledger?.events?.filter(row=>ledgerCore.CORPORATE_ACTIONS.has(row.type))||[]),importHistory:clone(importHistory),migration:{version:MIGRATION_VERSION,...clone(migration)},audit:{status:audit?.status||null,exportedWith:VERSION}}}
  function migrateBackup(raw){if(!raw||!SUPPORTED_BACKUPS.includes(Number(raw.version)))return{ok:false,status:"UNSUPPORTED_VERSION"};if(Number(raw.version)===6)return raw.schema==="HS_PORTFOLIO_BACKUP_V6"?{ok:true,status:"ALREADY_CURRENT",backup:clone(raw)}:{ok:false,status:"INVALID_SCHEMA"};const restored=workflowCore.restoreBackup(raw);if(!restored.ok)return restored;const migrationTime=String(raw.exportedAt||restored.ledger?.ledgerInitializedAt||"1970-01-01T00:00:00.000Z");return{ok:true,status:"MIGRATED",backup:createBackupV6({...restored,exportedAt:migrationTime,importState:restored.importState,migration:{fromVersion:Number(raw.version),migratedAt:migrationTime}})}}
  function previewBackup(raw){const migrated=migrateBackup(raw);if(!migrated.ok)return migrated;const data=migrated.backup,ledger=data.ledger?ledgerCore.validateLedger(data.ledger):null;if(data.ledger&&!ledger)return{ok:false,status:"INVALID_LEDGER"};const audit=ledger?auditPortfolioData({ledger,snapshots:data.snapshots,targets:data.rebalanceSettings?.targets||{},backup:data}):null;return{ok:true,status:"PREVIEW",version:data.version,migrated:migrated.status==="MIGRATED",counts:{events:ledger?.events.length||0,snapshots:data.snapshots.length,holdings:data.holdings.length,imports:data.importHistory.length,corporateActions:data.corporateActions.length},performanceStartDate:ledger?.performanceStartDate||null,audit,backup:data}}
  function restoreBackup(raw){const preview=previewBackup(raw);if(!preview.ok||preview.audit?.status===AUDIT_STATUS.REPAIR_REQUIRED)return{ok:false,status:preview.status||"AUDIT_FAILED",preview};const data=preview.backup;return{ok:true,status:"VALID",version:6,holdings:clone(data.holdings),ledger:data.ledger?ledgerCore.validateLedger(data.ledger):null,snapshots:clone(data.snapshots),rebalanceSettings:clone(data.rebalanceSettings),goal:workflowCore.normalizeGoal(data.goal),monthlyPlan:workflowCore.normalizeMonthlyPlan(data.monthlyPlan),importState:clone(data.importState),importHistory:clone(data.importHistory),migration:clone(data.migration)}}
  function createRecoveryPoint({reason,state,createdAt=new Date().toISOString()}={}){const backup=createBackupV6({...state,exportedAt:createdAt});return{id:`recovery_${hash(`${createdAt}|${reason}|${backup.ledger?.events?.length||0}`)}`,reason:String(reason||"MANUAL").slice(0,64),createdAt,backup}}
  function appendRecoveryPoint(points,point){return[...(Array.isArray(points)?points:[]),point].filter(Boolean).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).slice(-3)}
  function previewRepair(input){const audit=auditPortfolioData(input),operations=[];for(const row of audit.issues)if(row.code==="NON_CHRONOLOGICAL_ORDER")operations.push({type:"SORT_LEDGER_EVENTS"});else if(row.code==="ORPHAN_METADATA")operations.push({type:"REMOVE_ORPHAN_METADATA",key:row.key});return{status:operations.length?"REPAIR_AVAILABLE":"NO_SAFE_REPAIR",audit,operations:[...new Map(operations.map(row=>[JSON.stringify(row),row])).values()]}}
  function applyRepair(input,preview){if(!preview||preview.status!=="REPAIR_AVAILABLE")return{ok:false,status:"NO_SAFE_REPAIR"};const next=clone(input);for(const operation of preview.operations){if(operation.type==="SORT_LEDGER_EVENTS")next.ledger.events=ledgerCore.sortEvents(next.ledger.events);if(operation.type==="REMOVE_ORPHAN_METADATA"&&next.metadata)delete next.metadata[operation.key]}const audit=auditPortfolioData(next);return audit.status===AUDIT_STATUS.REPAIR_REQUIRED?{ok:false,status:"REPAIR_FAILED",audit}:{ok:true,status:"REPAIRED",data:next,audit}}
  const GENERIC_HEADERS=Object.freeze(["trade_date","side","ticker","shares","unit_price","amount","fee","tax","memo"]);
  const GENERIC_BROKER_ADAPTER=Object.freeze({id:"GENERIC_BROKER_CSV_V1",name:"通用券商 CSV",detect(text){const line=String(text||"").replace(/^\uFEFF/,"").split(/\r?\n/,1)[0]||"",first=line.split(",");return GENERIC_HEADERS.every((name,index)=>String(first[index]||"").trim().toLowerCase()===name)},parse(text){if(!this.detect(text))return{ok:false,status:"UNSUPPORTED_FORMAT",rows:[]};const source=String(text||"").replace(/^\uFEFF/,""),newline=source.indexOf("\n"),normalized=`${workflowCore.CSV_HEADERS.join(",")}\n${newline>=0?source.slice(newline+1):""}`,parsed=workflowCore.parseCsv(normalized);return{ok:true,status:"PARSED",rows:parsed.rows.map(row=>({rowNumber:row.__row,tradeDate:row.date,type:String(row.type||"").trim().toUpperCase(),symbol:ledgerCore.normalizeSymbol(row.symbol),quantity:row.quantity,unitPrice:row.price,grossAmount:row.amount,fee:row.fee,tax:row.tax,note:row.note}))}},normalize(row){return ledgerCore.normalizeEvent({...row,source:"BROKER_IMPORT",timestamp:`${row.tradeDate}T12:00:00+08:00`,createdAt:`${row.tradeDate}T12:00:00+08:00`})},validate(event){return Boolean(event)}});
  function detectBrokerAdapter(text,adapters=[GENERIC_BROKER_ADAPTER]){return adapters.find(adapter=>adapter.detect(text))||null}
  function buildBrokerPreview(text,ledger,{adapter=detectBrokerAdapter(text),fileName="broker.csv",batchId=""}={}){if(!adapter)return{ok:false,status:"UNSUPPORTED_FORMAT",rows:[]};const parsed=adapter.parse(text);if(!parsed.ok)return parsed;const id=batchId||`import_${hash(`${adapter.id}|${fileName}|${text}`)}`,rows=parsed.rows.map(row=>{const event=adapter.normalize(row),duplicate=event?ledgerCore.detectLikelyDuplicate(ledger?.events||[],event):false;return{rowNumber:row.rowNumber,event,status:!event||!adapter.validate(event)?"ERROR":duplicate?"DUPLICATE_CANDIDATE":"VALID",selected:Boolean(event&&!duplicate),messages:!event?["欄位格式無效"]:duplicate?["疑似重複"]:[]}});return{ok:true,status:"PREVIEW",adapterId:adapter.id,importBatchId:id,fileName,total:rows.length,valid:rows.filter(row=>row.status==="VALID").length,warning:rows.filter(row=>row.status==="WARNING").length,errors:rows.filter(row=>row.status==="ERROR").length,duplicates:rows.filter(row=>row.status==="DUPLICATE_CANDIDATE").length,rows}}
  function atomicBrokerImport(ledger,preview,selectedRows){if(!preview?.ok)return{ok:false,status:"INVALID_PREVIEW"};const indexes=Array.isArray(selectedRows)?selectedRows:preview.rows.map((_,index)=>index),events=indexes.map(index=>preview.rows[index]).filter(row=>row?.selected&&row.event).map(row=>ledgerCore.normalizeEvent({...row.event,importBatchId:preview.importBatchId,adapterId:preview.adapterId,source:"BROKER_IMPORT"}));let next=ledgerCore.validateLedger(ledger);if(!next)return{ok:false,status:"INVALID_LEDGER"};for(const event of events){const result=ledgerCore.mutateLedger(next,{type:"ADD",event});if(!result.ok)return{ok:false,status:result.status,error:result.error};next=result.ledger}return{ok:true,status:"IMPORTED",ledger:next,imported:events.length,importBatchId:preview.importBatchId,adapterId:preview.adapterId}}
  function rollbackImportBatch(ledger,batchId){const valid=ledgerCore.validateLedger(ledger);if(!valid)return{ok:false,status:"INVALID_LEDGER"};const id=String(batchId||""),removed=valid.events.filter(row=>row.importBatchId===id);if(!removed.length)return{ok:false,status:"BATCH_NOT_FOUND"};const remaining=valid.events.filter(row=>row.importBatchId!==id),replay=ledgerCore.derivePortfolioStateFromLedger(remaining);return replay.valid?{ok:true,status:"ROLLED_BACK",removed:removed.length,ledger:{...valid,events:replay.events}}:{ok:false,status:replay.status,error:replay.error}}
  function cashBackup(state={}){const backup=createBackupV6(state);if(state.investableCash!=null)backup.investableCash=clone(validateCashStore(state.investableCash));return backup;}
  function cashPreview(raw){try{if(raw?.investableCash!=null)validateCashStore(raw.investableCash);return previewBackup(raw);}catch{return{ok:false,status:"INVALID_CASH_STORE"};}}
  function cashRestore(raw){const preview=cashPreview(raw);if(!preview.ok)return preview;const restored=restoreBackup(raw);if(restored.ok)restored.investableCash=raw.investableCash?clone(raw.investableCash):null;return restored;}
  function cashRecoveryPoint(options={}){const point=createRecoveryPoint(options);point.backup=cashBackup({...options.state,exportedAt:point.createdAt});return point;}
  return Object.freeze({VERSION,BACKUP_VERSION,MIGRATION_VERSION,RECOVERY_STORAGE_KEY,IMPORT_HISTORY_STORAGE_KEY,AUDIT_STATUS,GENERIC_BROKER_ADAPTER,auditPortfolioData,createBackupV6:cashBackup,migrateBackup,previewBackup:cashPreview,restoreBackup:cashRestore,createRecoveryPoint:cashRecoveryPoint,appendRecoveryPoint,previewRepair,applyRepair,detectBrokerAdapter,buildBrokerPreview,atomicBrokerImport,rollbackImportBatch,CASH_KEY,CASH_LOCK,CASH_SCHEMA,emptyCashStore,cashSourceFingerprint,validateCashStore,readInvestableCash,confirmInvestableCash,confirmInvestableCashCoordinated});
});

;
/* sealed source: portfolio-dividend-receipt-v2-core.js */
(function(root,factory){
  const api=typeof module==="object"&&module.exports?factory(require("./portfolio-investable-cash-core.js"),require("./portfolio-ledger-core.js")):factory(root.HSPortfolioInvestableCashCore,root.HSPortfolioLedgerCore);
  if(typeof module==="object"&&module.exports)module.exports=api;
  if(root)root.HSPortfolioDividendReceiptV2Core=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(cash,ledger){
  "use strict";
  // Pure, opt-in V2 receipt contract. NOT a Ledger, storage adapter or cash account.
  // This API returns only the V2 dividend credit since an explicit V1 baseline.
  // Never add this to a V1 result that already includes the same dividend IDs.
  const SCHEMA="HS_DIVIDEND_RECEIPT_METADATA_V2",VERSION=2;
  const DEDUCTION_TYPES=Object.freeze(["WITHHOLDING_TAX","BROKER_FEE","TRANSFER_FEE","OTHER"]);
  const REVIEW="RECONCILIATION_REQUIRED",MAX=BigInt(Number.MAX_SAFE_INTEGER);
  const fail=reason=>{throw new Error(reason);};
  const plain=v=>Boolean(v&&typeof v==="object"&&!Array.isArray(v)&&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null));
  const text=v=>typeof v==="string"&&v.length>0&&v===v.trim()&&v.length<=512;
  const hash=v=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
  const clone=v=>JSON.parse(JSON.stringify(v));
  const minor=v=>{if(!Number.isSafeInteger(v)||v<0||Object.is(v,-0))fail("INVALID_MINOR_UNITS");return BigInt(v);};
  const safe=v=>{if(v<0n||v>MAX)fail("UNSAFE_MINOR_UNITS");return Number(v);};
  function time(v){
    if(typeof v!=="string"||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(v))fail("OFFSET_TIMESTAMP_REQUIRED");
    const value=Date.parse(v),day=v.slice(0,10),offset=v.slice(-6);
    if(!Number.isFinite(value)||new Date(day+"T00:00:00Z").toISOString().slice(0,10)!==day||+v.slice(11,13)>23||+v.slice(14,16)>59||+v.slice(17,19)>59||/^[+-]14:/.test(offset)&&offset.slice(4)!=="00")fail("INVALID_TIMESTAMP");
    return value;
  }
  function confirmation(value,now){
    if(!plain(value)||!["USER_CONFIRMATION","DOCUMENT_REFERENCE"].includes(value.kind)||!text(value.reference))fail("CONFIRMATION_REQUIRED");
    if(Object.keys(value).some(k=>!["kind","reference","confirmed_at"].includes(k)))fail("UNSUPPORTED_CONFIRMATION_CLAIM");
    const at=time(value.confirmed_at);if(at>now)fail("FUTURE_CONFIRMATION");
    return at;
  }
  function freeze(value){if(value&&typeof value==="object"){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
  function eventHash(event){return cash.fingerprint(event);}
  function eventCheck(event){
    const normalized=ledger.normalizeEvent(event);
    if(!plain(event)||!text(event.id)||event.type!=="DIVIDEND"||!normalized||normalized.id!==event.id)fail("INVALID_DIVIDEND_EVENT");
    time(event.timestamp);
    if(cash.toMinorUnits(event.grossAmount)!==cash.toMinorUnits(normalized.grossAmount))fail("INVALID_LEDGER_GROSS");
    return cash.toMinorUnits(event.grossAmount);
  }
  function seal(body){return{...body,record_sha256:cash.fingerprint(body)};}
  function shape(record){
    if(!plain(record)||record.schema!==SCHEMA||record.version!==VERSION)fail("UNSUPPORTED_RECEIPT_VERSION");
    const fields=["schema","version","record_id","event_id","event_sha256","currency","minor_unit_scale","gross_amount_minor","deductions","net_received_minor","receipt_state","received_at","available_at","investment_account","confirmation","payment_reference","baseline_coverage","fee_tax_review","evidence_classification","integrity_status","record_sha256"];
    if(Object.keys(record).length!==fields.length||Object.keys(record).some(k=>!fields.includes(k)))fail("UNSUPPORTED_RECEIPT_FIELD");
    if(!text(record.record_id)||!text(record.event_id)||!hash(record.event_sha256)||record.currency!=="TWD"||record.minor_unit_scale!==2||record.integrity_status!=="UNVERIFIED")fail("INVALID_RECEIPT_SCHEMA");
    if(!hash(record.record_sha256))fail("RECEIPT_HASH_REQUIRED");
    const {record_sha256,...body}=record;if(cash.fingerprint(body)!==record_sha256)fail("RECEIPT_HASH_MISMATCH");
    minor(record.gross_amount_minor);
    if(record.net_received_minor!==null)minor(record.net_received_minor);
    if(!Array.isArray(record.deductions))fail("DEDUCTION_DETAILS_REQUIRED");
    const ids=new Set();let sum=0n;
    for(const row of record.deductions){
      if(!plain(row)||Object.keys(row).length!==4||Object.keys(row).some(k=>!["deduction_id","type","amount_minor","reason"].includes(k))||!text(row.deduction_id)||ids.has(row.deduction_id)||!DEDUCTION_TYPES.includes(row.type)||!text(row.reason))fail("INVALID_DEDUCTION_DETAILS");
      ids.add(row.deduction_id);sum+=minor(row.amount_minor);safe(sum);
    }
    if(sum>BigInt(record.gross_amount_minor))fail("DEDUCTIONS_EXCEED_GROSS");
    if(!["PENDING","CONFIRMED"].includes(record.receipt_state)||![true,false,null].includes(record.investment_account)||!text(record.payment_reference))fail("INVALID_RECEIPT_STATE");
    if(!Array.isArray(record.fee_tax_review))fail("FEE_TAX_REVIEW_REQUIRED");
    if(record.evidence_classification!=="USER_PROVIDED_NOT_EXTERNALLY_AUTHENTICATED")fail("UNSUPPORTED_VERIFICATION_CLAIM");
    return sum;
  }
  function createReceipt({event,...input}={}){
    eventCheck(event);
    // Explicit V2 factory only; do not accept V1 records as constructor input.
    const allowed=new Set(["record_id","gross_amount_minor","deductions","net_received_minor","receipt_state","received_at","available_at","investment_account","confirmation","payment_reference","baseline_coverage","fee_tax_review"]);
    for(const key of Object.keys(input))if(!allowed.has(key))fail("UNSUPPORTED_RECEIPT_FIELD:"+key);
    cash.fingerprint(input); // Reject NaN/Infinity before JSON cloning.
    const body={schema:SCHEMA,version:VERSION,record_id:input.record_id,event_id:event.id,event_sha256:eventHash(event),currency:"TWD",minor_unit_scale:2,
      gross_amount_minor:input.gross_amount_minor,deductions:input.deductions,net_received_minor:input.net_received_minor,
      receipt_state:input.receipt_state,received_at:input.received_at,available_at:input.available_at,investment_account:input.investment_account,
      confirmation:input.confirmation,payment_reference:input.payment_reference,baseline_coverage:input.baseline_coverage,fee_tax_review:input.fee_tax_review,
      evidence_classification:"USER_PROVIDED_NOT_EXTERNALLY_AUTHENTICATED",integrity_status:"UNVERIFIED"};
    const record=seal(body);shape(record);return freeze(clone(record));
  }
  function ledgerMap(events,now){
    if(!Array.isArray(events))fail("COMPLETE_LEDGER_REQUIRED");
    const map=new Map();
    for(const row of events){
      if(!plain(row)||!text(row.id)||map.has(row.id))fail("DUPLICATE_OR_INVALID_EVENT_ID");
      const recorded=time(row.timestamp),created=row.createdAt===undefined?recorded:time(row.createdAt),updated=row.updatedAt===undefined?created:time(row.updatedAt);
      if(recorded>now||created>now||updated>now||updated<created)fail("LEDGER_CLOCK_CONFLICT");
      map.set(row.id,row);
    }
    if(!ledger.derivePortfolioStateFromLedger(events).valid)fail("INVALID_LEDGER_REPLAY");return map;
  }
  function feeReview(record,map,now){
    const costs=[...map.values()].filter(e=>e.type==="FEE"||e.type==="TAX"),reviews=new Map();
    for(const row of record.fee_tax_review){
      if(!plain(row)||!text(row.event_id)||reviews.has(row.event_id)||!hash(row.event_sha256))fail("INVALID_FEE_TAX_REVIEW");
      const cost=map.get(row.event_id);if(!cost||!["FEE","TAX"].includes(cost.type)||eventHash(cost)!==row.event_sha256)fail("FEE_TAX_REVIEW_HASH_MISMATCH");
      if(confirmation(row.confirmation,now)<time(cost.updatedAt||cost.timestamp))fail("STALE_FEE_TAX_CONFIRMATION");
      if(row.relationship!=="UNRELATED")fail("POSSIBLE_DUPLICATE_LEDGER_DEDUCTION");
      reviews.set(row.event_id,row);
    }
    // No reliable event linkage exists in Ledger V1: even a different date alone
    // is not proof of unrelated costs. Owner review is explicit and hash-bound.
    if(costs.some(e=>!reviews.has(e.id)))fail("UNREVIEWED_SEPARATE_FEE_TAX");
  }
  function coverage(record,event,baseline,now){
    const c=record.baseline_coverage;
    if(!plain(c)||c.baseline_id!==baseline.baseline_id||c.baseline_sha256!==baseline.baseline_sha256||!["INCLUDED","EXCLUDED"].includes(c.disposition))fail("BASELINE_COVERAGE_REQUIRED");
    const checked=confirmation(c.confirmation,now);
    if(checked<time(baseline.confirmed_at)||checked<time(event.updatedAt||event.timestamp))fail("STALE_COVERAGE_CONFIRMATION");
    const pinned=baseline.ledger.event_pins.some(p=>p.event_id===record.event_id),old=baseline.settlement_at_baseline.find(p=>p.event_id===record.event_id);
    if(pinned&&!old)fail("BASELINE_SETTLEMENT_MISSING");
    if(old?.state==="UNKNOWN")fail("BASELINE_SETTLEMENT_UNKNOWN");
    if(old?.state==="AVAILABLE"){
      if(c.disposition!=="INCLUDED"||old.reference!==record.payment_reference||old.received_amount_minor!==record.net_received_minor||time(old.available_at)!==time(record.available_at))fail("BASELINE_SETTLEMENT_CONFLICT");
    }else if(old?.state==="PENDING"){
      if(c.disposition!=="EXCLUDED")fail("BASELINE_PENDING_COVERAGE_CONFLICT");
      if(old.reference&&old.reference!==record.payment_reference)fail("BASELINE_PENDING_REFERENCE_CONFLICT");
    }
    if(c.disposition==="INCLUDED"&&!pinned)fail("UNPINNED_INCLUDED_RECEIPT");
    if(c.disposition==="EXCLUDED"&&record.available_at!==null&&time(record.available_at)<=time(baseline.confirmed_at))fail("PRE_BASELINE_AVAILABILITY_REQUIRES_NEW_CHECKPOINT");
    return c.disposition;
  }
  function assessOne(record,event,map,baseline,now){
    const deducted=shape(record),gross=eventCheck(event);
    if(event.id!==record.event_id||eventHash(event)!==record.event_sha256)fail("EVENT_HASH_MISMATCH");
    if(gross!==record.gross_amount_minor)fail("LEDGER_GROSS_MISMATCH");
    if(event.fee!==0||event.tax!==0)fail("DIVIDEND_EMBEDDED_COST_REVIEW_REQUIRED");
    feeReview(record,map,now);
    const disposition=coverage(record,event,baseline,now);
    if(record.receipt_state==="PENDING"){
      if(record.received_at!==null||record.net_received_minor!==null||record.available_at!==null||record.confirmation!==null)fail("PENDING_RECEIPT_CANNOT_CLAIM_ACTUAL_PAYMENT");
      return{status:"PENDING",credit_minor:0,reason:"NOT_RECEIVED"};
    }
    if(record.net_received_minor===null)fail("NET_RECEIPT_REQUIRED");
    if(BigInt(gross)!==minor(record.net_received_minor)+deducted)fail("GROSS_DEDUCTION_NET_MISMATCH");
    const received=time(record.received_at),available=time(record.available_at),confirmed=confirmation(record.confirmation,now);
    if(received>now||received<time(event.tradeDate+"T00:00:00+08:00")||available<received||confirmed<received||confirmed<time(event.updatedAt||event.timestamp))fail("RECEIPT_CLOCK_CONFLICT");
    if(record.investment_account===null)fail("INVESTMENT_ACCOUNT_CONFIRMATION_REQUIRED");
    if(disposition==="INCLUDED")return{status:"COVERED_BY_BASELINE",credit_minor:0,reason:"ALREADY_INCLUDED"};
    if(record.investment_account===false)return{status:"NOT_INVESTABLE",credit_minor:0,reason:"NON_INVESTMENT_ACCOUNT"};
    if(available>now)return{status:"PENDING",credit_minor:0,reason:"NOT_YET_AVAILABLE"};
    return{status:"AVAILABLE",credit_minor:record.net_received_minor,reason:null};
  }
  function evaluateReceipts({events,receipts,baseline,asOf,ledgerComplete=false,v1EventMetadata={}}={}){
    const blocked=reason=>({status:REVIEW,credit_minor:null,recognized_event_ids:[],receipts:[],reasons:[reason]});
    try{
      if(ledgerComplete!==true)fail("COMPLETE_LEDGER_REQUIRED");
      const now=time(asOf);cash.validateBaseline(baseline);
      if(time(baseline.confirmed_at)>now)fail("CLOCK_BEFORE_BASELINE");
      const map=ledgerMap(events,now);
      if(baseline.integrity.status!=="VERIFIED")fail("V1_BASELINE_REQUIRES_RECONCILIATION");
      for(const pin of baseline.ledger.event_pins)if(!map.has(pin.event_id)||eventHash(map.get(pin.event_id))!==pin.sha256)fail("BASELINE_EVENT_CHANGED_OR_REMOVED:"+pin.event_id);
      if(!Array.isArray(receipts)||!plain(v1EventMetadata))fail("INVALID_RECEIPT_SET");
      const records=new Map(),ids=new Map(),references=new Set(),results=[];
      for(const [id,meta] of Object.entries(v1EventMetadata)){
        if(!map.has(id)||!plain(meta))fail("INVALID_V1_ROUTING_METADATA");
        if(meta.availability?.state==="AVAILABLE"){
          const ref=meta.availability.reference;if(!text(ref)||references.has(ref))fail("DUPLICATE_PAYMENT_REFERENCE");references.add(ref);
        }
      }
      const routed=new Set(receipts.map(r=>r?.event_id));
      for(const old of baseline.settlement_at_baseline)if(old.state==="AVAILABLE"&&!routed.has(old.event_id)){
        if(references.has(old.reference)&&v1EventMetadata[old.event_id]?.availability?.reference!==old.reference)fail("DUPLICATE_PAYMENT_REFERENCE");
        references.add(old.reference);
      }
      for(const record of receipts){
        shape(record);
        if(ids.has(record.record_id)&&ids.get(record.record_id)!==record.record_sha256)fail("RECEIPT_ID_CONFLICT");
        ids.set(record.record_id,record.record_sha256);
        if(records.has(record.event_id)){
          if(records.get(record.event_id).record_sha256!==record.record_sha256)fail("MULTIPLE_RECEIPTS_FOR_EVENT");
          continue; // Exact duplicate metadata contributes only once.
        }
        if(Object.hasOwn(v1EventMetadata,record.event_id))fail("V1_V2_ROUTING_CONFLICT");
        const event=map.get(record.event_id);if(!event)fail("ORPHAN_RECEIPT:"+record.event_id);
        if(references.has(record.payment_reference))fail("DUPLICATE_PAYMENT_REFERENCE");references.add(record.payment_reference);
        records.set(record.event_id,record);
        const result=assessOne(record,event,map,baseline,now);
        results.push({event_id:record.event_id,record_id:record.record_id,record_sha256:record.record_sha256,...result});
      }
      results.sort((a,b)=>a.event_id<b.event_id?-1:a.event_id>b.event_id?1:0);
      const credit=safe(results.reduce((sum,row)=>sum+BigInt(row.credit_minor),0n));
      return{schema:SCHEMA,version:VERSION,validation_status:"VALID",status:results.some(r=>r.status==="PENDING")?"PENDING":results.some(r=>r.status==="AVAILABLE")?"AVAILABLE":"NO_NEW_CREDIT",credit_minor:credit,
        recognized_event_ids:results.filter(r=>r.status==="AVAILABLE").map(r=>r.event_id),receipts:results,reasons:[],
        evidence_classification:"USER_PROVIDED_NOT_EXTERNALLY_AUTHENTICATED"};
    }catch(error){return blocked(error.message||"INVALID_RECEIPT");}
  }
  // Contract-layer primitive for Checkpoint V2. The caller MUST first validate
  // the checkpoint and full Ledger. This performs the identical receipt,
  // deduction, event-hash, coverage and fee/tax checks; it never credits a store.
  function inspectReceipt({record,event,events,baseline,asOf}={}){
    const now=time(asOf),map=ledgerMap(events,now);
    if(!map.has(event?.id)||eventHash(map.get(event.id))!==eventHash(event))fail("ORPHAN_OR_MISMATCHED_RECEIPT_EVENT");
    return assessOne(record,event,map,baseline,now);
  }
  return Object.freeze({SCHEMA,VERSION,DEDUCTION_TYPES,createReceipt,eventHash,evaluateReceipts,inspectReceipt});
});

;
/* sealed source: portfolio-transaction-cash-sync-core.js */
(function(root,factory){
  const api=typeof module==="object"&&module.exports?factory(require("./portfolio-investable-cash-core.js"),require("./portfolio-dividend-receipt-v2-core.js"),require("./portfolio-ledger-core.js")):factory(root.HSPortfolioInvestableCashCore,root.HSPortfolioDividendReceiptV2Core,root.HSPortfolioLedgerCore);
  if(typeof module==="object"&&module.exports)module.exports=api;
  if(root)root.HSPortfolioTransactionCashSyncCore=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(v1,v2,ledger){
  "use strict";
  // Opt-in service only. No DOM, localStorage, network, or default wall clock.
  // The sole active transaction source is state.events (the existing Ledger).
  // Journal before/after images are recovery/audit snapshots, never replayed as
  // extra transactions. Derived balances are recomputed, never accumulated.
  const SCHEMA="HS_TRANSACTION_CASH_SYNC_V1",META="HS_TRANSACTION_CASH_METADATA_V1",STORE="HS_TRANSACTION_CASH_JOURNAL_V1";
  const REVIEW="RECONCILIATION_REQUIRED",NO_CASH=new Set(["OPENING_POSITION","POSITION_CORRECTION","SPLIT","REVERSE_SPLIT","STOCK_DIVIDEND"]);
  const clone=v=>JSON.parse(JSON.stringify(v)),fp=v=>v1.fingerprint(v),fail=s=>{throw Error(s);};
  const plain=v=>!!v&&typeof v==="object"&&!Array.isArray(v)&&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null);
  const text=v=>typeof v==="string"&&v.length>0&&v.trim()===v&&v.length<=512;
  const hash=v=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
  const minor=v=>{if(!Number.isSafeInteger(v)||v<0||Object.is(v,-0))fail("INVALID_MINOR_UNITS");return v;};
  const safe=v=>{if(v>BigInt(Number.MAX_SAFE_INTEGER)||v< -BigInt(Number.MAX_SAFE_INTEGER))fail("UNSAFE_MINOR_UNITS");return Number(v);};
  function time(s){
    if(typeof s!=="string"||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(s))fail("OFFSET_TIMESTAMP_REQUIRED");
    const n=Date.parse(s),day=s.slice(0,10),off=s.slice(-6);
    if(!Number.isFinite(n)||new Date(day+"T00:00:00Z").toISOString().slice(0,10)!==day||+s.slice(11,13)>23||+s.slice(14,16)>59||+s.slice(17,19)>59||/^[+-]14:/.test(off)&&off.slice(4)!=="00")fail("INVALID_TIMESTAMP");return n;
  }
  const day=n=>new Date(n+28800000).toISOString().slice(0,10);
  const amountText=n=>Math.floor(n/100)+"."+String(n%100).padStart(2,"0");
  const seal=body=>({...body,sha256:fp(body)});
  function sealed(value){if(!plain(value)||!hash(value.sha256))fail("INTEGRITY_HASH_REQUIRED");const{sha256,...body}=value;if(fp(body)!==sha256)fail("INTEGRITY_HASH_MISMATCH");return body;}
  function confirmation(c,now,minimum){
    if(!plain(c)||c.kind!=="USER_CONFIRMED"||!text(c.reference)||Object.keys(c).sort().join()!=="confirmed_at,kind,reference")fail("USER_CONFIRMATION_REQUIRED");
    const at=time(c.confirmed_at);if(at>now||at<minimum)fail("STALE_OR_FUTURE_CONFIRMATION");
  }
  function createMetadata({event,...fields}={}){
    if(!event||!text(event.id)||!ledger.normalizeEvent(event))fail("INVALID_EVENT");
    const body={schema:META,version:1,currency:"TWD",minor_unit_scale:2,event_id:event.id,event_sha256:fp(event),dividend_receipt_version:event.type==="DIVIDEND"?1:null,fee_tax_review:[],...fields};
    if(body.schema!==META||body.version!==1||body.event_id!==event.id||body.event_sha256!==fp(event))fail("METADATA_BINDING_OVERRIDE");
    fp(body);return clone(seal(body));
  }
  function assessMetadata(meta,e,baseline,now){
    const body=sealed(meta),keys=["schema","version","currency","minor_unit_scale","event_id","event_sha256","dividend_receipt_version","fee_tax_review","record_id","occurred_at","recorded_at","state","received_at","available_at","net_minor","investment_account","payment_reference","confirmation","baseline_coverage","sha256"];
    if(Object.keys(meta).length!==keys.length||Object.keys(meta).some(k=>!keys.includes(k))||body.schema!==META||body.version!==1||!text(body.record_id)||body.event_id!==e.id||body.event_sha256!==fp(e))fail("METADATA_EVENT_BINDING_MISMATCH:"+e.id);
    if(meta.currency!=="TWD"||meta.minor_unit_scale!==2)fail("UNSUPPORTED_CURRENCY_OR_SCALE");
    if(e.type==="DIVIDEND"?![1,2].includes(meta.dividend_receipt_version):meta.dividend_receipt_version!==null)fail("EXPLICIT_DIVIDEND_VERSION_REQUIRED");
    if(!Array.isArray(meta.fee_tax_review))fail("FEE_TAX_REVIEW_REQUIRED");
    const occurred=time(meta.occurred_at),recorded=time(meta.recorded_at),updated=time(e.updatedAt||e.timestamp),cut=time(baseline.confirmed_at);
    if(e.createdAt!==undefined&&(time(e.createdAt)>recorded||updated<time(e.createdAt)))fail("EVENT_CLOCK_CONFLICT:"+e.id);
    if(occurred>recorded||recorded>now||occurred>now||time(e.timestamp)>now||updated>now||day(occurred)!==e.tradeDate)fail("METADATA_CLOCK_CONFLICT:"+e.id);
    const c=meta.baseline_coverage,pin=baseline.ledger.event_pins.find(p=>p.event_id===e.id),old=baseline.settlement_at_baseline.find(p=>p.event_id===e.id);
    if(!plain(c)||Object.keys(c).sort().join()!=="baseline_id,baseline_sha256,confirmation,disposition"||c.baseline_id!==baseline.baseline_id||c.baseline_sha256!==baseline.baseline_sha256||!["INCLUDED","EXCLUDED"].includes(c.disposition))fail("BASELINE_COVERAGE_REQUIRED:"+e.id);
    confirmation(c.confirmation,now,Math.max(cut,updated));
    if(!pin&&(occurred<=cut||recorded<=cut||e.tradeDate<day(cut)))fail("BACKDATED_UNPINNED_REQUIRES_RECONCILIATION:"+e.id);
    if(pin){
      if(old?.state==="UNKNOWN")fail("BASELINE_SETTLEMENT_UNKNOWN:"+e.id);
      if(c.disposition!==(old?.state==="PENDING"?"EXCLUDED":"INCLUDED"))fail("BASELINE_COVERAGE_CONFLICT:"+e.id);
    }else if(c.disposition!=="EXCLUDED")fail("UNPINNED_INCLUDED_EVENT:"+e.id);
    if(!["AVAILABLE","PENDING","RECONCILIATION_REQUIRED"].includes(meta.state))fail("INVALID_SETTLEMENT_STATE");
    if(meta.state==="RECONCILIATION_REQUIRED")fail("SETTLEMENT_REQUIRES_RECONCILIATION:"+e.id);
    if(meta.state==="PENDING"){
      if(meta.net_minor!==null||meta.received_at!==null||meta.available_at!==null||meta.confirmation!==null||![true,false,null].includes(meta.investment_account)||!text(meta.payment_reference))fail("PENDING_CANNOT_CLAIM_PAYMENT");
      if(e.type!=="SELL"&&e.type!=="DIVIDEND")fail("UNCONFIRMED_DEBIT_OR_TRANSFER:"+e.id);
      if(old?.reference&&old.reference!==meta.payment_reference)fail("BASELINE_REFERENCE_CHANGED");
      return{state:"PENDING",reference:meta.payment_reference};
    }
    minor(meta.net_minor);const received=time(meta.received_at),available=time(meta.available_at);
    confirmation(meta.confirmation,now,Math.max(received,updated));
    if(received>now||received<occurred||available<received||typeof meta.investment_account!=="boolean"||!text(meta.payment_reference))fail("PAYMENT_CLOCK_OR_ACCOUNT_CONFLICT");
    if(c.disposition==="EXCLUDED"&&available<=cut)fail("PRE_BASELINE_PAYMENT_REQUIRES_CHECKPOINT");
    if(e.type==="SELL"||e.type==="DIVIDEND"){
      if(old?.state==="AVAILABLE"&&(old.reference!==meta.payment_reference||old.received_amount_minor!==meta.net_minor||time(old.available_at)!==available))fail("BASELINE_SETTLEMENT_CONFLICT");
      if(old?.state==="PENDING"&&old.reference&&old.reference!==meta.payment_reference)fail("BASELINE_REFERENCE_CHANGED");
    }
    return{state:meta.investment_account&&available<=now?"AVAILABLE":"PENDING",availableAt:meta.available_at,reference:meta.payment_reference,receivedAmount:amountText(meta.net_minor)};
  }
  function feeReview(meta,map,now){
    const reviewed=new Set();
    for(const row of meta.fee_tax_review){
      const event=map.get(row?.event_id);
      if(!plain(row)||Object.keys(row).sort().join()!=="confirmation,event_id,event_sha256,relationship"||!event||!["FEE","TAX"].includes(event.type)||reviewed.has(row.event_id)||fp(event)!==row.event_sha256)fail("INVALID_FEE_TAX_REVIEW");
      confirmation(row.confirmation,now,time(event.updatedAt||event.timestamp));
      if(row.relationship!=="UNRELATED")fail("POSSIBLE_DUPLICATE_LEDGER_DEDUCTION");reviewed.add(row.event_id);
    }
    if([...map.values()].some(e=>["FEE","TAX"].includes(e.type)&&!reviewed.has(e.id)))fail("UNREVIEWED_SEPARATE_FEE_TAX");
  }
  const REVIEWED_STATE="HS_TRANSACTION_CASH_STATE_V2",BUY_REVIEW="HS_BUY_BASELINE_COVERAGE_V1",REVIEW_ROUTE=Symbol("validated-buy-coverage");
  function derive(input={}){
    const {baseline=null,events=[],metadata={},dividendReceipts=[],asOf,ledgerComplete=false}=input;
    if(input.schema!==undefined||input.coverageReviews!==undefined)return deriveReviewed(input);
    const blocked=reason=>({schema:SCHEMA,status:REVIEW,balance_minor:null,investable_minor:null,reasons:[reason]});
    if(baseline===null)return{schema:SCHEMA,status:"UNINITIALIZED",balance_minor:null,investable_minor:null,reasons:[]};
    if(baseline.schema===CHECKPOINT_V2)return deriveCheckpoint({baseline,events,metadata,dividendReceipts,asOf,ledgerComplete});
    try{
      if(ledgerComplete!==true||!Array.isArray(events)||!plain(metadata)||!Array.isArray(dividendReceipts))fail("COMPLETE_INPUT_REQUIRED");
      v1.validateBaseline(baseline);const now=time(asOf),cut=time(baseline.confirmed_at);if(now<cut)fail("CLOCK_BEFORE_BASELINE");
      const map=new Map(),refs=new Set(),recordIds=new Set();
      for(const e of events){if(!plain(e)||!text(e.id)||map.has(e.id)||!ledger.normalizeEvent(e))fail("DUPLICATE_OR_INVALID_LEDGER_EVENT");if(e.currency!==undefined&&e.currency!=="TWD")fail("UNSUPPORTED_LEDGER_CURRENCY");fp(e);map.set(e.id,e);}
      const replay=ledger.derivePortfolioStateFromLedger(events);if(!replay.valid)fail("INVALID_LEDGER_REPLAY:"+replay.status);
      for(const p of baseline.ledger.event_pins)if(!map.has(p.event_id)||fp(map.get(p.event_id))!==p.sha256)fail("BASELINE_EVENT_CHANGED_OR_REMOVED:"+p.event_id);
      const routed=new Map();for(const r of dividendReceipts){if(!r||routed.has(r.event_id))fail("DUPLICATE_V2_ROUTE");routed.set(r.event_id,r);}
      for(const id of Object.keys(metadata))if(!map.has(id))fail("ORPHAN_METADATA:"+id);
      const v1Meta=Object.create(null),actualV1=Object.create(null),ignored=[],excluded=[];
      for(const e of events){
        const pinned=baseline.ledger.event_pins.some(p=>p.event_id===e.id),old=baseline.settlement_at_baseline.find(p=>p.event_id===e.id),m=metadata[e.id];
        if(routed.has(e.id)){
          if(e.type!=="DIVIDEND")fail("V2_ONLY_FOR_DIVIDEND");
          if(!m||m.dividend_receipt_version!==2)fail("EXPLICIT_V2_ROUTING_METADATA_REQUIRED");
          assessMetadata(m,e,baseline,now);
          const r=routed.get(e.id);
          if(m.net_minor!==r.net_received_minor||m.received_at!==r.received_at||m.available_at!==r.available_at||m.investment_account!==r.investment_account||m.payment_reference!==r.payment_reference||m.baseline_coverage.disposition!==r.baseline_coverage?.disposition||m.state!==(r.receipt_state==="PENDING"?"PENDING":"AVAILABLE"))fail("V2_RECEIPT_ENVELOPE_CONFLICT");
          if(refs.has(r.payment_reference))fail("DUPLICATE_PAYMENT_REFERENCE");refs.add(r.payment_reference);
          if(recordIds.has(m.record_id)||m.record_id===r.record_id)fail("DUPLICATE_METADATA_RECORD_ID");recordIds.add(m.record_id);
          if(recordIds.has(r.record_id))fail("DUPLICATE_METADATA_RECORD_ID");recordIds.add(r.record_id);
          // Explicit routing barrier: V1 validates full Ledger and original gross,
          // but never recognizes this V2 payment. No synthetic net/gross value.
          v1Meta[e.id]={occurredAt:m.occurred_at,recordedAt:m.recorded_at,availability:old?.state==="AVAILABLE"?{state:old.state,availableAt:old.available_at,reference:old.reference,receivedAmount:amountText(old.received_amount_minor)}:{state:"PENDING"}};
          ignored.push(e.id);continue;
        }
        if(!m){
          if(pinned&&(!old||old.state==="AVAILABLE"))continue;
          fail("METADATA_REQUIRED:"+e.id);
        }
        if(m.dividend_receipt_version===2)fail("V2_RECEIPT_REQUIRED");
        const a=assessMetadata(m,e,baseline,now);
        if(["SELL","DIVIDEND"].includes(e.type))feeReview(m,map,now);
        if(e.type==="DIVIDEND"&&(e.fee!==0||e.tax!==0))fail("DIVIDEND_EMBEDDED_COST_REVIEW_REQUIRED");
        if(refs.has(m.payment_reference))fail("DUPLICATE_PAYMENT_REFERENCE");refs.add(m.payment_reference);
        if(recordIds.has(m.record_id))fail("DUPLICATE_METADATA_RECORD_ID");recordIds.add(m.record_id);
        const entry={occurredAt:m.occurred_at,recordedAt:m.recorded_at,availability:a};
        // Confirm all actual monetary magnitudes via unchanged V1 validation.
        // For non-investment receipts, validate the stated net before deferring.
        if(m.state==="AVAILABLE"&&m.net_minor!==(NO_CASH.has(e.type)?0:v1.eventAmountMinor(e)))fail("NET_AMOUNT_MISMATCH:"+e.id);
        if(!["SELL","DIVIDEND"].includes(e.type)&&m.state!=="AVAILABLE")fail("DEBIT_NOT_CONFIRMED");
        if(!["SELL","DIVIDEND"].includes(e.type)&&(!m.investment_account||time(m.available_at)>now))fail("DEBIT_NOT_AVAILABLE");
        if(["SELL","DIVIDEND"].includes(e.type)&&m.investment_account===false)excluded.push(e.id);
        v1Meta[e.id]=entry;actualV1[e.id]=entry;
      }
      const base=v1.deriveCash({baseline,events,eventMetadata:v1Meta,asOf,ledgerComplete:true});
      if(["RECONCILIATION_REQUIRED","UNINITIALIZED"].includes(base.status))fail(base.reasons.join(";"));
      const extra=v2.evaluateReceipts({baseline,events,receipts:dividendReceipts,v1EventMetadata:actualV1,asOf,ledgerComplete:true});
      if(extra.status===REVIEW)fail(extra.reasons.join(";"));
      excluded.push(...extra.receipts.filter(r=>r.status==="NOT_INVESTABLE").map(r=>r.event_id));
      const value=safe(BigInt(base.balance_minor)+BigInt(extra.credit_minor)),pending=[...base.pending_event_ids.filter(id=>!ignored.includes(id)&&!excluded.includes(id)),...extra.receipts.filter(r=>r.status==="PENDING").map(r=>r.event_id)];
      return{schema:SCHEMA,status:value<0?"INSUFFICIENT_CASH":pending.length?"PENDING":"READY",balance_minor:value,investable_minor:value<0?null:value,
        applied_event_ids:[...base.applied_event_ids,...extra.recognized_event_ids].sort(),pending_event_ids:pending.sort(),excluded_event_ids:excluded.sort(),reasons:value<0?["INSUFFICIENT_CASH"]:[],ledger_sha256:fp(events),baseline_sha256:baseline.baseline_sha256};
    }catch(e){return blocked(e.message);}
  }
  const CHECKPOINT_V2="HS_INVESTABLE_CASH_CHECKPOINT_V2";
  function stateShape(s){
    const keys=Object.keys(s||{}).sort().join();
    if(!plain(s)||(keys!=="baseline,dividendReceipts,events,ledgerComplete,metadata"&&!(keys==="baseline,coverageReviews,dividendReceipts,events,ledgerComplete,metadata,schema"&&s.schema===REVIEWED_STATE&&Array.isArray(s.coverageReviews))))fail("INVALID_STATE_SCHEMA");
  }
  function createBuyCoverageReview({event,baseline,recordId,disposition,occurredAt,recordedAt,confirmedAt,source}={}){
    validateCheckpoint(baseline);
    if(!event||event.type!=="BUY"||!ledger.normalizeEvent(event)||!text(recordId)||!text(source)||!["INCLUDED","EXCLUDED"].includes(disposition))fail("EXPLICIT_BUY_COVERAGE_REVIEW_REQUIRED");
    if(event.currency!==undefined&&event.currency!=="TWD")fail("UNSUPPORTED_LEDGER_CURRENCY");
    const cut=time(baseline.confirmed_at),occurred=time(occurredAt),recorded=time(recordedAt),confirmed=time(confirmedAt);
    if(time(event.timestamp)!==occurred||time(event.createdAt)!==recorded||recorded<occurred||confirmed<recorded||confirmed<time(event.updatedAt||event.timestamp)||day(occurred)!==event.tradeDate)fail("BUY_REVIEW_TIME_CONFLICT");
    if(baseline.ledger.event_pins.some(p=>p.event_id===event.id)||recorded<=cut||occurred===cut||disposition==="INCLUDED"&&occurred>cut)fail("BUY_REVIEW_BASELINE_CONFLICT");
    const total=v1.eventAmountMinor(event),fee=v1.toMinorUnits(event.fee);
    return seal({schema:BUY_REVIEW,version:1,record_id:recordId,event_id:event.id,event_sha256:fp(event),baseline_id:baseline.baseline_id,baseline_sha256:baseline.baseline_sha256,occurred_at:occurredAt,recorded_at:recordedAt,disposition,principal_minor:total-fee,fee_minor:fee,cash_impact_minor:disposition==="INCLUDED"?0:-total,confirmation:{kind:"USER_CONFIRMATION",reference:source,confirmed_at:confirmedAt},evidence_classification:"USER_PROVIDED_NOT_EXTERNALLY_AUTHENTICATED"});
  }
  function deriveReviewed(s){
    try{
      const{asOf,...body}=s;stateShape(body);validateCheckpoint(s.baseline);const now=time(asOf),cut=time(s.baseline.confirmed_at);
      if(s.ledgerComplete!==true||now<cut||!Array.isArray(s.events)||!plain(s.metadata)||!Array.isArray(s.dividendReceipts))fail("COMPLETE_INPUT_REQUIRED");
      const map=new Map();for(const e of s.events){if(!e?.id||map.has(e.id)||!ledger.normalizeEvent(e))fail("DUPLICATE_OR_INVALID_LEDGER_EVENT");map.set(e.id,e);}
      if(!ledger.derivePortfolioStateFromLedger(s.events).valid)fail("INVALID_LEDGER_REPLAY");
      const covered=new Map(),recordIds=new Set([...Object.values(s.metadata).map(m=>m?.record_id),...s.dividendReceipts.map(r=>r?.record_id)]),active=new Set();let delta=0n;
      for(const old of s.baseline.source_state?.coverageReviews||[])if(!s.coverageReviews.some(r=>fp(r)===fp(old)))fail("COVERED_BUY_REVIEW_REMOVED");
      for(const review of s.coverageReviews){
        if(covered.has(review?.event_id)||recordIds.has(review?.record_id))fail("DUPLICATE_BUY_COVERAGE_REVIEW");
        const e=map.get(review.event_id);if(!e)fail("ORPHAN_BUY_COVERAGE_REVIEW");
        const base=evidenceBaseline(s.baseline,e.id),rebuilt=createBuyCoverageReview({event:e,baseline:base,recordId:review.record_id,disposition:review.disposition,occurredAt:review.occurred_at,recordedAt:review.recorded_at,confirmedAt:review.confirmation?.confirmed_at,source:review.confirmation?.reference});
        if(fp(rebuilt)!==fp(review)||time(review.confirmation.confirmed_at)>now||time(review.recorded_at)>now)fail("BUY_COVERAGE_HASH_OR_CLOCK_CONFLICT");
        if(s.metadata[e.id]||s.dividendReceipts.some(r=>r.event_id===e.id))fail("BUY_COVERAGE_DOUBLE_ROUTE");
        const pinned=s.baseline.ledger.event_pins.some(p=>p.event_id===e.id);
        if(pinned){const original=s.baseline.source_state?.coverageReviews?.find(r=>r.event_id===e.id);if(!original||fp(original)!==fp(review))fail("COVERED_BUY_REVIEW_CHANGED");}
        else{active.add(e.id);delta+=BigInt(review.cash_impact_minor);safe(delta);}
        covered.set(e.id,review);recordIds.add(review.record_id);
      }
      // The new reviewed-state contract validates the COMPLETE real Ledger.
      // Never remove BUYs to trick V1 holdings replay (a later SELL can rely on
      // those shares). V1 baseline validation remains unchanged; only this
      // explicit, hash-bound route can skip a BUY's second cash recognition.
      const base=deriveCheckpoint({baseline:s.baseline,events:s.events,metadata:s.metadata,dividendReceipts:s.dividendReceipts,asOf:s.asOf,ledgerComplete:true},{[REVIEW_ROUTE]:true,reviewed:active});
      if(!Number.isSafeInteger(base.balance_minor))fail(base.reasons.join(";"));
      const balance=safe(BigInt(base.balance_minor)+delta);
      return{...base,status:balance<0?"INSUFFICIENT_CASH":base.pending_event_ids.length?"PENDING":"READY",balance_minor:balance,investable_minor:balance<0?null:balance,applied_event_ids:[...base.applied_event_ids,...[...active].filter(id=>covered.get(id).disposition==="EXCLUDED")].sort(),ledger_sha256:fp(s.events),reasons:balance<0?["INSUFFICIENT_CASH"]:[]};
    }catch(e){return{schema:SCHEMA,status:REVIEW,balance_minor:null,investable_minor:null,reasons:[e.message]};}
  }
  // A checkpoint freezes the validated cash projection, NOT new transactions.
  // Immutable evidence retains its original V1/V2 contract and original coverage
  // binding. Covered pending receipts can subsequently become available; their
  // difference is measured against the frozen projection, never credited twice.
  function checkpointBody({baselineId,amount,confirmedAt,state,ledgerRevision,ledgerRawSha256,reconciliation=null},depth=0){
    if(depth>16)fail("CHECKPOINT_DEPTH_REQUIRES_REVIEW");
    if(!text(baselineId)||!Number.isSafeInteger(ledgerRevision)||ledgerRevision<0||!hash(ledgerRawSha256))fail("CHECKPOINT_LEDGER_IDENTITY_REQUIRED");
    time(confirmedAt);
    stateShape(state);
    const result=derive({...state,asOf:confirmedAt});
    if(!["READY","PENDING","INSUFFICIENT_CASH"].includes(result.status)||!Number.isSafeInteger(result.balance_minor))fail("CHECKPOINT_SOURCE_REQUIRES_RECONCILIATION:"+result.reasons?.join(";"));
    const confirmed=v1.toMinorUnits(amount),difference=safe(BigInt(confirmed)-BigInt(result.balance_minor));
    if(difference!==0){
      if(result.pending_event_ids.length||result.status==="PENDING")fail("CASH_DIFFERENCE_UNRESOLVED_FLOWS");
      if(!plain(reconciliation)||Object.keys(reconciliation).sort().join()!=="acknowledged,confirmed_at,reference"||reconciliation.acknowledged!==true||!text(reconciliation.reference)||time(reconciliation.confirmed_at)!==time(confirmedAt))fail("CASH_DIFFERENCE_REQUIRES_EXPLICIT_RECONCILIATION");
    }else if(reconciliation!==null)fail("UNEXPECTED_RECONCILIATION");
    const pins=state.events.map(e=>({event_id:e.id,canonical_event:JSON.stringify(e),sha256:fp(e)})).sort((a,b)=>a.event_id.localeCompare(b.event_id));
    const coverage=pins.map(p=>{
      const e=state.events.find(e=>e.id===p.event_id),m=state.metadata[e.id],receipt=state.dividendReceipts.find(r=>r.event_id===e.id),review=state.coverageReviews?.find(r=>r.event_id===e.id);
      const pending=result.pending_event_ids.includes(e.id),excluded=result.excluded_event_ids.includes(e.id);
      // Economic impact is evidence, not a command to apply it again. Unknown
      // pre-V1-history amounts remain null rather than being invented as zero.
      let impact=null;
      if(NO_CASH.has(e.type))impact=0;
      else if(review)impact=-v1.eventAmountMinor(e);
      else if(m?.state==="AVAILABLE"&&m.investment_account===true&&time(m.available_at)<=time(confirmedAt))impact=(e.type==="BUY"||e.type==="WITHDRAWAL"?-1:1)*m.net_minor;
      return{event_id:e.id,event_sha256:p.sha256,disposition:pending?"PENDING":excluded?"NOT_INVESTABLE":"INCLUDED",cash_impact_minor:impact,metadata_sha256:m?.sha256??null,receipt_sha256:receipt?.record_sha256??null,dividend_receipt_version:m?.dividend_receipt_version??null};
    });
    // Shape-compatible identity fields are not a V1 baseline: V1 validation
    // continues to reject this schema. Source proof is deeply replayed below.
    return{schema:CHECKPOINT_V2,version:2,baseline_id:baselineId,currency:"TWD",minor_unit_scale:2,confirmed_amount_minor:confirmed,confirmed_at:confirmedAt,confirmed_at_utc:new Date(time(confirmedAt)).toISOString(),
      ledger:{version:ledger.VERSION,complete:true,event_count:pins.length,event_pins:pins,snapshot_sha256:fp(pins),revision:ledgerRevision,raw_sha256:ledgerRawSha256},
      source_state:clone(state),source_state_sha256:fp(state),source_balance_minor:result.balance_minor,coverage,
      reconciliation:{difference_minor:difference,confirmation:reconciliation},integrity:{status:"VERIFIED",evidence_classification:"USER_PROVIDED_NOT_EXTERNALLY_AUTHENTICATED"}};
  }
  function createCheckpointV2(options){const body=checkpointBody(options);return clone({...body,baseline_sha256:fp(body)});}
  function validateCheckpoint(b,depth=0){
    if(b?.schema!==CHECKPOINT_V2)return v1.validateBaseline(b);
    if(depth>16)fail("CHECKPOINT_DEPTH_REQUIRES_REVIEW");
    // Explicit walk prevents arbitrarily deep, attacker-controlled witness trees.
    let cursor=b,n=0;while(cursor?.schema===CHECKPOINT_V2){if(++n>16)fail("CHECKPOINT_DEPTH_REQUIRES_REVIEW");cursor=cursor.source_state?.baseline;}
    const rebuilt=createCheckpointV2({baselineId:b.baseline_id,amount:amountText(minor(b.confirmed_amount_minor)),confirmedAt:b.confirmed_at,state:b.source_state,ledgerRevision:b.ledger?.revision,ledgerRawSha256:b.ledger?.raw_sha256,reconciliation:b.reconciliation?.confirmation});
    if(fp(rebuilt)!==fp(b))fail("CHECKPOINT_V2_INTEGRITY_MISMATCH");return b;
  }
  function evidenceBaseline(b,eventId){
    // Only the sealed checkpoint's pinned events can use prior coverage proof.
    if(b?.schema===CHECKPOINT_V2&&b.ledger.event_pins.some(p=>p.event_id===eventId))return evidenceBaseline(b.source_state.baseline,eventId);
    return b;
  }
  function deriveCheckpoint({baseline:b,events,metadata,dividendReceipts,asOf,ledgerComplete},trustedReplay){
    const blocked=e=>({schema:SCHEMA,status:REVIEW,balance_minor:null,investable_minor:null,reasons:[e.message]});
    try{
      validateCheckpoint(b);const now=time(asOf);if(now<time(b.confirmed_at))fail("CLOCK_BEFORE_BASELINE");
      if(ledgerComplete!==true||!Array.isArray(events)||!plain(metadata)||!Array.isArray(dividendReceipts))fail("COMPLETE_INPUT_REQUIRED");
      const map=new Map();for(const e of events){if(!plain(e)||!text(e.id)||map.has(e.id)||!ledger.normalizeEvent(e))fail("DUPLICATE_OR_INVALID_LEDGER_EVENT");if(e.currency!==undefined&&e.currency!=="TWD")fail("UNSUPPORTED_LEDGER_CURRENCY");map.set(e.id,e);}
      if(!ledger.derivePortfolioStateFromLedger(events).valid)fail("INVALID_LEDGER_REPLAY");
      const pinned=new Set(b.ledger.event_pins.map(p=>p.event_id));
      for(const p of b.ledger.event_pins)if(!map.has(p.event_id)||fp(map.get(p.event_id))!==p.sha256)fail("BASELINE_EVENT_CHANGED_OR_REMOVED:"+p.event_id);
      const refs=new Set(),ids=new Set(),routed=new Map();
      for(const r of dividendReceipts){if(routed.has(r?.event_id)||!map.has(r?.event_id))fail("DUPLICATE_OR_ORPHAN_V2_ROUTE");routed.set(r.event_id,r);}
      for(const id of Object.keys(metadata))if(!map.has(id))fail("ORPHAN_METADATA:"+id);
      for(const e of events){const m=metadata[e.id],r=routed.get(e.id);if(!m)continue;
        if(ids.has(m.record_id)||refs.has(m.payment_reference))fail("DUPLICATE_METADATA_OR_PAYMENT_REFERENCE");ids.add(m.record_id);refs.add(m.payment_reference);
        if(r){if(ids.has(r.record_id))fail("DUPLICATE_METADATA_RECORD_ID");ids.add(r.record_id);}
        const cover=b.coverage?.find(p=>p.event_id===e.id);
        if(cover&&cover.disposition!=="PENDING"&&(cover.metadata_sha256!==m.sha256||cover.receipt_sha256!==(r?.record_sha256??null)))fail("COVERED_EVIDENCE_CHANGED:"+e.id);
      }
      for(const cover of b.coverage||[])if(cover.metadata_sha256&&!metadata[cover.event_id]||cover.receipt_sha256&&!routed.has(cover.event_id))fail("COVERED_EVIDENCE_REMOVED");
      let root=b;while(root.schema===CHECKPOINT_V2)root=root.source_state.baseline;
      for(const old of root.settlement_at_baseline)if(old.state==="AVAILABLE"&&!metadata[old.event_id]){if(refs.has(old.reference))fail("DUPLICATE_PAYMENT_REFERENCE");refs.add(old.reference);}
      // Re-evaluate only the already pinned cohort against its ORIGINAL contract.
      // New events are not fed into this replay, preventing epoch double count.
      const v2Baseline=b.schema===CHECKPOINT_V2;
      if(!v2Baseline&&!trustedReplay?.[REVIEW_ROUTE])fail("REVIEWED_STATE_REQUIRED");
      const old=derive({...(v2Baseline?b.source_state:{}),baseline:v2Baseline?b.source_state.baseline:b,events:events.filter(e=>pinned.has(e.id)),metadata:Object.fromEntries(Object.entries(metadata).filter(([id])=>pinned.has(id))),dividendReceipts:dividendReceipts.filter(r=>pinned.has(r.event_id)),asOf,ledgerComplete:true});
      if(!Number.isSafeInteger(old.balance_minor))fail("COVERED_SOURCE_REQUIRES_RECONCILIATION:"+old.reasons?.join(";"));
      let value=v2Baseline?BigInt(b.confirmed_amount_minor)+BigInt(old.balance_minor)-BigInt(b.source_balance_minor):BigInt(old.balance_minor);
      const pending=[...old.pending_event_ids],excluded=[...old.excluded_event_ids],applied=[];
      for(const e of events.filter(e=>!pinned.has(e.id))){
        if(trustedReplay?.[REVIEW_ROUTE]&&trustedReplay.reviewed?.has(e.id))continue;
        const m=metadata[e.id];if(!m)fail("METADATA_REQUIRED:"+e.id);
        // An unpinned event must have provable actual and recording timestamps
        // after this checkpoint, even when its Taipei calendar date is the same.
        const a=assessMetadata(m,e,{...b,settlement_at_baseline:[]},now),r=routed.get(e.id);
        if(!["SELL","DIVIDEND"].includes(e.type)&&(m.state!=="AVAILABLE"||m.investment_account!==true||time(m.available_at)>now))fail("DEBIT_NOT_AVAILABLE");
        if(NO_CASH.has(e.type)){if(m.net_minor!==0||r)fail("NO_CASH_EVENT_CONFLICT");continue;}
        if(!["BUY","SELL","DIVIDEND","DEPOSIT","WITHDRAWAL"].includes(e.type))fail("UNSUPPORTED_NEW_CASH_EVENT");
        let net;
        if(m.dividend_receipt_version===2){
          if(e.type!=="DIVIDEND"||!r||m.net_minor!==r.net_received_minor||m.received_at!==r.received_at||m.available_at!==r.available_at||m.investment_account!==r.investment_account||m.payment_reference!==r.payment_reference||m.baseline_coverage.disposition!==r.baseline_coverage?.disposition||m.state!==(r.receipt_state==="PENDING"?"PENDING":"AVAILABLE"))fail("V2_RECEIPT_ENVELOPE_CONFLICT");
          const proof=v2.inspectReceipt({record:r,event:e,events,baseline:{...b,settlement_at_baseline:[]},asOf});
          if(proof.status==="PENDING"){pending.push(e.id);continue;}if(proof.status==="NOT_INVESTABLE"){excluded.push(e.id);continue;}net=proof.credit_minor;
        }else{
          if(r)fail("EXPLICIT_V2_ROUTING_METADATA_REQUIRED");
          if(["SELL","DIVIDEND"].includes(e.type))feeReview(m,map,now);
          if(e.type==="DIVIDEND"&&(e.fee!==0||e.tax!==0))fail("DIVIDEND_EMBEDDED_COST_REVIEW_REQUIRED");
          if(m.state==="AVAILABLE"&&m.net_minor!==v1.eventAmountMinor(e))fail("NET_AMOUNT_MISMATCH:"+e.id);
          if(a.state==="PENDING"){if(m.investment_account===false)excluded.push(e.id);else pending.push(e.id);continue;}
          net=m.net_minor;
        }
        if(!["SELL","DIVIDEND"].includes(e.type)&&(!m.investment_account||time(m.available_at)>now))fail("DEBIT_NOT_AVAILABLE");
        value+=BigInt(net)*(e.type==="BUY"||e.type==="WITHDRAWAL"?-1n:1n);safe(value);applied.push(e.id);
      }
      const balance=safe(value);return{schema:SCHEMA,status:balance<0?"INSUFFICIENT_CASH":pending.length?"PENDING":"READY",balance_minor:balance,investable_minor:balance<0?null:balance,applied_event_ids:applied.sort(),pending_event_ids:pending.sort(),excluded_event_ids:excluded.sort(),reasons:balance<0?["INSUFFICIENT_CASH"]:[],ledger_sha256:fp(events),baseline_sha256:b.baseline_sha256};
    }catch(e){return blocked(e);}
  }
  function stateCheck(s,asOf){
    stateShape(s);
    const result=derive({...s,asOf});if(result.status===REVIEW||result.status==="UNINITIALIZED")fail(result.reasons?.join(";")||result.status);return result;
  }
  function createStore(state,asOf){stateCheck(state,asOf);return clone(seal({schema:STORE,version:1,revision:0,state,pending:null,audit:[]}));}
  function storeCheck(raw){
    sealed(raw);if(Object.keys(raw).sort().join()!=="audit,pending,revision,schema,sha256,state,version"||raw.schema!==STORE||raw.version!==1||!Number.isSafeInteger(raw.revision)||raw.revision<0||!Array.isArray(raw.audit)||raw.revision!==raw.audit.length*2+(raw.pending===null?0:1))fail("INVALID_STORE");
    const ids=new Set();let previous=null,active=null,at=null;
    for(const row of raw.audit){
      sealed(row);
      if(Object.keys(row).sort().join()!=="after,at,before,journal_sha256,prepared_at,previous_sha256,request_sha256,sha256,status,transaction_id"||!text(row.transaction_id)||ids.has(row.transaction_id)||row.previous_sha256!==previous||!["COMMITTED","ROLLED_BACK"].includes(row.status)||row.request_sha256!==fp(row.after)||fp(row.before.baseline)!==fp(row.after.baseline)||active!==null&&fp(row.before)!==fp(active)||time(row.at)<time(row.prepared_at)||at!==null&&time(row.prepared_at)<at)fail("AUDIT_CHAIN_CONFLICT");
      const p=seal({transaction_id:row.transaction_id,request_sha256:row.request_sha256,prepared_at:row.prepared_at,before:row.before,after:row.after});
      if(p.sha256!==row.journal_sha256)fail("AUDIT_JOURNAL_HASH_MISMATCH");
      ids.add(row.transaction_id);previous=row.sha256;active=row.status==="COMMITTED"?row.after:row.before;at=time(row.at);
    }
    if(active!==null&&fp(active)!==fp(raw.state))fail("AUDIT_ACTIVE_STATE_MISMATCH");
    if(raw.pending){sealed(raw.pending);if(ids.has(raw.pending.transaction_id)||fp(raw.pending.before)!==fp(raw.state)||at!==null&&time(raw.pending.prepared_at)<at)fail("INVALID_PENDING_JOURNAL");}
    return raw;
  }
  function service(storage){
    // Contract is mandatory, not inferred from multiple setItem successes.
    // Implementor must supply a real cross-context linearizable CAS (e.g.
    // IndexedDB transaction); merely declaring these flags is not proof.
    if(!storage||storage.contract!=="ATOMIC_CROSS_CONTEXT_CAS_V1"||typeof storage.read!=="function"||typeof storage.compareAndSwap!=="function")fail("ATOMIC_STORAGE_REQUIRED");
    const read=()=>storeCheck(clone(storage.read()));
    const cas=(before,body)=>{
      if(!Number.isSafeInteger(body.revision)||body.revision!==before.revision+1)fail("REVISION_OVERFLOW_OR_CONFLICT");
      const next=clone(seal(body));if(storage.compareAndSwap(before.sha256,next)!==true)fail("VERSION_CONFLICT");
      const after=read();if(after.sha256!==next.sha256)fail("WRITE_VERIFICATION_FAILED");return after;
    };
    const clean=r=>{const{sha256,...body}=r;return body;};
    function append(raw,p,status,at){
      const row=seal({transaction_id:p.transaction_id,journal_sha256:p.sha256,prepared_at:p.prepared_at,request_sha256:p.request_sha256,status,at,before:p.before,after:p.after,previous_sha256:raw.audit.at(-1)?.sha256||null});
      return{...clean(raw),revision:raw.revision+1,state:status==="COMMITTED"?p.after:p.before,pending:null,audit:[...raw.audit,row]};
    }
    function pendingCheck(raw,p,asOf){
      sealed(p);if(!text(p.transaction_id)||fp(raw.state)!==fp(p.before)||fp(p.before.baseline)!==fp(p.after.baseline)||p.request_sha256!==fp(p.after)||time(asOf)<time(p.prepared_at))fail("INVALID_PENDING_JOURNAL");
      stateCheck(p.before,asOf);return stateCheck(p.after,asOf);
    }
    return Object.freeze({
      read(asOf){try{const r=read();if(r.pending)return{ok:false,status:"RECOVERY_REQUIRED",balance_minor:null,investable_minor:null};return{ok:true,revision:r.revision,state:clone(r.state),cash:stateCheck(r.state,asOf)};}catch(e){return{ok:false,status:REVIEW,balance_minor:null,investable_minor:null,reason:e.message};}},
      prepare({transactionId,expectedRevision,nextState,asOf}={}){
        try{
          if(!text(transactionId))fail("TRANSACTION_ID_REQUIRED");time(asOf);const raw=read(),request=fp(nextState),old=raw.audit.find(a=>a.transaction_id===transactionId);
          if(old){if(old.request_sha256!==request||old.status!=="COMMITTED")fail("TRANSACTION_ID_CONFLICT");return{ok:true,status:"ALREADY_COMMITTED",transaction_id:transactionId};}
          if(raw.pending){if(raw.pending.transaction_id===transactionId&&raw.pending.request_sha256===request){pendingCheck(raw,raw.pending,asOf);return{ok:true,status:"PREPARED",journal_sha256:raw.pending.sha256};}fail("RECOVERY_REQUIRED");}
          if(raw.revision!==expectedRevision)fail("VERSION_CONFLICT");stateCheck(raw.state,asOf);stateCheck(nextState,asOf);
          if(raw.audit.length&&time(asOf)<time(raw.audit.at(-1).at))fail("CLOCK_BEFORE_LAST_TRANSACTION");
          if(fp(raw.state.baseline)!==fp(nextState.baseline))fail("BASELINE_CHANGE_NOT_AUTHORIZED");
          const p=seal({transaction_id:transactionId,request_sha256:request,prepared_at:asOf,before:raw.state,after:clone(nextState)});
          cas(raw,{...clean(raw),revision:raw.revision+1,pending:p});return{ok:true,status:"PREPARED",journal_sha256:p.sha256};
        }catch(e){return{ok:false,status:REVIEW,reason:e.message};}
      },
      commit({transactionId,journalSha256,asOf}={}){
        try{const raw=read();if(!raw.pending){const done=raw.audit.find(a=>a.transaction_id===transactionId);if(done?.status==="COMMITTED"&&done.journal_sha256===journalSha256)return{ok:true,status:"ALREADY_COMMITTED"};fail("NO_PENDING_TRANSACTION");}
          const p=raw.pending;if(p.transaction_id!==transactionId||p.sha256!==journalSha256)fail("JOURNAL_ID_OR_HASH_MISMATCH");
          const cash= pendingCheck(raw,p,asOf);cas(raw,append(raw,p,"COMMITTED",asOf));return{ok:true,status:"COMMITTED",cash};
        }catch(e){return{ok:false,status:"RECOVERY_REQUIRED",balance_minor:null,investable_minor:null,reason:e.message};}
      },
      recover({transactionId,journalSha256,action,asOf}={}){
        try{const raw=read(),p=raw.pending;if(!p||p.transaction_id!==transactionId||p.sha256!==journalSha256||!["COMMIT","ROLLBACK"].includes(action))fail("EXPLICIT_RECOVERY_REQUIRED");pendingCheck(raw,p,asOf);
          cas(raw,append(raw,p,action==="COMMIT"?"COMMITTED":"ROLLED_BACK",asOf));return{ok:true,status:action==="COMMIT"?"COMMITTED":"ROLLED_BACK"};
        }catch(e){return{ok:false,status:"RECOVERY_REQUIRED",balance_minor:null,investable_minor:null,reason:e.message};}
      }
    });
  }
  function validateStore(value,{asOf,allowPending=false}={}){storeCheck(value);if(value.pending&&!allowPending)fail("TRANSACTION_RECOVERY_REQUIRED");stateCheck(value.state,asOf);return value;}
  return Object.freeze({SCHEMA,META,STORE,CHECKPOINT_V2,REVIEWED_STATE,createMetadata,derive,createStore,validateStore,service,createCheckpointV2,validateCheckpoint,evidenceBaseline,createBuyCoverageReview});
});

;
/* sealed source: portfolio-write-coordinator.js */
(function(root,factory){
 const api=typeof module==="object"&&module.exports?factory(require("./portfolio-investable-cash-core.js"),require("./portfolio-transaction-cash-sync-core.js"),require("./portfolio-ledger-core.js"),require("./portfolio-resilience-core.js")):factory(root.HSPortfolioInvestableCashCore,root.HSPortfolioTransactionCashSyncCore,root.HSPortfolioLedgerCore,root.HSPortfolioResilienceCore);
 if(typeof module==="object"&&module.exports)module.exports=api;if(root)root.HSPortfolioWriteCoordinator=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(cash,sync,ledger,resilience){
 "use strict";
 const PREFIX="hsRadar.portfolio.",META_KEY=PREFIX+"writeCoordination.v1",JOURNAL_KEY=PREFIX+"writeJournal.v1",SYNC_KEY=PREFIX+"transactionCashSync.v1",ARCHIVE_KEY=PREFIX+"transactionCashArchives.v1",LEGACY_JOURNAL=PREFIX+"preRestoreJournal.v1",LOCK="hsRadar.portfolio.investableCash.lock.v1";
 const SCHEMA="HS_PORTFOLIO_WRITE_COORDINATION_V1",JOURNAL_SCHEMA="HS_PORTFOLIO_WRITE_JOURNAL_V1";
 const excluded=new Set([META_KEY,JOURNAL_KEY,LEGACY_JOURNAL,PREFIX+"quotes",PREFIX+"marketVersion"]);
 const legacy=new Set(["hs_portfolio_v6","hs_portfolio_auto_v1"]);
 const fp=v=>cash.fingerprint(v),clone=v=>JSON.parse(JSON.stringify(v)),fail=s=>{throw Error(s);},plain=v=>!!v&&typeof v==="object"&&!Array.isArray(v);
 const text=v=>typeof v==="string"&&v.length>0&&v.trim()===v&&v.length<=256;
 const own=(o,k)=>Object.hasOwn(o,k),seal=o=>({...o,sha256:fp(o)});
 const PLAN_KEY=PREFIX+"capitalBuildPlans.v1",GEN_KEY=PREFIX+"capitalGeneration.v1";
 function planContract(){const api=typeof module==="object"&&module.exports?require("./portfolio-plan-generation-core"):globalThis.HSPortfolioPlanGenerationCore;if(!api)fail("PLAN_VALIDATOR_UNAVAILABLE");return api;}
 const hasPlan=e=>own(e,PLAN_KEY)||own(e,GEN_KEY)||own(e,PREFIX+'accelerationConsumption.v1');
 function journalKeys(before,after,order){const keys=[...new Set([...Object.keys(before),...Object.keys(after)])].sort();if(order==="LEDGER_FIRST")return[ledger.STORAGE_KEY,...keys.filter(k=>k!==ledger.STORAGE_KEY)];if(order!==undefined&&order!=="KEY_SORT")fail("INVALID_WRITE_ORDER");return keys;}
 function check(o){if(!plain(o))fail("INVALID_ENVELOPE");const{sha256,...body}=o;if(fp(body)!==sha256)fail("ENVELOPE_SHA_MISMATCH");return o;}
 function clock(s){if(typeof s!=="string"||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(s)||!Number.isFinite(Date.parse(s)))fail("EXPLICIT_CLOCK_REQUIRED");const day=s.slice(0,10),off=s.slice(-6);if(new Date(day+"T00:00:00Z").toISOString().slice(0,10)!==day||+s.slice(11,13)>23||+s.slice(14,16)>59||+s.slice(17,19)>59||/^[+-]14:/.test(off)&&off.slice(4)!=="00")fail("INVALID_CLOCK");return Date.parse(s);}
 const isDataKey=k=>typeof k==="string"&&(k.startsWith(PREFIX)||legacy.has(k))&&!excluded.has(k);
 function collect(storage){const rows={};for(let i=0;i<storage.length;i++){const k=storage.key(i);if(isDataKey(k))rows[k]=storage.getItem(k);}return Object.fromEntries(Object.entries(rows).sort(([a],[b])=>a.localeCompare(b)));}
 function fingerprint(entries){return fp(entries);}
 function components(entries){return{ledger_sha256:fp(entries[ledger.STORAGE_KEY]??null),cash_sha256:fp(entries[resilience.CASH_KEY]??null),metadata_sha256:fp({sync:entries[SYNC_KEY]??null,archives:entries[ARCHIVE_KEY]??null}),entries_sha256:fp(entries)};}
 function validateEntries(entries,asOf){
  clock(asOf);if(!plain(entries))fail("INVALID_ENTRIES");for(const[k,v]of Object.entries(entries))if(!isDataKey(k)||typeof v!=="string")fail("INVALID_DATA_KEY");
  for(const [oldKey,newKey] of [["hs_portfolio_v6",PREFIX+"holdings"],["hs_portfolio_auto_v1",PREFIX+"autoRefresh"]])if(own(entries,oldKey)&&!own(entries,newKey))fail("LEGACY_MIGRATION_REQUIRES_EXPLICIT_PREVIEW");
  const backup=typeof module==="object"&&module.exports?require("./portfolio-full-backup-core.js"):globalThis.HSPortfolioFullBackupCore;
  if(!backup?.validateStorageEntries)fail("BASE_VALIDATOR_UNAVAILABLE");const described=backup.validateStorageEntries(entries);
  const l=entries[ledger.STORAGE_KEY]===undefined||entries[ledger.STORAGE_KEY]==="null"?null:JSON.parse(entries[ledger.STORAGE_KEY]);
  if(l&&!ledger.validateLedger(l))fail("INVALID_LEDGER");
  if(l){const actual=described.holdings.map(h=>({code:h.code,shares:h.shares,averageCost:h.averageCost})).sort((a,b)=>a.code.localeCompare(b.code)),expected=ledger.derivePortfolioStateFromLedger(l.events).holdings.map(h=>({code:h.symbol,shares:h.quantity,averageCost:h.averageCost})).sort((a,b)=>a.code.localeCompare(b.code));if(fp(actual)!==fp(expected))fail("DERIVED_HOLDINGS_MISMATCH");}
  const c=entries[resilience.CASH_KEY]===undefined?null:resilience.validateCashStore(JSON.parse(entries[resilience.CASH_KEY]));
  if(entries[PREFIX+"recoveryPoints.v1"]!==undefined){const points=JSON.parse(entries[PREFIX+"recoveryPoints.v1"]);if(!Array.isArray(points))fail("INVALID_RECOVERY_POINTS");for(const p of points)if(p?.kind==="HS_COORDINATED_RECOVERY_POINT_V1"&&!backup.validateBackup(p.backup).ok)fail("INVALID_COORDINATED_RECOVERY_POINT");}
  if(entries[ARCHIVE_KEY]!==undefined){const archives=JSON.parse(entries[ARCHIVE_KEY]);if(!Array.isArray(archives))fail("INVALID_SYNC_ARCHIVES");const seen=new Set();for(const a of archives){check(a);if(!text(a.archive_id)||seen.has(a.archive_id))fail("DUPLICATE_ARCHIVE_ID");seen.add(a.archive_id);sync.validateStore(a.store,{asOf:a.archived_at});}}
  if(entries[SYNC_KEY]!==undefined){
   const s=JSON.parse(entries[SYNC_KEY]);sync.validateStore(s,{asOf});
   if(!l||fp(l.events)!==fp(s.state.events))fail("SYNC_LEDGER_RELATION_MISMATCH");
   if(!c?.checkpoints.length||fp(c.checkpoints.at(-1).baseline)!==fp(s.state.baseline))fail("SYNC_CASH_BASELINE_MISMATCH");
  }else if(c?.checkpoints.length){const source=c.checkpoints.at(-1).source;if(source.ledger_raw!==(entries[ledger.STORAGE_KEY]??null)||source.ledger_raw===null&&source.holdings_raw!==(entries[PREFIX+"holdings"]??null))fail("CASH_SOURCE_REQUIRES_SYNCHRONIZATION");
  }
  if(hasPlan(entries))planContract().validateEntries(entries);
  return components(entries);
 }
 function validateMeta(meta,entries){
  check(meta);if(meta.schema!==SCHEMA||meta.version!==1||!Number.isSafeInteger(meta.revision)||meta.revision<0||meta.journal_state!=="COMMITTED"||!Array.isArray(meta.receipts)||meta.revision!==meta.receipts.length||fp(meta.components)!==fp(components(entries))||!plain(meta.component_revisions)||["ledger","cash","metadata"].some(k=>!Number.isSafeInteger(meta.component_revisions[k])||meta.component_revisions[k]<0||meta.component_revisions[k]>meta.revision))fail("COORDINATION_VERSION_OR_DATA_CONFLICT");
  const ids=new Set();for(let i=0;i<meta.receipts.length;i++){const r=meta.receipts[i];if(!text(r.operation_id)||ids.has(r.operation_id)||r.revision!==i+1||!/^[a-f0-9]{64}$/.test(r.request_sha256)||!/^[a-f0-9]{64}$/.test(r.after_sha256)||i===meta.receipts.length-1&&r.after_sha256!==meta.components.entries_sha256)fail("INVALID_OPERATION_RECEIPT");ids.add(r.operation_id);}return meta;
 }
 function capture(storage,{asOf}={}){
  return cash.withFingerprintScope(()=>{
  const pendingRaw=storage.getItem(JOURNAL_KEY);if(pendingRaw!==null&&validateJournal(JSON.parse(pendingRaw)).status!=="COMMITTED")fail("RECOVERY_REQUIRED");
  validateEntries(collect(storage),asOf);
  if(storage.getItem(LEGACY_JOURNAL)!==null)fail("LEGACY_RESTORE_REVIEW_REQUIRED");
  const entries=collect(storage),raw=storage.getItem(META_KEY),journal=storage.getItem(JOURNAL_KEY);
  const meta=raw===null?null:validateMeta(JSON.parse(raw),entries);
  if(journal!==null){const j=validateJournal(JSON.parse(journal));if(j.status!=="COMMITTED"||raw!==j.after_meta_raw||fp(entries)!==fp(j.after))fail("RECOVERY_REQUIRED");}
  if(hasPlan(entries))planContract().validateCommitted(entries,{meta,journal:journal===null?null:JSON.parse(journal)});
  return{schema:SCHEMA,version:1,revision:meta?.revision??0,operation_id:meta?.operation_id??null,...components(entries),ledger_revision:meta?.component_revisions.ledger??0,cash_baseline_revision:meta?.component_revisions.cash??0,metadata_revision:meta?.component_revisions.metadata??0,cash_checkpoint_revision:entries[resilience.CASH_KEY]?JSON.parse(entries[resilience.CASH_KEY]).revision:null,sync_store_revision:entries[SYNC_KEY]?JSON.parse(entries[SYNC_KEY]).revision:null,state_sha256:fp({entries,meta_raw:raw,journal_raw:journal}),journal_state:journal===null?"NONE":"COMMITTED"};
  });
 }
 function validateJournal(j){
  check(j);if(j.schema!==JOURNAL_SCHEMA||![1,2].includes(j.version)||!["PREPARED","COMMITTING","COMMITTED","RECOVERY_REQUIRED","CONFLICT"].includes(j.status)||!Number.isSafeInteger(j.cursor)||j.cursor<0||j.cursor>j.keys.length)fail("INVALID_WRITE_JOURNAL");
  if(j.version===2){const a=j.authority_binding;if(a?.schema!=='HS_TEST_ONLY_AUTHORITY_BINDING_V1'||a.scope!=='TEST_ONLY'||!['authority_id','portfolio_id'].every(k=>/^TEST_ONLY[_:a-zA-Z0-9.-]+$/.test(a[k]))||!['generation','authority_revision','writer_epoch'].every(k=>Number.isSafeInteger(a[k])&&a[k]>=0)||!/^[a-f0-9]{64}$/.test(a.fingerprint))fail('AUTHORITY_BINDING_REQUIRED');}else if(own(j,'authority_binding'))fail('AUTHORITY_JOURNAL_VERSION_REQUIRED');
  const immutable={operation_id:j.operation_id,request_sha256:j.request_sha256,before:j.before,after:j.after,before_meta_raw:j.before_meta_raw,after_meta_raw:j.after_meta_raw,keys:j.keys,prepared_at:j.prepared_at,...(j.participant_contract?{participant_contract:j.participant_contract,key_order:j.key_order,parent_snapshot:j.parent_snapshot}:{}),...(j.version===2?{authority_binding:j.authority_binding}:{})};
  if((hasPlan(j.before)||hasPlan(j.after))&&j.participant_contract!==planContract().GENERATION)fail("PLAN_JOURNAL_CONTRACT_REQUIRED");
  if(!text(j.operation_id)||fp(immutable)!==j.plan_sha256||fp(j.keys)!==fp(journalKeys(j.before,j.after,j.key_order)))fail("INVALID_JOURNAL_PLAN");
  const before=validateMeta(JSON.parse(j.before_meta_raw),j.before),after=validateMeta(JSON.parse(j.after_meta_raw),j.after);
  if(after.revision!==before.revision+1||after.operation_id!==j.operation_id||after.receipts.at(-1)?.request_sha256!==j.request_sha256||fp(after.receipts.slice(0,-1))!==fp(before.receipts)||["ledger","cash","metadata"].some(k=>after.component_revisions[k]!==before.component_revisions[k]+(before.components[k+"_sha256"]!==after.components[k+"_sha256"]?1:0)))fail("INVALID_JOURNAL_GENERATION");
  if(hasPlan(j.before)||hasPlan(j.after)){if(j.parent_snapshot?.revision!==before.revision||j.parent_snapshot?.ledger_revision!==before.component_revisions.ledger||j.parent_snapshot?.entries_sha256!==fp(j.before))fail("PLAN_JOURNAL_PARENT_CONFLICT");planContract().validateTransition(j.before,j.after,{operationId:j.operation_id,kind:after.receipts.at(-1).kind,expected:j.parent_snapshot});}
  if(!Array.isArray(j.evidence))fail("INVALID_CONFLICT_EVIDENCE");return j;
 }
 // A V2 candidate includes its complete recoverable financial state and canonical
 // terminal Journal. Receipt/transport diagnostics stay outside this state: no
 // hash self-reference and no mutation of the accepted candidate during recovery.
 function authorityProjection(j){validateJournal(j);if(j.version!==2)fail('AUTHORITY_JOURNAL_VERSION_REQUIRED');const{sha256,...body}=j;const terminal=seal({...body,status:'COMMITTED',cursor:j.keys.length});return{schema:'HS_ISOLATED_AUTHORITY_PORTFOLIO_V1',scope:'TEST_ONLY',entries:{...clone(j.after),[META_KEY]:j.after_meta_raw,[JOURNAL_KEY]:JSON.stringify(terminal)}};}
 function prefix(j,count){const e=clone(j.before);for(let i=0;i<count;i++){const k=j.keys[i];if(own(j.after,k))e[k]=j.after[k];else delete e[k];}return Object.fromEntries(Object.entries(e).sort(([a],[b])=>a.localeCompare(b)));}
 function pending(storage){const raw=storage.getItem(JOURNAL_KEY);if(raw===null)return null;return validateJournal(JSON.parse(raw));}
 function active(storage){return storage.getItem(META_KEY)!==null||storage.getItem(JOURNAL_KEY)!==null||storage.getItem(SYNC_KEY)!==null||storage.getItem(PLAN_KEY)!==null||storage.getItem(GEN_KEY)!==null;}
 function service(storage,{locks,validate=validateEntries,hook=()=>{},writeOrder="KEY_SORT",authority}={}){
  if(authority&&(typeof module!=='object'||!module.exports||!require('./services/portfolio-authority/product-adapter.cjs').isAdapter(authority)))fail('TRUSTED_AUTHORITY_ADAPTER_REQUIRED');
  const full=()=>{const e=collect(storage);for(const k of[META_KEY,JOURNAL_KEY]){const v=storage.getItem(k);if(v!==null)e[k]=v;}return e;};
  const writeJ=j=>{const row=seal(j),raw=JSON.stringify(row);storage.setItem(JOURNAL_KEY,raw);if(storage.getItem(JOURNAL_KEY)!==raw)fail("JOURNAL_VERIFY_FAILED");return row;};
  function evidence(j,status,reason){try{if(storage.getItem(JOURNAL_KEY)!==JSON.stringify(j))return{ok:false,status:"CONFLICT",reason:"JOURNAL_CHANGED_PRESERVED"};const{sha256,...body}=j;if(j.version===2){authority?.note(j,reason);writeJ({...body,status});}else writeJ({...body,status,evidence:[...j.evidence,{reason,observed:components(collect(storage)),meta_raw_sha256:fp(storage.getItem(META_KEY))}]});}catch{}return{ok:false,status,reason};}
  async function lock(action,signal){
   if(!locks?.request)return{ok:false,status:"LOCK_UNAVAILABLE"};
   try{return await locks.request(LOCK,{mode:"exclusive",...(signal?{signal}:{})},lock=>{if(!lock)fail("LOCK_UNAVAILABLE");return action();});}catch(e){return{ok:false,status:e.name==="AbortError"?"CANCELLED":"RECOVERY_REQUIRED",reason:e.message};}
  }
  async function finish(j,{asOf,recovery=false}){
   if(j.version===2&&!authority)fail('AUTHORITY_ADAPTER_REQUIRED');
   if(authority&&j.version!==2)fail('LEGACY_JOURNAL_AUTHORITY_MIGRATION_REQUIRED');
   // Mandatory participant validation cannot be replaced by a caller's validator.
   if(hasPlan(j.before)||hasPlan(j.after)){validateEntries(j.before,asOf);validateEntries(j.after,asOf);}
   validate(j.before,asOf);validate(j.after,asOf);
   const beforeMeta=j.before_meta_raw,afterMeta=j.after_meta_raw,raw=storage.getItem(META_KEY),current=collect(storage);
   if(j.status==="CONFLICT")return evidence(j,"CONFLICT","MANUAL_REVIEW_REQUIRED");
   if(storage.getItem(LEGACY_JOURNAL)!==null)return evidence(j,"CONFLICT","LEGACY_JOURNAL_APPEARED");
   let index=-1;
   // Only the recorded cursor or the immediately following atomic setItem is
   // a known crash boundary. Never accept an arbitrary mixture of old/new keys.
   for(const i of [...new Set([j.cursor,Math.min(j.cursor+1,j.keys.length)])])if(fp(current)===fp(prefix(j,i)))index=i;
   if(index<0||![beforeMeta,afterMeta].includes(raw)||raw===afterMeta&&index!==j.keys.length)return evidence(j,"CONFLICT","UNKNOWN_NEWER_DATA");
   try{
    if(j.version===2){const decision=await authority.confirm(j,{recovery});if(!decision.ok)return evidence(j,decision.rejected?'CONFLICT':'RECOVERY_REQUIRED',decision.reason);}
    for(let i=index;i<j.keys.length;i++){
     if(storage.getItem(JOURNAL_KEY)!==JSON.stringify(j))return{ok:false,status:"CONFLICT",reason:"JOURNAL_CHANGED_PRESERVED"};
     if(storage.getItem(LEGACY_JOURNAL)!==null||fp(collect(storage))!==fp(prefix(j,i))||storage.getItem(META_KEY)!==beforeMeta)return evidence(j,"CONFLICT","UNCOORDINATED_WRITER");
     const{sha256,...body}=j;j=writeJ({...body,status:"COMMITTING",cursor:i});await hook("BEFORE_KEY",{key:j.keys[i],index:i,operationId:j.operation_id});
     if(storage.getItem(JOURNAL_KEY)!==JSON.stringify(j))return{ok:false,status:"CONFLICT",reason:"JOURNAL_CHANGED_PRESERVED"};
     if(storage.getItem(LEGACY_JOURNAL)!==null||fp(collect(storage))!==fp(prefix(j,i))||storage.getItem(META_KEY)!==beforeMeta)return evidence(j,"CONFLICT","UNCOORDINATED_WRITER");
     const k=j.keys[i];if(own(j.after,k))storage.setItem(k,j.after[k]);else storage.removeItem(k);
     if(fp(collect(storage))!==fp(prefix(j,i+1)))return evidence(j,"CONFLICT","KEY_WRITE_MISMATCH");
     const{sha256:drop,...progress}=j;j=writeJ({...progress,status:"COMMITTING",cursor:i+1});await hook("AFTER_KEY",{key:k,index:i,operationId:j.operation_id});
    }
    if(storage.getItem(JOURNAL_KEY)!==JSON.stringify(j))return{ok:false,status:"CONFLICT",reason:"JOURNAL_CHANGED_PRESERVED"};
    if(storage.getItem(LEGACY_JOURNAL)!==null||fp(collect(storage))!==fp(j.after)||![beforeMeta,afterMeta].includes(storage.getItem(META_KEY)))return evidence(j,"CONFLICT","PROMOTION_CONFLICT");
    validate(collect(storage),asOf);storage.setItem(META_KEY,afterMeta);if(storage.getItem(META_KEY)!==afterMeta)fail("META_VERIFY_FAILED");
    await hook("AFTER_META",{operationId:j.operation_id});
    if(storage.getItem(JOURNAL_KEY)!==JSON.stringify(j))return{ok:false,status:"CONFLICT",reason:"JOURNAL_CHANGED_PRESERVED"};
    if(fp(collect(storage))!==fp(j.after)||storage.getItem(META_KEY)!==afterMeta)return evidence(j,"CONFLICT","POST_PROMOTION_CONFLICT");
    const{sha256,...body}=j;j=writeJ({...body,status:"COMMITTED",cursor:j.keys.length});
    const verified=capture(storage,{asOf});if(fp(collect(storage))!==fp(j.after))fail("POST_COMMIT_DATA_CONFLICT");if(j.version===2)await authority.complete(j,full());return{ok:true,status:"COMMITTED",operation_id:j.operation_id,snapshot:verified};
   }catch(e){const latest=pending(storage)||j;return evidence(latest,"RECOVERY_REQUIRED",e.message);}
  }
  return Object.freeze({
   snapshot:options=>capture(storage,options),
   initialize({asOf,signal}={}){return lock(async()=>{const initial=capture(storage,{asOf});if(authority){if(storage.getItem(META_KEY)===null)fail('EXPLICIT_AUTHORITY_ENROLLMENT_REQUIRED');await authority.verifyMirror(full());}if(storage.getItem(META_KEY)!==null)return{ok:true,status:"ALREADY_INITIALIZED",snapshot:initial};const entries=collect(storage);validate(entries,asOf);const meta=seal({schema:SCHEMA,version:1,revision:0,operation_id:null,components:components(entries),component_revisions:{ledger:0,cash:0,metadata:0},journal_state:"COMMITTED",receipts:[]});storage.setItem(META_KEY,JSON.stringify(meta));return{ok:true,status:"INITIALIZED",snapshot:capture(storage,{asOf})};},signal);},
   execute({operationId,kind,intent,expected,plan,asOf,signal,onPhase}={}){return lock(async()=>{
    const notify=phase=>{try{onPhase?.(phase);}catch{/* Observers cannot authorize or change a write. */}};
    const cancelled=()=>{if(signal?.aborted)throw Object.assign(Error("CANCELLED_BEFORE_WRITE"),{name:"AbortError"});};
    notify("PREPARING");cancelled();
    clock(asOf);if(!text(operationId)||!text(kind)||typeof plan!=="function"||!plain(expected))fail("OPERATION_PREVIEW_REQUIRED");
    const request=fp({kind,intent}),j=pending(storage);
    if(j&&j.status!=="COMMITTED")return{ok:false,status:j.status==="CONFLICT"?"CONFLICT":"RECOVERY_REQUIRED"};
    if(j?.version===2&&!authority)fail('AUTHORITY_ADAPTER_REQUIRED');
    const binding=authority?await authority.parent(full()):null;
    const current=capture(storage,{asOf}),raw=storage.getItem(META_KEY);if(raw===null)fail("EXPLICIT_INITIALIZATION_REQUIRED");
    const meta=validateMeta(JSON.parse(raw),collect(storage)),prior=meta.receipts.find(r=>r.operation_id===operationId);
    if(prior)return prior.request_sha256===request?{ok:true,status:"ALREADY_COMMITTED",operation_id:operationId,snapshot:current}:{ok:false,status:"CONFLICT",reason:"OPERATION_ID_REUSED"};
    if(fp(expected)!==fp(current))return{ok:false,status:"CONFLICT",reason:"STALE_PREVIEW"};
    const before=collect(storage),after=await plan(clone(before),clone(current));cancelled();if(hasPlan(before)||hasPlan(after))validateEntries(after,asOf);validate(after,asOf);
    if(hasPlan(before)||hasPlan(after))planContract().validateTransition(before,after,{operationId,kind,expected:current});
    if(capture(storage,{asOf}).state_sha256!==current.state_sha256)return{ok:false,status:"CONFLICT",reason:"DATA_CHANGED_DURING_PLAN"};
    const revision=meta.revision+1;if(!Number.isSafeInteger(revision))fail("REVISION_OVERFLOW");
    const parts=components(after),component_revisions={};for(const k of ["ledger","cash","metadata"])component_revisions[k]=meta.component_revisions[k]+(parts[k+"_sha256"]!==meta.components[k+"_sha256"]?1:0);
    const conversion=after['hsRadar.portfolio.accelerationConsumption.v1']?JSON.parse(after['hsRadar.portfolio.accelerationConsumption.v1']).records.at(-1):null;
    const publication=conversion?.partial_conversion&&conversion.operation_id===operationId?{conversion_receipt_sha256:conversion.sha256,committed_generation_id:JSON.parse(after[planContract().GEN_KEY]).generation_id}:{};
    const next=seal({schema:SCHEMA,version:1,revision,operation_id:operationId,components:parts,component_revisions,journal_state:"COMMITTED",receipts:[...meta.receipts,{operation_id:operationId,kind,request_sha256:request,revision,before_sha256:fp(before),after_sha256:fp(after),...publication}]});
    const body={operation_id:operationId,request_sha256:request,before,after,before_meta_raw:raw,after_meta_raw:JSON.stringify(next),keys:journalKeys(before,after,hasPlan(before)||hasPlan(after)?writeOrder:undefined),prepared_at:asOf,...(hasPlan(before)||hasPlan(after)?{participant_contract:planContract().GENERATION,key_order:writeOrder,parent_snapshot:current}:{}),...(binding?{authority_binding:binding}:{})};
    cancelled();notify("COMMITTING");
    const prepared=writeJ({schema:JOURNAL_SCHEMA,version:binding?2:1,...body,plan_sha256:fp(body),status:"PREPARED",cursor:0,evidence:[]});
    await hook("AFTER_PREPARE",{operationId});return finish(prepared,{asOf});
   },signal);},
   recover({operationId,planSha256,asOf,signal}={}){return lock(async()=>{const j=pending(storage);if(!j)return{ok:true,status:"NONE"};if(j.operation_id!==operationId||j.plan_sha256!==planSha256) return{ok:false,status:"CONFLICT",reason:"RECOVERY_TARGET_MISMATCH"};if(j.version===2&&!authority)fail('AUTHORITY_ADAPTER_REQUIRED');if(j.status==="COMMITTED"){capture(storage,{asOf});if(j.version===2)await authority.complete(j,full());else if(authority)await authority.verifyMirror(full());return{ok:true,status:"ALREADY_COMMITTED"};}return finish(j,{asOf,recovery:true});},signal);}
  });
 }
 function replaceCheckpoint(entries,cashRaw,{asOf,archiveId}={}){
  const next=clone(entries),store=resilience.validateCashStore(JSON.parse(cashRaw));next[resilience.CASH_KEY]=cashRaw;
  if(next[SYNC_KEY]!==undefined){const previous=sync.validateStore(JSON.parse(next[SYNC_KEY]),{asOf});if(!text(archiveId))fail("ARCHIVE_ID_REQUIRED");const archives=JSON.parse(next[ARCHIVE_KEY]||"[]");archives.push(seal({archive_id:archiveId,archived_at:asOf,store:previous}));next[ARCHIVE_KEY]=JSON.stringify(archives);
   const events=JSON.parse(next[ledger.STORAGE_KEY]).events,baseline=store.checkpoints.at(-1).baseline;
   // V2 retains original receipt versions and coverage evidence verbatim.
   // They are revalidated through the checkpoint witness, not rebound or erased.
   const v2=baseline.schema===sync.CHECKPOINT_V2;
   if(v2&&cash.fingerprint(baseline.source_state)!==cash.fingerprint(previous.state))fail("CHECKPOINT_SOURCE_STATE_MISMATCH");
   const reviewed=v2&&previous.state.schema===sync.REVIEWED_STATE?{schema:sync.REVIEWED_STATE,coverageReviews:previous.state.coverageReviews}:{};
   next[SYNC_KEY]=JSON.stringify(sync.createStore({...reviewed,baseline,events,metadata:v2?previous.state.metadata:{},dividendReceipts:v2?previous.state.dividendReceipts:[],ledgerComplete:true},asOf));
  }validateEntries(next,asOf);return next;
 }
 return Object.freeze({SCHEMA,JOURNAL_SCHEMA,META_KEY,JOURNAL_KEY,SYNC_KEY,ARCHIVE_KEY,LEGACY_JOURNAL,LOCK,isDataKey,collect,fingerprint,components,validateEntries,validateMeta,validateJournal,authorityProjection,capture,active,replaceCheckpoint,service});
});

;
/* sealed source: portfolio-capital-build-plan-core.js */
(function(root,factory){
  const node=typeof module==="object"&&module.exports;
  const api=factory(...(node?[require("./portfolio-investable-cash-core"),require("./portfolio-transaction-cash-sync-core"),require("./portfolio-write-coordinator"),require("./portfolio-ledger-core"),require("./portfolio-dashboard-core")]:[root.HSPortfolioInvestableCashCore,root.HSPortfolioTransactionCashSyncCore,root.HSPortfolioWriteCoordinator,root.HSPortfolioLedgerCore,root.HSPortfolioDashboardCore]));
  if(node)module.exports=api;if(root)root.HSPortfolioCapitalBuildPlanCore=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(cash,sync,coordinator,ledger,dashboard){
  "use strict";
  // Pure proposals only. SHA binds bytes, NOT identity or external authenticity.
  // Future persistence MUST CAS both Plan revision/SHA and the Phase 2 snapshot
  // under its existing Shared Lock/Journal. No plan is created by evaluation.
  const SCHEMA="HS_CAPITAL_BUILD_PLAN_V1",TZ="Asia/Taipei",RULE="REPLAN_GAP_NO_ADDITIVE_CARRY",MAX=BigInt(Number.MAX_SAFE_INTEGER);
  const fp=v=>cash.fingerprint(v),copy=v=>JSON.parse(JSON.stringify(v)),fail=s=>{throw Error(s);},plain=v=>v!==null&&typeof v==="object"&&!Array.isArray(v),text=v=>typeof v==="string"&&v.trim()===v&&v.length>0&&v.length<=240;
  const seal=o=>({...copy(o),sha256:fp(o)});
  function check(o){if(!plain(o))fail("INVALID_RECORD");const{sha256,...body}=o;if(sha256!==fp(body))fail("RECORD_SHA_MISMATCH");return o;}
  function safe(v){if(v<0n||v>MAX)fail("INVALID_MINOR_UNITS");return Number(v);}
  function minor(v){if(!Number.isSafeInteger(v)||v<0||Object.is(v,-0))fail("INVALID_MINOR_UNITS");return v;}
  function scaled(v,d){if(!["number","string"].includes(typeof v)||Object.is(v,-0)||String(v).length>32||!new RegExp("^\\d+(?:\\.\\d{1,"+d+"})?$").test(String(v)))fail("INVALID_DECIMAL");const[a,b=""]=String(v).split(".");return BigInt(a)*10n**BigInt(d)+BigInt(b.padEnd(d,"0")||"0");}
  function stamp(s){
    if(typeof s!=="string"||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(s))fail("OFFSET_TIMESTAMP_REQUIRED");
    const ms=Date.parse(s),day=s.slice(0,10),off=s.slice(-6);
    if(!Number.isFinite(ms)||new Date(day+"T00:00:00Z").toISOString().slice(0,10)!==day||+s.slice(11,13)>23||+s.slice(14,16)>59||+s.slice(17,19)>59||/^[+-]14:/.test(off)&&off.slice(4)!=="00")fail("INVALID_TIMESTAMP");return ms;
  }
  const iso=ms=>new Date(ms).toISOString(),local=ms=>new Date(ms+28800000).toISOString();
  function clock(asOf,reference){const t=stamp(asOf);if(!text(reference?.source)||Math.abs(t-stamp(reference.reference_at))>60000)fail("CLOCK_REFERENCE_OR_SKEW");return t;}
  function duration(n){if(![3,6,12].includes(n))fail("INVALID_DURATION");return n;}
  function anniversary(start,n){
    const a=local(stamp(start)),year=+a.slice(0,4),month=+a.slice(5,7)-1+n,y=year+Math.floor(month/12),m=month%12;
    const d=Math.min(+a.slice(8,10),new Date(Date.UTC(y,m+1,0)).getUTCDate());
    return iso(Date.UTC(y,m,d,+a.slice(11,13)-8,+a.slice(14,16),+a.slice(17,19),+a.slice(20,23)));
  }
  function periodAt(plan,asOf){const t=stamp(asOf);if(t<stamp(plan.start_at))return{status:"SCHEDULED",index:null,id:null};for(let i=1;i<=plan.duration_months;i++)if(t<stamp(anniversary(plan.start_at,i)))return{status:"ACTIVE",index:i,id:plan.plan_id+":period:"+i,start:anniversary(plan.start_at,i-1),end:anniversary(plan.start_at,i)};return{status:"COMPLETED",index:null,id:null};}
  function weights(config){
    if(!plain(config.etf_target_weights)||!Object.keys(config.etf_target_weights).length)fail("ETF_WEIGHTS_REQUIRED");let sum=0;
    for(const[code,value]of Object.entries(config.etf_target_weights)){const n=dashboard.normalizeTarget(value);if(!/^[0-9A-Z]{4,10}$/.test(code)||typeof value!=="number"||!n.ok||n.value===null)fail("INVALID_ETF_TARGET");if(code==="00631L"&&value>0)fail("00631L_NOT_ELIGIBLE");sum+=Math.round(value*10);}
    if(sum!==1000)fail("ETF_WEIGHTS_MUST_TOTAL_100");
    const r=config.allocation_tolerance_reference;if(r?.contract!==dashboard.VERSION||r.mode!=="ABSOLUTE_PERCENTAGE_POINTS"||!text(r.reference)||typeof r.value!=="number"||!dashboard.normalizeTarget(r.value).ok)fail("ALLOCATION_TOLERANCE_REFERENCE_REQUIRED");
    const a=config.normal_equity_target_bps,b=config.maximum_equity_limit_bps;if(!Number.isInteger(a)||!Number.isInteger(b)||a<0||a>b||b>10000)fail("EQUITY_TARGET_OR_LIMIT");
  }
  function confirmation(c,asOf,earliest){if(c?.kind!=="USER_CONFIRMATION"||!text(c.reference)||stamp(c.confirmed_at)>stamp(asOf)||stamp(c.confirmed_at)<earliest)fail("EXPLICIT_USER_CONFIRMATION_REQUIRED");}
  function split(total,count){minor(total);if(!Number.isInteger(count)||count<1||count>12)fail("INVALID_PERIOD_COUNT");const q=BigInt(total)/BigInt(count),r=Number(BigInt(total)%BigInt(count));return Array.from({length:count},(_,i)=>safe(q+BigInt(i<r)));}
  function source(input){
    const now=clock(input.asOf,input.clock);if(!plain(input.entries))fail("PHASE2_ENTRIES_REQUIRED");
    const keys=Object.keys(input.entries);if(keys.some(k=>typeof input.entries[k]!=="string"))fail("INVALID_ENTRIES");
    const view=entries=>{const names=Object.keys(entries);return{get length(){return names.length;},key:i=>names[i]??null,getItem:k=>Object.hasOwn(entries,k)?entries[k]:null};};
    // A candidate is NOT a committed receipt. Capture its real parent first;
    // validate the private Phase 2 projection independently, without inventing
    // an intermediate storage generation or weakening canonical capture().
    if(input.prepared_source){const contract=typeof module==="object"&&module.exports?require("./portfolio-plan-generation-core"):globalThis.HSPortfolioPlanGenerationCore;if(!contract)fail("CANDIDATE_VALIDATOR_UNAVAILABLE");contract.validatePreparedSource(input);}
    const memory=view(input.entries),snapshot=coordinator.capture(view(input.prepared_source?.before_entries||input.entries),{asOf:input.asOf});
    if(snapshot.revision!==input.expected_revision||snapshot.state_sha256!==input.expected_state_sha256)fail("LEDGER_REVISION_OR_SHA_CONFLICT");
    const raw=memory.getItem(coordinator.SYNC_KEY);if(!raw)fail("CASH_UNINITIALIZED");const store=sync.validateStore(JSON.parse(raw),{asOf:input.asOf}),s=store.state,projection=sync.derive({...s,asOf:input.asOf});
    if(!["READY","PENDING"].includes(projection.status)||!Number.isSafeInteger(projection.investable_minor))fail("CASH_RECONCILIATION_REQUIRED");
    const events=JSON.parse(memory.getItem(ledger.STORAGE_KEY)).events,replay=ledger.derivePortfolioStateFromLedger(events);if(!replay.valid||fp(events)!==fp(s.events))fail("LEDGER_STATE_CONFLICT");
    return{now,snapshot,state:s,projection,events,replay};
  }
  // Full current holdings (including out-of-plan BUYs) and one canonical cash
  // balance. An unsettled SELL is a separate verified receivable, NEVER cash.
  function valuation(input,src){
    const v=input.valuation;if(v?.status!=="VERIFIED"||v.currency!=="TWD"||!text(v.evidence_reference)||v.ledger_sha256!==fp(src.events)||stamp(v.as_of)>src.now||stamp(v.valid_until)<src.now||stamp(v.valid_until)<stamp(v.as_of)||!Array.isArray(v.rows))fail("VALUATION_INCOMPLETE_OR_STALE");
    if(!Array.isArray(input.receivables)||!Array.isArray(input.other_assets))fail("ASSET_COVERAGE_REQUIRED");
    const positions=new Map(src.replay.holdings.map(h=>[h.symbol,h])),seen=new Set();let equity=0n,claims=0n,others=0n;
    for(const row of v.rows){const h=positions.get(row.symbol);if(!h||seen.has(row.symbol)||scaled(row.quantity,8)!==scaled(h.quantity,8)||scaled(row.unit_price,6)<=0n)fail("HOLDINGS_VALUATION_MISMATCH");seen.add(row.symbol);equity+=(scaled(row.quantity,8)*scaled(row.unit_price,6)+500000000000n)/1000000000000n;safe(equity);}
    if(seen.size!==positions.size)fail("MISSING_HOLDING_PRICE");
    const pending=new Set(src.projection.pending_event_ids),refs=new Set([v.evidence_reference]),claimed=new Set();
    for(const p of input.receivables){check(p);const e=src.events.find(e=>e.id===p.event_id),m=src.state.metadata[p.event_id];
      if(p.schema!=="HS_CAPITAL_SELL_RECEIVABLE_V1"||p.currency!=="TWD"||!e||e.type!=="SELL"||claimed.has(e.id)||!pending.has(e.id)||!m||p.event_sha256!==fp(e)||p.metadata_sha256!==m.sha256||p.investment_account!==true||m.investment_account===false||p.state!=="PENDING"||p.net_minor!==cash.eventAmountMinor(e))fail("RECEIVABLE_BINDING_OR_DOUBLE_COUNT");
      confirmation(p.confirmation,input.asOf,stamp(e.updatedAt||e.timestamp));if(refs.has(p.confirmation.reference))fail("DUPLICATE_ASSET_REFERENCE");refs.add(p.confirmation.reference);claimed.add(e.id);claims+=BigInt(minor(p.net_minor));safe(claims);
    }
    if([...pending].some(id=>!claimed.has(id)))fail("PENDING_ASSET_EVIDENCE_INCOMPLETE");
    const assetIds=new Set();for(const a of input.other_assets){check(a);if(a.schema!=="HS_CAPITAL_OTHER_ASSET_V1"||a.currency!=="TWD"||!text(a.asset_id)||assetIds.has(a.asset_id)||a.category!=="OTHER_VERIFIED_NON_CASH_NON_EQUITY"||a.included_in_cash!==false||!text(a.evidence_reference)||refs.has(a.evidence_reference)||stamp(a.as_of)>src.now||stamp(a.valid_until)<src.now)fail("OTHER_ASSET_EVIDENCE_CONFLICT");assetIds.add(a.asset_id);refs.add(a.evidence_reference);others+=BigInt(minor(a.amount_minor));safe(others);}
    const available=minor(src.projection.investable_minor),reserve=minor(input.fee_reserve_minor),total=safe(equity+claims+others+BigInt(available));
    return{equity_minor:safe(equity),available_cash_minor:available,fee_reserve_minor:reserve,spendable_minor:Math.max(0,available-reserve),pending_sell_minor:safe(claims),other_assets_minor:safe(others),total_assets_minor:total,valuation_sha256:fp(v),receivables_sha256:fp(input.receivables),other_assets_sha256:fp(input.other_assets)};
  }
  function validatePlan(p){
    check(p);if(p.schema!==SCHEMA||p.version!==1||p.time_zone!==TZ||!text(p.plan_id)||!Number.isSafeInteger(p.revision)||p.revision<1||p.unused_rule!==RULE||fp(p.integrity)!==fp({status:"HASH_BOUND_SOURCE_VALIDATED",not_authentication:true,currency:"TWD",minor_unit_scale:2}))fail("INVALID_PLAN");duration(p.duration_months);weights(p);stamp(p.start_at);stamp(p.created_at);stamp(p.updated_at);
    if(p.start_date!==local(stamp(p.start_at)).slice(0,10)||stamp(p.start_at)<stamp(p.created_at)||stamp(p.updated_at)<stamp(p.created_at)||!Array.isArray(p.quota_records)||!Array.isArray(p.execution_attributions)||!Array.isArray(p.configuration_changes)||!Array.isArray(p.audit)||p.audit.length!==p.revision)fail("INVALID_PLAN_HISTORY");
    if(p.quota_records.length>12||p.status!==periodAt(p,p.updated_at).status||p.current_period!==periodAt(p,p.updated_at).index)fail("PLAN_STATUS_OR_PERIOD_CONFLICT");
    const qids=new Set(),aids=new Set();let prior=0,lastIndex=0;
    for(const q of p.quota_records){check(q);if(qids.has(q.period_id)||!Number.isInteger(q.index)||q.index<=lastIndex||q.index>12||q.period_id!==p.plan_id+":period:"+q.index||q.start!==anniversary(p.start_at,q.index-1)||q.end!==anniversary(p.start_at,q.index)||stamp(q.issued_at)<stamp(q.start)||stamp(q.issued_at)>=stamp(q.end)||!Number.isSafeInteger(q.issued_plan_revision)||q.issued_plan_revision<1||q.issued_plan_revision>p.revision)fail("INVALID_QUOTA_HISTORY");lastIndex=q.index;qids.add(q.period_id);minor(q.approved_minor);
      const config=p.configuration_changes.filter(c=>c.revision<=q.issued_plan_revision).at(-1),w=q.witness;for(const k of ["equity_minor","available_cash_minor","fee_reserve_minor","spendable_minor","pending_sell_minor","other_assets_minor","total_assets_minor"])minor(w[k]);
      minor(q.already_executed_minor);if(w.total_assets_minor!==safe(BigInt(w.equity_minor)+BigInt(w.available_cash_minor)+BigInt(w.pending_sell_minor)+BigInt(w.other_assets_minor))||w.spendable_minor!==Math.max(0,w.available_cash_minor-w.fee_reserve_minor)||q.remaining_periods!==config?.duration_months-q.index+1||q.remainder_rule!=="EARLIEST_PERIOD_EXTRA_CENT"||q.target_gap_minor!==gap(p,w).target_gap_minor||q.maximum_headroom_minor!==gap(p,w).maximum_headroom_minor||fp(split(q.target_gap_minor,q.remaining_periods))!==fp(q.forecast_minor)||q.approved_minor!==safe(BigInt(q.already_executed_minor)+BigInt(Math.min(q.forecast_minor[0],w.spendable_minor,q.maximum_headroom_minor))))fail("QUOTA_ARITHMETIC_CONFLICT");}
    for(const a of p.execution_attributions){check(a);if(aids.has(a.record_id)||a.plan_id!==p.plan_id||periodAt(p,a.occurred_at).id!==a.period_id||!["IN_PLAN","OUTSIDE_PLAN"].includes(a.classification)||!["ASSIGN","REVISE","REVOKE"].includes(a.action)||a.recognition_status!==(a.action==="REVOKE"?"REVOKED":"CONFIRMED")||a.revision>p.revision)fail("INVALID_ATTRIBUTION_HISTORY");aids.add(a.record_id);minor(a.principal_minor);minor(a.fee_minor);}
    for(let i=0;i<p.configuration_changes.length;i++){const c=p.configuration_changes[i];check(c);duration(c.duration_months);if(c.revision<=prior||c.revision>p.revision||c.start_at!==p.start_at)fail("INVALID_CONFIG_HISTORY");prior=c.revision;}
    if(!prior||p.configuration_changes.at(-1).duration_months!==p.duration_months)fail("CONFIGURATION_VERSION_CONFLICT");
    for(let i=0;i<p.audit.length;i++){check(p.audit[i]);if(p.audit[i].revision!==i+1||i&&p.audit[i].previous_audit_sha256!==p.audit[i-1].sha256)fail("PLAN_AUDIT_CHAIN_CONFLICT");}
    if(!Array.isArray(p.ledger_at_creation.event_pins)||new Set(p.ledger_at_creation.event_pins.map(x=>x.event_id)).size!==p.ledger_at_creation.event_pins.length)fail("INVALID_CREATION_LEDGER_PINS");
    return p;
  }
  function current(p,input,expected){validatePlan(p);if(expected!==p.revision)fail("PLAN_REVISION_CONFLICT");const src=source(input);if(src.now<stamp(p.updated_at))fail("CLOCK_MOVED_BACKWARDS");if(src.snapshot.revision<p.source_watermark.revision||src.snapshot.revision===p.source_watermark.revision&&src.snapshot.state_sha256!==p.source_watermark.state_sha256)fail("SOURCE_REVISION_CONFLICT");return src;}
  function finish(p,src,input,action,recordId){
    p.revision++;p.updated_at=input.asOf;const period=periodAt(p,input.asOf);p.current_period=period.index;p.status=period.status;p.source_watermark=copy(src.snapshot);
    p.audit.push(seal({revision:p.revision,action,record_id:recordId,at:input.asOf,previous_plan_sha256:p.sha256,previous_audit_sha256:p.audit.at(-1).sha256,source_revision:src.snapshot.revision,source_sha256:src.snapshot.state_sha256}));delete p.sha256;return validatePlan(seal(p));
  }
  function createPlan({planId,startAt,config,confirmation:confirmed,input}={}){
    if(!text(planId))fail("PLAN_ID_REQUIRED");const src=source(input);confirmation(confirmed,input.asOf,src.now);startAt=startAt??input.asOf;if(stamp(startAt)<src.now)fail("BACKDATED_PLAN_NOT_ALLOWED");const c=copy(config);c.duration_months=duration(c.duration_months??6);weights(c);
    const p={schema:SCHEMA,version:1,plan_id:planId,revision:1,created_at:input.asOf,updated_at:input.asOf,start_at:startAt,start_date:local(stamp(startAt)).slice(0,10),time_zone:TZ,duration_months:c.duration_months,normal_equity_target_bps:c.normal_equity_target_bps,maximum_equity_limit_bps:c.maximum_equity_limit_bps,etf_target_weights:c.etf_target_weights,allocation_tolerance_reference:c.allocation_tolerance_reference,unused_rule:RULE,confirmation:copy(confirmed),ledger_at_creation:{revision:src.snapshot.ledger_revision,sha256:fp(src.events),event_pins:src.events.map(e=>({event_id:e.id,sha256:fp(e)}))},source_watermark:copy(src.snapshot),quota_records:[],execution_attributions:[],configuration_changes:[seal({revision:1,duration_months:c.duration_months,start_at:startAt,at:input.asOf,confirmation:copy(confirmed)})],audit:[seal({revision:1,action:"CREATE",at:input.asOf,previous_audit_sha256:null,source_revision:src.snapshot.revision,source_sha256:src.snapshot.state_sha256})]};
    const period=periodAt(p,input.asOf);p.current_period=period.index;p.status=period.status;p.integrity={status:"HASH_BOUND_SOURCE_VALIDATED",not_authentication:true,currency:"TWD",minor_unit_scale:2};return validatePlan(seal(p));
  }
  function gap(p,v){
    const total=BigInt(v.total_assets_minor),afterFees=BigInt(Math.max(0,v.total_assets_minor-v.fee_reserve_minor)),normal=BigInt(p.normal_equity_target_bps),maximum=BigInt(p.maximum_equity_limit_bps);
    // Declared fee reserve is not spent money or a Ledger event. Stress the
    // post-fee denominator so a principal at today's cap cannot breach it as
    // soon as the fee is charged. Actual fees still need Phase 2 validation.
    return{normal_target_gap_minor:Math.max(0,safe(total*normal/10000n)-v.equity_minor),target_gap_minor:Math.max(0,safe(afterFees*normal/10000n)-v.equity_minor),maximum_headroom_minor:Math.max(0,safe(afterFees*maximum/10000n)-v.equity_minor),above_maximum:v.equity_minor>safe(total*maximum/10000n)};
  }
  function progress(p,src){
    const latest=new Map();for(const a of p.execution_attributions){const prior=latest.get(a.event_id);if(a.supersedes!==(prior?.record_id??null)||!prior&&a.action!=="ASSIGN"||prior&&a.action==="ASSIGN")fail("ATTRIBUTION_CHAIN_CONFLICT");latest.set(a.event_id,a);}
    for(const e of src.events.filter(e=>e.type==="BUY"&&!p.ledger_at_creation.event_pins.some(pin=>pin.event_id===e.id))){const proof=src.state.coverageReviews?.find(r=>r.event_id===e.id)||src.state.metadata[e.id];if(!proof)fail("BUY_ACTUAL_TIME_EVIDENCE_REQUIRED");if(periodAt(p,proof.occurred_at).status==="ACTIVE"&&!latest.has(e.id))fail("UNCLASSIFIED_BUY_REQUIRES_RECONCILIATION:"+e.id);}
    const periods={};for(const a of latest.values()){
      const e=src.events.find(e=>e.id===a.event_id);if(a.action==="REVOKE"){if(e)fail("REVOKED_EVENT_REAPPEARED");continue;}
      const proof=src.state.coverageReviews?.find(r=>r.event_id===a.event_id)||src.state.metadata[a.event_id];
      if(!e||e.type!=="BUY"||fp(e)!==a.event_sha256||!proof||fp(proof)!==a.metadata_fingerprint||a.occurred_at!==proof.occurred_at||a.recorded_at!==proof.recorded_at||periodAt(p,proof.occurred_at).id!==a.period_id)fail("ATTRIBUTION_RECONCILIATION_REQUIRED");
      if(a.principal_minor!==cash.eventAmountMinor(e)-cash.toMinorUnits(e.fee))fail("PRINCIPAL_CONFLICT");
      if(a.classification==="IN_PLAN")periods[a.period_id]=safe(BigInt(periods[a.period_id]||0)+BigInt(a.principal_minor));
    }return periods;
  }
  function evaluate(plan,input){
    if(plan===null)return{status:"UNINITIALIZED",executable_minor:null,reasons:["USER_PLAN_CONFIRMATION_REQUIRED"]};
    try{const src=current(plan,input,plan.revision),v=valuation(input,src),g=gap(plan,v),period=periodAt(plan,input.asOf),totals=progress(plan,src),q=plan.quota_records.find(q=>q.period_id===period.id),used=totals[period.id]||0,unused=q?Math.max(0,q.approved_minor-used):null,months=period.index?plan.duration_months-period.index:0;
      return{status:period.status==="ACTIVE"?(q?"READY":"QUOTA_NOT_ISSUED"):period.status,current_period:period.index,period_id:period.id,approved_minor:q?.approved_minor??null,executed_principal_minor:used,within_quota_minor:q?Math.min(used,q.approved_minor):0,over_quota_minor:q?Math.max(0,used-q.approved_minor):0,unused_minor:unused,executable_minor:period.status==="ACTIVE"&&q?Math.min(unused,v.spendable_minor,g.target_gap_minor,g.maximum_headroom_minor):period.status==="ACTIVE"?null:0,completed_principal_minor:safe(Object.values(totals).reduce((s,n)=>s+BigInt(n),0n)),period_progress:totals,history:plan.quota_records.map(q=>({period_id:q.period_id,approved_minor:q.approved_minor,used_minor:totals[q.period_id]||0,unused_minor:Math.max(0,q.approved_minor-(totals[q.period_id]||0))})),future_forecast_minor:months?split(Math.max(0,g.target_gap_minor-(unused??0)),months):[],remaining_periods:period.index?plan.duration_months-period.index+1:0,...v,...g,source_revision:src.snapshot.revision,plan_revision:plan.revision,reasons:[]};
    }catch(e){return{status:"RECONCILIATION_REQUIRED",executable_minor:null,reasons:[e.message]};}
  }
  function issueQuota(plan,input,{expectedPlanRevision}={}){
    const src=current(plan,input,expectedPlanRevision),period=periodAt(plan,input.asOf);if(period.status!=="ACTIVE")fail("NO_ACTIVE_PERIOD");valuation(input,src);const used=progress(plan,src)[period.id]||0;
    if(plan.quota_records.some(q=>q.period_id===period.id))return copy(plan);
    const v=valuation(input,src),g=gap(plan,v),remaining=plan.duration_months-period.index+1,forecast=split(g.target_gap_minor,remaining),p=copy(plan);
    p.quota_records.push(seal({period_id:period.id,index:period.index,start:period.start,end:period.end,issued_at:input.asOf,issued_plan_revision:plan.revision,target_gap_minor:g.target_gap_minor,maximum_headroom_minor:g.maximum_headroom_minor,remaining_periods:remaining,forecast_minor:forecast,remainder_rule:"EARLIEST_PERIOD_EXTRA_CENT",already_executed_minor:used,approved_minor:safe(BigInt(used)+BigInt(Math.min(forecast[0],v.spendable_minor,g.maximum_headroom_minor))),witness:v,ledger_revision:src.snapshot.ledger_revision,source_sha256:src.snapshot.state_sha256}));return finish(p,src,input,"ISSUE_QUOTA",period.id);
  }
  function attributeBuy(plan,input,{eventId,classification,confirmation:confirmed,expectedPlanRevision,classificationContext}={}){
    const src=current(plan,input,expectedPlanRevision),e=src.events.find(e=>e.id===eventId);if(!e||e.type!=="BUY"||!["IN_PLAN","OUTSIDE_PLAN"].includes(classification)||classification==="IN_PLAN"&&e.symbol==="00631L")fail("INELIGIBLE_BUY");
    if(plan.ledger_at_creation.event_pins.some(p=>p.event_id===e.id))fail("HISTORICAL_BUY_NOT_ATTRIBUTABLE");
    const proof=src.state.coverageReviews?.find(r=>r.event_id===e.id)||src.state.metadata[e.id];if(!proof||stamp(proof.recorded_at)<stamp(plan.created_at))fail("BUY_ACTUAL_TIME_EVIDENCE_REQUIRED");
    const prior=plan.execution_attributions.filter(a=>a.event_id===e.id).at(-1),period=periodAt(plan,proof.occurred_at);if(period.status!=="ACTIVE"&&(!classificationContext&&(!prior||classification!=="OUTSIDE_PLAN")||classification!=="OUTSIDE_PLAN"))fail("BUY_PERIOD_UNCONFIRMED");confirmation(confirmed,input.asOf,Math.max(stamp(proof.recorded_at),stamp(e.updatedAt||e.timestamp)));
    if(prior?.action==="REVOKE")fail("EVENT_ID_REUSED_AFTER_REVOCATION");if(prior?.event_sha256===fp(e)&&prior.metadata_fingerprint===fp(proof)&&prior.classification===classification)return copy(plan);
    const p=copy(plan);let record=seal({record_id:plan.plan_id+":execution:"+(plan.execution_attributions.length+1),revision:plan.revision+1,action:prior?"REVISE":"ASSIGN",recognition_status:"CONFIRMED",plan_id:plan.plan_id,period_id:period.id,event_id:e.id,event_sha256:fp(e),metadata_fingerprint:fp(proof),occurred_at:proof.occurred_at,recorded_at:proof.recorded_at,principal_minor:cash.eventAmountMinor(e)-cash.toMinorUnits(e.fee),fee_minor:cash.toMinorUnits(e.fee),classification,confirmation:copy(confirmed),supersedes:prior?.record_id??null,source_revision:src.snapshot.revision,ledger_revision:src.snapshot.ledger_revision,ledger_sha256:fp(src.events)});
    if(classificationContext){const contract=typeof module==='object'&&module.exports?require('./portfolio-plan-generation-core'):globalThis.HSPortfolioPlanGenerationCore;record=contract.classify(record,{...classificationContext,plan});}
    p.execution_attributions.push(record);return finish(p,src,input,"ATTRIBUTE_BUY",record.record_id);
  }
  function acknowledgeRevocation(plan,input,{eventId,confirmation:confirmed,expectedPlanRevision,classificationContext}={}){
    const src=current(plan,input,expectedPlanRevision),prior=plan.execution_attributions.filter(a=>a.event_id===eventId).at(-1);if(!prior||src.events.some(e=>e.id===eventId))fail("BUY_NOT_REVOKED");confirmation(confirmed,input.asOf,src.now);if(prior.action==="REVOKE")return copy(plan);
    const p=copy(plan),{sha256,classification_contract,...old}=prior;let r=seal({...old,record_id:plan.plan_id+":execution:"+(plan.execution_attributions.length+1),revision:plan.revision+1,action:"REVOKE",recognition_status:"REVOKED",confirmation:copy(confirmed),supersedes:prior.record_id,source_revision:src.snapshot.revision,ledger_revision:src.snapshot.ledger_revision,ledger_sha256:fp(src.events)});
    if(classificationContext){const contract=typeof module==='object'&&module.exports?require('./portfolio-plan-generation-core'):globalThis.HSPortfolioPlanGenerationCore;r=contract.classify(r,{...classificationContext,plan});}
    p.execution_attributions.push(r);return finish(p,src,input,"ACKNOWLEDGE_REVOCATION",r.record_id);
  }
  function reviseDuration(plan,input,{durationMonths,confirmation:confirmed,expectedPlanRevision}={}){
    const src=current(plan,input,expectedPlanRevision);duration(durationMonths);confirmation(confirmed,input.asOf,src.now);if(periodAt(plan,input.asOf).status==="COMPLETED"||src.now>=stamp(anniversary(plan.start_at,durationMonths)))fail("NEW_PLAN_REQUIRED_EXPIRED_DURATION");
    if(durationMonths===plan.duration_months)return copy(plan);const p=copy(plan);p.duration_months=durationMonths;p.configuration_changes.push(seal({revision:plan.revision+1,duration_months:durationMonths,start_at:plan.start_at,at:input.asOf,confirmation:copy(confirmed)}));return finish(p,src,input,"REVISE_FUTURE_DURATION",null);
  }
  function validateAttributions(plan,events,state){validatePlan(plan);if(!Array.isArray(events)||fp(events)!==fp(state.events))fail("ATTRIBUTION_LEDGER_CONFLICT");return progress(plan,{events,state});}
  function rebaseRestoredCandidate(plan,input,confirmationRecord){
    if(!input.prepared_source)fail("RESTORE_CANDIDATE_REQUIRED");validatePlan(plan);const src=source(input);confirmation(confirmationRecord,input.asOf,src.now);
    if(src.now<stamp(plan.updated_at))fail("RESTORE_CLOCK_BEFORE_PLAN");validateAttributions(plan,src.events,src.state);
    return finish(copy(plan),src,input,"RESTORE_SOURCE_REBASE",confirmationRecord.reference);
  }
  // LOCAL_ONLY reference bridge: reuse existing gap/split math without inventing
  // Ledger positions, a confirmed execution quota, or a financial Plan generation.
  function localReference(config,{equity_minor,available_cash_minor}){
    duration(config.duration_months);weights(config);minor(equity_minor);minor(available_cash_minor);
    const total=safe(BigInt(equity_minor)+BigInt(available_cash_minor)),v={equity_minor,available_cash_minor,total_assets_minor:total,fee_reserve_minor:0};
    const result=gap(config,v);return{scope:'LOCAL_ONLY_REFERENCE_V1',...v,...result,forecast_minor:split(result.target_gap_minor,config.duration_months),quota_issued:false,executable_minor:null};
  }
  const localPositionValue=(quantity,unit_price)=>safe((scaled(quantity,8)*scaled(unit_price,6)+500000000000n)/1000000000000n);
  return Object.freeze({SCHEMA,VERSION:1,TIME_ZONE:TZ,UNUSED_RULE:RULE,sealEvidence:seal,anniversary,periodAt,splitMinor:split,localReference,localPositionValue,createPlan,validatePlan,evaluate,issueQuota,attributeBuy,acknowledgeRevocation,reviseDuration,validateAttributions,rebaseRestoredCandidate});
});

;
/* sealed source: portfolio-plan-generation-core.js */
(function(root,factory){
 const node=typeof module==="object"&&module.exports;
 const api=factory(node?require("./portfolio-investable-cash-core"):root.HSPortfolioInvestableCashCore,node?require("./portfolio-ledger-core"):root.HSPortfolioLedgerCore,node?require("./portfolio-transaction-cash-sync-core"):root.HSPortfolioTransactionCashSyncCore);
 if(node)module.exports=api;if(root)root.HSPortfolioPlanGenerationCore=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(cash,ledger,sync){
 "use strict";
 const KEY="hsRadar.portfolio.capitalBuildPlans.v1",GEN_KEY="hsRadar.portfolio.capitalGeneration.v1",CASH_KEY="hsRadar.portfolio.investableCash.v1",SYNC_KEY="hsRadar.portfolio.transactionCashSync.v1",POINTS="hsRadar.portfolio.recoveryPoints.v1";
 const SCHEMA="HS_CAPITAL_PLAN_STORE_V1",GENERATION="HS_CAPITAL_PLAN_GENERATION_V1",CANDIDATE="HS_CAPITAL_PLAN_CANDIDATE_V1",PREPARED="HS_CAPITAL_PREPARED_SOURCE_V1";
 const fp=cash.fingerprint,copy=v=>JSON.parse(JSON.stringify(v)),fail=s=>{throw Error(s);},seal=o=>({...copy(o),sha256:fp(o)}),text=s=>typeof s==="string"&&s.length>0&&s.trim()===s&&s.length<=240;
 const coordinator=()=>typeof module==="object"&&module.exports?require("./portfolio-write-coordinator"):globalThis.HSPortfolioWriteCoordinator;
 const core=()=>typeof module==="object"&&module.exports?require("./portfolio-capital-build-plan-core"):globalThis.HSPortfolioCapitalBuildPlanCore;
 const CLASSIFICATION='HS_PLAN_BUY_CLASSIFICATION_V2';
 const APPROVAL_KEY='hsRadar.portfolio.accelerationConsumption.v1',APPROVAL_POLICY='HS_APPROVAL_CONSUMPTION_V1';
 const hasApproval=e=>e[APPROVAL_KEY]!==undefined||JSON.parse(e[KEY]||'null')?.lifecycle?.some(r=>r.approval_policy===APPROVAL_POLICY);
 function approvals(){const a=typeof module==='object'&&module.exports?require('./portfolio-approval-consumption-core'):globalThis.HSPortfolioApprovalConsumptionCore;if(!a)fail('APPROVAL_VALIDATOR_REQUIRED');return a;}
 const CLASSIFICATION_ONLY='CLASSIFICATION_ONLY_CHANGE',CHANGE_SCHEMA='HS_CLASSIFICATION_ONLY_CHANGE_V1';
 function exactKeys(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||fp(Object.keys(value).sort())!==fp([...keys].sort()))fail('CLASSIFICATION_ONLY_PAYLOAD_REJECTED');}
 // The request contains identifiers/confirmation ONLY, never a Ledger payload.
 function classificationOnlyShape(request){
  exactKeys(request,['schema','operation_id','event_id','expected_event_sha256','expected_classification_revision','expected_generation_id','target_classification','plan_ref','confirmation']);
  exactKeys(request.plan_ref,['plan_id','revision','period_id']);exactKeys(request.confirmation,['kind','reference','confirmed_at']);
  if(request.schema!==CHANGE_SCHEMA||!Number.isSafeInteger(request.plan_ref.revision)||request.plan_ref.revision<1||!Number.isSafeInteger(request.expected_classification_revision)||request.expected_classification_revision<1)fail('CLASSIFICATION_ONLY_VERSION_CONFLICT');
 }
 function classificationOnlyRequest(before,request,{operationId,asOf}){
  classificationOnlyShape(request);
  const store=validateStore(JSON.parse(before[KEY]),before),gen=validateEntries(before),events=JSON.parse(before[ledger.STORAGE_KEY]).events;
  const matches=events.filter(e=>e.id===request.event_id),prior=store.plan.execution_attributions.filter(a=>a.event_id===request.event_id).at(-1);
  if(request.schema!==CHANGE_SCHEMA||!text(operationId)||request.operation_id!==operationId||!text(request.event_id)||matches.length!==1||matches[0].type!=='BUY'||fp(matches[0])!==request.expected_event_sha256)fail('CLASSIFICATION_ONLY_EVENT_CONFLICT');
  if(!prior||prior.action==='REVOKE'||prior.event_sha256!==request.expected_event_sha256||prior.revision!==request.expected_classification_revision||gen.generation_id!==request.expected_generation_id||request.plan_ref.plan_id!==store.plan_id||request.plan_ref.revision!==store.revision||request.plan_ref.period_id!==prior.period_id)fail('CLASSIFICATION_ONLY_VERSION_CONFLICT');
  const type={PLAN_BUY:'IN_PLAN',OUTSIDE_PLAN_BUY:'OUTSIDE_PLAN'}[request.target_classification];
  if(!type||type==='IN_PLAN'&&!eligibility(store.plan,store.lifecycle,prior.occurred_at).eligible)fail('INVALID_PLAN_ATTRIBUTION');
  if(type===prior.classification)fail('CLASSIFICATION_UNCHANGED');
  const conf=request.confirmation;
  if(conf.kind!=='USER_CONFIRMATION'||!text(conf.reference)||conf.confirmed_at!==asOf||!Number.isFinite(Date.parse(asOf))||Date.parse(asOf)<Date.parse(prior.confirmation.confirmed_at))fail('PLAN_USER_CONFIRMATION_REQUIRED');
  return{store,prior,event:matches[0],classification:type};
 }
 function changeAudit(record,prior,request,sourceBindings,reference){
  return seal({schema:CHANGE_SCHEMA,version:1,request:copy(request),previous_record_sha256:prior.sha256,previous_classification:prior.classification,new_classification:record.classification,previous_classification_revision:prior.revision,new_classification_revision:record.revision,unchanged_event_sha256:record.event_sha256,source_bindings:copy(sourceBindings),parent_generation_id:reference.parent_generation_id,
   // A non-circular new-generation reference. The enclosing generation binds
   // this record's hash and validates operation/shared revision/parent together.
   new_generation_reference:copy(reference)});
 }
 function eligibility(plan,lifecycle,occurredAt){
  const period=core().periodAt(plan,occurredAt),row=lifecycle.filter(r=>['PLAN_ACTIVATE','PLAN_PAUSE','PLAN_RESUME','PLAN_COMPLETE'].includes(r.kind)&&Date.parse(r.at)<=Date.parse(occurredAt)).at(-1),quota=plan.quota_records.find(q=>q.period_id===period.id&&Date.parse(q.issued_at)<=Date.parse(occurredAt));
  return{period_status:period.status,period_id:period.id,lifecycle_status:row?.status??'NOT_APPLICABLE',lifecycle_sha256:row?.sha256??null,quota_sha256:quota?.sha256??null,eligible:period.status==='ACTIVE'&&row?.status==='ACTIVE'&&!!quota};
 }
 function classificationContext(plan,lifecycle,{snapshot,operationId,parentGenerationId}){
  return{plan,lifecycle,generation_reference:{operation_id:operationId,shared_revision:snapshot.revision+1,parent_generation_id:parentGenerationId||snapshot.state_sha256}};
 }
 function classify(record,context){
  const {sha256,...body}=record,e=eligibility(context.plan,context.lifecycle,record.occurred_at);
  if(record.action!=='REVOKE'&&record.classification==='IN_PLAN'&&!e.eligible)fail('INVALID_PLAN_ATTRIBUTION');
  const contract=seal({schema:CLASSIFICATION,version:2,record_id:record.record_id,event_id:record.event_id,event_sha256:record.event_sha256,metadata_fingerprint:record.metadata_fingerprint,type:record.classification==='IN_PLAN'?'PLAN_BUY':'OUTSIDE_PLAN_BUY',related_plan_id:record.plan_id,related_plan_revision:record.revision-1,eligibility:e,occurred_at:record.occurred_at,confirmed_at:record.confirmation.confirmed_at,confirmation_source:record.confirmation.reference,generation_reference:copy(context.generation_reference)});
  if(context.classificationOnly){
   const request=context.classificationOnly,prior=context.plan.execution_attributions.filter(a=>a.event_id===record.event_id).at(-1);
   contract.change=changeAudit(record,prior,request,context.sourceBindings,context.generation_reference);
   const{sha256,...b}=contract;return seal({...body,classification_contract:seal(b)});
  }
  return seal({...body,classification_contract:contract});
 }
 function validateClassification(record,plan,lifecycle){
  const v=check(record.classification_contract),ref=v.generation_reference;
  if(v.schema!==CLASSIFICATION||v.version!==2||v.record_id!==record.record_id||v.event_id!==record.event_id||v.event_sha256!==record.event_sha256||v.metadata_fingerprint!==record.metadata_fingerprint||v.type!==(record.classification==='IN_PLAN'?'PLAN_BUY':'OUTSIDE_PLAN_BUY')||v.related_plan_id!==plan.plan_id||v.related_plan_revision!==record.revision-1||v.occurred_at!==record.occurred_at||v.confirmed_at!==record.confirmation.confirmed_at||v.confirmation_source!==record.confirmation.reference||!text(v.confirmation_source)||!Number.isFinite(Date.parse(v.confirmed_at))||Date.parse(v.occurred_at)>Date.parse(v.confirmed_at)||!ref||!text(ref.operation_id)||!text(ref.parent_generation_id)||!Number.isSafeInteger(ref.shared_revision)||ref.shared_revision<1)fail('INVALID_PLAN_CLASSIFICATION');
  if(fp(v.eligibility)!==fp(eligibility(plan,lifecycle,record.occurred_at))||record.classification==='IN_PLAN'&&!v.eligibility.eligible)fail('INVALID_PLAN_ATTRIBUTION');
  if(!/^[a-f0-9]{64}$/.test(ref.parent_generation_id)||ref.shared_revision!==record.source_revision+1||!Number.isSafeInteger(v.related_plan_revision)||v.related_plan_revision<1)fail('CLASSIFICATION_GENERATION_CONFLICT');
  return v;
 }
 function check(o){if(!o||typeof o!=="object"||Array.isArray(o))fail("INVALID_PLAN_ENVELOPE");const{sha256,...body}=o;if(sha256!==fp(body))fail("PLAN_ENVELOPE_SHA_MISMATCH");return o;}
 function memory(entries){const keys=Object.keys(entries);return{get length(){return keys.length;},key:i=>keys[i]??null,getItem:k=>Object.hasOwn(entries,k)?entries[k]:null};}
 function strip(entries){const next=copy(entries);delete next[KEY];delete next[GEN_KEY];delete next[APPROVAL_KEY];return next;}
 function bindings(entries){return{ledger_sha256:fp(entries[ledger.STORAGE_KEY]??null),cash_sha256:fp(entries[CASH_KEY]??null),sync_sha256:fp(entries[SYNC_KEY]??null)};}
 function relevant(entries){return Object.fromEntries(Object.entries(entries).filter(([k])=>k!==GEN_KEY&&k!==POINTS).sort(([a],[b])=>a.localeCompare(b)));}
 function validateStore(value,entries){
  check(value);if(value.schema!==SCHEMA||value.version!==1||!Number.isSafeInteger(value.revision)||value.revision<1||!text(value.last_committed_operation_id)||!["ACTIVE","PAUSED","COMPLETED","EXPIRED","RECONCILIATION_REQUIRED"].includes(value.status)||!Array.isArray(value.lifecycle)||!value.lifecycle.length)fail("INVALID_PLAN_STORE");
  if(!core())fail("PLAN_CORE_UNAVAILABLE");core().validatePlan(value.plan);
  if(value.plan_id!==value.plan.plan_id||value.plan_revision!==value.plan.revision||fp(value.bindings)!==fp(bindings(entries)))fail("PLAN_SOURCE_BINDING_MISMATCH");
  let previous=null,at=-Infinity;for(const row of value.lifecycle){check(row);if(row.previous_sha256!==previous||!text(row.operation_id)||!Number.isFinite(Date.parse(row.at))||Date.parse(row.at)<at)fail("PLAN_LIFECYCLE_CONFLICT");if(row.confirmation!==null&&(row.confirmation?.kind!=="USER_CONFIRMATION"||!text(row.confirmation.reference)||row.confirmation.confirmed_at!==row.at)||row.kind!=="CASH_CHECKPOINT"&&row.confirmation===null)fail("PLAN_CONFIRMATION_RECORD_REQUIRED");previous=row.sha256;at=Date.parse(row.at);}
  if(value.lifecycle.at(-1).operation_id!==value.last_committed_operation_id||value.lifecycle.at(-1).status!==value.status||value.lifecycle[0].kind!=="PLAN_ACTIVATE"||value.lifecycle[0].at!==value.plan.created_at)fail("PLAN_OPERATION_MISMATCH");
  const l=ledger.validateLedger(JSON.parse(entries[ledger.STORAGE_KEY]||"null"));if(!l)fail("PLAN_LEDGER_REQUIRED");
  // Previous plans are immutable historical snapshots, not another Ledger.
  // Until an explicit archived-attribution amendment contract exists, edits to
  // their attributed BUYs require review rather than silently rewriting history.
  const planIds=new Set([value.plan_id]);let archived=value.previous_plan,successor=value;
  while(archived){
   check(archived);core().validatePlan(archived.plan);
   if(archived.schema!==SCHEMA||archived.version!==1||archived.plan_id!==archived.plan.plan_id||archived.plan_revision!==archived.plan.revision||!Number.isSafeInteger(archived.revision)||archived.revision<1||planIds.has(archived.plan_id)||planIds.size>100||archived.status==='RECONCILIATION_REQUIRED'||!['COMPLETED','EXPIRED'].includes(archived.status)&&core().periodAt(archived.plan,successor.plan.created_at).status!=='COMPLETED'||Date.parse(successor.plan.created_at)<Date.parse(archived.plan.updated_at))fail('INVALID_ARCHIVED_PLAN');
   if(!Array.isArray(archived.lifecycle)||!archived.lifecycle.length||archived.lifecycle[0].kind!=='PLAN_ACTIVATE'||archived.lifecycle[0].at!==archived.plan.created_at||archived.lifecycle.at(-1).status!==archived.status||archived.lifecycle.at(-1).operation_id!==archived.last_committed_operation_id)fail('INVALID_ARCHIVED_LIFECYCLE');
   let lastHash=null,lastTime=-Infinity;for(const row of archived.lifecycle){check(row);if(row.previous_sha256!==lastHash||!text(row.operation_id)||!Number.isFinite(Date.parse(row.at))||Date.parse(row.at)<lastTime||row.confirmation!==null&&(row.confirmation?.kind!=='USER_CONFIRMATION'||!text(row.confirmation.reference)||row.confirmation.confirmed_at!==row.at)||row.kind!=='CASH_CHECKPOINT'&&row.confirmation===null)fail('INVALID_ARCHIVED_LIFECYCLE');lastHash=row.sha256;lastTime=Date.parse(row.at);}
   planIds.add(archived.plan_id);
   const latestArchived=new Map(archived.plan.execution_attributions.map(a=>[a.event_id,a]));
   for(const a of latestArchived.values())if(a.action!=='REVOKE'&&fp(l.events.find(e=>e.id===a.event_id)??null)!==a.event_sha256)fail('ARCHIVED_BUY_REVIEW_REQUIRED');
   validateClassificationHistory(archived);
   successor=archived;archived=archived.previous_plan;
  }
  const s=JSON.parse(entries[SYNC_KEY]||"null");if(!s)fail("PLAN_CASH_REQUIRED");
  core().validateAttributions(value.plan,l.events,s.state);
  const latest=new Map(value.plan.execution_attributions.map(a=>[a.event_id,a]));
  for(const a of latest.values())if(a.action!=="REVOKE"&&a.classification==="IN_PLAN"&&value.lifecycle.filter(r=>Date.parse(r.at)<=Date.parse(a.occurred_at)).at(-1)?.status!=="ACTIVE")fail("BUY_OUTSIDE_ACTIVE_LIFECYCLE");
  validateClassificationHistory(value);return value;
 }
 function validateClassificationHistory(value){
  // Append-only lifecycle commitments make a missing classification detectable
  // after reload/backup; a bare optional metadata array would not do so.
  const required=new Map();
  for(const row of value.lifecycle){
   if(row.classification_records!==undefined&&!Array.isArray(row.classification_records))fail('INVALID_CLASSIFICATION_COMMITMENT');
   for(const pin of row.classification_records||[]){
    if(!text(pin.record_id)||required.has(pin.record_id))fail('DUPLICATE_CLASSIFICATION_COMMITMENT');
    required.set(pin.record_id,{pin,row});
   }
  }
  for(const a of value.plan.execution_attributions){
   if(a.classification_contract===undefined){if(required.has(a.record_id))fail('CLASSIFICATION_METADATA_REQUIRED');continue;}
   const v=validateClassification(a,value.plan,value.lifecycle),bound=required.get(a.record_id);
   if(!bound||bound.row.classification_policy!==CLASSIFICATION||bound.pin.sha256!==a.sha256||bound.row.operation_id!==v.generation_reference.operation_id||bound.row.at!==v.confirmed_at||fp(bound.row.classification_generation)!==fp(v.generation_reference))fail('CLASSIFICATION_METADATA_REQUIRED');
   if(bound.row.kind===CLASSIFICATION_ONLY||v.change!==undefined){
    const index=value.plan.execution_attributions.indexOf(a),prior=value.plan.execution_attributions.slice(0,index).filter(r=>r.event_id===a.event_id).at(-1),change=check(v.change),request=change.request;
    classificationOnlyShape(request);
    exactKeys(change.source_bindings,['ledger_sha256','cash_sha256','sync_sha256']);
    if(Object.values(change.source_bindings).some(h=>typeof h!=='string'||!/^[a-f0-9]{64}$/.test(h))||prior?.classification===a.classification||request.plan_ref.revision!==value.revision-value.lifecycle.length+value.lifecycle.indexOf(bound.row))fail('CLASSIFICATION_ONLY_AUDIT_CONFLICT');
    if(bound.row.kind!==CLASSIFICATION_ONLY||!prior||prior.action==='REVOKE'||a.action!=='REVISE'||a.supersedes!==prior.record_id||a.event_sha256!==prior.event_sha256||a.metadata_fingerprint!==prior.metadata_fingerprint||fp(change)!==fp(changeAudit(a,prior,request,change.source_bindings,v.generation_reference))||request.operation_id!==bound.row.operation_id||request.expected_generation_id!==v.generation_reference.parent_generation_id||request.expected_event_sha256!==a.event_sha256||request.expected_classification_revision!==prior.revision||request.event_id!==a.event_id||request.plan_ref.plan_id!==value.plan_id||request.plan_ref.period_id!==a.period_id||request.target_classification!==v.type||fp(request.confirmation)!==fp(a.confirmation))fail('CLASSIFICATION_ONLY_AUDIT_CONFLICT');
   }
   required.delete(a.record_id);
  }
  if(required.size)fail('CLASSIFICATION_METADATA_REQUIRED');
  for(const row of value.lifecycle)if(row.kind===CLASSIFICATION_ONLY&&(row.classification_policy!==CLASSIFICATION||row.classification_records?.length!==1))fail('CLASSIFICATION_ONLY_AUDIT_REQUIRED');
  return value;
 }
 function participants(entries){
  const p=JSON.parse(entries[KEY]||"null"),s=JSON.parse(entries[SYNC_KEY]||"null");
  return{...bindings(entries),cash_state_sha256:fp({baseline:entries[CASH_KEY]??null,sync:entries[SYNC_KEY]??null}),plan_revision:p?.revision??0,plan_sha256:fp(entries[KEY]??null),transaction_metadata_revision:s?.revision??0,transaction_metadata_sha256:fp(s?{metadata:s.state.metadata,receipts:s.state.dividendReceipts,coverage:s.state.coverageReviews||[]}:null),attribution_metadata_revision:p?.plan.revision??0,attribution_metadata_sha256:fp(p?.plan.execution_attributions??[]),period_snapshot_sha256:fp(p?.plan.quota_records??[]),...(hasApproval(entries)?{approval_policy:APPROVAL_POLICY,approval_sha256:fp(entries[APPROVAL_KEY]??null)}:{})};
 }
 function validateEntries(entries){
  if(entries[KEY]===undefined&&entries[GEN_KEY]===undefined){if(entries[APPROVAL_KEY]!==undefined)fail('APPROVAL_ORPHAN_STORE');return null;}
  if(entries[KEY]===undefined||entries[GEN_KEY]===undefined)fail("PLAN_GENERATION_REQUIRED");
  const p=validateStore(JSON.parse(entries[KEY]),entries),g=check(JSON.parse(entries[GEN_KEY]));
  if(g.kind!==p.lifecycle.at(-1).kind)fail('PLAN_OPERATION_KIND_CONFLICT');
  if(g.schema!==GENERATION||g.version!==1||g.required_journal_state!=="COMMITTED"||!text(g.operation_id)||g.operation_id!==p.last_committed_operation_id||!Number.isSafeInteger(g.shared_revision)||g.shared_revision<1||![g.cash_revision,g.ledger_revision].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=g.shared_revision)||!text(g.parent_generation_id)||fp(g.participants)!==fp(participants(entries))||g.data_sha256!==fp(relevant(entries)))fail("PLAN_GENERATION_MISMATCH");
  const{generation_id,sha256,...body}=g;if(generation_id!==fp(body))fail("GENERATION_ID_MISMATCH");if(hasApproval(entries))approvals().validateState(entries,p);return g;
 }
 function validateCommitted(entries,{meta,journal}={}){
  if(entries?.schema===CANDIDATE||entries?.state==="CANDIDATE")fail("CANDIDATE_IS_NOT_COMMITTED");
  const g=validateEntries(entries);if(!g)return null;
  if(!meta||!journal||journal.status!=="COMMITTED"||meta.revision<g.shared_revision||meta.component_revisions.ledger!==g.ledger_revision||!meta.receipts.some(r=>r.revision===g.shared_revision&&r.operation_id===g.operation_id))fail("PLAN_NOT_COMMITTED");
  coordinator().validateMeta(meta,entries);coordinator().validateJournal(journal);
  if(fp(journal.after)!==fp(entries)||fp(JSON.parse(journal.after_meta_raw))!==fp(meta))fail("PLAN_COMMITTED_PROOF_MISMATCH");
  if(hasApproval(entries))approvals().validatePublication(entries,meta);
  return{...g,state:"COMMITTED",journal_state:journal.status};
 }
 function validateTransition(before,after,{operationId,expected,kind}={}){
  const old=before[KEY]?JSON.parse(before[KEY]):null;
  if(old&&after[KEY]===undefined)fail("PLAN_REMOVAL_REQUIRES_EXPLICIT_UI_CONTRACT");
  const g=validateEntries(after);if(!g)return;
  if(hasApproval(before)||hasApproval(after))approvals().validateTransition(before,after,{operationId,expected,kind});
  if(before[KEY]===after[KEY]&&before[GEN_KEY]===after[GEN_KEY]){if(fp(relevant(before))!==fp(relevant(after)))fail("PLAN_ADAPTER_REQUIRED");return;}
  const prior=before[GEN_KEY]?validateEntries(before):null;
  if(g.operation_id!==operationId||g.shared_revision!==expected.revision+1||g.parent_generation_id!==(prior?.generation_id||expected.state_sha256)||g.kind!==kind)fail("PLAN_PARENT_GENERATION_CONFLICT");
  if(g.ledger_revision!==expected.ledger_revision+(bindings(before).ledger_sha256!==bindings(after).ledger_sha256?1:0)||g.cash_revision!==(prior?.cash_revision||0)+(participants(before).cash_state_sha256!==participants(after).cash_state_sha256?1:0))fail("PLAN_COMPONENT_REVISION_CONFLICT");
  const next=JSON.parse(after[KEY]);if(old&&next.revision!==old.revision+1)fail("PLAN_REVISION_CONFLICT");
  if(kind===CLASSIFICATION_ONLY)validateClassificationOnlyTransition(before,after,{operationId,expected,old,next});
  const addedClassifications=next.plan.execution_attributions.slice(kind==='PLAN_ACTIVATE'?0:old?.plan.execution_attributions.length||0);
  if(kind==='TRANSACTION'&&next.lifecycle.at(-1).classification_policy===CLASSIFICATION&&addedClassifications.some(a=>!a.classification_contract))fail('CLASSIFICATION_METADATA_REQUIRED');
  const restoreProof=next.lifecycle.at(-1)?.classification_restore_proof;
  let restoredRecords=null;
  if(kind==='PLAN_RESTORE'&&next.plan.execution_attributions.some(a=>a.classification_contract)){
   // Historical records must retain their ORIGINAL generation, not be rebound
   // to the restore operation. Verify its complete original COMMITTED receipt,
   // and byte-equivalent attribution history, rather than exempting restoration.
   if(!restoreProof?.journal||!restoreProof.meta)fail('CLASSIFICATION_RESTORE_PROOF_REQUIRED');
   validateCommitted(restoreProof.journal.after,restoreProof);
   const original=JSON.parse(restoreProof.journal.after[KEY]);
   if(original.plan_id!==next.plan_id||fp(original.plan.execution_attributions)!==fp(next.plan.execution_attributions))fail('CLASSIFICATION_RESTORE_HISTORY_CONFLICT');
   restoredRecords=new Map(original.plan.execution_attributions.map(a=>[a.record_id,a]));
  }
  for(const a of addedClassifications)if(a.classification_contract){
   const ref=a.classification_contract.generation_reference;
   if(restoredRecords){if(fp(restoredRecords.get(a.record_id))!==fp(a))fail('CLASSIFICATION_RESTORE_HISTORY_CONFLICT');}
   else if(ref.operation_id!==operationId||ref.shared_revision!==expected.revision+1||ref.parent_generation_id!==(prior?.generation_id||expected.state_sha256))fail('CLASSIFICATION_GENERATION_CONFLICT');
  }
  if(!old&&next.previous_plan!==undefined&&kind!=='PLAN_RESTORE')fail('UNEXPECTED_ARCHIVED_PLAN');
  if(old&&kind==='PLAN_ACTIVATE'){
   if(next.plan_id===old.plan_id||fp(next.previous_plan)!==fp(old)||!['COMPLETED','EXPIRED'].includes(old.status)&&core().periodAt(old.plan,next.plan.created_at).status!=='COMPLETED')fail('PREVIOUS_PLAN_NOT_TERMINAL');
  }else if(old&&kind!=="PLAN_RESTORE"){
   if(fp(next.previous_plan??null)!==fp(old.previous_plan??null))fail('ARCHIVED_PLAN_REWRITE');
   if(next.plan_id!==old.plan_id||next.plan.start_at!==old.plan.start_at||fp(next.plan.quota_records.slice(0,old.plan.quota_records.length))!==fp(old.plan.quota_records)||fp(next.plan.execution_attributions.slice(0,old.plan.execution_attributions.length))!==fp(old.plan.execution_attributions))fail("PLAN_HISTORY_REWRITE");
   if(fp(next.lifecycle.slice(0,old.lifecycle.length))!==fp(old.lifecycle)||next.lifecycle.length!==old.lifecycle.length+1||fp(next.plan.configuration_changes.slice(0,old.plan.configuration_changes.length))!==fp(old.plan.configuration_changes)||fp(next.plan.audit.slice(0,old.plan.audit.length))!==fp(old.plan.audit))fail("PLAN_AUDIT_REWRITE");
   for(const field of ["normal_equity_target_bps","maximum_equity_limit_bps","etf_target_weights","allocation_tolerance_reference","ledger_at_creation","confirmation"])if(fp(next.plan[field])!==fp(old.plan[field]))fail("PLAN_CONFIGURATION_REWRITE");
   if(["COMPLETED","EXPIRED"].includes(old.status)&&next.status==="ACTIVE")fail("PLAN_CANNOT_RESTART");
   // Old V1 COMMITTED receipts are read under their original contract. New
   // candidates below REQUIRE V2; they cannot opt out by deleting metadata.
   if(kind==='TRANSACTION'&&next.lifecycle.at(-1).classification_policy===CLASSIFICATION){
    const oldEvents=new Map(JSON.parse(before[ledger.STORAGE_KEY]).events.map(e=>[e.id,e]));
    const records=new Map(next.plan.execution_attributions.map(a=>[a.event_id,a]));
    const state=JSON.parse(after[SYNC_KEY]).state;
    for(const event of JSON.parse(after[ledger.STORAGE_KEY]).events){
     if(event.type!=='BUY'||next.plan.ledger_at_creation.event_pins.some(p=>p.event_id===event.id)||fp(oldEvents.get(event.id)??null)===fp(event))continue;
     const a=records.get(event.id),proof=state.coverageReviews?.find(r=>r.event_id===event.id)||state.metadata[event.id];
     if(!a?.classification_contract||a.action==='REVOKE'||a.event_sha256!==fp(event)||a.metadata_fingerprint!==fp(proof))fail('CLASSIFICATION_METADATA_REQUIRED');
    }
   }
  }
 }
 function validateClassificationOnlyTransition(before,after,{operationId,expected,old,next}){
  if(!old)fail('PLAN_REQUIRED');
  const other=entries=>Object.fromEntries(Object.entries(entries).filter(([k])=>k!==KEY&&k!==GEN_KEY));
  if(fp(other(before))!==fp(other(after)))fail('CLASSIFICATION_ONLY_FINANCIAL_BYTES_CHANGED');
  const added=next.plan.execution_attributions.slice(old.plan.execution_attributions.length);
  if(added.length!==1||next.status!==old.status)fail('CLASSIFICATION_ONLY_AUDIT_REQUIRED');
  const a=added[0],v=a.classification_contract,change=v?.change;
  if(!change)fail('CLASSIFICATION_ONLY_AUDIT_REQUIRED');
  const {prior,event,classification}=classificationOnlyRequest(before,change.request,{operationId,asOf:next.lifecycle.at(-1).at});
  if(fp(change.source_bindings)!==fp(bindings(before))||a.classification!==classification||a.event_sha256!==fp(event)||a.metadata_fingerprint!==prior.metadata_fingerprint)fail('CLASSIFICATION_ONLY_SOURCE_CONFLICT');
  const period=core().periodAt(old.plan,next.lifecycle.at(-1).at),p=copy(old.plan),at=next.lifecycle.at(-1).at;
  const expectedRecord=seal({...Object.fromEntries(Object.entries(prior).filter(([k])=>!['sha256','classification_contract'].includes(k))),record_id:p.plan_id+':execution:'+(p.execution_attributions.length+1),revision:p.revision+1,action:'REVISE',classification,confirmation:copy(change.request.confirmation),supersedes:prior.record_id,source_revision:expected.revision,ledger_revision:expected.ledger_revision,ledger_sha256:fp(JSON.parse(before[ledger.STORAGE_KEY]).events)});
  const rebuilt=classify(expectedRecord,{plan:p,lifecycle:old.lifecycle,generation_reference:v.generation_reference,classificationOnly:change.request,sourceBindings:bindings(before)});
  if(fp(a)!==fp(rebuilt))fail('CLASSIFICATION_ONLY_RECORD_CONFLICT');
  p.execution_attributions.push(rebuilt);p.revision++;p.updated_at=at;p.current_period=period.index;p.status=period.status;p.source_watermark=copy(expected);
  p.audit.push(seal({revision:p.revision,action:'ATTRIBUTE_BUY',record_id:a.record_id,at,previous_plan_sha256:p.sha256,previous_audit_sha256:p.audit.at(-1).sha256,source_revision:expected.revision,source_sha256:expected.state_sha256}));
  delete p.sha256;if(fp(seal(p))!==fp(next.plan))fail('CLASSIFICATION_ONLY_PLAN_REWRITE');
 }
 function validatePreparedSource(input){
  const p=input.prepared_source;if(p?.schema!==PREPARED||p.state!=="CANDIDATE"||!text(p.operation_id)||p.entries_sha256!==fp(input.entries))fail("INVALID_PREPARED_PLAN_SOURCE");
  const c=coordinator();if(!c)fail("COORDINATOR_UNAVAILABLE");
  const snap=c.capture(memory(p.before_entries),{asOf:input.asOf});if(snap.revision!==input.expected_revision||snap.state_sha256!==input.expected_state_sha256)fail("CANDIDATE_PARENT_CONFLICT");
  if(input.entries[KEY]!==undefined||input.entries[GEN_KEY]!==undefined||Object.keys(input.entries).some(k=>!c.isDataKey(k)))fail("CANDIDATE_SOURCE_IS_NOT_PRIVATE_PHASE2_DATA");
  c.validateEntries(input.entries,input.asOf);return snap;
 }
 function preparedInput(beforeFull,after,input,operationId){
  const snap=coordinator().capture(memory(beforeFull),{asOf:input.asOf}),entries=strip(after);
  return{...input,entries,expected_revision:snap.revision,expected_state_sha256:snap.state_sha256,prepared_source:{schema:PREPARED,state:"CANDIDATE",operation_id:operationId,before_entries:copy(beforeFull),entries_sha256:fp(entries)}};
 }
 function assemble(before,after,{snapshot,operationId,kind,asOf,plan,status,previousStore=null,confirmationRecord=null,classificationRestoreProof}){
  if(before[APPROVAL_KEY]!==undefined&&after[APPROVAL_KEY]===undefined)after={...after,[APPROVAL_KEY]:before[APPROVAL_KEY]};
  const replacing=kind==='PLAN_ACTIVATE'&&previousStore!==null;
  const lifecycle=[...(!replacing&&previousStore?.lifecycle||[])],added=plan.execution_attributions.slice(replacing?0:previousStore?.plan.execution_attributions.length||0).filter(a=>a.classification_contract);
  const pins=added.map(a=>({record_id:a.record_id,sha256:a.sha256}));
  const approval=after[APPROVAL_KEY]?JSON.parse(after[APPROVAL_KEY]):null,receipt=approval?.records.at(-1),approvalFields=approval?{approval_policy:APPROVAL_POLICY,...(receipt.operation_id===operationId?{approval_records:[{sha256:receipt.sha256}],approval_generation:copy(receipt.reference)}:{})}:{};
  lifecycle.push(seal({operation_id:operationId,kind,status,at:asOf,confirmation:confirmationRecord,previous_sha256:lifecycle.at(-1)?.sha256??null,...(['TRANSACTION',CLASSIFICATION_ONLY].includes(kind)?{classification_policy:CLASSIFICATION}:{}),...(pins.length?{classification_records:pins,classification_generation:copy(added[0].classification_contract.generation_reference)}:{}),...(classificationRestoreProof?{classification_restore_proof:copy(classificationRestoreProof)}:{}),...approvalFields}));
  const historical=replacing?previousStore:previousStore?.previous_plan;
  const store=seal({schema:SCHEMA,version:1,revision:(previousStore?.revision||0)+1,plan_id:plan.plan_id,plan_revision:plan.revision,status,plan:copy(plan),bindings:bindings(after),lifecycle,last_committed_operation_id:operationId,...(historical?{previous_plan:copy(historical)}:{})});
  const next={...after,[KEY]:JSON.stringify(store)};delete next[GEN_KEY];
  const prev=before[GEN_KEY]?JSON.parse(before[GEN_KEY]):null;
  const nextParts=participants(next),body={schema:GENERATION,version:1,required_journal_state:"COMMITTED",operation_id:operationId,kind,shared_revision:snapshot.revision+1,parent_generation_id:prev?.generation_id||snapshot.state_sha256,ledger_revision:snapshot.ledger_revision+(bindings(before).ledger_sha256!==bindings(next).ledger_sha256?1:0),cash_revision:(prev?.cash_revision||0)+(participants(before).cash_state_sha256!==nextParts.cash_state_sha256?1:0),participants:nextParts,data_sha256:fp(relevant(next)),prepared_at:asOf};
  next[GEN_KEY]=JSON.stringify(seal({...body,generation_id:fp(body)}));validateEntries(next);return next;
 }
 function candidate({beforeFull,after,expected,operationId,kind,asOf,validUntil}){
  if(kind==='TRANSACTION'&&JSON.parse(after[KEY]).lifecycle.at(-1).classification_policy!==CLASSIFICATION)fail('CLASSIFICATION_METADATA_REQUIRED');
  const c=coordinator(),snap=c.capture(memory(beforeFull),{asOf});if(fp(snap)!==fp(expected))fail("STALE_PLAN_PREVIEW");c.validateEntries(after,asOf);validateTransition(c.collect(memory(beforeFull)),after,{operationId,kind,expected});
  const plan=JSON.parse(after[KEY]).plan,period=core().periodAt(plan,asOf),limit=Math.min(Date.parse(asOf)+60000,period.end?Date.parse(period.end)-1:Infinity),deadline=validUntil??new Date(limit).toISOString();
  if(!Number.isFinite(Date.parse(deadline))||Date.parse(deadline)<Date.parse(asOf)||Date.parse(deadline)>limit)fail("CANDIDATE_VALIDITY_WINDOW_CONFLICT");
  return seal({schema:CANDIDATE,state:"CANDIDATE",operationId,kind,asOf,validUntil:deadline,expected:copy(expected),before_sha256:fp(beforeFull),before_full:copy(beforeFull),after:copy(after)});
 }
 function validateCandidate(value){check(value);if(value.schema!==CANDIDATE||value.state!=="CANDIDATE")fail("NOT_A_PLAN_CANDIDATE");const rebuilt=candidate({beforeFull:value.before_full,after:value.after,...value});if(fp(rebuilt)!==fp(value))fail("CANDIDATE_VERSION_CONFLICT");return value;}
 return Object.freeze({KEY,GEN_KEY,SCHEMA,GENERATION,CANDIDATE,PREPARED,CLASSIFICATION,CLASSIFICATION_ONLY,CHANGE_SCHEMA,classificationOnlyRequest,eligibility,classificationContext,classify,fp,seal,memory,strip,bindings,participants,validateStore,validateEntries,validateCommitted,validateTransition,validatePreparedSource,preparedInput,assemble,candidate,validateCandidate});
});

;
/* sealed source: portfolio-c4-smart-acceleration-core.js */
(function(root,factory){
 const node=typeof module==='object'&&module.exports,api=factory(...(node?[require('./portfolio-capital-build-storage-adapter'),require('./portfolio-plan-generation-core'),require('./portfolio-write-coordinator'),require('./portfolio-ledger-core'),require('./canonical-score-resolver')]:[root.HSPortfolioCapitalBuildStorageAdapter,root.HSPortfolioPlanGenerationCore,root.HSPortfolioWriteCoordinator,root.HSPortfolioLedgerCore,root.HSCanonicalScoreResolver]));
 if(node)module.exports=api;if(root)root.HSPortfolioC4SmartAccelerationCore=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(adapter,g,c,ledger,resolver){
 'use strict';
 // Pure, read-only ceilings; neither SHA nor a fixture is authentication.
 // Trust pins MUST be supplied by a future independently verified reader.
 const VERSION='HS_C4_ACCELERATION_BALANCED_B_V1',MODEL='FINAL_CORE_WEIGHT_V1',SCHEMA='HS_C4_CAPITAL_SAFETY_INPUT_V1';
 const ELIGIBLE=Object.freeze(['0050','00662','00830','00935','009815']);
 const BANDS=Object.freeze([[0,10000],[30,10000],[40,10000],[45,12000],[50,15000],[65,17500],[70,20000],[80,25000],[90,30000]].map(([from,multiplier_bps])=>Object.freeze({from,multiplier_bps})));
 const NORMAL='NORMAL_BUILD',OPPORTUNITY='OPPORTUNITY_ACCELERATION',MAX=BigInt(Number.MAX_SAFE_INTEGER),copy=x=>JSON.parse(JSON.stringify(x)),fail=s=>{throw Error(s);},fp=g.fp;
 function minor(n){if(!Number.isSafeInteger(n)||n<0||Object.is(n,-0))fail('INVALID_MINOR_UNITS');return n;}
 function safe(n){if(n<0n||n>MAX)fail('MINOR_OVERFLOW');return Number(n);}
 const sum=a=>safe(a.reduce((s,n)=>s+BigInt(minor(n)),0n));
 function time(s){if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(s)||!Number.isFinite(Date.parse(s))||new Date(s.slice(0,10)+'T00:00:00Z').toISOString().slice(0,10)!==s.slice(0,10)||+s.slice(11,13)>23||+s.slice(14,16)>59||+s.slice(17,19)>59||/[+-]14:(?!00$)/.test(s))fail('OFFSET_TIME_REQUIRED');return Date.parse(s);}
 function scaled(v,d){if(!['number','string'].includes(typeof v)||!new RegExp('^\\d+(?:\\.\\d{1,'+d+'})?$').test(String(v)))fail('INVALID_QUOTE_DECIMAL');const[a,b='']=String(v).split('.');return BigInt(a)*10n**BigInt(d)+BigInt(b.padEnd(d,'0')||'0');}
 function multiplier(score){if(typeof score!=='number'||!Number.isFinite(score)||score<0||score>100)fail('INVALID_C4_SCORE');return BANDS.filter(b=>score>=b.from).at(-1).multiplier_bps/10000;}
 function seal(body){return{...copy(body),sha256:fp(body)};}
 function checked(record,pin,schema,ctx,now){
  if(!record||typeof pin!=='string'||pin.length!==64)fail('EXTERNAL_PIN_REQUIRED');const{sha256,...body}=record;
  if(sha256!==fp(body)||sha256!==pin||record.schema!==schema)fail('RECORD_HASH_OR_SCHEMA_CONFLICT');
  if(time(record.as_of)>now||time(record.valid_until)<now||time(record.valid_until)<time(record.as_of))fail('STALE_OR_FUTURE_EVIDENCE');
  if(ctx&&['generation_id','plan_id','plan_revision','period_id','settings_sha256'].some(k=>record[k]!==ctx[k]))fail('REVISION_OR_SCOPE_CONFLICT');return record;
 }
 const settings=plan=>({normal_equity_target_bps:plan.normal_equity_target_bps,maximum_equity_limit_bps:plan.maximum_equity_limit_bps,etf_target_weights:plan.etf_target_weights,allocation_tolerance_reference:plan.allocation_tolerance_reference});
 function context(view){return{generation_id:view.generation.generation_id,plan_id:view.store.plan_id,plan_revision:view.store.revision,period_id:view.period_id,settings_sha256:fp(settings(view.store.plan))};}
 // Existing canonical normalization/selection ONLY: no factor recomputation.
 function c4(symbol,bundle,pin,now){
  try{
   const r=checked(bundle,pin,'HS_VERIFIED_C4_RECEIPT_V1',null,now);
   if(r.symbol!==symbol||r.source_type!=='HS_FORMAL_C4'||r.source_version!==MODEL||r.freshness!=='CURRENT'||r.evidence_status!=='VERIFIED'||r.snapshot_sha256!==fp(r.snapshot)||!/^\d{4}-\d{2}-\d{2}$/.test(r.expected_trading_date)||r.expected_trading_date>new Date(now+28800000).toISOString().slice(0,10))fail('C4_SOURCE_OR_SYMBOL_CONFLICT');
   const day=new Date(now+28800000).toISOString().slice(0,10),calendar=r.calendar;
   if(!calendar||calendar.target_date!==day||!['TRADING_DAY','HOLIDAY'].includes(calendar.trading_day_status)||!/^\d{4}-\d{2}-\d{2}$/.test(calendar.latest_completed_session)||calendar.latest_completed_session>day)fail('C4_VERIFIED_CALENDAR_REQUIRED');
   let selected,calculated;
   if(r.kind==='FINALIZED'){
    if(r.snapshot.rows?.filter(e=>e.symbol===symbol).length!==1)fail('C4_ROW_IDENTITY_CONFLICT');const row=r.snapshot.rows.find(e=>e.symbol===symbol);multiplier(row?.final_core_score);
    if(r.snapshot.date!==r.expected_trading_date||r.expected_trading_date!==calendar.latest_completed_session||time(r.snapshot.finalized_at)>now)fail('C4_DATE_OR_CALCULATION_CONFLICT');
    const normalized=resolver.normalizeFinalizedSnapshot(r.snapshot,{scoreVersion:MODEL,symbols:[symbol],targetDate:r.expected_trading_date}),n=normalized?.items?.[symbol];
    const v=resolver.buildDualTrackView({finalizedArtifact:{schema_version:1,core_score_version:MODEL,snapshots:[r.snapshot]},intradaySnapshots:[],targetDate:day,scoreVersion:MODEL,symbols:[symbol],now:new Date(now),tradingDayStatus:calendar.trading_day_status,maxAgeMinutes:10});
    selected=resolver.selectFormalCoreScore(v,symbol);calculated=n?.calculated_at;
   }else if(r.kind==='LIVE'){
    const row=r.snapshot.items?.[symbol];multiplier(row?.score);
    if(r.snapshot.trading_date!==r.expected_trading_date||r.expected_trading_date!==day||time(row.market_as_of)>now||now-time(row.market_as_of)>600000||time(r.valid_until)>time(row.market_as_of)+600000)fail('C4_LIVE_FRESHNESS');
    const n=resolver.normalizeIntradaySnapshot(r.snapshot,{scoreVersion:MODEL,symbols:[symbol],targetDate:r.expected_trading_date})?.items?.[symbol];
    const v=resolver.buildDualTrackView({finalizedArtifact:null,intradaySnapshots:[r.snapshot],targetDate:day,scoreVersion:MODEL,symbols:[symbol],now:new Date(now),tradingDayStatus:calendar.trading_day_status,maxAgeMinutes:10});
    selected=resolver.selectFormalCoreScore(v,symbol);calculated=n?.calculated_at||row.market_as_of;
   }else fail('C4_SOURCE_KIND');
   if(!selected.available||selected.source!==r.kind||selected.trading_date!==r.expected_trading_date||time(selected.market_as_of)>now||time(calculated)>now)fail(selected.reason||'C4_UNAVAILABLE');
   return{status:'VERIFIED',score:selected.score,multiplier:multiplier(selected.score),source:r.kind,source_version:MODEL,trading_date:selected.trading_date,calculated_at:calculated,source_fingerprint:r.snapshot_sha256,receipt_sha256:r.sha256,reasons:[]};
  }catch(e){return{status:'UNAVAILABLE',score:null,multiplier:null,reasons:[e.message]};}
 }
 // Deterministic capped proportional allocation; largest remainder, symbol tie.
 function allocate(total,requests,caps){
  const codes=Object.keys(requests).sort(),a=Object.fromEntries(codes.map(k=>[k,0]));let left=minor(total);
  for(let round=0;left&&round<32;round++){
   const active=codes.filter(k=>a[k]<Math.min(requests[k],caps[k])),weight=active.reduce((s,k)=>s+BigInt(requests[k]-a[k]),0n);if(!weight)break;
   const start=left,fractions=[];for(const k of active){const n=BigInt(start)*BigInt(requests[k]-a[k]),q=Math.min(safe(n/weight),requests[k]-a[k],caps[k]-a[k]);a[k]+=q;left-=q;fractions.push({k,r:n%weight});}
   fractions.sort((a,b)=>a.r===b.r?a.k.localeCompare(b.k):a.r>b.r?-1:1);
   for(const{k}of fractions)if(left&&a[k]<Math.min(requests[k],caps[k])){a[k]++;left--;}
   if(left===start)break;
  }return a;
 }
 function apportion(total,weights){
  if(sum(Object.values(weights))!==1000)fail('ETF_WEIGHTS_MUST_TOTAL_100');
  const rows=Object.keys(weights).sort().map(symbol=>{const value=BigInt(total)*BigInt(weights[symbol]);return{symbol,minor:safe(value/1000n),remainder:value%1000n};});let left=total-sum(rows.map(r=>r.minor));
  rows.sort((a,b)=>a.remainder===b.remainder?a.symbol.localeCompare(b.symbol):a.remainder>b.remainder?-1:1);for(const r of rows)if(left){r.minor++;left--;}
  return Object.fromEntries(rows.map(r=>[r.symbol,r.minor]));
 }
 function calculate(input){
  const blocked=reason=>({schema:'HS_C4_CAPITAL_SAFETY_RESULT_V1',strategy_version:VERSION,status:'RECONCILIATION_REQUIRED',mode:NORMAL,final_budget_ceiling_minor:0,reasons:[reason],production_activation:'BLOCKED',creates_approval:false});
  try{
   if(input?.schema!==SCHEMA||input.strategy_version!==VERSION)fail('STRATEGY_VERSION_CONFLICT');const now=time(input.asOf),p=input.portfolio,trust=input.trust||{};
   if(!p||fp(p.source)!==trust.source_sha256||p.source?.asOf!==undefined)fail('SOURCE_PIN_OR_TIME_CONFLICT');
   const memory=g.memory(copy(p.entries)),snapshot=c.capture(memory,{asOf:input.asOf});if(fp(snapshot)!==fp(p.expected))fail('PORTFOLIO_REVISION_CONFLICT');
   const generation=g.validateCommitted(c.collect(memory),{meta:JSON.parse(p.entries[c.META_KEY]),journal:JSON.parse(p.entries[c.JOURNAL_KEY])});if(!generation||generation.generation_id!==trust.generation_id)fail('COMMITTED_GENERATION_REQUIRED');
   const view=adapter.service(memory,{clock:()=>input.asOf}).read({asOf:input.asOf,source:copy(p.source)});
   if(!view.committed||!view.store||view.status==='RECONCILIATION_REQUIRED')fail((view.reasons||['PLAN_OR_CASH_UNAVAILABLE']).join('|'));
   const ctx=context(view),plan=view.store.plan;if(trust.plan_sha256!==plan.sha256||trust.settings_sha256!==ctx.settings_sha256||trust.period_sha256!==(plan.quota_records.find(q=>q.period_id===view.period_id)?.sha256??null))fail('PLAN_SETTINGS_OR_PERIOD_CONFLICT');
   const active=view.store.status==='ACTIVE'&&view.status==='READY'&&view.remaining_periods>0,base=active?minor(view.unused_minor):0,E=BigInt(view.equity_minor),T=BigInt(view.total_assets_minor),normal=plan.normal_equity_target_bps,maximum=plan.maximum_equity_limit_bps;
   const global=checked(input.budget?.global,trust.global_sha256,'HS_SHARED_CAPITAL_BUDGET_V1',ctx,now),holds=checked(input.budget?.cash_holds,trust.holds_sha256,'HS_ADDITIONAL_CASH_HOLDS_V1',ctx,now),fees=checked(input.fee_policy,trust.fee_sha256,'HS_CONFIRMED_FEE_POLICY_V1',ctx,now);
   if(global.basis!=='TOTAL_CASH_OUTLAY_INCLUDING_FEES'||typeof global.budget_id!=='string'||!global.budget_id||global.confirmation?.kind!=='USER_CONFIRMATION'||!global.confirmation.reference||time(global.confirmation.confirmed_at)>now)fail('GLOBAL_BUDGET_CONFIRMATION_REQUIRED');
   const globalRemaining=minor(global.authorized_minor)-minor(global.consumed_minor)-minor(global.reserved_minor);if(globalRemaining<0)fail('GLOBAL_BUDGET_OVERUSED');
   const ids=new Set(),events=JSON.parse(p.entries[ledger.STORAGE_KEY]).events;if(!Array.isArray(holds.rows))fail('HOLDS_REQUIRED');
   for(const h of holds.rows){if(typeof h.operation_id!=='string'||!h.operation_id||ids.has(h.operation_id)||h.already_reflected_in_cash!==false||events.some(e=>e.id===h.event_id)||JSON.parse(p.entries[c.META_KEY]).receipts.some(r=>r.operation_id===h.operation_id))fail('CASH_HOLD_DOUBLE_COUNT_OR_UNKNOWN');ids.add(h.operation_id);minor(h.amount_minor);}
   const held=sum(holds.rows.map(r=>r.amount_minor));let budgetOnly=0;
   if(p.entries['hsRadar.portfolio.accelerationConsumption.v1']){const reservations=typeof module==='object'&&module.exports?require('./portfolio-approval-consumption-core'):globalThis.HSPortfolioApprovalConsumptionCore,cashLinks=typeof module==='object'&&module.exports?require('./portfolio-approval-consumption-adapter'):globalThis.HSPortfolioApprovalConsumptionAdapter;if(!reservations?.budgetOnlyReserved||!cashLinks?.verifyReservationHolds)fail('RESERVATION_SEMANTICS_READER_REQUIRED');cashLinks.verifyReservationHolds(input);budgetOnly=reservations.budgetOnlyReserved(p.entries,{asOf:input.asOf,budgetId:global.budget_id});}
   if(budgetOnly>global.reserved_minor||held<global.reserved_minor-budgetOnly)fail('BUDGET_RESERVATION_CASH_EVIDENCE_INCOMPLETE');
   if(fees.currency!=='TWD'||fees.rounding!=='CEIL'||fees.order_model!=='AT_MOST_ONE_ORDER_PER_ETF'||fees.confirmation?.kind!=='USER_CONFIRMATION'||!fees.confirmation.reference||time(fees.confirmation.confirmed_at)>now||!Number.isInteger(fees.rate_bps)||fees.rate_bps<0||fees.rate_bps>10000)fail('FEE_POLICY_REQUIRED');minor(fees.fixed_per_order_minor);
   const fee=n=>n?safe(BigInt(fees.fixed_per_order_minor)+(BigInt(n)*BigInt(fees.rate_bps)+9999n)/10000n):0;
   let mode=NORMAL,modeVerified=false;const reasons=[];
   try{
    const previous=checked(input.previous_mode,trust.mode_sha256,'HS_CAPITAL_MODE_STATE_V1',null,now),hy=checked(input.hysteresis,trust.hysteresis_sha256,'HS_CONFIRMED_HYSTERESIS_V1',ctx,now);
    if(previous.plan_id!==ctx.plan_id||previous.settings_sha256!==ctx.settings_sha256||previous.revision!==input.expected_mode_revision||!Number.isSafeInteger(previous.revision)||previous.revision<1||![NORMAL,OPPORTUNITY].includes(previous.mode)||hy.confirmation?.kind!=='USER_CONFIRMATION'||!hy.confirmation.reference||time(hy.confirmation.confirmed_at)>now||!Number.isInteger(hy.buffer_bps)||hy.buffer_bps<0||hy.buffer_bps>normal)fail('MODE_HISTORY_OR_BUFFER_REQUIRED');
    modeVerified=true;mode=previous.mode;if(T>0n){if(E*10000n>=T*BigInt(normal))mode=OPPORTUNITY;else if(previous.mode===OPPORTUNITY&&E*10000n<T*BigInt(normal-hy.buffer_bps))mode=NORMAL;}else mode=NORMAL;
   }catch{reasons.push('MODE_HISTORY_OR_HYSTERESIS_REVIEW_REQUIRED');}
   let approved=0,approvalRef=null;
   if(input.budget.approval){const a=checked(input.budget.approval,trust.approval_sha256,'HS_CONFIRMED_ACCELERATION_BUDGET_V1',ctx,now);
    if(a.budget_id!==global.budget_id||a.basis!=='PRINCIPAL_EXCLUDING_FEES'||typeof a.authorization_id!=='string'||!a.authorization_id||a.strategy_version!==VERSION||!Array.isArray(a.symbols)||new Set(a.symbols).size!==a.symbols.length||a.symbols.some(s=>!ELIGIBLE.includes(s))||a.kind!==(mode===OPPORTUNITY?'OPPORTUNITY':'ACCELERATION')||a.confirmation?.kind!=='USER_CONFIRMATION'||!a.confirmation.reference||time(a.confirmation.confirmed_at)>now)fail('ACCELERATION_APPROVAL_SCOPE');
    approved=minor(a.authorized_minor)-minor(a.consumed_minor)-minor(a.reserved_minor);if(approved<0)fail('ACCELERATION_BUDGET_OVERUSED');if(a.consumed_minor>global.consumed_minor)fail('ACCELERATION_USAGE_NOT_IN_GLOBAL');if(a.reserved_minor>global.reserved_minor)fail('ACCELERATION_RESERVATION_NOT_IN_GLOBAL');approvalRef=a;
   }
   if(!active)reasons.push('PLAN_NOT_ACTIVE_OR_PERIOD_UNISSUED');if(!modeVerified)approved=0;
   const opportunity=minor(input.budget.opportunity_reference_minor),reference=mode===NORMAL?base:opportunity,weights=plan.etf_target_weights;
   const weighted=Object.fromEntries(Object.entries(weights).map(([s,w])=>[s,Math.round(w*10)])),baseShares=apportion(reference,weighted);
   const equityRows=Object.fromEntries(p.source.valuation.rows.map(row=>[row.symbol,safe((scaled(row.quantity,8)*scaled(row.unit_price,6)+500000000000n)/1000000000000n)]));
   // Use the existing validated aggregate; reject unsafe conversion instead of
   // silently rounding a row differently from the original BigInt valuation.
   for(const value of Object.values(equityRows))minor(value);if(sum(Object.values(equityRows))!==view.equity_minor)fail('HOLDING_MINOR_PRECISION_REVIEW_REQUIRED');
   const candidates=[],baseRequests={},extraRequests={},upper={};
   for(const symbol of Object.keys(weights).sort()){
    const eligible=ELIGIBLE.includes(symbol),score=eligible?c4(symbol,input.c4?.[symbol],trust.c4?.[symbol],now):{status:'EXCLUDED',score:null,multiplier:null,reasons:['ETF_NOT_ELIGIBLE']};
    const part=baseShares[symbol]||0,theory=score.status==='VERIFIED'?(mode===OPPORTUNITY&&score.multiplier===1?0:safe(BigInt(part)*BigInt(Math.round(score.multiplier*10000))/10000n)):null;
    const b=mode===NORMAL&&score.status==='VERIFIED'?part:0,extra=theory===null?0:Math.max(0,theory-b),allowedExtra=approvalRef?.symbols.includes(symbol)?Math.min(extra,approved):0;
    baseRequests[symbol]=b;extraRequests[symbol]=allowedExtra;upper[symbol]=sum([b,allowedExtra]);
    candidates.push({symbol,...score,base_candidate_minor:mode===NORMAL?part:0,theoretical_accelerated_minor:theory,additional_demand_minor:extra,unapproved_additional_demand_minor:extra,approved_acceleration_ceiling_minor:allowedExtra,current_equity_minor:equityRows[symbol]||0,target_weight_bps:weighted[symbol]*10});
   }
   // Allocate the one shared approval once, independently of cash constraints.
   // Unspent approved shares remain APPROVED, never relabelled unapproved.
   const approvedShares=allocate(Math.min(approved,sum(Object.values(extraRequests))),extraRequests,extraRequests);
   for(const symbol of Object.keys(upper)){extraRequests[symbol]=approvedShares[symbol];upper[symbol]=sum([baseRequests[symbol],approvedShares[symbol]]);}
   const boundFees=sum(Object.values(upper).map(n=>fee(Math.min(n,globalRemaining)))),cashSafe=Math.max(0,view.spendable_minor-held-boundFees),afterFees=T-BigInt(Math.min(view.total_assets_minor,sum([view.fee_reserve_minor,boundFees]))),maxSafe=Math.max(0,safe(afterFees*BigInt(maximum)/10000n)-view.equity_minor),normalSafe=Math.max(0,safe(afterFees*BigInt(normal)/10000n)-view.equity_minor);
   const approvedBase=mode===NORMAL?sum(Object.values(baseRequests)):0,extraTotal=Math.min(approved,sum(Object.values(extraRequests))),theoreticalTotal=sum(candidates.map(r=>r.theoretical_accelerated_minor||0));
   const pool=Math.min(Math.max(0,globalRemaining-boundFees),sum([approvedBase,extraTotal]),cashSafe,maxSafe,mode===NORMAL?normalSafe:maxSafe);let P=active?pool:0,baseAllocation={},extraAllocation={},caps={},settled=false;
   const tolerance=Math.round(plan.allocation_tolerance_reference.value*100);
   for(let round=0;round<128;round++){
    caps=Object.fromEntries(candidates.map(r=>{const cap=Math.min(10000,r.target_weight_bps+tolerance),already=E>0n&&BigInt(r.current_equity_minor)*10000n>E*BigInt(cap);return[r.symbol,already?0:Math.max(0,safe((E+BigInt(P))*BigInt(cap)/10000n)-r.current_equity_minor)];}));
    baseAllocation=allocate(Math.min(P,approvedBase),baseRequests,caps);const used=sum(Object.values(baseAllocation)),leftCaps=Object.fromEntries(Object.keys(caps).map(s=>[s,caps[s]-baseAllocation[s]]));extraAllocation=allocate(Math.min(P-used,extraTotal),extraRequests,leftCaps);const actual=sum([...Object.values(baseAllocation),...Object.values(extraAllocation)]);
    if(actual===P){settled=true;break;}P=actual;
   }
   if(!settled){P=0;for(const s of Object.keys(weights)){baseAllocation[s]=0;extraAllocation[s]=0;}reasons.push('ALLOCATION_CONVERGENCE_REVIEW_REQUIRED');}
   const rows=candidates.map(r=>{const b=baseAllocation[r.symbol]||0,a=extraAllocation[r.symbol]||0,n=sum([b,a]),share=approvedShares[r.symbol]||0;return{...r,approved_acceleration_ceiling_minor:share,unapproved_additional_demand_minor:Math.max(0,r.additional_demand_minor-share),approved_unallocated_acceleration_minor:share-a,allocated_base_minor:b,allocated_acceleration_minor:a,allocated_minor:n,allocation_safe_ceiling_minor:caps[r.symbol]||0,fee_minor:fee(n)};});
   const actualFee=sum(rows.map(r=>r.fee_minor));
   if(P>pool||sum([P,actualFee])>globalRemaining||sum(rows.map(r=>r.allocated_minor))!==P||sum([P,actualFee,held,view.fee_reserve_minor])>view.available_cash_minor&&P>0||P>0&&(E+BigInt(P))*10000n>(T-BigInt(actualFee))*BigInt(maximum)||rows.some(r=>r.allocated_minor>0&&BigInt(r.current_equity_minor+r.allocated_minor)*10000n>(E+BigInt(P))*BigInt(Math.min(10000,r.target_weight_bps+tolerance))))fail('POST_TRADE_SAFETY_INVARIANT');
   return{schema:'HS_C4_CAPITAL_SAFETY_RESULT_V1',strategy_version:VERSION,status:reasons.length||rows.some(r=>r.status!=='VERIFIED')?'PARTIAL':'READY',mode,mode_verified:modeVerified,base_plan_readable:true,remaining_periods:view.remaining_periods,approved_base_minor:view.approved_minor??null,remaining_base_minor:view.unused_minor??null,effective_base_budget_minor:mode===NORMAL?base:0,period_executed_principal_minor:view.executed_principal_minor,theoretical_accelerated_minor:theoreticalTotal,additional_demand_minor:sum(rows.map(r=>r.additional_demand_minor)),approved_acceleration_ceiling_minor:approved,unapproved_additional_demand_minor:sum(rows.map(r=>r.unapproved_additional_demand_minor)),global_remaining_minor:globalRemaining,available_investable_cash_minor:view.available_cash_minor,existing_fee_reserve_minor:view.fee_reserve_minor,additional_cash_holds_minor:held,cash_safe_ceiling_minor:cashSafe,equity_max_safe_ceiling_minor:maxSafe,allocation_safe_ceiling_minor:sum(rows.map(r=>r.allocation_safe_ceiling_minor)),final_budget_ceiling_minor:P,allocated_base_minor:sum(rows.map(r=>r.allocated_base_minor)),allocated_acceleration_minor:sum(rows.map(r=>r.allocated_acceleration_minor)),remaining_shared_budget_minor:globalRemaining-P-actualFee,unassigned_approved_acceleration_minor:approved-sum(Object.values(approvedShares)),remaining_approved_acceleration_minor:approved-sum(rows.map(r=>r.allocated_acceleration_minor)),fee_reservation_minor:boundFees,estimated_fee_minor:actualFee,after_equity_minor:view.equity_minor+P,after_total_assets_minor:view.total_assets_minor-actualFee,action:P>0?'BUDGET_CEILING_ONLY':'HOLD_NO_BUY',reasons,rows,source_references:{...ctx,portfolio_sha256:snapshot.state_sha256,source_sha256:trust.source_sha256,period_sha256:trust.period_sha256,mode_sha256:input.previous_mode?.sha256??null,c4_receipts:rows.filter(r=>r.receipt_sha256).map(r=>r.receipt_sha256),approval_sha256:approvalRef?.sha256??null,global_sha256:global.sha256,fee_sha256:fees.sha256,holds_sha256:holds.sha256},creates_approval:false,writes:false,production_activation:'BLOCKED'};
  }catch(e){return blocked(e.message);}
 }
 function evaluate(input){
  const r=calculate(input),rows=r.rows||[],verified=rows.filter(row=>row.status==='VERIFIED').length,source=r.source_references;
  const failure=(r.reasons||[]).join('|'),code=/VALUATION|PRICE|HOLDING|ASSET|RECEIVABLE/.test(failure)?'VALUATION_UNAVAILABLE':/CASH|BASELINE|SYNC/.test(failure)?'CASH_RECONCILIATION_REQUIRED':/PLAN|PORTFOLIO|GENERATION|LEDGER|REVISION|COMMITTED|JOURNAL|SETTINGS|PERIOD/.test(failure)?'PLAN_GENERATION_CONFLICT':'DATA_EVIDENCE_INVALID';
  const data_status=r.status==='RECONCILIATION_REQUIRED'?{base_plan:'UNVERIFIED',overall:code}:{base_plan:'READABLE',c4:verified===0?'C4_UNAVAILABLE':rows.some(row=>row.status==='UNAVAILABLE')?'PARTIAL':'AVAILABLE',budget_approval:source.approval_sha256?(r.mode_verified?'VERIFIED':'MODE_REVIEW_REQUIRED'):r.additional_demand_minor>0?'BUDGET_APPROVAL_REQUIRED':'NOT_REQUIRED',valuation:'VERIFIED',cash:'VERIFIED_INVESTABLE_ONLY',equity:r.equity_max_safe_ceiling_minor===0?'EQUITY_MAX_REACHED':'WITHIN_LIMIT',overall:'VALIDATED_CEILINGS_ONLY'};
  return{...r,data_status,approved_unallocated_acceleration_minor:rows.reduce((n,row)=>n+row.approved_unallocated_acceleration_minor,0),global_budget_basis:'TOTAL_CASH_OUTLAY_INCLUDING_FEES'};
 }
 return Object.freeze({SCHEMA,VERSION,MODEL,ELIGIBLE,BANDS,NORMAL,OPPORTUNITY,multiplier,evaluate,settings,context,sealEvidence:seal});
});

;
/* sealed source: portfolio-approval-consumption-core.js */
(function(root,factory){
 const node=typeof module==='object'&&module.exports,api=factory(node?require('./portfolio-investable-cash-core'):root.HSPortfolioInvestableCashCore,node?require('./portfolio-ledger-core'):root.HSPortfolioLedgerCore);
 if(node)module.exports=api;if(root)root.HSPortfolioApprovalConsumptionCore=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(cash,ledger){
 'use strict';
 const KEY='hsRadar.portfolio.accelerationConsumption.v1',POLICY='HS_APPROVAL_CONSUMPTION_V1',SCHEMA='HS_APPROVAL_CONSUMPTION_STORE_V1',RECORD='HS_APPROVAL_OPERATION_V1';
 const PLAN='hsRadar.portfolio.capitalBuildPlans.v1',GEN='hsRadar.portfolio.capitalGeneration.v1',SYNC='hsRadar.portfolio.transactionCashSync.v1';
 const fp=cash.fingerprint,copy=x=>JSON.parse(JSON.stringify(x)),fail=s=>{throw Error(s);},seal=o=>{const{sha256,...body}=copy(o);return{...body,sha256:fp(body)};};
 const strategy=()=>typeof module==='object'&&module.exports?require('./portfolio-c4-smart-acceleration-core'):globalThis.HSPortfolioC4SmartAccelerationCore;
 const g=()=>typeof module==='object'&&module.exports?require('./portfolio-plan-generation-core'):globalThis.HSPortfolioPlanGenerationCore;
 const core=()=>typeof module==='object'&&module.exports?require('./portfolio-capital-build-plan-core'):globalThis.HSPortfolioCapitalBuildPlanCore;
 function minor(n){if(!Number.isSafeInteger(n)||n<0||Object.is(n,-0))fail('APPROVAL_INVALID_MINOR');return n;}
 function sum(ns){const n=ns.reduce((s,x)=>s+BigInt(minor(x)),0n);if(n>BigInt(Number.MAX_SAFE_INTEGER))fail('APPROVAL_AMOUNT_OVERFLOW');return Number(n);}
 function text(s){if(typeof s!=='string'||!s.trim()||s.trim()!==s||s.length>240)fail('APPROVAL_ID_REQUIRED');return s;}
 function time(s){if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(s)||!Number.isFinite(Date.parse(s))||new Date(s.slice(0,10)+'T00:00:00Z').toISOString().slice(0,10)!==s.slice(0,10)||+s.slice(11,13)>23||+s.slice(14,16)>59||+s.slice(17,19)>59||/[+-]14:(?!00$)/.test(s))fail('APPROVAL_OFFSET_TIME_REQUIRED');return Date.parse(s);}
 function checked(v){if(!v||typeof v!=='object'||Array.isArray(v))fail('APPROVAL_INVALID_RECORD');const{sha256,...b}=v;if(fp(b)!==sha256)fail('APPROVAL_HASH_CONFLICT');return v;}
 function settings(p){return fp({normal_equity_target_bps:p.normal_equity_target_bps,maximum_equity_limit_bps:p.maximum_equity_limit_bps,etf_target_weights:p.etf_target_weights,allocation_tolerance_reference:p.allocation_tolerance_reference});}
 function state(entries){return entries[KEY]===undefined?null:checked(JSON.parse(entries[KEY]));}
 function plan(entries){if(!entries[PLAN])fail('APPROVAL_PLAN_REQUIRED');return JSON.parse(entries[PLAN]);}
 function scope(store,at){const period=core().periodAt(store.plan,at),q=store.plan.quota_records.find(q=>q.period_id===period.id);if(!q||period.status!=='ACTIVE'||store.status!=='ACTIVE')fail('APPROVAL_ACTIVE_PERIOD_REQUIRED');return{plan_id:store.plan_id,plan_revision:store.plan.revision,store_revision:store.revision,period_id:period.id,period_sha256:q.sha256,settings_sha256:settings(store.plan),effective_at:period.start,valid_until:period.end};}
 function confirmation(v,at){if(v?.kind!=='USER_CONFIRMATION'||v.confirmed_at!==at)fail('APPROVAL_CONFIRMATION_REQUIRED');text(v.reference);time(at);return copy(v);}
 function reservationKind(r){
  if(!Object.hasOwn(r,'reservation_semantics'))return'LEGACY_UNSPECIFIED';
  const s=r.reservation_semantics;if(!s||s.schema!=='HS_RESERVATION_SEMANTICS_V2'||s.version!==2||!['BUDGET_ONLY','CASH_BACKED'].includes(s.kind)||Object.keys(s).sort().join(',')!=='cash_hold_id,kind,schema,version')fail('APPROVAL_RESERVATION_SEMANTICS_INVALID');
  if(s.kind==='BUDGET_ONLY'?s.cash_hold_id!==null:typeof s.cash_hold_id!=='string'||!s.cash_hold_id.trim())fail('APPROVAL_RESERVATION_SEMANTICS_INVALID');return s.kind;
 }
 const PARTIAL='HS_PARTIAL_RESERVATION_CONVERSION_V2';
 function partialPolicy(r){if(!Object.hasOwn(r,'conversion_contract'))return false;const v=r.conversion_contract;if(!v||v.schema!==PARTIAL||v.version!==2||Object.keys(v).sort().join(',')!=='schema,version')fail('PARTIAL_CONVERSION_VERSION_INVALID');return true;}
 function reservationProjection(r,changes={}){
  const b={...copy(r),...copy(changes)};delete b.projection_sha256;
  if(b.original_reserved_minor!==sum([b.cumulative_converted_minor,b.reserved_minor,b.terminal_released_minor]))fail('PARTIAL_RESERVATION_CONSERVATION_CONFLICT');
  return{...b,projection_sha256:fp(b)};
 }
 function partialRequest(hold){
  if(!hold||!partialPolicy(hold))fail('PARTIAL_CONVERSION_POLICY_REQUIRED');if(reservationKind(hold)!=='BUDGET_ONLY')fail('CASH_BACKED_PARTIAL_CONVERSION_BLOCKED');
  if(hold.status!=='ACTIVE')fail('PARTIAL_RESERVATION_NOT_ACTIVE');
  return{schema:PARTIAL,version:2,reservation_id:hold.reservation_id,original_reservation_sha256:hold.sha256,reservation_lineage:hold.reservation_lineage,expected_reservation_revision:hold.reservation_revision,expected_projection_sha256:hold.projection_sha256};
 }
 function conversionReceipt(r,hold){
  partialRequest(hold);minor(r.consumed_minor);if(r.consumed_minor===0||r.consumed_minor>hold.reserved_minor)fail('PARTIAL_RESERVATION_AMOUNT_CONFLICT');
  return seal({schema:PARTIAL,version:2,operation_id:r.operation_id,consumption_receipt_id:r.consumption_id,original_reservation_id:hold.reservation_id,original_reservation_sha256:hold.sha256,reservation_lineage:hold.reservation_lineage,previous_projection_sha256:hold.projection_sha256,reservation_revision:hold.reservation_revision+1,approval_id:r.approval_id,approval_revision:r.approval_revision,approval_revision_sha256:r.approval_revision_sha256,plan_id:r.plan_id,plan_revision:r.plan_revision_reference,period_id:r.period_id,period_snapshot_sha256:r.period_sha256,event_id:r.event_id,event_sha256:r.event_sha256,converted_principal_minor:r.consumed_minor,previous_reserved_minor:hold.reserved_minor,remaining_reserved_minor:hold.reserved_minor-r.consumed_minor,cumulative_converted_minor:sum([hold.cumulative_converted_minor,r.consumed_minor]),parent_committed_generation_id:r.reference.parent_generation_id,journal_reference:copy(r.reference)});
 }
 function validatePublication(entries,meta){
  const s=state(entries),records=s?.records.filter(r=>r.partial_conversion)||[],gen=JSON.parse(entries[GEN]);
  for(const r of records){const pub=meta?.receipts?.filter(x=>x.operation_id===r.operation_id&&x.revision===r.reference.shared_revision);if(pub?.length!==1||pub[0].conversion_receipt_sha256!==r.sha256||!/^[a-f0-9]{64}$/.test(pub[0].committed_generation_id||'')||gen.operation_id===r.operation_id&&pub[0].committed_generation_id!==gen.generation_id)fail('PARTIAL_CONVERSION_PUBLICATION_REQUIRED');}
  for(const pub of meta?.receipts||[])if(pub.conversion_receipt_sha256&&!records.some(r=>r.operation_id===pub.operation_id&&r.sha256===pub.conversion_receipt_sha256))fail('PARTIAL_CONVERSION_PUBLICATION_CONFLICT');
 }
 function conversionEvidence(entries,{meta,journal}){validatePublication(entries,meta);return(state(entries)?.records.filter(r=>r.partial_conversion)||[]).map(r=>{const p=meta.receipts.find(p=>p.operation_id===r.operation_id);return{schema:'HS_PARTIAL_CONVERSION_COMMITTED_EVIDENCE_V2',scope:'COMMITTED_NOT_PRODUCTION_AUTHORIZATION',receipt:copy(r),created_committed_generation_id:p.committed_generation_id,publication:copy(p),current_committed_generation_id:JSON.parse(entries[GEN]).generation_id,current_journal_sha256:fp(journal)};});}
 function budgetOnlyReserved(entries,{asOf,budgetId}={}){
  const v=validateState(entries);if(!v)return 0;const rows=[...v.reservations.values()].filter(r=>r.status==='ACTIVE');
  for(const r of rows){reservationKind(r);if(time(asOf)>=time(r.expires_at))fail('APPROVAL_RESERVATION_EXPIRY_REQUIRES_LOCKED_RELEASE');}
  const pure=rows.filter(r=>reservationKind(r)==='BUDGET_ONLY');if(pure.some(r=>r.budget_id!==budgetId))fail('APPROVAL_BUDGET_ID_CONFLICT');return sum(pure.map(r=>r.reserved_minor));
 }
 // Existing core validates every principal and attribution. Only the NEW
 // attribution-of-excess contract below distributes that already-validated total.
 function excess(entries,p){
  const events=JSON.parse(entries[ledger.STORAGE_KEY]).events,s=JSON.parse(entries[SYNC]).state,totals=core().validateAttributions(p,events,s),latest=new Map(p.execution_attributions.map(a=>[a.event_id,a]));
  const rows=[...latest.values()].filter(a=>a.action!=='REVOKE'&&a.classification==='IN_PLAN'),caps=Object.create(null),prefix=[],running=Object.create(null);
  rows.sort((a,b)=>time(a.occurred_at)-time(b.occurred_at)||a.event_id.localeCompare(b.event_id));
  for(let i=0;i<rows.length;i++){
   const a=rows[i],q=p.quota_records.find(q=>q.period_id===a.period_id);if(!q)fail('APPROVAL_PERIOD_SNAPSHOT_REQUIRED');
   const prior=running[a.period_id]||0,next=sum([prior,a.principal_minor]);running[a.period_id]=next;
   const tied=rows.filter(b=>b.period_id===a.period_id&&time(b.occurred_at)===time(a.occurred_at)),earlierTie=rows.slice(0,i).filter(b=>b.period_id===a.period_id&&time(b.occurred_at)===time(a.occurred_at)),groupBefore=prior-sum(earlierTie.map(b=>b.principal_minor)),ambiguous=tied.length>1&&groupBefore+sum(tied.map(b=>b.principal_minor))>q.approved_minor;
   caps[a.event_id]={amount_minor:ambiguous?null:Math.max(0,next-q.approved_minor)-Math.max(0,prior-q.approved_minor),order_ambiguous:ambiguous,attribution:a,prefix_sha256:fp([...prefix,{id:a.event_id,event_sha256:a.event_sha256,occurred_at:a.occurred_at,principal_minor:a.principal_minor}])};
   prefix.push({id:a.event_id,event_sha256:a.event_sha256,occurred_at:a.occurred_at,principal_minor:a.principal_minor});
  }
  if(fp(running)!==fp(totals))fail('APPROVAL_EXISTING_PRINCIPAL_CONFLICT');return caps;
 }
 function replay(s){
  checked(s);if(s.schema!==SCHEMA||s.version!==1||s.policy!==POLICY||s.strategy_version!==strategy()?.VERSION||s.reservation_policy!=='EXPLICIT_SHARED_COMMIT_ONLY_V1'||s.revision!==s.records?.length||!s.records.length||s.records[0].action!=='INITIALIZE'||!Array.isArray(s.initial_event_pins))fail('APPROVAL_STORE_CONTRACT_REQUIRED');
  const approvals=new Map(),consumptions=new Map(),reservations=new Map(),ids=new Set(),ops=new Set();let previous=null,last=-Infinity;
  const usage=id=>({consumed:sum([...consumptions.values()].filter(r=>r.approval_id===id).map(r=>r.consumed_minor)),reserved:sum([...reservations.values()].filter(r=>r.approval_id===id&&r.status==='ACTIVE').map(r=>r.reserved_minor))});
  for(let i=0;i<s.records.length;i++){
   const r=checked(s.records[i]);text(r.operation_id);if(r.schema!==RECORD||r.version!==1||r.strategy_version!==s.strategy_version||r.index!==i+1||r.previous_sha256!==previous||ops.has(r.operation_id)||time(r.at)<last||r.reference.operation_id!==r.operation_id||r.reference.parent_generation_id!==r.parent_generation_id||!Number.isSafeInteger(r.reference.shared_revision)||r.reference.shared_revision<1)fail('APPROVAL_OPERATION_CHAIN_CONFLICT');
   if(Object.hasOwn(r,'partial_conversion')&&(!r.partial_conversion||r.action!=='CONSUME')||Object.hasOwn(r,'conversion_contract')&&r.action!=='RESERVE')fail('PARTIAL_CONVERSION_RECORD_SCOPE_CONFLICT');
   confirmation(r.confirmation,r.at);ops.add(r.operation_id);previous=r.sha256;last=time(r.at);
   if(r.action==='INITIALIZE'){if(i!==0||r.plan_id!==s.plan_id)fail('APPROVAL_INITIALIZATION_CONFLICT');continue;}
   const id=text(r.approval_id),old=approvals.get(id);text(r.budget_id);if(old&&r.budget_id!==old.budget_id)fail('APPROVAL_BUDGET_ID_CONFLICT');
   if(['APPROVE','REVISE','REVOKE'].includes(r.action)){
    minor(r.ceiling_minor);if(r.action==='APPROVE'?(!!old||r.approval_revision!==1||r.previous_approval_sha256!==null):(!old||r.approval_revision!==old.approval_revision+1||r.previous_approval_sha256!==old.sha256))fail('APPROVAL_REVISION_CONFLICT');
    if(r.action==='APPROVE'&&[...approvals.values()].some(a=>a.scope.plan_id===r.scope.plan_id&&a.scope.period_id===r.scope.period_id))fail('APPROVAL_PERIOD_LINEAGE_ALREADY_EXISTS');
    if(old&&(r.lineage_id!==old.lineage_id||fp(r.scope)!==fp(old.scope)))fail('APPROVAL_LINEAGE_SCOPE_CONFLICT');
    if(r.action==='APPROVE'&&r.lineage_id!==fp({approval_id:id,plan_id:r.scope.plan_id,period_id:r.scope.period_id,first_operation_id:r.operation_id}))fail('APPROVAL_LINEAGE_CONFLICT');
    const u=usage(id);if(sum([u.consumed,u.reserved])>r.ceiling_minor||r.action==='REVOKE'&&(u.reserved!==0||r.ceiling_minor!==u.consumed))fail('APPROVAL_CEILING_BELOW_USAGE');approvals.set(id,r);
   }else{
    if(!old||r.lineage_id!==old.lineage_id)fail('APPROVAL_REFERENCE_REQUIRED');
    if(r.action==='CONSUME'||r.action==='REPLACE'){
     const prior=consumptions.get(r.event_id);if(prior?.partial_conversion)fail('PARTIAL_CONVERSION_REVERSAL_REQUIRES_REVIEW');if(r.action==='REPLACE'){if(!prior||r.reversal_reference!==prior.sha256||prior.approval_id!==id||prior.event_sha256===r.event_sha256)fail('APPROVAL_REPLACEMENT_CONFLICT');consumptions.delete(r.event_id);}else if(prior)fail('APPROVAL_EVENT_ALREADY_CONSUMED');
     if(ids.has(text(r.consumption_id))||r.consumed_minor===0)fail('APPROVAL_DUPLICATE_CONSUMPTION');ids.add(r.consumption_id);minor(r.consumed_minor);
     const revision=s.records.find(a=>a.sha256===r.approval_revision_sha256&&a.approval_id===id&&a.approval_revision===r.approval_revision);
     if(!revision||revision.action==='REVOKE'||time(revision.at)>time(r.occurred_at)||r.plan_id!==revision.scope.plan_id||r.period_id!==revision.scope.period_id||r.period_sha256!==revision.scope.period_sha256||time(r.occurred_at)<time(revision.scope.effective_at)||time(r.occurred_at)>=time(revision.scope.valid_until))fail('APPROVAL_HISTORICAL_AUTHORIZATION_REJECTED');
     if(s.initial_event_pins.some(p=>p.event_id===r.event_id))fail('APPROVAL_HISTORICAL_BUY_REJECTED');
     if(r.reservation_id){const hold=reservations.get(r.reservation_id);if(!hold||hold.status!=='ACTIVE'||hold.approval_id!==id||time(r.at)>=time(hold.expires_at))fail('APPROVAL_RESERVATION_CONVERSION_CONFLICT');
      if(r.partial_conversion){if(r.action!=='CONSUME'||fp(r.partial_conversion)!==fp(conversionReceipt(r,hold)))fail('PARTIAL_CONVERSION_RECEIPT_CONFLICT');const v=r.partial_conversion;reservations.set(r.reservation_id,reservationProjection(hold,{reserved_minor:v.remaining_reserved_minor,cumulative_converted_minor:v.cumulative_converted_minor,reservation_revision:v.reservation_revision,status:v.remaining_reserved_minor?'ACTIVE':'CONSUMED',conversion_history:[...hold.conversion_history,{consumption_id:r.consumption_id,record_sha256:r.sha256}]}));}
      else{if(partialPolicy(hold))fail('PARTIAL_CONVERSION_RECEIPT_REQUIRED');if(hold.reserved_minor!==r.consumed_minor)fail('APPROVAL_RESERVATION_CONVERSION_CONFLICT');reservations.set(r.reservation_id,{...hold,status:'CONSUMED',consumption_id:r.consumption_id});}
     }else if(r.partial_conversion)fail('PARTIAL_CONVERSION_RESERVATION_REQUIRED');
     if(old.action==='REVOKE')fail('APPROVAL_REVOKED');consumptions.set(r.event_id,r);
    }else if(r.action==='REVERSE'){
     const prior=consumptions.get(r.event_id);if(prior?.partial_conversion)fail('PARTIAL_CONVERSION_REVERSAL_REQUIRES_REVIEW');if(!prior||prior.approval_id!==id||r.reversal_reference!==prior.sha256)fail('APPROVAL_REVERSAL_CONFLICT');consumptions.delete(r.event_id);
    }else if(r.action==='RESERVE'){
     reservationKind(r);
     if(old.action==='REVOKE'||r.approval_revision_sha256!==old.sha256||reservations.has(text(r.reservation_id))||r.reserved_minor===0||time(r.expires_at)<=time(r.at)||time(r.expires_at)>time(old.scope.valid_until))fail('APPROVAL_RESERVATION_CONFLICT');minor(r.reserved_minor);const initial={...r,status:'ACTIVE'};reservations.set(r.reservation_id,partialPolicy(r)?reservationProjection(initial,{original_reserved_minor:r.reserved_minor,cumulative_converted_minor:0,terminal_released_minor:0,reservation_revision:0,reservation_lineage:fp({reservation_id:r.reservation_id,original_record_sha256:r.sha256}),conversion_history:[]}):initial);
    }else if(r.action==='RELEASE'){
     const hold=reservations.get(r.reservation_id);if(!hold||hold.approval_id!==id||hold.status!=='ACTIVE'||hold.sha256!==r.reservation_sha256)fail('APPROVAL_RELEASE_CONFLICT');if(partialPolicy(hold)){if(r.reservation_projection_sha256!==hold.projection_sha256||r.reservation_revision!==hold.reservation_revision+1)fail('PARTIAL_RELEASE_REVISION_CONFLICT');reservations.set(r.reservation_id,reservationProjection(hold,{status:'RELEASED',terminal_released_minor:sum([hold.terminal_released_minor,hold.reserved_minor]),reserved_minor:0,reservation_revision:r.reservation_revision,release_sha256:r.sha256}));}else reservations.set(r.reservation_id,{...hold,status:'RELEASED',release_sha256:r.sha256});
    }else fail('APPROVAL_UNKNOWN_ACTION');
   }
   const active=approvals.get(id),u=usage(id);if(sum([u.consumed,u.reserved])>active.ceiling_minor)fail('APPROVAL_CAPACITY_EXCEEDED');
  }
  return{approvals,consumptions,reservations,usage};
 }
 function validateState(entries,pstore=plan(entries)){
  const s=state(entries),marked=pstore.lifecycle.some(r=>r.approval_policy===POLICY);if(!s){if(marked)fail('APPROVAL_PARTICIPANT_MISSING');return null;}
  if(!marked||s.plan_id!==pstore.plan_id)fail('APPROVAL_PLAN_OR_POLICY_CONFLICT');
  const v=replay(s),commitments=new Map();for(const row of pstore.lifecycle){if(row.approval_policy&&row.approval_policy!==POLICY)fail('APPROVAL_POLICY_CONFLICT');for(const pin of row.approval_records||[]){if(commitments.has(pin.sha256))fail('APPROVAL_DUPLICATE_COMMITMENT');commitments.set(pin.sha256,row);}}
  for(const r of s.records){const row=commitments.get(r.sha256);if(!row||row.operation_id!==r.operation_id||row.at!==r.at||row.approval_policy!==POLICY||fp(row.approval_generation)!==fp(r.reference))fail('APPROVAL_COMMITMENT_REQUIRED');commitments.delete(r.sha256);}
  if(commitments.size)fail('APPROVAL_RECEIPT_MISSING');
  const events=JSON.parse(entries[ledger.STORAGE_KEY]).events,caps=excess(entries,pstore.plan);
  for(const a of v.approvals.values()){const q=pstore.plan.quota_records.find(q=>q.period_id===a.scope.period_id);if(a.scope.plan_id!==pstore.plan_id||!q||q.sha256!==a.scope.period_sha256||a.scope.settings_sha256!==settings(pstore.plan))fail('APPROVAL_SCOPE_CONFLICT');}
  const temporal=Object.create(null);
  for(const r of [...v.consumptions.values()].sort((a,b)=>time(a.occurred_at)-time(b.occurred_at))){
   const event=events.find(e=>e.id===r.event_id),cap=caps[r.event_id],a=v.approvals.get(r.approval_id);
   if(!event||event.type!=='BUY'||!strategy().ELIGIBLE.includes(event.symbol)||!cap||cap.amount_minor===null||fp(event)!==r.event_sha256||cap.attribution.sha256!==r.attribution_sha256||fp(r.attribution_reference)!==fp({record_id:cap.attribution.record_id,sha256:cap.attribution.sha256,classification_sha256:cap.attribution.classification_contract?.sha256??null})||r.occurred_at!==cap.attribution.occurred_at||r.consumed_minor>cap.amount_minor||r.prefix_sha256!==cap.prefix_sha256)fail('APPROVAL_CONSUMPTION_EVENT_CONFLICT');
   if(r.partial_conversion&&r.consumed_minor!==cap.amount_minor)fail('PARTIAL_CONVERSION_PRINCIPAL_CONFLICT');
   const rev=s.records.filter(x=>x.approval_id===r.approval_id&&['APPROVE','REVISE','REVOKE'].includes(x.action)&&time(x.at)<=time(r.occurred_at)).at(-1);
   if(!rev||rev.sha256!==r.approval_revision_sha256||rev.action==='REVOKE')fail('APPROVAL_EFFECTIVE_REVISION_CONFLICT');
   temporal[r.approval_id]=sum([temporal[r.approval_id]||0,r.consumed_minor]);if(temporal[r.approval_id]>rev.ceiling_minor||a.scope.period_id!==r.period_id)fail('APPROVAL_HISTORICAL_CAPACITY_CONFLICT');
  }
  // Reversed receipts may only cease affecting capacity when their BUY really
  // disappeared or ceased being PLAN_BUY, never merely to free budget.
  for(const r of s.records.filter(r=>r.action==='REVERSE')){const latest=pstore.plan.execution_attributions.filter(a=>a.event_id===r.event_id).at(-1);if(events.some(e=>e.id===r.event_id)&&latest?.action!=='REVOKE'&&latest?.classification==='IN_PLAN'&&!v.consumptions.has(r.event_id))fail('APPROVAL_LIVE_BUY_REVERSAL_REJECTED');}
  return{s,...v,caps};
 }
 function validateTransition(before,after,{operationId,expected,kind}){
  const old=state(before),next=state(after);if(old&&!next)fail('APPROVAL_REMOVAL_REJECTED');if(!next)return;
  const p=plan(after),v=validateState(after,p);
  if(old){if(next.plan_id!==old.plan_id||fp(next.initial_event_pins)!==fp(old.initial_event_pins)||fp(next.records.slice(0,old.records.length))!==fp(old.records)||next.records.length>old.records.length+1)fail('APPROVAL_HISTORY_REWRITE');if(next.records.length===old.records.length&&fp(next)!==fp(old))fail('APPROVAL_UNAUDITED_CHANGE');}
  const added=next.records.slice(old?.records.length||0);if(!old&&(added.length!==1||added[0].action!=='INITIALIZE'||fp(next.initial_event_pins)!==fp(JSON.parse(before[ledger.STORAGE_KEY]).events.map(e=>({event_id:e.id,sha256:fp(e)})))))fail('APPROVAL_EXPLICIT_INITIALIZATION_REQUIRED');
  for(const r of added){if(r.operation_id!==operationId||r.reference.parent_generation_id!==(before[GEN]?JSON.parse(before[GEN]).generation_id:expected.state_sha256)||r.reference.shared_revision!==expected.revision+1)fail('APPROVAL_GENERATION_CONFLICT');
   if(r.plan_revision_reference!==plan(before).plan.revision||r.plan_store_revision_reference!==plan(before).revision)fail('APPROVAL_PLAN_REVISION_CONFLICT');
   if(r.source_ledger_sha256!==expected.ledger_sha256||r.source_cash_sha256!==expected.cash_sha256)fail('APPROVAL_SOURCE_REFERENCE_CONFLICT');
   if(time(r.at)!==time(p.lifecycle.at(-1).at))fail('APPROVAL_COMMIT_CLOCK_CONFLICT');
   if(['CONSUME','REPLACE','REVERSE'].includes(r.action)&&!['TRANSACTION','CLASSIFICATION_ONLY_CHANGE'].includes(kind))fail('APPROVAL_TRANSACTION_ATOMICITY_REQUIRED');
   if(!['CONSUME','REPLACE','REVERSE'].includes(r.action)&&kind!=='APPROVAL_CHANGE')fail('APPROVAL_OPERATION_SCOPE_CONFLICT');
   if(['APPROVE','REVISE','REVOKE','RESERVE'].includes(r.action)){const sc=scope(plan(before),r.at);if(r.scope?.period_id!==sc.period_id||r.scope.period_sha256!==sc.period_sha256||r.action==='APPROVE'&&fp(r.scope)!==fp(sc))fail('APPROVAL_STALE_PERIOD');}
   if(['CONSUME','REPLACE'].includes(r.action)){
    const prior=JSON.parse(before[ledger.STORAGE_KEY]).events.find(e=>e.id===r.event_id),event=JSON.parse(after[ledger.STORAGE_KEY]).events.find(e=>e.id===r.event_id);
    if(!event||prior&&fp(prior)===fp(event))fail('APPROVAL_LATE_CONSUMPTION_REJECTED');
   }
  }
  if(kind==='APPROVAL_CHANGE')for(const k of [ledger.STORAGE_KEY,'hsRadar.portfolio.holdings','hsRadar.portfolio.investableCash.v1',SYNC,'hsRadar.portfolio.snapshotHistory.v1'])if(before[k]!==after[k])fail('APPROVAL_FINANCIAL_BYTES_CHANGED');
  if(kind==='PLAN_RESTORE'&&old&&fp(old)!==fp(next))fail('APPROVAL_RESTORE_VERSION_CONFLICT');
  return v;
 }
 function project(before,after,{plan:p,status,operationId,kind,intent,expected,asOf}){
  const old=state(before),request=kind==='APPROVAL_CHANGE'?intent.approval:intent.accelerationConsumption;
  if(!old&&!request)return after;
  if(!request)return{...after,[KEY]:before[KEY]};
  if(old?.records.some(r=>r.operation_id===operationId))fail('APPROVAL_OPERATION_ID_REUSED');
  if(old&&['CONSUME','REPLACE','RESERVE','REVISE','REVOKE'].includes(request.action)&&read(before,{asOf}).status==='RECONCILIATION_REQUIRED')fail('APPROVAL_USAGE_RECONCILIATION_REQUIRED');
  const conf=confirmation(request.confirmation,asOf),priorStore=plan(before),sc=['RELEASE','REVERSE'].includes(request.action)&&old?replay(old).approvals.get(request.approval_id)?.scope:scope({...priorStore,status},asOf),reference={operation_id:operationId,parent_generation_id:JSON.parse(before[GEN]).generation_id,shared_revision:expected.revision+1};
  let s=old?copy(old):{schema:SCHEMA,version:1,policy:POLICY,strategy_version:strategy().VERSION,reservation_policy:'EXPLICIT_SHARED_COMMIT_ONLY_V1',plan_id:priorStore.plan_id,initial_event_pins:JSON.parse(before[ledger.STORAGE_KEY]).events.map(e=>({event_id:e.id,sha256:fp(e)})),revision:0,records:[]};
  const r={schema:RECORD,version:1,strategy_version:s.strategy_version,index:s.records.length+1,operation_id:operationId,action:request.action,at:asOf,confirmation:conf,plan_id:s.plan_id,plan_revision_reference:priorStore.plan.revision,plan_store_revision_reference:priorStore.revision,source_ledger_sha256:expected.ledger_sha256,source_cash_sha256:expected.cash_sha256,parent_generation_id:reference.parent_generation_id,reference,previous_sha256:s.records.at(-1)?.sha256??null};
  if(!old){if(request.action!=='INITIALIZE'||kind!=='APPROVAL_CHANGE')fail('APPROVAL_EXPLICIT_INITIALIZATION_REQUIRED');}
  else{
   const v=replay(old),id=text(request.approval_id),a=v.approvals.get(id);r.approval_id=id;r.budget_id=a?.budget_id??text(request.budget_id);if(request.budget_id!==undefined&&request.budget_id!==r.budget_id)fail('APPROVAL_BUDGET_ID_CONFLICT');r.scope=a?copy(a.scope):sc;r.lineage_id=a?.lineage_id??fp({approval_id:id,plan_id:sc.plan_id,period_id:sc.period_id,first_operation_id:operationId});
   if(request.expected_approval_sha256!==(a?.sha256??null))fail('APPROVAL_STALE_REVISION');
   if(['APPROVE','REVISE','REVOKE'].includes(request.action)){r.approval_revision=(a?.approval_revision||0)+1;r.previous_approval_sha256=a?.sha256??null;r.ceiling_minor=request.action==='REVOKE'?v.usage(id).consumed:minor(request.ceiling_minor);}
   else if(request.action==='RESERVE'){r.reservation_id=text(request.reservation_id);r.reserved_minor=minor(request.reserved_minor);r.expires_at=request.expires_at;r.approval_revision_sha256=a?.sha256;r.scope=copy(a.scope);if(Object.hasOwn(request,'reservation_semantics'))r.reservation_semantics=copy(request.reservation_semantics);reservationKind(r);if(Object.hasOwn(request,'conversion_contract'))r.conversion_contract=copy(request.conversion_contract);partialPolicy(r);}
   else if(request.action==='RELEASE'){const hold=v.reservations.get(request.reservation_id);r.reservation_id=text(request.reservation_id);r.reservation_sha256=hold?.sha256;if(hold&&partialPolicy(hold)){r.reservation_projection_sha256=hold.projection_sha256;r.reservation_revision=hold.reservation_revision+1;}}
   else if(['CONSUME','REPLACE'].includes(request.action)){
    const rows={...after,[PLAN]:JSON.stringify({...priorStore,plan:p})},caps=excess(rows,p),cap=caps[request.event_id],event=JSON.parse(after[ledger.STORAGE_KEY]).events.find(e=>e.id===request.event_id);
    if(cap?.order_ambiguous)fail('APPROVAL_TRANSACTION_ORDER_AMBIGUOUS');if(!cap||!event||!strategy().ELIGIBLE.includes(event.symbol)||cap.amount_minor===0)fail('APPROVAL_ELIGIBLE_EXCESS_REQUIRED');
    const rev=old.records.find(x=>x.sha256===request.approval_revision_sha256&&x.approval_id===id);if(!rev)fail('APPROVAL_REVISION_REFERENCE_REQUIRED');
    Object.assign(r,{consumption_id:operationId+':consumption',event_id:event.id,event_sha256:fp(event),attribution_sha256:cap.attribution.sha256,attribution_reference:{record_id:cap.attribution.record_id,sha256:cap.attribution.sha256,classification_sha256:cap.attribution.classification_contract?.sha256??null},prefix_sha256:cap.prefix_sha256,consumed_minor:minor(request.consumed_minor),occurred_at:cap.attribution.occurred_at,period_id:cap.attribution.period_id,period_sha256:rev.scope.period_sha256,approval_revision:rev.approval_revision,approval_revision_sha256:rev.sha256,reservation_id:request.reservation_id??null,reversal_reference:v.consumptions.get(event.id)?.sha256??null});
    if(request.partial_conversion){const hold=v.reservations.get(r.reservation_id);if(request.action!=='CONSUME'||fp(request.partial_conversion)!==fp(partialRequest(hold)))fail('PARTIAL_CONVERSION_REVISION_CONFLICT');r.partial_conversion=conversionReceipt(r,hold);}
   }else if(request.action==='REVERSE'){r.event_id=text(request.event_id);r.reversal_reference=v.consumptions.get(r.event_id)?.sha256;}
   else fail('APPROVAL_UNKNOWN_ACTION');
  }
  s.records.push(seal(r));s.revision=s.records.length;return{...after,[KEY]:JSON.stringify(seal(s))};
 }
 function read(entries,{asOf}={}){
  try{
   const p=plan(entries),v=validateState(entries,p);if(!v)return{status:'UNINITIALIZED',consumed_minor:null,reserved_minor:null,remaining_minor:null,reasons:['APPROVAL_CONTRACT_NOT_INITIALIZED']};
   if(time(asOf)<time(v.s.records.at(-1).at))fail('APPROVAL_FUTURE_COMMIT_TIME');
   const sc=scope(p,asOf),a=[...v.approvals.values()].find(a=>a.scope.period_id===sc.period_id),reasons=[];
   if(!a)return{status:'UNINITIALIZED',consumed_minor:null,reserved_minor:null,remaining_minor:null,reasons:['APPROVAL_NOT_CONFIRMED']};
   const usage=v.usage(a.approval_id),unassigned=Object.entries(v.caps).filter(([id,c])=>c.attribution.period_id===sc.period_id&&(c.order_ambiguous||c.amount_minor>(v.consumptions.get(id)?.consumed_minor||0)));
   if(unassigned.length)reasons.push('APPROVAL_UNATTRIBUTED_EXCESS_REQUIRES_REVIEW');
   if([...v.reservations.values()].some(r=>r.status==='ACTIVE'&&r.scope.period_id!==sc.period_id))reasons.push('APPROVAL_PRIOR_RESERVATION_REQUIRES_LOCKED_RELEASE');
   if([...v.reservations.values()].some(r=>r.approval_id===a.approval_id&&r.status==='ACTIVE'&&time(r.expires_at)<=time(asOf)))reasons.push('APPROVAL_RESERVATION_EXPIRY_REQUIRES_LOCKED_RELEASE');
   const result={schema:POLICY,status:reasons.length?'RECONCILIATION_REQUIRED':a.action==='REVOKE'?'REVOKED':'VALID',approval_id:a.approval_id,budget_id:a.budget_id,approval_revision:a.approval_revision,approval_sha256:a.sha256,lineage_id:a.lineage_id,authorized_minor:a.ceiling_minor,consumed_minor:usage.consumed,reserved_minor:usage.reserved,remaining_minor:reasons.length?null:a.ceiling_minor-usage.consumed-usage.reserved,plan_id:p.plan_id,plan_revision:p.revision,period_id:sc.period_id,period_sha256:sc.period_sha256,generation:JSON.parse(entries[GEN]),store_sha256:v.s.sha256,reasons,writes:false};return{...result,evidence_sha256:fp(result)};
  }catch(e){return{status:'RECONCILIATION_REQUIRED',consumed_minor:null,reserved_minor:null,remaining_minor:null,reasons:[e.message],writes:false};}
 }
 function validateExecution(entries,operationId,asOf){
  const s=state(entries),r=s?.records.at(-1);if(!r||r.operation_id!==operationId)return;
  if(r.action==='RESERVE'&&time(asOf)>=time(r.expires_at))fail('APPROVAL_RESERVATION_EXPIRED_BEFORE_LOCK');
  if(['CONSUME','REPLACE'].includes(r.action)&&r.reservation_id){const hold=replay(s).reservations.get(r.reservation_id);if(!hold||time(asOf)>=time(hold.expires_at))fail('APPROVAL_RESERVATION_EXPIRED_BEFORE_LOCK');}
 }
 return Object.freeze({KEY,POLICY,SCHEMA,RECORD,seal,fp,state,replay,validateState,validateTransition,validateExecution,project,read,excess,settings,reservationKind,budgetOnlyReserved,PARTIAL,partialRequest,validatePublication,conversionEvidence});
});

;
/* sealed source: portfolio-full-backup-core.js */
(function(root,factory){const dependencies=typeof module==="object"&&module.exports?{portfolio:require("./portfolio-core.js"),ledger:require("./portfolio-ledger-core.js"),performance:require("./portfolio-performance-core.js"),dashboard:require("./portfolio-dashboard-core.js")}: {portfolio:root.HSPortfolioCore,ledger:root.HSPortfolioLedgerCore,performance:root.HSPortfolioPerformanceCore,dashboard:root.HSPortfolioDashboardCore};const api=factory(dependencies);if(typeof module==="object"&&module.exports)module.exports=api;if(root)root.HSPortfolioFullBackupCore=api;})(typeof window!=="undefined"?window:globalThis,function(dependencies){
  "use strict";
  const {portfolio,ledger,performance,dashboard}=dependencies;
  const resilience=typeof module==="object"&&module.exports?require("./portfolio-resilience-core.js"):globalThis.HSPortfolioResilienceCore;
  const SCHEMA="HS_PORTFOLIO_FULL_BACKUP_V1",SCHEMA_VERSION=1,PREFIX="hsRadar.portfolio.",JOURNAL_KEY=`${PREFIX}preRestoreJournal.v1`;
  const EXCLUDED=new Set([`${PREFIX}quotes`,`${PREFIX}marketVersion`,JOURNAL_KEY,`${PREFIX}writeCoordination.v1`,`${PREFIX}writeJournal.v1`,"hs_portfolio_quotes_v1","hs_portfolio_market_version_v1"]);
  const LEGACY_KEYS=new Set(["hs_portfolio_v6","hs_portfolio_auto_v1"]);
  const HOLDINGS_KEY=`${PREFIX}holdings`,SETTINGS_KEY=`${PREFIX}rebalanceSettings`;
  const JSON_KEYS=new Set([HOLDINGS_KEY,SETTINGS_KEY,ledger.STORAGE_KEY,ledger.LEGACY_BACKUP_KEY,performance.STORAGE_KEY,`${PREFIX}goal.v1`,`${PREFIX}monthlyPlan.v1`,`${PREFIX}importState.v1`,`${PREFIX}recoveryPoints.v1`,`${PREFIX}importHistory.v1`,"hs_portfolio_v6"]);
  const isPortfolioKey=key=>(key.startsWith(PREFIX)||LEGACY_KEYS.has(key))&&!EXCLUDED.has(key);
  const own=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);
  const plain=value=>Boolean(value&&typeof value==="object"&&!Array.isArray(value));
  const parse=(value,fallback)=>value===undefined?fallback:JSON.parse(value);
  const PLAN_KEY=PREFIX+"capitalBuildPlans.v1",GEN_KEY=PREFIX+"capitalGeneration.v1";
  function planContract(){const api=typeof module==="object"&&module.exports?require("./portfolio-plan-generation-core"):globalThis.HSPortfolioPlanGenerationCore;if(!api)throw Error("PLAN_VALIDATOR_UNAVAILABLE");return api;}
  function collectEntries(storage){const entries={};for(let index=0;index<storage.length;index++){const key=storage.key(index);if(key&&isPortfolioKey(key))entries[key]=storage.getItem(key)}return Object.fromEntries(Object.entries(entries).sort(([a],[b])=>a.localeCompare(b)))}
  function validateSettings(value){if(!plain(value))throw new Error("INVALID_REBALANCE_SETTINGS");const finite=(number,min,max)=>typeof number==="number"&&Number.isFinite(number)&&number>=min&&number<=max;
    if(!finite(value.cash,-Number.MAX_VALUE,Number.MAX_VALUE)||!["conservative","balanced","trend","custom"].includes(value.profile)||!finite(value.customTolerance,0,20)||!finite(value.customDays,7,365)||!["30","90","custom"].includes(String(value.reminder))||typeof value.cashFirst!=="boolean"||typeof value.trendProtection!=="boolean"||!plain(value.targets))throw new Error("INVALID_REBALANCE_SETTINGS");
    for(const [code,target] of Object.entries(value.targets))if(!portfolio.CODE_PATTERN.test(code)||!dashboard.normalizeTarget(target).ok||target!==null&&typeof target!=="number")throw new Error("INVALID_TARGET");
  }
  function describe(entries){const holdings=parse(entries[HOLDINGS_KEY],[]),settings=parse(entries[SETTINGS_KEY],{cash:0,profile:"trend",customTolerance:3,reminder:"90",customDays:60,cashFirst:true,trendProtection:true,targets:{}});
    if(!Array.isArray(holdings))throw new Error("INVALID_HOLDINGS");portfolio.validateImportPayload(holdings);validateSettings(settings);
    if(own(entries,ledger.STORAGE_KEY)&&entries[ledger.STORAGE_KEY]!=="null"&&!ledger.validateLedger(parse(entries[ledger.STORAGE_KEY])))throw new Error("INVALID_LEDGER");
    const snapshots=parse(entries[performance.STORAGE_KEY],[]);if(!Array.isArray(snapshots)||snapshots.some(row=>!performance.validateSnapshot(row)))throw new Error("INVALID_SNAPSHOTS");
    for(const key of JSON_KEYS)if(own(entries,key))parse(entries[key]);
    if(own(entries,resilience.CASH_KEY))resilience.validateCashStore(JSON.parse(entries[resilience.CASH_KEY]));
    const actual=new Map(holdings.map(row=>[row.code,row.shares]));const universe=[...new Set([...actual.keys(),...Object.keys(settings.targets)])].sort().map(code=>({code,quantity:actual.get(code)||0}));
    const generation=own(entries,PLAN_KEY)||own(entries,GEN_KEY)||own(entries,PREFIX+'accelerationConsumption.v1')?planContract().validateEntries(entries):null;
    return{holdings,targets:settings.targets,cash:settings.cash,universe,rebalanceSettings:settings,ledgerPresent:Boolean(own(entries,ledger.STORAGE_KEY)&&entries[ledger.STORAGE_KEY]!=="null"),snapshotCount:snapshots.length,...(generation?{capitalBuildPlan:{plan_id:JSON.parse(entries[PLAN_KEY]).plan_id,revision:JSON.parse(entries[PLAN_KEY]).revision,generation_id:generation.generation_id}}:{})};
  }
  function coordinator(){return typeof module==="object"&&module.exports?require("./portfolio-write-coordinator.js"):globalThis.HSPortfolioWriteCoordinator;}
  function validateNewData(entries,asOf,meta,commitJournal){const syncKey=PREFIX+"transactionCashSync.v1",archiveKey=PREFIX+"transactionCashArchives.v1";if(Object.hasOwn(entries,syncKey)||Object.hasOwn(entries,archiveKey)||own(entries,PLAN_KEY)||own(entries,GEN_KEY)||meta){const c=coordinator();if(!c)throw Error("COORDINATOR_UNAVAILABLE");c.validateEntries(entries,asOf);if(!meta)throw Error("COORDINATION_RECEIPT_REQUIRED");c.validateMeta(meta,entries);if(own(entries,PLAN_KEY)||own(entries,GEN_KEY)){if(!commitJournal)throw Error("PLAN_BACKUP_COMMIT_PROOF_REQUIRED");c.validateJournal(commitJournal);if(commitJournal.status!=="COMMITTED"||resilienceHash(commitJournal.after)!==resilienceHash(entries)||resilienceHash(JSON.parse(commitJournal.after_meta_raw))!==resilienceHash(meta))throw Error("PLAN_BACKUP_NOT_COMMITTED");planContract().validateCommitted(entries,{meta,journal:commitJournal});}}}
  function newState(storage,backup){return storage.getItem(resilience.CASH_KEY)!==null||storage.getItem(PREFIX+"writeCoordination.v1")!==null||storage.getItem(PREFIX+"writeJournal.v1")!==null||storage.getItem(PREFIX+"transactionCashSync.v1")!==null||storage.getItem(PLAN_KEY)!==null||storage.getItem(GEN_KEY)!==null||Boolean(backup?.coordination)||Object.hasOwn(backup?.storage||{},resilience.CASH_KEY)||Object.hasOwn(backup?.storage||{},PREFIX+"transactionCashSync.v1")||own(backup?.storage||{},PLAN_KEY)||own(backup?.storage||{},GEN_KEY);}
  function createBackup(storage,{exportedAt=new Date().toISOString()}={}){
    if(storage.getItem(JOURNAL_KEY)!==null)throw Error("RESTORE_IN_PROGRESS");
    const c=coordinator(),raw=storage.getItem(PREFIX+"writeCoordination.v1"),j=storage.getItem(PREFIX+"writeJournal.v1");
    let captured=null;if(raw!==null||j!==null){if(!c)throw Error("COORDINATOR_UNAVAILABLE");captured=c.capture(storage,{asOf:exportedAt});}
    const entries=collectEntries(storage),meta=raw===null?null:JSON.parse(raw),hasPlan=own(entries,PLAN_KEY)||own(entries,GEN_KEY),proof=hasPlan&&j!==null?JSON.parse(j):null;validateNewData(entries,exportedAt,meta,proof);const portfolioState=describe(entries);
    const payload={schema:SCHEMA,schemaVersion:SCHEMA_VERSION,exportedAt,portfolio:portfolioState,storage:entries,...(meta?{coordination:meta}:{}),...(hasPlan?{planCommitJournal:proof}:{})};
    if(hasPlan){if(!captured||c.capture(storage,{asOf:exportedAt}).state_sha256!==captured.state_sha256)throw Error("BACKUP_CHANGED_DURING_CAPTURE");if(JSON.stringify(payload).length>5*1024*1024)throw Error("BACKUP_TOO_LARGE");}
    return payload;
  }
  function validateBackup(raw){try{if(!plain(raw)||raw.schema!==SCHEMA||raw.schemaVersion!==SCHEMA_VERSION||!Number.isFinite(Date.parse(raw.exportedAt))||!plain(raw.storage)||!plain(raw.portfolio))throw new Error("INVALID_SCHEMA");const entries=raw.storage;
      if(JSON.stringify(raw).length>5*1024*1024)throw new Error("BACKUP_TOO_LARGE");
      for(const [key,value] of Object.entries(entries))if(!isPortfolioKey(key)||typeof value!=="string")throw new Error("INVALID_STORAGE_ENTRY");
      validateNewData(entries,raw.exportedAt,raw.coordination,raw.planCommitJournal);const state=describe(entries);if(JSON.stringify(raw.portfolio)!==JSON.stringify(state))throw new Error("BACKUP_MISMATCH");
      return{ok:true,status:"VALID",state,entries};
    }catch(error){return{ok:false,status:error instanceof SyntaxError?"INVALID_JSON":String(error.message||"INVALID_BACKUP")}}}
  function writeEntries(storage,entries){const current=collectEntries(storage);for(const key of Object.keys(current))if(!own(entries,key))storage.removeItem(key);for(const [key,value] of Object.entries(entries))storage.setItem(key,value)}
  function recoverPendingRestore(storage,{defer=false}={}){const raw=storage.getItem(JOURNAL_KEY);if(raw===null)return{ok:true,status:"NONE"};try{const journal=JSON.parse(raw);if(!plain(journal)||!plain(journal.entries))throw new Error("INVALID_JOURNAL");for(const [key,value] of Object.entries(journal.entries))if(!isPortfolioKey(key)||typeof value!=="string")throw new Error("INVALID_JOURNAL");if(defer)return{ok:true,status:"PENDING",requiresCashLock:true};return{ok:false,status:"RECOVERY_REQUIRED",reason:"LEGACY_JOURNAL_HAS_NO_EXPECTED_CURRENT_VERSION"};}catch{return{ok:false,status:"RECOVERY_FAILED"}}}
  function restoreAtomic(storage,backup){const checked=validateBackup(backup);if(!checked.ok)return checked;if(newState(storage,backup))return{ok:false,status:"COORDINATOR_REQUIRED"};let before;try{const recovered=recoverPendingRestore(storage);if(!recovered.ok)return recovered;before=collectEntries(storage);storage.setItem(JOURNAL_KEY,JSON.stringify({schema:SCHEMA,entries:before}));writeEntries(storage,checked.entries);if(JSON.stringify(collectEntries(storage))!==JSON.stringify(Object.fromEntries(Object.entries(checked.entries).sort(([a],[b])=>a.localeCompare(b)))))throw new Error("RESTORE_VERIFY_FAILED");storage.removeItem(JOURNAL_KEY);return{ok:true,status:"RESTORED",before}}catch{try{if(before)writeEntries(storage,before);storage.removeItem(JOURNAL_KEY);return{ok:false,status:"RESTORE_ROLLED_BACK"}}catch{return{ok:false,status:"RECOVERY_REQUIRED"}}}}
  function previewCoordinatedRestore(storage,backup,{asOf}={}){
    const c=coordinator(),checked=validateBackup(backup);if(!checked.ok)return checked;
    try{if(!c)throw Error("COORDINATOR_UNAVAILABLE");const expected=c.capture(storage,{asOf}),entries=cloneEntries(checked.entries),migrations=[];
      if(storage.getItem(PLAN_KEY)!==null&&!own(entries,PLAN_KEY))throw Error("PLAN_REMOVAL_REQUIRES_EXPLICIT_UI_CONTRACT");
      for(const [from,to] of [["hs_portfolio_v6",HOLDINGS_KEY],["hs_portfolio_auto_v1",PREFIX+"autoRefresh"]])if(Object.hasOwn(entries,from)&&!Object.hasOwn(entries,to)){entries[to]=from==="hs_portfolio_v6"?JSON.stringify(portfolio.validateImportPayload(JSON.parse(entries[from]))):entries[from];migrations.push({from,to});}
      const current=JSON.parse(storage.getItem(ledger.STORAGE_KEY)||"null"),target=JSON.parse(entries[ledger.STORAGE_KEY]||"null");
      const targetMap=new Map((target?.events||[]).map(e=>[e.id,resilienceHash(e)]));const affected=(current?.events||[]).filter(e=>targetMap.get(e.id)!==resilienceHash(e)).map(e=>e.id).sort();
      const body={schema:"HS_PORTFOLIO_RESTORE_PREVIEW_V1",expected,entries,migrations,affected_event_ids:affected,backup_sha256:resilienceHash(backup),...(own(entries,PLAN_KEY)?{classificationRestoreProof:{meta:backup.coordination,journal:backup.planCommitJournal}}:{})};return{ok:true,...body,digest:resilienceHash(body)};
    }catch(e){return{ok:false,status:"CONFLICT",reason:e.message};}
  }
  const resilienceHash=value=>(typeof module==="object"&&module.exports?require("./portfolio-investable-cash-core.js"):globalThis.HSPortfolioInvestableCashCore).fingerprint(value);
  const cloneEntries=e=>JSON.parse(JSON.stringify(e));
  async function restoreCoordinated(storage,preview,{locks,operationId,asOf,acknowledgement,signal,hook}={}){
    try{const{ok,digest,...body}=preview;if(ok!==true||resilienceHash(body)!==digest||acknowledgement?.digest!==digest||resilienceHash(acknowledgement.affected_event_ids)!==resilienceHash(preview.affected_event_ids))throw Error("RESTORE_RECONFIRMATION_REQUIRED");const c=coordinator();if(!c)throw Error("COORDINATOR_UNAVAILABLE");
      const hasPlan=own(preview.entries,PLAN_KEY),kind=hasPlan?"PLAN_RESTORE":"RESTORE";
      return await c.service(storage,{locks,hook,validate:(entries,clock)=>{describe(entries);c.validateEntries(entries,clock);}}).execute({operationId,kind,intent:{preview_digest:digest},expected:preview.expected,plan:()=>{
        if(!hasPlan)return cloneEntries(preview.entries);
        const adapter=typeof module==="object"&&module.exports?require("./portfolio-capital-build-storage-adapter"):globalThis.HSPortfolioCapitalBuildStorageAdapter;
        if(!adapter)throw Error("PLAN_RESTORE_ADAPTER_REQUIRED");return adapter.rebaseForRestore(storage,cloneEntries(preview.entries),{operationId,asOf,expected:preview.expected,confirmationReference:digest,classificationRestoreProof:preview.classificationRestoreProof});
      },asOf,signal});
    }catch(e){return{ok:false,status:"CONFLICT",reason:e.message};}
  }
  async function createCoordinatedRecoveryPoint(storage,{locks,expected,operationId,reason,asOf,signal}={}){const c=coordinator();if(!c)return{ok:false,status:"COORDINATOR_UNAVAILABLE"};return c.service(storage,{locks}).execute({operationId,kind:"RECOVERY_POINT",intent:{reason,asOf},expected,asOf,signal,plan:entries=>{
    const payload=createBackup(storage,{exportedAt:asOf}),points=JSON.parse(entries[`${PREFIX}recoveryPoints.v1`]||"[]");points.push({kind:"HS_COORDINATED_RECOVERY_POINT_V1",id:operationId,createdAt:asOf,reason,backup:payload});return{...entries,[`${PREFIX}recoveryPoints.v1`]:JSON.stringify(points)};
  }});}
  return Object.freeze({SCHEMA,SCHEMA_VERSION,JOURNAL_KEY,collectEntries,createBackup,validateBackup,validateStorageEntries:describe,restoreAtomic,recoverPendingRestore,previewCoordinatedRestore,restoreCoordinated,createCoordinatedRecoveryPoint});
});

;
/* sealed source: portfolio-transaction-storage-adapter.js */
(function(root,factory){
 const api=typeof module==="object"&&module.exports?factory(require("./portfolio-ledger-core"),require("./portfolio-investable-cash-core"),require("./portfolio-dividend-receipt-v2-core"),require("./portfolio-transaction-cash-sync-core"),require("./portfolio-write-coordinator"),require("./portfolio-resilience-core"),require("./portfolio-full-backup-core")):factory(root.HSPortfolioLedgerCore,root.HSPortfolioInvestableCashCore,root.HSPortfolioDividendReceiptV2Core,root.HSPortfolioTransactionCashSyncCore,root.HSPortfolioWriteCoordinator,root.HSPortfolioResilienceCore,root.HSPortfolioFullBackupCore);
 if(typeof module==="object"&&module.exports)module.exports=api;if(root)root.HSPortfolioTransactionStorageAdapter=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(ledger,cash,dividend,sync,c,r,backup){
 "use strict";
 const HOLDINGS="hsRadar.portfolio.holdings",clone=v=>JSON.parse(JSON.stringify(v)),fp=cash.fingerprint;
 const fail=s=>{throw Error(s);};
 function confirmation(reference,at){if(typeof reference!=="string"||!reference.trim())fail("USER_CONFIRMATION_SOURCE_REQUIRED");return{kind:"USER_CONFIRMED",reference:reference.trim(),confirmed_at:at};}
 function metadata(e,baseline,input,asOf){
  const pending=input.state==="PENDING",credit=["SELL","DIVIDEND"].includes(e.type),zero=["OPENING_POSITION","POSITION_CORRECTION"].includes(e.type);
  if(input.confirmed!==true)fail("EXPLICIT_USER_CONFIRMATION_REQUIRED");
  if(!["AVAILABLE","PENDING"].includes(input.state))fail("RECONCILIATION_REQUIRED");
  if(!credit&&pending)fail("UNCONFIRMED_DEBIT_OR_TRANSFER");
  const conf=confirmation(input.source,asOf),coverage={baseline_id:baseline.baseline_id,baseline_sha256:baseline.baseline_sha256,disposition:input.coverage,confirmation:conf};
  return sync.createMetadata({event:e,record_id:input.recordId,occurred_at:e.timestamp,recorded_at:e.createdAt,
   state:pending?"PENDING":"AVAILABLE",received_at:pending?null:credit?input.receivedAt:asOf,
   available_at:pending?null:credit?input.availableAt:asOf,
   net_minor:pending?null:zero?0:credit?cash.toMinorUnits(input.net):cash.eventAmountMinor(e),
   investment_account:credit?input.investmentAccount:true,payment_reference:input.paymentReference,confirmation:pending?null:conf,
   dividend_receipt_version:e.type==="DIVIDEND"?input.dividendVersion:null,baseline_coverage:coverage,fee_tax_review:[]});
 }
 function transactionPlan(entries,{operation,input},operationId,asOf){
  const original=ledger.validateLedger(JSON.parse(entries[ledger.STORAGE_KEY]||"null"));if(!original)fail("VALID_LEDGER_REQUIRED");
  if(entries[r.CASH_KEY]===undefined)fail("UNINITIALIZED");
  const cs=r.validateCashStore(JSON.parse(entries[r.CASH_KEY])),baseline=cs.checkpoints.at(-1)?.baseline;if(!baseline)fail("UNINITIALIZED");
  const raw=entries[c.SYNC_KEY]?sync.validateStore(JSON.parse(entries[c.SYNC_KEY]),{asOf}):sync.createStore({baseline,events:original.events,metadata:{},dividendReceipts:[],ledgerComplete:true},asOf);
  const next=clone(raw.state);let updated=original,event;
  if(operation.type==="RECEIPT"){event=original.events.find(e=>e.id===operation.id);if(!event||!["SELL","DIVIDEND"].includes(event.type))fail("RECEIPT_EVENT_REQUIRED");}
  else{
   if(!["ADD","EDIT","DELETE"].includes(operation.type))fail("INVALID_OPERATION");
   const result=ledger.mutateLedger(original,operation);if(!result.ok)fail(result.status);
   updated=result.ledger;next.events=updated.events;
   event=updated.events.find(e=>e.id===(operation.id||operation.event?.id));
  }
  const id=operation.id||event?.id;
  if(operation.type==="DELETE"){delete next.metadata[id];next.dividendReceipts=next.dividendReceipts.filter(x=>x.event_id!==id);if(next.coverageReviews)next.coverageReviews=next.coverageReviews.filter(x=>x.event_id!==id);}
  else if(event.type==="BUY"&&input.buyCoverage!==undefined){
   if(input.confirmed!==true)fail("EXPLICIT_USER_CONFIRMATION_REQUIRED");
   const review=sync.createBuyCoverageReview({event,baseline:sync.evidenceBaseline(baseline,event.id),recordId:input.recordId,disposition:input.buyCoverage,occurredAt:input.occurredAt,recordedAt:event.createdAt,confirmedAt:asOf,source:input.source});
   next.schema=sync.REVIEWED_STATE;next.coverageReviews=[...(next.coverageReviews||[]).filter(r=>r.event_id!==id),review];delete next.metadata[id];
  }
  else{
   if(!["BUY","SELL","DIVIDEND","DEPOSIT","WITHDRAWAL","POSITION_CORRECTION"].includes(event.type))fail("UNSUPPORTED_UI_EVENT");
   const evidenceBase=sync.evidenceBaseline(baseline,event.id);
   const m=metadata(event,evidenceBase,input,asOf);next.metadata[id]=m;next.dividendReceipts=next.dividendReceipts.filter(x=>x.event_id!==id);
   if(event.type==="DIVIDEND"&&input.dividendVersion===2){
    next.dividendReceipts.push(dividend.createReceipt({event,record_id:input.receiptId,gross_amount_minor:cash.toMinorUnits(event.grossAmount),
     deductions:input.deductions,net_received_minor:m.net_minor,receipt_state:m.state==="PENDING"?"PENDING":"CONFIRMED",
     received_at:m.received_at,available_at:m.available_at,investment_account:m.investment_account,
     confirmation:m.confirmation?{...m.confirmation,kind:"USER_CONFIRMATION"}:null,payment_reference:m.payment_reference,
     baseline_coverage:{...m.baseline_coverage,confirmation:{...m.baseline_coverage.confirmation,kind:"USER_CONFIRMATION"}},fee_tax_review:[]}));
   }
  }
  // A private plan buffer, not a second persistent Ledger. Shared storage is
  // published only by coordinator.execute while the actual Web Lock is held.
  let buffer=raw;const service=sync.service({contract:"ATOMIC_CROSS_CONTEXT_CAS_V1",read:()=>buffer,compareAndSwap(hash,value){if(hash!==buffer.sha256)return false;buffer=value;return true;}});
  const prepared=service.prepare({transactionId:operationId,expectedRevision:raw.revision,nextState:next,asOf});if(!prepared.ok)fail(prepared.reason||prepared.status);
  const committed=service.commit({transactionId:operationId,journalSha256:prepared.journal_sha256,asOf});if(!committed.ok)fail(committed.reason||committed.status);
  const previous=new Map(JSON.parse(entries[HOLDINGS]||"[]").map(h=>[h.code,h]));
  const state=ledger.derivePortfolioStateFromLedger(updated.events);
  const after={...entries,[ledger.STORAGE_KEY]:JSON.stringify(updated),[HOLDINGS]:JSON.stringify(state.holdings.map(h=>({...previous.get(h.symbol),code:h.symbol,shares:h.quantity,averageCost:h.averageCost}))),[c.SYNC_KEY]:JSON.stringify(buffer)};
  c.validateEntries(after,asOf);return after;
 }
 async function checkpointPlan(entries,input,operationId,asOf){
  const after={...entries};
  if(!after[ledger.STORAGE_KEY]){
   const holdings=JSON.parse(after[HOLDINGS]||"[]");
   if(holdings.length)fail("EXPLICIT_LEDGER_MIGRATION_REQUIRED");
   after[ledger.STORAGE_KEY]=JSON.stringify(ledger.migrateLegacyPortfolio({holdings:[],cash:0,tradeDate:new Date(Date.parse(asOf)+28800000).toISOString().slice(0,10),timestamp:asOf}));
   after[HOLDINGS]="[]";
  }
  if(after[c.SYNC_KEY]){
   const previous=sync.validateStore(JSON.parse(after[c.SYNC_KEY]),{asOf}),old=r.validateCashStore(JSON.parse(after[r.CASH_KEY]));
   if(old.checkpoints.some(row=>row.baseline.baseline_id===input.baselineId))fail("DUPLICATE_BASELINE_ID");
   const baseline=sync.createCheckpointV2({baselineId:input.baselineId,amount:input.amount,confirmedAt:asOf,state:previous.state,
    ledgerRevision:input.expectedLedgerRevision,ledgerRawSha256:fp(after[ledger.STORAGE_KEY]),reconciliation:input.reconciliation??null});
   const row={baseline,source:{ledger_raw:after[ledger.STORAGE_KEY],holdings_raw:null},previous_sha256:old.checkpoints.at(-1)?.checkpoint_sha256??null};
   const body={...old,revision:old.revision+1,checkpoints:[...old.checkpoints,{...row,checkpoint_sha256:fp(row)}]};delete body.sha256;
   return c.replaceCheckpoint(after,JSON.stringify(r.validateCashStore({...body,sha256:fp(body)})),{asOf,archiveId:operationId});
  }
  // Keep the unchanged V1 initial baseline contract. Ambiguous existing receipts are
  // rejected, not reinterpreted as included cash or silently promoted to V2.
  const data={...after};delete data[c.SYNC_KEY];delete data[c.ARCHIVE_KEY];
  const memory={getItem:k=>data[k]??null,setItem:(k,v)=>{data[k]=String(v);}};
  const result=await r.confirmInvestableCash(memory,{baselineId:input.baselineId,amount:input.amount,confirmedAt:asOf,expectedRaw:data[r.CASH_KEY]??null,expectedSource:r.cashSourceFingerprint(memory),locks:{request:async(n,o,fn)=>fn()}});
  if(!result.ok)fail(result.status);
  const next=c.replaceCheckpoint(after,data[r.CASH_KEY],{asOf,archiveId:operationId});
  if(!next[c.SYNC_KEY])next[c.SYNC_KEY]=JSON.stringify(sync.createStore({baseline:JSON.parse(next[r.CASH_KEY]).checkpoints.at(-1).baseline,events:JSON.parse(next[ledger.STORAGE_KEY]).events,metadata:{},dividendReceipts:[],ledgerComplete:true},asOf));
  c.validateEntries(next,asOf);return next;
 }
 function service(storage,{locks,hook}={}){
  const coordinator=c.service(storage,{locks,hook});
  async function plan(entries,kind,intent,id,asOf,expected){return kind==="CASH_CHECKPOINT"?checkpointPlan(entries,{...intent,expectedLedgerRevision:expected.ledger_revision},id,asOf):kind==="TRANSACTION"?transactionPlan(entries,intent,id,asOf):fail("INVALID_KIND");}
  return Object.freeze({
   initialize:options=>coordinator.initialize(options),
   snapshot:options=>coordinator.snapshot(options),
   async preview({operationId,kind,intent,expected,asOf}){
    const current=coordinator.snapshot({asOf});if(fp(current)!==fp(expected))fail("STALE_PREVIEW");
    const entries=await plan(c.collect(storage),kind,clone(intent),operationId,asOf,expected),raw=JSON.parse(entries[c.SYNC_KEY]);
    const body={operationId,kind,intent:clone(intent),expected:clone(expected),asOf,after_sha256:fp(entries)};
    return{...body,digest:fp(body),cash:sync.derive({...raw.state,asOf}),holdings:JSON.parse(entries[HOLDINGS]),eventCount:JSON.parse(entries[ledger.STORAGE_KEY]).events.length};
   },
   commit(preview,{signal,onPhase}={}){
    const{digest,cash:ignored,holdings,eventCount,...body}=preview;
    if(fp(body)!==digest)return Promise.resolve({ok:false,status:"CONFLICT",reason:"PREVIEW_DIGEST_MISMATCH"});
    return coordinator.execute({...body,signal,onPhase,asOf:body.asOf,plan:async entries=>{const next=await plan(entries,body.kind,body.intent,body.operationId,body.asOf,body.expected);if(fp(next)!==body.after_sha256)fail("PREVIEW_PLAN_CHANGED");return next;}});
   },
   recover:options=>coordinator.recover(options),
   restorePreview:(payload,options)=>backup.previewCoordinatedRestore(storage,payload,options),
   restore:(preview,options)=>backup.restoreCoordinated(storage,preview,{...options,locks,hook}),
   backup:options=>backup.createBackup(storage,options),
   recoveryPoint:options=>backup.createCoordinatedRecoveryPoint(storage,{...options,locks})
  });
 }
 return Object.freeze({service,transactionPlan,checkpointPlan});
});

;
/* sealed source: portfolio-backup-crypto-core.js */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.HSPortfolioBackupCrypto=api;})(globalThis,function(){
 'use strict';
 const SCHEMA='HS_ENCRYPTED_PORTFOLIO_BACKUP_V1',iterations=310000,maximum=5*1024*1024;
 const encode=new TextEncoder(),decode=new TextDecoder('utf-8',{fatal:true});
 const bytes=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
 function base64(b){let out='';for(let i=0;i<b.length;i+=8192)out+=String.fromCharCode(...b.subarray(i,i+8192));return btoa(out);}
 function password(p){if(typeof p!=='string'||p.length<12||p.length>1024)throw Error('BACKUP_PASSWORD_MIN_12');if(!globalThis.crypto?.subtle)throw Error('SECURE_WEB_CRYPTO_REQUIRED');}
 async function key(p,salt){const material=await crypto.subtle.importKey('raw',encode.encode(p),'PBKDF2',false,['deriveKey']);return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);}
 async function encrypt(payload,p){password(p);const clear=encode.encode(JSON.stringify(payload));if(clear.length>maximum)throw Error('BACKUP_TOO_LARGE');const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12)),header={schema:SCHEMA,version:1,cipher:'AES-256-GCM',kdf:'PBKDF2-SHA256',iterations,salt:base64(salt),iv:base64(iv)},ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encode.encode(JSON.stringify(header)),tagLength:128},await key(p,salt),clear);return{...header,ciphertext:base64(new Uint8Array(ciphertext))};}
 async function decrypt(envelope,p){password(p);if(!envelope||JSON.stringify(envelope).length>8*1024*1024||Object.keys(envelope).sort().join(',')!=='cipher,ciphertext,iterations,iv,kdf,salt,schema,version'||envelope.schema!==SCHEMA||envelope.version!==1||envelope.cipher!=='AES-256-GCM'||envelope.kdf!=='PBKDF2-SHA256'||envelope.iterations!==iterations)throw Error('INVALID_ENCRYPTED_BACKUP');try{const salt=bytes(envelope.salt),iv=bytes(envelope.iv),cipher=bytes(envelope.ciphertext);if(salt.length!==16||iv.length!==12||cipher.length>maximum+16||cipher.length<16)throw Error('INVALID');const header={schema:SCHEMA,version:1,cipher:'AES-256-GCM',kdf:'PBKDF2-SHA256',iterations,salt:envelope.salt,iv:envelope.iv},clear=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:encode.encode(JSON.stringify(header)),tagLength:128},await key(p,salt),cipher);return JSON.parse(decode.decode(clear));}catch{throw Error('BACKUP_AUTHENTICATION_FAILED');}}
 return Object.freeze({SCHEMA,encrypt,decrypt});
});

;
/* sealed source: portfolio-simple-holdings-core.js */
(function(root,factory){const node=typeof module==='object'&&module.exports,api=factory(node?require('./portfolio-investable-cash-core'):root.HSPortfolioInvestableCashCore);if(node)module.exports=api;if(root)root.HSPortfolioSimpleHoldings=api;})(globalThis,function(cash){
 'use strict';
 const KEY='hsRadar.portfolio.simpleHoldings.v1',SCHEMA='HS_SIMPLE_HOLDINGS_V1',basis='BROKER_BREAK_EVEN_USER_CONFIRMED',fp=cash.fingerprint;
 const seal=b=>({...b,sha256:fp(b)}),time=s=>typeof s==='string'&&/T.*(?:Z|[+-]\d\d:\d\d)$/.test(s)&&Number.isFinite(Date.parse(s));
 function positive(s){if(!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(String(s))||!Number.isFinite(Number(s))||Number(s)<=0||Number(s)>1e12)throw Error('請輸入有效的正數，最多八位小數');return Number(s);}
 function record({symbol,name,shares,break_even_price,created_at,updated_at}){if(!/^[0-9A-Z]{4,10}$/.test(symbol)||!time(created_at)||!time(updated_at)||Date.parse(updated_at)<Date.parse(created_at))throw Error('INVALID_HOLDING_ID_OR_TIME');return{symbol,name:String(name||symbol).trim().slice(0,100),shares:positive(shares),break_even_price:positive(break_even_price),price_basis:basis,created_at,updated_at};}
 function empty(){return seal({schema:SCHEMA,version:1,revision:0,records:[]});}
 const SCHEMA_V2='HS_SIMPLE_HOLDINGS_V2';
 function validate(store){const{sha256,...body}=store||{};if(!((body.schema===SCHEMA&&body.version===1)||(body.schema===SCHEMA_V2&&body.version===2))||!Number.isSafeInteger(body.revision)||body.revision<0||!Array.isArray(body.records)||body.records.length>1000||fp(body)!==sha256)throw Error('INVALID_SIMPLE_HOLDINGS');const seen=new Set();for(const r of body.records){if(seen.has(r.symbol)||r.price_basis!==basis||fp(record(r))!==fp(r))throw Error('INVALID_SIMPLE_HOLDING_RECORD');seen.add(r.symbol);}if(body.version===2){if(!Array.isArray(body.deleted)||body.deleted.length>1000)throw Error('INVALID_DELETED_HOLDINGS');const ids=new Set();for(const d of body.deleted){if(typeof d.deletion_id!=='string'||!d.deletion_id||d.deletion_id.length>120||ids.has(d.deletion_id)||!time(d.deleted_at)||Date.parse(d.deleted_at)<Date.parse(d.record?.updated_at)||!['DELETED','RESTORED'].includes(d.status)||d.record?.price_basis!==basis||fp(record(d.record))!==d.record_sha256||fp(d.record)!==d.record_sha256||(d.status==='DELETED'?d.restored_at!==null:!time(d.restored_at)||Date.parse(d.restored_at)<Date.parse(d.deleted_at)))throw Error('INVALID_DELETED_HOLDING');ids.add(d.deletion_id);}}return store;}
 function change(store,{action,holding,symbol,at,deletion_id}){validate(store);const rows=store.records.map(r=>({...r})),deleted=JSON.parse(JSON.stringify(store.deleted||[]));if(!time(at))throw Error('INVALID_TIME');if(action==='DELETE'){const index=rows.findIndex(r=>r.symbol===symbol);if(index<0)throw Error('HOLDING_NOT_FOUND');if(typeof deletion_id!=='string'||!deletion_id||deleted.some(d=>d.deletion_id===deletion_id))throw Error('DELETION_ID_REQUIRED_OR_CONFLICT');const original=rows.splice(index,1)[0];deleted.push({deletion_id,deleted_at:at,record:original,record_sha256:fp(original),status:'DELETED',restored_at:null});}else if(action==='RESTORE'){const d=deleted.find(d=>d.deletion_id===deletion_id);if(!d||d.status!=='DELETED')throw Error('DELETION_NOT_AVAILABLE');if(rows.some(r=>r.symbol===d.record.symbol))throw Error('RESTORE_WOULD_OVERWRITE_NEW_HOLDING');rows.push({...d.record});d.status='RESTORED';d.restored_at=at;}else if(action==='SAVE'){const index=rows.findIndex(r=>r.symbol===holding.symbol),prior=rows[index],value=record({...holding,created_at:prior?.created_at||at,updated_at:at});if(index<0)rows.push(value);else rows[index]=value;}else throw Error('INVALID_ACTION');const v2=store.version===2||action==='DELETE'||action==='RESTORE';const after=seal({schema:v2?SCHEMA_V2:SCHEMA,version:v2?2:1,revision:store.revision+1,records:rows.sort((a,b)=>a.symbol.localeCompare(b.symbol)),...(v2?{deleted}: {})});validate(after);return after;}
 function resolve(value,catalog=[]){const text=String(value).trim(),symbol=text.toUpperCase();if(/^[0-9A-Z]{4,10}$/.test(symbol))return{symbol,name:catalog.find(x=>x.symbol===symbol)?.name||symbol};const found=catalog.filter(x=>x.name===text);if(found.length!==1)throw Error('請輸入股票／ETF代號，或清單內的完整名稱');return found[0];}
 function estimate(holding,quote,{now=Date.now(),verifyQuote=()=>false}={}){let usable=false;try{usable=verifyQuote(quote)===true&&quote.symbol===holding.symbol&&Number.isFinite(quote.price)&&quote.price>0&&Date.parse(quote.as_of)<=now&&Date.parse(quote.valid_until)>=now;}catch{}if(!usable)return{status:'行情待更新',price:null,marketValue:null,estimatedPnl:null,estimatedReturn:null};const p=quote.price,b=holding.break_even_price;return{status:'估算（不另扣手續費或證交稅）',price:p,marketValue:p*holding.shares,estimatedPnl:b===null?null:(p-b)*holding.shares,estimatedReturn:b===null?null:(p/b-1)*100};}
 function legacy(rows){return(Array.isArray(rows)?rows:[]).map(r=>{let b=null;try{if(r.breakEvenPrice!==undefined&&r.breakEvenPrice!==null)b=positive(r.breakEvenPrice);}catch{}return{symbol:r.code||r.symbol,name:r.name||r.code||r.symbol,shares:r.shares??r.quantity,break_even_price:b,price_basis:b===null?'NOT_PROVIDED':'LEGACY_EXPLICIT_BREAK_EVEN',legacy:true};});}
 return Object.freeze({KEY,SCHEMA,SCHEMA_V2,empty,validate,change,resolve,estimate,legacy});
});

;
/* sealed source: portfolio-local-first-core.js */
(function(root,factory){const node=typeof module==='object'&&module.exports,api=factory(...(node?[require('./portfolio-transaction-storage-adapter'),require('./portfolio-write-coordinator'),require('./portfolio-ledger-core'),require('./portfolio-resilience-core'),require('./portfolio-full-backup-core'),require('./portfolio-investable-cash-core'),require('./portfolio-transaction-cash-sync-core')]:[root.HSPortfolioTransactionStorageAdapter,root.HSPortfolioWriteCoordinator,root.HSPortfolioLedgerCore,root.HSPortfolioResilienceCore,root.HSPortfolioFullBackupCore,root.HSPortfolioInvestableCashCore,root.HSPortfolioTransactionCashSyncCore]));if(node)module.exports=api;if(root)root.HSPortfolioLocalFirstCore=api;})(globalThis,function(tx,c,ledger,r,backup,cash,sync){
 'use strict';
 const mode='LOCAL_RECORDS_V1',PLAN='hsRadar.portfolio.capitalBuildPlans.v1',APPROVAL='hsRadar.portfolio.accelerationConsumption.v1';
 function service(storage,{locks,clock=()=>new Date().toISOString(),id=()=>crypto.randomUUID(),hook}={}){
  const api=tx.service(storage,{locks,hook}),coordinator=c.service(storage,{locks,hook});
  const simple=()=>typeof module==='object'&&module.exports?require('./portfolio-simple-holdings-core'):globalThis.HSPortfolioSimpleHoldings;
  const localPlan=()=>typeof module==='object'&&module.exports?require('./portfolio-local-only-contract'):globalThis.HSPortfolioLocalOnlyContract;
  function journal(){return JSON.parse(storage.getItem(c.JOURNAL_KEY)||'null');}
  function writable(){if(storage.getItem(PLAN)!==null||storage.getItem(APPROVAL)!==null)throw Error('LOCAL_PLAN_WRITE_CONTRACT_NOT_ENABLED');if(journal()?.version===2)throw Error('AUTHORITY_BOUND_STATE_REQUIRES_EXPLICIT_MODE_REVIEW');}
  function read(){try{const at=clock(),snapshot=c.capture(storage,{asOf:at}),raw=storage.getItem(ledger.STORAGE_KEY),l=raw?ledger.validateLedger(JSON.parse(raw)):null;if(raw&&!l)throw Error('INVALID_LEDGER');const state=l?ledger.derivePortfolioStateFromLedger(l.events):null,holdings=state?.holdings||JSON.parse(storage.getItem('hsRadar.portfolio.holdings')||'[]'),plan=JSON.parse(storage.getItem(PLAN)||'null'),approval=JSON.parse(storage.getItem(APPROVAL)||'null');return{mode,status:'READY',initialized:storage.getItem(c.META_KEY)!==null,snapshot,journal:journal(),cash:r.readInvestableCash(storage,{asOf:at}),holdings,events:l?.events||[],plan,approval,advancedWrites:false,externalHighWater:false,source:'SOURCE_UNVERIFIED'};}catch(e){let j;try{j=journal();}catch{j={status:'INVALID'};}return{mode,status:'RECOVERY_REQUIRED',reason:e.message,journal:j,advancedWrites:false,externalHighWater:false};}}
  function check(p){if(!p||Date.parse(clock())<Date.parse(p.asOf)||Date.parse(clock())-Date.parse(p.asOf)>60000)throw Error('LOCAL_PREVIEW_EXPIRED');}
  return Object.freeze({read,
   initialize({confirmed}={}){if(confirmed!==true)throw Error('EXPLICIT_CONFIRMATION_REQUIRED');writable();return api.initialize({asOf:clock()});},
   async previewCash(amount){writable();cash.toMinorUnits(amount);const asOf=clock();return api.preview({operationId:id(),kind:'CASH_CHECKPOINT',intent:{baselineId:id(),amount},expected:api.snapshot({asOf}),asOf});},
   simpleRead(){c.capture(storage,{asOf:clock()});const s=simple(),raw=storage.getItem(s.KEY);return{store:raw?s.validate(JSON.parse(raw)):s.empty(),legacy:s.legacy(JSON.parse(storage.getItem('hsRadar.portfolio.holdings')||'[]'))};},
   previewHolding(change){writable();const s=simple(),raw=storage.getItem(s.KEY),asOf=clock(),store=raw?s.validate(JSON.parse(raw)):s.empty();if(['DELETE','RESTORE'].includes(change.action)){const symbol=change.action==='DELETE'?change.symbol:store.deleted?.find(d=>d.deletion_id===change.deletion_id)?.record.symbol,state=read();if(state.status!=='READY')throw Error('資料需要確認，暫時不能刪除或復原。');if(state.holdings?.some(h=>(h.code||h.symbol)===symbol))throw Error('此部位含原持股或交易紀錄，不能用簡易刪除或復原；原紀錄未變更。');}const after=s.change(store,{...change,deletion_id:change.deletion_id||(change.action==='DELETE'?id():undefined),at:asOf}),expected=api.snapshot({asOf}),body={operationId:id(),kind:'SIMPLE_HOLDING_REGISTER',asOf,expected,after};return{...body,digest:cash.fingerprint(body)};},
   previewSettings(settings){writable();const s=localPlan(),raw=storage.getItem(s.KEY),asOf=clock(),after=s.create(raw?s.validate(JSON.parse(raw)):null,settings,asOf),expected=api.snapshot({asOf}),body={operationId:id(),kind:'LOCAL_REFERENCE_SETTINGS',asOf,expected,after};return{...body,digest:cash.fingerprint(body)};},
   commit(p){writable();check(p);if(!['SIMPLE_HOLDING_REGISTER','LOCAL_REFERENCE_SETTINGS'].includes(p.kind))return api.commit(p);const{digest,...body}=p;if(cash.fingerprint(body)!==digest)throw Error('INVALID_LOCAL_PREVIEW');const target=p.kind==='SIMPLE_HOLDING_REGISTER'?simple():localPlan();target.validate(p.after);return coordinator.execute({operationId:p.operationId,kind:p.kind,asOf:p.asOf,expected:p.expected,intent:{preview_sha256:digest},plan:entries=>({...entries,[target.KEY]:JSON.stringify(p.after)})});},
   exportBackup(){const payload=api.backup({exportedAt:clock()});if(payload.storage[simple().KEY])simple().validate(JSON.parse(payload.storage[simple().KEY]));if(payload.storage[localPlan().KEY])localPlan().validate(JSON.parse(payload.storage[localPlan().KEY]));return payload;},
   previewRestore(payload){if(payload?.planCommitJournal?.version===2)throw Error('AUTHORITY_BACKUP_REQUIRES_EXPLICIT_MODE_REVIEW');const checked=backup.validateBackup(payload);if(!checked.ok)throw Error(checked.status);if(payload.storage?.[simple().KEY])simple().validate(JSON.parse(payload.storage[simple().KEY]));if(payload.storage?.[localPlan().KEY])localPlan().validate(JSON.parse(payload.storage[localPlan().KEY]));const at=clock(),p=api.restorePreview(payload,{asOf:at});if(!p.ok)throw Error(p.reason||p.status);const local_backup=api.backup({exportedAt:at});return{preview:p,asOf:at,local_backup,local_backup_sha256:cash.fingerprint(local_backup)};},
   restore(ticket,{confirmed,digest,backupExportedSha}={}){const p=ticket.preview;if(confirmed!==true||digest!==p.digest||backupExportedSha!==ticket.local_backup_sha256||backupExportedSha!==cash.fingerprint(api.backup({exportedAt:ticket.asOf})))throw Error('EXPORT_CURRENT_BACKUP_AND_RECONFIRM');return api.restore(p,{operationId:id(),asOf:clock(),acknowledgement:{digest:p.digest,affected_event_ids:p.affected_event_ids}});},
   recovery(){const j=journal();if(!j||j.status==='COMMITTED')throw Error('NO_PENDING_JOURNAL');if(j.version===2)throw Error('AUTHORITY_RECOVERY_REQUIRED');return api.recover({operationId:j.operation_id,planSha256:j.plan_sha256,asOf:clock()});}
  });
 }
 return Object.freeze({mode,service});
});

;
/* sealed source: portfolio-market-evidence-core.js */
(function(root,factory){
  'use strict';
  const api=factory(typeof module==='object'&&module.exports?require('./portfolio-investable-cash-core'):root.HSPortfolioInvestableCashCore);
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.HSPortfolioMarketEvidenceCore=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(cash){
  'use strict';
  // No network, storage, signing, default wall clock, UI or production activation.
  // A hash is integrity only. The registry pin MUST arrive independently of data.
  const VERSION='HS_MARKET_EVIDENCE_CONTRACT_V1',POLICY='HS_TRUSTED_SOURCE_POLICY_V1',RECEIPT='HS_MARKET_EVIDENCE_RECEIPT_V1',REGISTRY='HS_MARKET_SOURCE_REGISTRY_V1';
  const CATEGORIES=Object.freeze(['QUOTE','TRADING_METADATA','CORPORATE_ACTION','FEE_POLICY']);
  const LEVELS=Object.freeze(['SOURCE_DISCOVERED','SOURCE_ACCESSIBLE','SOURCE_EVIDENCE_CAPTURED','SOURCE_VERIFIED','SOURCE_STALE','SOURCE_UNTRUSTED','SOURCE_UNAVAILABLE']);
  const validated=new WeakSet(),fp=cash.fingerprint,copy=v=>JSON.parse(JSON.stringify(v));
  const fail=reason=>{throw Error(reason);};
  const text=v=>typeof v==='string'&&v.trim()===v&&v.length>0&&v.length<=2048;
  const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
  function freeze(v){if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
  function canonical(v){
    if(v===null||typeof v==='boolean'||typeof v==='string')return JSON.stringify(v);
    if(typeof v==='number'){if(!Number.isFinite(v)||Object.is(v,-0))fail('NON_CANONICAL_NUMBER');return JSON.stringify(v);}
    if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';
    if(v&&Object.getPrototypeOf(v)===Object.prototype)return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
    fail('NON_CANONICAL_VALUE');
  }
  function stamp(v){
    if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(v)||!Number.isFinite(Date.parse(v))||+v.slice(11,13)>23||+v.slice(14,16)>59||+v.slice(17,19)>59||new Date(v.slice(0,10)+'T00:00:00Z').toISOString().slice(0,10)!==v.slice(0,10)||/[+-]14:(?!00$)/.test(v))fail('OFFSET_TIMESTAMP_REQUIRED');
    return Date.parse(v);
  }
  function day(v){if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v+'T00:00:00Z'))||new Date(v+'T00:00:00Z').toISOString().slice(0,10)!==v)fail('MARKET_DATE_REQUIRED');return v;}
  const taipei=t=>new Date(t+28800000).toISOString().slice(0,10);
  function minor(v,positive=false){if(!Number.isSafeInteger(v)||v<0||Object.is(v,-0)||positive&&v===0)fail('INTEGER_UNIT_REQUIRED');return v;}
  function period(from,to,now){const a=stamp(from),b=stamp(to);if(b<=a)fail('EFFECTIVE_PERIOD_INVALID');if(a>now)fail('EFFECTIVE_PERIOD_NOT_YET_VALID');if(b<now)fail('EFFECTIVE_PERIOD_EXPIRED');}
  function endpoint(v){try{const u=new URL(v);if(u.protocol!=='https:'||u.username||u.password||u.hash||u.href!==v)fail('ENDPOINT_NOT_ALLOWED');return u;}catch{fail('ENDPOINT_NOT_ALLOWED');}}
  function bytes(v){if(typeof v!=='string'||v.length>8192||!v.length||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v))fail('INVALID_SIGNATURE_ENCODING');return Uint8Array.from(atob(v),x=>x.charCodeAt(0));}
  const utf8=v=>new TextEncoder().encode(v);
  async function rawSHA(raw){if(typeof raw!=='string'||raw.length>4000000||new TextDecoder('utf-8',{fatal:true}).decode(utf8(raw))!==raw)fail('RAW_UTF8_REQUIRED');return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',utf8(raw))),b=>b.toString(16).padStart(2,'0')).join('');}
  async function signature(body,sig,key){try{const k=await globalThis.crypto.subtle.importKey('spki',bytes(key),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);return await globalThis.crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},k,bytes(sig),utf8(canonical(body)));}catch{return false;}}
  function result(reason){reason=/^[A-Z0-9_]+$/.test(reason)?reason:'CONTRACT_VALIDATION_ERROR';return freeze({status:'BLOCKED',source_level:reason==='MISSING_SOURCE_RESPONSE'?'SOURCE_UNAVAILABLE':/STALE|EXPIRED/.test(reason)?'SOURCE_STALE':'SOURCE_UNTRUSTED',validation_status:'FAIL',reasons:[reason],executable_estimate:false,writes:false,production_activation:'BLOCKED'});}
  // The default is deliberately unusable. No TEST issuer is installed by import.
  const EMPTY_PRODUCTION_REGISTRY=freeze({schema:REGISTRY,mode:'PRODUCTION',revision:0,roots:[],revoked_roots:[],revoked_issuers:[],revoked_receipts:[]});
  function normalize(raw){
    let record;try{record=JSON.parse(raw);}catch{fail('SOURCE_JSON_INVALID');}
    if(record?.schema!=='HS_CANONICAL_SOURCE_RECORD_V1'||!CATEGORIES.includes(record.category)||!text(record.provider_id)||!/^\d{4,6}[A-Z]?$/.test(record.symbol)||!record.data||Array.isArray(record.data)||typeof record.data!=='object')fail('SOURCE_RECORD_SCHEMA');
    stamp(record.published_at);canonical(record);return copy(record);
  }
  // Preparer returns a candidate ONLY. It never signs or creates trust pins.
  async function prepareReceipt({policy,raw,receiptId,acquisitionId,acquiredAt,sourceEndpoint,evidenceReference,transport}){
    const record=normalize(raw);stamp(acquiredAt);
    if(!text(receiptId)||!text(acquisitionId)||!text(evidenceReference))fail('RECEIPT_IDENTITY_REQUIRED');
    return freeze({schema:RECEIPT,version:1,receipt_id:receiptId,acquisition_id:acquisitionId,issuer_id:policy.issuer_id,provider_id:record.provider_id,category:record.category,symbol:record.symbol,source_published_at:record.published_at,acquired_at:acquiredAt,market_date:record.data.trading_date??null,session:record.data.session??null,original_payload_sha256:await rawSHA(raw),normalized_payload_sha256:fp(record),source_endpoint:sourceEndpoint,evidence_reference:evidenceReference,policy_revision:policy.revision,policy_sha256:fp(policy),normalizer_version:'CANONICAL_SOURCE_RECORD_V1',verification_method:'EXTERNALLY_ANCHORED_ACQUISITION_ATTESTATION',signature_algorithm:policy.signature_algorithm,corporate_action_reference:record.category==='CORPORATE_ACTION'?record.data.action_id:record.data.corporate_action_reference??null,transport:copy(transport),scope:policy.scope,freshness_status:'UNASSESSED',validation_status:'CANDIDATE',failure_reasons:[]});
  }
  async function trustedPolicy(envelope,trust,now){
    const reg=trust?.registry,p=envelope?.policy;
    if(!reg||!hash(trust.expected_registry_sha256)||fp(reg)!==trust.expected_registry_sha256||reg.schema!==REGISTRY||!['TEST_ONLY','PRODUCTION'].includes(trust.mode)||reg.mode!==trust.mode||!Number.isSafeInteger(reg.revision)||reg.revision<1)fail('EXTERNAL_TRUST_ROOT_REQUIRED');
    canonical(reg);period(reg.effective_from,reg.effective_until,now);
    for(const key of ['roots','revoked_roots','revoked_issuers','revoked_receipts'])if(!Array.isArray(reg[key]))fail('REGISTRY_INVALID');
    if(new Set(reg.roots.map(x=>x.reference)).size!==reg.roots.length)fail('REGISTRY_DUPLICATE_ROOT');
    if(!p||p.schema!==POLICY||p.version!==1||p.scope!==trust.mode||!text(p.provider_id)||!text(p.issuer_id)||!text(p.trust_root_reference)||!Number.isSafeInteger(p.revision)||p.revision<1)fail('POLICY_IDENTITY_INVALID');
    const root=reg.roots.find(x=>x.reference===p.trust_root_reference);
    if(!root||root.scope!==trust.mode||reg.revoked_roots.includes(root.reference)||reg.revoked_issuers.includes(p.issuer_id))fail('TRUST_ROOT_OR_ISSUER_REVOKED');
    if(root.signature_algorithm!=='ECDSA_P256_SHA256'||p.signature_algorithm!=='ECDSA_P256_SHA256')fail('SIGNATURE_ALGORITHM_NOT_ALLOWED');
    if(!Array.isArray(root.approved_policy_sha256s)||!root.approved_policy_sha256s.includes(fp(p)))fail('POLICY_NOT_IN_EXTERNAL_REGISTRY');
    if(!(await signature(p,envelope.signature,root.public_key_spki_base64)))fail('POLICY_SIGNATURE_INVALID');
    period(p.effective_from,p.effective_until,now);
    if(!CATEGORIES.includes(p.category)||!Array.isArray(p.symbols)||!p.symbols.length||new Set(p.symbols).size!==p.symbols.length||!p.symbols.every(s=>/^\d{4,6}[A-Z]?$/.test(s)))fail('POLICY_COVERAGE_INVALID');
    if(!Array.isArray(p.allowed_endpoints)||!p.allowed_endpoints.length||!p.allowed_endpoints.every(e=>endpoint(e).origin===p.allowed_origin)||p.acquisition_method!=='HTTPS_GET_ATTESTED'||p.verification_method!=='EXTERNALLY_ANCHORED_ACQUISITION_ATTESTATION'||p.revocation_rules!=='EXPLICIT_REGISTRY_REVOCATION'||p.timestamp_requirements!=='SOURCE_PUBLICATION_AND_ACQUISITION_WITH_OFFSET'||p.corporate_action_policy!=='EXPLICIT_BASIS_AND_COMPLETE_COVERAGE'||p.normalizer_version!=='CANONICAL_SOURCE_RECORD_V1')fail('POLICY_REQUIREMENTS_INVALID');
    if(!Number.isSafeInteger(p.freshness?.max_age_ms)||p.freshness.max_age_ms<=0||!Number.isSafeInteger(p.freshness.max_acquisition_lag_ms)||p.freshness.max_acquisition_lag_ms<0||!Number.isSafeInteger(p.freshness.max_retention_ms)||p.freshness.max_retention_ms<=0)fail('FRESHNESS_POLICY_REQUIRED');
    // The canonical source wire normalizer has no approved LIVE collector yet.
    if(trust.mode==='PRODUCTION')fail('LIVE_NORMALIZER_AND_ACQUISITION_NOT_PROVISIONED');
    return {policy:p,registry:reg,registry_sha256:trust.expected_registry_sha256};
  }
  function quote(d,published,now,p){
    if(d.schema!=='HS_ETF_QUOTE_V1'||d.currency!=='TWD'||!['TWSE','TPEX'].includes(d.market)||!['OFFICIAL_CLOSE','DELAYED_QUOTE','INTRADAY_REFERENCE','INDICATIVE_PRICE','OTHER_VERIFIED_TYPE'].includes(d.price_type)||!text(d.session)||!text(d.corporate_action_reference)||!text(d.price_basis))fail('QUOTE_CONTRACT_INVALID');
    minor(d.price_minor,true);if(d.price_precision!==2)fail('QUOTE_PRECISION_INVALID');
    day(d.trading_date);if(stamp(d.valid_until)<now)fail('QUOTE_STALE');if(d.trading_date!==taipei(published)||stamp(d.source_timestamp)!==published||stamp(d.valid_until)>published+p.freshness.max_age_ms)fail('QUOTE_TIME_OR_FRESHNESS_CONFLICT');
    // Historical closes remain explicitly informational; never current execution.
    if(['DELAYED_QUOTE','INTRADAY_REFERENCE'].includes(d.price_type)&&d.trading_date!==taipei(now))fail('QUOTE_STALE');
  }
  function metadata(d,now){
    if(d.schema!=='HS_TRADING_METADATA_V1'||d.currency!=='TWD'||!['TWSE','TPEX'].includes(d.market)||typeof d.odd_lot_eligible!=='boolean'||typeof d.trading_eligible!=='boolean'||!Array.isArray(d.sessions)||!d.sessions.length||!d.sessions.every(text)||!text(d.policy_version)||!text(d.source_evidence)||!text(d.corporate_action_reference))fail('TRADING_METADATA_MISSING');
    period(d.effective_from,d.effective_until,now);minor(d.board_lot_size,true);minor(d.minimum_quantity,true);if(d.minimum_quantity!==d.board_lot_size)fail('BOARD_LOT_MINIMUM_CONFLICT');
    if(d.odd_lot_eligible){minor(d.odd_minimum_shares,true);minor(d.odd_step_shares,true);if(d.odd_minimum_shares>=d.board_lot_size||d.odd_step_shares>=d.board_lot_size||d.board_lot_size%d.odd_step_shares||d.odd_minimum_shares%d.odd_step_shares)fail('ODD_LOT_RULE_INVALID');}
    if(!Array.isArray(d.tick_schedule)||!d.tick_schedule.length)fail('TICK_SCHEDULE_REQUIRED');
    let end=0;for(const [i,b] of d.tick_schedule.entries()){minor(b.from_minor);minor(b.tick_minor,true);if(b.from_minor!==end||b.to_minor===null&&i!==d.tick_schedule.length-1)fail('TICK_SCHEDULE_GAP');if(b.to_minor!==null){minor(b.to_minor,true);if(b.to_minor<=b.from_minor)fail('TICK_SCHEDULE_INVALID');}end=b.to_minor;}
    if(end!==null)fail('TICK_SCHEDULE_INCOMPLETE');
  }
  function action(d,now){
    if(d.schema!=='HS_CORPORATE_ACTION_EVIDENCE_V1'||!text(d.action_id)||!['NO_ACTION_CONFIRMED','SPLIT','REVERSE_SPLIT','DIVIDEND','OTHER'].includes(d.action_type)||!text(d.quantity_basis)||!text(d.price_basis)||!text(d.adjustment_reference)||!text(d.source_evidence)||d.coverage_complete!==true)fail('CORPORATE_ACTION_CONFLICT');
    day(d.effective_date);day(d.coverage_from);day(d.coverage_to);
    if(d.coverage_from>d.effective_date||d.coverage_to<taipei(now)||d.coverage_from>d.coverage_to||stamp(d.announcement_at)>now)fail('CORPORATE_ACTION_COVERAGE_INCOMPLETE');
    // Even NO_ACTION needs explicit independently attested coverage, never [].
    if(d.verification_status!=='CONFIRMED')fail('CORPORATE_ACTION_UNVERIFIED');
  }
  function fee(d,now){
    if(d.schema!=='HS_BROKER_FEE_POLICY_V1'||!text(d.fee_policy_id)||!text(d.broker_context)||!text(d.policy_version)||d.currency!=='TWD'||!['TWSE','TPEX'].includes(d.market)||d.order_model!=='WHOLE_AND_ODD_SEPARATE_ORDERS')fail('FEE_POLICY_MISSING');
    period(d.effective_from,d.effective_until,now);
    const confirm=d.confirmation;if(confirm?.kind!=='USER_CONFIRMATION'||!text(confirm.reference)||stamp(confirm.confirmed_at)>now||confirm.broker_context!==d.broker_context)fail('BROKER_SPECIFIC_CONFIRMATION_REQUIRED');
    for(const r of[d.whole,d.odd]){if(!r||r.rounding!=='CEIL')fail('FEE_RULE_INCOMPLETE');for(const key of ['rate_ppm','minimum_minor','fixed_minor','buy_cost_ppm'])minor(r[key]);if(r.rate_ppm>1000000||r.buy_cost_ppm>1000000)fail('FEE_RATE_INVALID');}
    if(d.confirmation_scope!=='USER_PROVIDED_NOT_BROKER_VERIFIED')fail('FEE_CONFIRMATION_SCOPE_REQUIRED');
  }
  async function validateReceipt({signedPolicy,signedReceipt,raw,trust,asOf,expected,replayState}){
    try{
      // Snapshot all caller-owned inputs before the first cryptographic await.
      // Otherwise an issuer/key/freshness mutation could race signature checks.
      ({signedPolicy,signedReceipt,raw,trust,asOf,expected,replayState}=copy({signedPolicy,signedReceipt,raw,trust,asOf,expected,replayState}));
      if(raw===undefined||raw===null||raw==='')fail('MISSING_SOURCE_RESPONSE');
      const now=stamp(asOf),ctx=await trustedPolicy(signedPolicy,trust,now),p=ctx.policy,r=signedReceipt?.receipt;
      if(!r||r.schema!==RECEIPT||r.version!==1||r.scope!==trust.mode||r.issuer_id!==p.issuer_id||r.policy_revision!==p.revision||r.policy_sha256!==fp(p)||r.provider_id!==p.provider_id||r.category!==p.category||!p.symbols.includes(r.symbol)||expected?.symbol!==r.symbol||expected?.category!==r.category||expected.currency!=='TWD')fail('RECEIPT_IDENTITY_OR_SCOPE_CONFLICT');
      if(ctx.registry.revoked_receipts.includes(r.receipt_id))fail('RECEIPT_REVOKED');
      if(!p.allowed_endpoints.includes(r.source_endpoint)||endpoint(r.source_endpoint).origin!==p.allowed_origin||r.transport?.http_status!==200||r.transport?.tls_verified!==true||r.transport?.final_url!==r.source_endpoint||r.verification_method!==p.verification_method)fail('ACQUISITION_PROVENANCE_INVALID');
      if(!(await signature(r,signedReceipt.signature,p.issuer_public_key_spki_base64)))fail('ISSUER_ATTESTATION_INVALID');
      const candidate=await prepareReceipt({policy:p,raw,receiptId:r.receipt_id,acquisitionId:r.acquisition_id,acquiredAt:r.acquired_at,sourceEndpoint:r.source_endpoint,evidenceReference:r.evidence_reference,transport:r.transport});
      if(canonical(candidate)!==canonical(r))fail('RAW_OR_NORMALIZED_PAYLOAD_CONFLICT');
      const acquired=stamp(r.acquired_at),published=stamp(r.source_published_at);
      if(published>acquired||acquired>now||acquired-published>p.freshness.max_acquisition_lag_ms)fail('SOURCE_TIME_OR_ACQUISITION_INVALID');
      if(now-published>p.freshness.max_age_ms||now-acquired>p.freshness.max_retention_ms)fail('SOURCE_STALE');
      if(replayState?.schema!=='HS_MARKET_RECEIPT_REPLAY_VIEW_V1'||!Number.isSafeInteger(replayState.revision)||replayState.revision<0||!Array.isArray(replayState.entries))fail('REPLAY_VIEW_REQUIRED');
      const priorIds=new Set(),priorAcquisitions=new Set();
      for(const prior of replayState.entries){if(!text(prior.receipt_id)||!text(prior.acquisition_id)||!hash(prior.receipt_sha256)||priorIds.has(prior.receipt_id)||priorAcquisitions.has(prior.acquisition_id))fail('REPLAY_VIEW_INVALID');priorIds.add(prior.receipt_id);priorAcquisitions.add(prior.acquisition_id);if(prior.receipt_id===r.receipt_id)fail(prior.receipt_sha256===fp(r)?'RECEIPT_DUPLICATE':'RECEIPT_ID_CONFLICT');if(prior.acquisition_id===r.acquisition_id)fail('RECEIPT_REPLAY');}
      const record=normalize(raw),d=record.data;if(d.currency!=='TWD')fail('CURRENCY_CONFLICT');if(expected.market!==undefined&&expected.market!==d.market)fail('MARKET_CONFLICT');
      if(r.category==='QUOTE')quote(d,published,now,p);
      if(r.category==='TRADING_METADATA')metadata(d,now);
      if(r.category==='CORPORATE_ACTION')action(d,now);
      if(r.category==='FEE_POLICY')fee(d,now);
      const expiration=Math.min(stamp(p.effective_until),stamp(ctx.registry.effective_until),published+p.freshness.max_age_ms,acquired+p.freshness.max_retention_ms,...(d.valid_until?[stamp(d.valid_until)]:[]),...(d.effective_until?[stamp(d.effective_until)]:[]));
      const output=freeze({status:'VERIFIED',source_level:'SOURCE_VERIFIED',validation_status:'PASS',scope:trust.mode,as_of:asOf,expires_at:new Date(expiration).toISOString(),receipt:copy(r),receipt_sha256:fp(r),normalized:record,registry_sha256:ctx.registry_sha256,replay_view_revision:replayState.revision,replay_view_sha256:fp(replayState),source_signature_verified:false,assurance:'TRUSTED_ACQUISITION_ATTESTATION_NOT_PROVIDER_SIGNATURE',executable_estimate:false,writes:false,production_activation:'BLOCKED',reasons:[]});
      validated.add(output);return output;
    }catch(e){return result(e.message);}
  }
  function usable(v,category,{now,registrySHA,symbol}){
    if(!hash(registrySHA)||!validated.has(v)||v.status!=='VERIFIED'||v.normalized.category!==category||v.registry_sha256!==registrySHA||v.normalized.symbol!==symbol||stamp(v.as_of)>now||stamp(v.expires_at)<now)fail('VALIDATED_RECEIPT_REQUIRED');
    const d=v.normalized.data;
    if(category==='CORPORATE_ACTION')action(d,now);
    if(category==='TRADING_METADATA')metadata(d,now);
    if(category==='QUOTE'&&['DELAYED_QUOTE','INTRADAY_REFERENCE'].includes(d.price_type)&&d.trading_date!==taipei(now))fail('QUOTE_STALE');
    return d;
  }
  function validateTradingPrice({metadata:meta,quote:q,asOf,registrySHA}){
    try{const now=stamp(asOf),symbol=q?.normalized?.symbol,d=usable(meta,'TRADING_METADATA',{now,registrySHA,symbol}),price=usable(q,'QUOTE',{now,registrySHA,symbol});
      if(meta.scope!==q.scope||d.market!==price.market||!d.trading_eligible||!d.sessions.includes(price.session)||d.corporate_action_reference!==price.corporate_action_reference)fail('TRADING_SESSION_OR_ACTION_CONFLICT');
      const band=d.tick_schedule.find(b=>price.price_minor>=b.from_minor&&(b.to_minor===null||price.price_minor<b.to_minor));
      if(!band||price.price_minor%band.tick_minor)fail('ILLEGAL_PRICE_TICK');
      return freeze({status:'VALID_REFERENCE',price_minor:price.price_minor,tick_minor:band.tick_minor,board_lot_size:d.board_lot_size,executable_estimate:false,writes:false});
    }catch(e){return result(e.message);}
  }
  function validateValuation({reference,positions,quotes,actions,asOf,registrySHA,expectedGeneration}){
    try{
      // Preserve validated receipt capabilities, but snapshot mutable caller
      // lists/reference/quantity bindings before hashing or arithmetic.
      if(!Array.isArray(quotes)||!Array.isArray(actions))fail('VALUATION_COVERAGE_INCOMPLETE');
      quotes=quotes.slice();actions=actions.slice();
      ({reference,positions,expectedGeneration}=copy({reference,positions,expectedGeneration}));
      const now=stamp(asOf),r=reference;
      if(!text(expectedGeneration?.generation_id)||!hash(expectedGeneration?.ledger_sha256)||!hash(expectedGeneration?.position_quantity_reference)||!hash(registrySHA)||r?.schema!=='HS_COMMON_PORTFOLIO_VALUATION_V1'||r.currency!=='TWD'||r.generation_id!==expectedGeneration.generation_id||r.ledger_sha256!==expectedGeneration.ledger_sha256||r.position_quantity_reference!==expectedGeneration.position_quantity_reference||r.position_quantity_reference!==fp(positions)||r.quote_set_reference!==fp(quotes.map(q=>q.receipt_sha256))||r.corporate_action_reference!==fp(actions.map(a=>a.receipt_sha256))||stamp(r.as_of)>now||stamp(r.valid_until)<now||!text(r.source_evidence)||r.fingerprint!==fp(Object.fromEntries(Object.entries(r).filter(([k])=>k!=='fingerprint'))))fail('VALUATION_REFERENCE_CONFLICT');
      if(!Array.isArray(positions)||new Set(positions.map(p=>p.symbol)).size!==positions.length||quotes.length!==positions.length||actions.length!==positions.length)fail('VALUATION_COVERAGE_INCOMPLETE');
      let total=0n;
      for(const pos of positions){minor(pos.quantity_e8);if(!text(pos.quantity_basis))fail('QUANTITY_BASIS_REQUIRED');
        const q=quotes.find(x=>x?.normalized?.symbol===pos.symbol),a=actions.find(x=>x?.normalized?.symbol===pos.symbol),qd=usable(q,'QUOTE',{now,registrySHA,symbol:pos.symbol}),ad=usable(a,'CORPORATE_ACTION',{now,registrySHA,symbol:pos.symbol});
        if(q.scope!==a.scope||qd.market!==ad.market||stamp(q.receipt.source_published_at)>stamp(r.as_of)||stamp(a.receipt.source_published_at)>stamp(r.as_of)||qd.corporate_action_reference!==ad.action_id||pos.quantity_basis!==ad.quantity_basis||qd.price_basis!==ad.price_basis||stamp(r.valid_until)>stamp(q.expires_at)||stamp(r.valid_until)>stamp(a.expires_at))fail('CORPORATE_ACTION_OR_VALUATION_CONFLICT');
        if(ad.coverage_from>qd.trading_date||ad.effective_date>qd.trading_date)fail('CORPORATE_ACTION_COVERAGE_INCOMPLETE');
        total+=(BigInt(pos.quantity_e8)*BigInt(qd.price_minor)+50000000n)/100000000n;
      }
      if(total>BigInt(Number.MAX_SAFE_INTEGER)||r.equity_minor!==Number(total))fail('VALUATION_AMOUNT_CONFLICT');
      return freeze({status:'VALID_REFERENCE',fingerprint:r.fingerprint,equity_minor:Number(total),generation_id:r.generation_id,executable_estimate:false,writes:false,production_activation:'BLOCKED'});
    }catch(e){return result(e.message);}
  }
  return Object.freeze({VERSION,POLICY,RECEIPT,REGISTRY,CATEGORIES,LEVELS,EMPTY_PRODUCTION_REGISTRY,canonical,fingerprint:fp,rawSHA,prepareReceipt,validateReceipt,validateTradingPrice,validateValuation});
});

;
/* sealed source: portfolio-native-market-core.js */
(function(root,factory){
 'use strict';const api=factory(typeof module==='object'&&module.exports?require('./portfolio-market-evidence-core'):root.HSPortfolioMarketEvidenceCore);
 if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.HSPortfolioNativeMarketCore=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(evidence){
 'use strict';
 const VERSION='HS_NATIVE_MARKET_PARSER_V1',fp=evidence.fingerprint,copy=v=>JSON.parse(JSON.stringify(v)),fail=r=>{throw Error(r);};
 const PROVIDERS=Object.freeze({TWSE_CLOSE:Object.freeze({revision:'STOCK_DAY_ALL_FIELDS_V1',market:'TWSE',endpoint:'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',code:'Code',price:'ClosingPrice',name:'Name'}),TPEX_CLOSE:Object.freeze({revision:'TPEX_MAINBOARD_QUOTES_FIELDS_V1',market:'TPEX',endpoint:'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes',code:'SecuritiesCompanyCode',price:'Close',name:'CompanyName'}),TWSE_MIS:Object.freeze({revision:'MIS_D_T_Z_V1',endpoint:'https://mis.twse.com.tw/stock/api/getStockInfo.jsp'}),HS_CACHE:Object.freeze({revision:'HS_MARKET_QUOTES_V2',endpoint:'hs-cache:market-quotes.json'})});
 function freeze(v){if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
 const text=v=>typeof v==='string'&&v.trim()===v&&v.length>0&&v.length<2048;
 function iso(v){if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(v)||!Number.isFinite(Date.parse(v))||+v.slice(11,13)>23||+v.slice(14,16)>59||+v.slice(17,19)>59||/[+-]14:(?!00$)/.test(v))fail('OFFSET_TIMESTAMP_REQUIRED');date(v.slice(0,10));return Date.parse(v);}
 function micros(v){const ms=iso(v),fraction=(/\.(\d+)/.exec(v)?.[1]||'').padEnd(6,'0');return BigInt(ms)*1000n+BigInt(fraction.slice(3));}
 const taipei=t=>new Date(t+28800000).toISOString().slice(0,10);
 function date(v,roc=false){if(typeof v!=='string')fail('MARKET_DATE_MISSING');let s=v;if(roc){const m=/^(\d{3})(\d{2})(\d{2})$/.exec(v);if(!m)fail('MARKET_DATE_INVALID');s=(+m[1]+1911)+'-'+m[2]+'-'+m[3];}else if(/^\d{8}$/.test(s))s=s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6);if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s+'T00:00:00Z'))||new Date(s+'T00:00:00Z').toISOString().slice(0,10)!==s)fail('MARKET_DATE_INVALID');return s;}
 function price(v){if(typeof v!=='string'&&typeof v!=='number')fail('PRICE_INVALID');let s=String(v);if(!/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(s))fail('PRICE_INVALID');s=s.replace(/,/g,'');const[a,b='']=s.split('.'),n=BigInt(a)*100n+BigInt(b.padEnd(2,'0'));if(n<=0n||n>BigInt(Number.MAX_SAFE_INTEGER))fail('PRICE_INVALID');return Number(n);}
 function blocked(reason){return freeze({schema:'HS_NATIVE_MARKET_PARSE_V1',status:'BLOCKED',source_trust:'NOT_PRODUCTION_TRUSTED',reasons:[/^[A-Z0-9_]+$/.test(reason)?reason:'NATIVE_CONTRACT_INVALID'],executable_estimate:false,writes:false});}
 function unique(rows,key,symbol){if(!Array.isArray(rows))fail('NATIVE_SCHEMA_INVALID');const seen=new Set();for(const r of rows){if(!r||!text(r[key]))fail('NATIVE_INSTRUMENT_ID_MISSING');if(seen.has(r[key]))fail('DUPLICATE_NATIVE_INSTRUMENT');seen.add(r[key]);}const row=rows.find(r=>r[key]===symbol);if(!row)fail('QUOTE_MISSING');return row;}
 function checkEndpoint(provider,url){const p=PROVIDERS[provider];if(provider!=='TWSE_MIS'){if(url!==p.endpoint)fail('SOURCE_ENDPOINT_CONFLICT');return;}let u;try{u=new URL(url);}catch{fail('SOURCE_ENDPOINT_CONFLICT');}if(u.origin!=='https://mis.twse.com.tw'||u.pathname!=='/stock/api/getStockInfo.jsp'||u.username||u.password||u.hash)fail('SOURCE_ENDPOINT_CONFLICT');}
 async function parse(input){
  try{
   const i=copy(input);if(!Object.hasOwn(PROVIDERS,i.provider))fail('UNKNOWN_PROVIDER');const p=PROVIDERS[i.provider];if(i.source_revision!==p.revision)fail('UNKNOWN_SOURCE_REVISION');checkEndpoint(i.provider,i.source_endpoint);
   const now=iso(i.asOf),nowUS=micros(i.asOf),acquiredUS=micros(i.acquired_at);if(acquiredUS>nowUS)fail('FUTURE_ACQUISITION_TIME');
   const x=i.instrument;if(!x||!/^\d{4,6}[A-Z]?$/.test(x.symbol)||!['TWSE','TPEX'].includes(x.market)||x.currency!=='TWD'||x.instrument_id!==x.market+':'+x.symbol)fail('UNKNOWN_INSTRUMENT_ID');
   if(!text(i.raw_reference)||!text(i.source_receipt_reference))fail('SOURCE_REFERENCE_REQUIRED');
   const rawSHA=await evidence.rawSHA(i.raw);if(i.expected_raw_sha256!==undefined&&i.expected_raw_sha256!==rawSHA)fail('RAW_PAYLOAD_HASH_CONFLICT');
   let payload;try{payload=JSON.parse(i.raw);}catch{fail('NATIVE_JSON_INVALID');}
   let row,marketDate,time=null,kind,field,session,cacheUpdated=null;
   if(i.provider==='TWSE_CLOSE'||i.provider==='TPEX_CLOSE'){
    if(x.market!==p.market)fail('INSTRUMENT_MARKET_CONFLICT');row=unique(payload,p.code,x.symbol);if(!text(row[p.name]))fail('NATIVE_INSTRUMENT_NAME_MISSING');marketDate=date(row.Date,true);kind='OFFICIAL_CLOSE';session='OFFICIAL_CLOSE';field=p.price;
   }else if(i.provider==='TWSE_MIS'){
    if(payload?.rtcode!=='0000')fail('NATIVE_PROVIDER_ERROR');row=unique(payload.msgArray,'c',x.symbol);if(row.ex!==(x.market==='TWSE'?'tse':'otc'))fail('INSTRUMENT_MARKET_CONFLICT');marketDate=date(row.d);field='z';kind='INTRADAY_REFERENCE';session=x.market+'_REGULAR_REFERENCE';
    if(typeof row.t!=='string'||!/^\d{2}:\d{2}:\d{2}$/.test(row.t))fail('SOURCE_TIMESTAMP_MISSING');time=marketDate+'T'+row.t+'+08:00';iso(time);
    // tlong/queryTime are not substituted for a last-price timestamp. pz is
    // deliberately not a fallback when z is absent/invalid.
   }else{
    if(payload?.version!==2)fail('UNKNOWN_SOURCE_REVISION');row=unique(payload.items,'code',x.symbol);if(row.market!==(x.market==='TPEX'?'TPEx':'TWSE'))fail('INSTRUMENT_MARKET_CONFLICT');marketDate=date(row.date);cacheUpdated=payload.updated_at??null;field='price';
    if(row.quote_mode==='close'){kind='OFFICIAL_CLOSE';session='OFFICIAL_CLOSE';}
    else if(row.quote_mode==='delayed'){kind='DELAYED_QUOTE';session=x.market+'_REGULAR_REFERENCE';if(typeof row.quote_time!=='string'||!/^\d{2}:\d{2}:\d{2}$/.test(row.quote_time))fail('SOURCE_TIMESTAMP_MISSING');time=marketDate+'T'+row.quote_time+'+08:00';iso(time);}
    else fail('QUOTE_TYPE_UNRECOGNIZED');
   }
   if(['Currency','currency'].some(k=>Object.hasOwn(row,k)&&row[k]!=='TWD'))fail('NATIVE_CURRENCY_CONFLICT');
   if(['source_revision','SchemaVersion','schema_version'].some(k=>Object.hasOwn(row,k)))fail('UNKNOWN_SOURCE_REVISION');
   if(i.provider==='TWSE_MIS'&&Object.hasOwn(payload,'schema_version'))fail('UNKNOWN_SOURCE_REVISION');
   if(marketDate>taipei(now)||time&&(micros(time)>nowUS||micros(time)>acquiredUS))fail('FUTURE_SOURCE_TIME');
   const priceMinor=price(row[field]);if(i.expected_market_date!==undefined&&marketDate!==date(i.expected_market_date))fail('SOURCE_MARKET_DATE_CONFLICT');
   if(!Number.isSafeInteger(i.maximum_quote_age_ms)||i.maximum_quote_age_ms<=0||i.maximum_quote_age_ms>600000)fail('DIAGNOSTIC_AGE_POLICY_REQUIRED');
   const normalized={schema:'HS_NATIVE_QUOTE_V1',provider_id:i.provider,instrument_id:x.instrument_id,symbol:x.symbol,market:x.market,currency:'TWD',reference_price_minor:priceMinor,price_precision:2,price_type:kind,trading_date:marketDate,session,source_timestamp:time,source_timestamp_semantics:time?'EXCHANGE_PRICE_TIME_NOT_PROVEN_PUBLICATION_TIME':'MARKET_DATE_ONLY',source_publication_time:null,raw_price_field:field};
   return freeze({schema:'HS_NATIVE_MARKET_PARSE_V1',status:'NATIVE_PARSE_PASS',parser_version:VERSION,source_revision:i.source_revision,source_revision_assurance:'DECLARED_ADAPTER_FIELDSET_NOT_PROVIDER_PUBLICATION_REVISION',source_endpoint:i.source_endpoint,raw_payload_reference:i.raw_reference,raw_payload_sha256:rawSHA,normalized,normalized_sha256:fp(normalized),acquired_at:i.acquired_at,source_receipt_reference:i.source_receipt_reference,cache_updated_at_observation:cacheUpdated,freshness_status:time?(nowUS-micros(time)>BigInt(i.maximum_quote_age_ms)*1000n?'STALE':'WITHIN_REQUESTED_AGE_UNTRUSTED'):'DATE_ONLY_UNASSESSED',source_trust:'NOT_PRODUCTION_TRUSTED',reasons:time?['SOURCE_PUBLICATION_TIME_UNPROVEN']:['SOURCE_TIMESTAMP_DATE_ONLY','SOURCE_PUBLICATION_TIME_UNPROVEN'],executable_estimate:false,writes:false});
  }catch(e){return blocked(e.message);}
 }
 return Object.freeze({VERSION,PROVIDERS,parse,priceMinor:price,marketDate:date});
});

;
/* sealed source: canonical-score-resolver.js */
"use strict";

(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  if(root)root.HSCanonicalScoreResolver=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  const validDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value||""));
  const finiteScore=value=>Number.isFinite(Number(value))&&Number(value)>=0&&Number(value)<=100;
  const boundedDate=(value,targetDate)=>validDate(value)&&validDate(targetDate)&&value<=targetDate;
  const finiteRaw=value=>value===null||value===undefined||value===""?null:(Number.isFinite(Number(value))?Number(value):null);
  const snapshotMarketAsOf=snapshot=>{
    const direct=String(snapshot?.market_as_of||"");
    const rows=Object.values(snapshot?.items||{}).map(row=>String(row?.market_as_of||"")).filter(Boolean);
    return [...rows,direct].filter(Boolean).sort().at(-1)||"";
  };
  const MARKET_STATES=Object.freeze({PREMARKET:"PREMARKET",OPEN:"OPEN",CLOSED:"CLOSED",HOLIDAY:"HOLIDAY",STALE:"STALE"});
  const LIVE_REASONS=Object.freeze({
    NO_CURRENT_DAY_INTRADAY:"NO_CURRENT_DAY_INTRADAY",INCOMPLETE_INTRADAY:"INCOMPLETE_INTRADAY",
    VERSION_MISMATCH:"VERSION_MISMATCH",FUTURE_AS_OF:"FUTURE_AS_OF",STALE_INTRADAY_SNAPSHOT:"STALE_INTRADAY_SNAPSHOT",
    PREMARKET:"MARKET_PREMARKET",CLOSED:"MARKET_CLOSED",HOLIDAY:"MARKET_HOLIDAY",UNKNOWN_TRADING_DAY:"TRADING_DAY_UNCONFIRMED"
  });

  function taipeiClock(now){
    const date=now instanceof Date?now:new Date(now),valid=Number.isFinite(date.getTime());
    if(!valid)return null;
    const parts=Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Taipei",weekday:"short",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).formatToParts(date).map(part=>[part.type,part.value]));
    return{date:`${parts.year}-${parts.month}-${parts.day}`,weekday:parts.weekday,minutes:Number(parts.hour)*60+Number(parts.minute)};
  }

  function componentState(key,value){
    const raw=finiteRaw(value);if(raw===null)return"unavailable";
    if(key==="weekly_j")return raw<0?"strong":raw<20?"positive":raw<50?"neutral":"weak";
    if(key==="dd52")return raw<=-20?"strong":raw<=-10?"positive":raw<=-5?"neutral":"weak";
    return raw<=-10?"strong":raw<=-5?"positive":raw<0?"neutral":"weak";
  }

  function normalizeFinalizedSnapshot(snapshot,{scoreVersion,symbols,targetDate}){
    const date=String(snapshot?.date||""),expected=[...(symbols||[])];
    if(!boundedDate(date,targetDate)||snapshot?.snapshot_type!=="FINALIZED_CLOSE"||snapshot?.finalized!==true)return null;
    const rows=Array.isArray(snapshot?.rows)?snapshot.rows:[],items={};
    for(const symbol of expected){
      const row=rows.find(item=>String(item?.symbol||"")===symbol),score=Number(row?.final_core_score),dataAsOf=String(row?.data_as_of||snapshot?.source?.data_as_of||"");
      if(!row||row.status==="WAIT_NATIVE"||!finiteScore(score)||row.core_score_version!==scoreVersion||!dataAsOf.startsWith(`${date}T`))return null;
      const factors=row.factors||{};
      const weeklyJ=finiteRaw(factors?.weekly_j?.raw),dd52=finiteRaw(factors?.dd52?.raw),crash=finiteRaw(factors?.crash?.raw);
      items[symbol]={status:"SUCCESS",source_status:"FINALIZED_EOD",score,display_score:Math.floor(score),score_version:row.core_score_version,trading_date:date,weekly_j:weeklyJ,dd52,components:{weekly_j:{value:weeklyJ,state:componentState("weekly_j",weeklyJ)},dd52:{value:dd52,state:componentState("dd52",dd52)},crash:{value:crash,state:componentState("crash",crash)}},core_factors:{weeklyJ:factors.weekly_j||{},dd52:factors.dd52||{},crash:factors.crash||{}},tier:String(row.tier||""),market_as_of:dataAsOf,calculated_at:String(snapshot.finalized_at||dataAsOf)};
    }
    return{schema_version:1,snapshot_type:"FINALIZED_CLOSE",status:"SUCCESS",source_status:"FINALIZED_EOD",trading_date:date,slot:"13:30",items,canonical_priority:2};
  }

  function normalizeIntradaySnapshot(snapshot,{scoreVersion,symbols,targetDate}){
    const date=String(snapshot?.trading_date||""),slot=String(snapshot?.slot||""),expected=[...(symbols||[])];
    if(!boundedDate(date,targetDate)||snapshot?.schema_version!==1||snapshot?.snapshot_type!=="INTRADAY_CORE"||snapshot?.status!=="SUCCESS"||!/^\d{2}:\d{2}$/.test(slot))return null;
    for(const symbol of expected){
      const row=snapshot?.items?.[symbol],score=Number(row?.score),asOf=String(row?.market_as_of||"");
      if(row?.status!=="SUCCESS"||!finiteScore(score)||!asOf.startsWith(`${date}T`))return null;
      if(row.score_version&&row.score_version!==scoreVersion)return null;
    }
    return{...snapshot,source_status:"INTRADAY_CANONICAL",canonical_priority:1};
  }

  function resolve({finalizedArtifact,intradaySnapshots,targetDate,scoreVersion,symbols}){
    if(!validDate(targetDate)||!scoreVersion||!(symbols instanceof Set||Array.isArray(symbols)))return null;
    const options={scoreVersion,symbols:new Set(symbols),targetDate},candidates=[];
    if(finalizedArtifact?.schema_version===1&&finalizedArtifact?.core_score_version===scoreVersion){
      for(const snapshot of finalizedArtifact.snapshots||[]){const normalized=normalizeFinalizedSnapshot(snapshot,options);if(normalized)candidates.push(normalized)}
    }
    for(const snapshot of intradaySnapshots||[]){const normalized=normalizeIntradaySnapshot(snapshot,options);if(normalized)candidates.push(normalized)}
    return candidates.sort((a,b)=>b.trading_date.localeCompare(a.trading_date)||b.canonical_priority-a.canonical_priority||String(b.slot).localeCompare(String(a.slot)))[0]||null;
  }

  function resolveFinalOnly({finalizedArtifact,targetDate,scoreVersion,symbols}){
    if(!validDate(targetDate)||!scoreVersion||!(symbols instanceof Set||Array.isArray(symbols)))return null;
    const options={scoreVersion,symbols:new Set(symbols),targetDate},candidates=[];
    if(finalizedArtifact?.schema_version===1&&finalizedArtifact?.core_score_version===scoreVersion){
      for(const snapshot of finalizedArtifact.snapshots||[]){const normalized=normalizeFinalizedSnapshot(snapshot,options);if(normalized)candidates.push(normalized)}
    }
    return candidates.sort((a,b)=>b.trading_date.localeCompare(a.trading_date))[0]||null;
  }

  function resolveMarketState({targetDate,now=new Date(),tradingDayStatus="UNKNOWN",finalizedSnapshot=null,intradaySnapshots=[]}={}){
    const clock=taipeiClock(now),status=String(tradingDayStatus||"UNKNOWN").toUpperCase();
    if(!clock||!validDate(targetDate)||clock.date!==targetDate)return MARKET_STATES.STALE;
    if(status==="HOLIDAY"||status==="NO_TRADING_DAY"||["Sat","Sun"].includes(clock.weekday))return MARKET_STATES.HOLIDAY;
    const finalizedToday=finalizedSnapshot?.source_status==="FINALIZED_EOD"&&finalizedSnapshot?.trading_date===targetDate;
    const intradayToday=(intradaySnapshots||[]).some(snapshot=>snapshot?.snapshot_type==="INTRADAY_CORE"&&snapshot?.status==="SUCCESS"&&snapshot?.trading_date===targetDate);
    const confirmed=status==="TRADING_DAY"||status==="READY"||finalizedToday||intradayToday;
    if(!confirmed)return MARKET_STATES.STALE;
    if(clock.minutes<9*60)return MARKET_STATES.PREMARKET;
    if(clock.minutes<=13*60+30&&!finalizedToday)return MARKET_STATES.OPEN;
    return MARKET_STATES.CLOSED;
  }

  function liveUnavailable(reason,marketState,snapshot=null){
    return{snapshot,display_eligible:false,status:"UNAVAILABLE",reason,freshness:reason===LIVE_REASONS.STALE_INTRADAY_SNAPSHOT?"STALE":"UNAVAILABLE",market_state:marketState};
  }

  function resolveLiveProjected({intradaySnapshots,targetDate,scoreVersion,symbols,now=new Date(),marketState=MARKET_STATES.STALE,maxAgeMinutes=15}={}){
    const expected=new Set(symbols||[]),rows=(intradaySnapshots||[]).filter(snapshot=>snapshot?.trading_date===targetDate&&snapshot?.status==="SUCCESS").sort((a,b)=>snapshotMarketAsOf(b).localeCompare(snapshotMarketAsOf(a))||String(b?.slot||"").localeCompare(String(a?.slot||""))),snapshot=rows[0]||null;
    if(marketState===MARKET_STATES.PREMARKET)return liveUnavailable(LIVE_REASONS.PREMARKET,marketState,snapshot);
    if(marketState===MARKET_STATES.CLOSED)return liveUnavailable(LIVE_REASONS.CLOSED,marketState,snapshot);
    if(marketState===MARKET_STATES.HOLIDAY)return liveUnavailable(LIVE_REASONS.HOLIDAY,marketState,snapshot);
    if(marketState!==MARKET_STATES.OPEN)return liveUnavailable(LIVE_REASONS.UNKNOWN_TRADING_DAY,marketState,snapshot);
    if(!snapshot)return liveUnavailable(LIVE_REASONS.NO_CURRENT_DAY_INTRADAY,marketState);
    if(snapshot?.schema_version!==1||snapshot?.snapshot_type!=="INTRADAY_CORE"||!/^[0-2]\d:[0-5]\d$/.test(String(snapshot?.slot||"")))return liveUnavailable(LIVE_REASONS.INCOMPLETE_INTRADAY,marketState,snapshot);
    for(const symbol of expected){
      const row=snapshot?.items?.[symbol];
      if(!row||row.status!=="SUCCESS"||!finiteScore(row.score)||String(row.market_as_of||"").startsWith(`${targetDate}T`)===false||!["FRESH","DELAYED"].includes(row.freshness))return liveUnavailable(LIVE_REASONS.INCOMPLETE_INTRADAY,marketState,snapshot);
      if(row.score_version!==scoreVersion)return liveUnavailable(LIVE_REASONS.VERSION_MISMATCH,marketState,snapshot);
    }
    const normalized=normalizeIntradaySnapshot(snapshot,{scoreVersion,symbols:expected,targetDate});
    if(!normalized)return liveUnavailable(LIVE_REASONS.INCOMPLETE_INTRADAY,marketState,snapshot);
    const nowMs=(now instanceof Date?now:new Date(now)).getTime(),asOfValues=[...expected].map(symbol=>Date.parse(String(normalized.items[symbol].market_as_of||"")));
    if(!Number.isFinite(nowMs)||asOfValues.some(value=>!Number.isFinite(value)))return liveUnavailable(LIVE_REASONS.INCOMPLETE_INTRADAY,marketState,snapshot);
    if(asOfValues.some(value=>value>nowMs))return liveUnavailable(LIVE_REASONS.FUTURE_AS_OF,marketState,snapshot);
    if(asOfValues.some(value=>nowMs-value>Number(maxAgeMinutes)*60000))return liveUnavailable(LIVE_REASONS.STALE_INTRADAY_SNAPSHOT,MARKET_STATES.STALE,snapshot);
    return{snapshot:normalized,display_eligible:true,status:"LIVE_PROJECTED",reason:null,freshness:"FRESH",market_state:marketState};
  }

  function buildDualTrackView({finalizedArtifact,intradaySnapshots,targetDate,scoreVersion,symbols,now=new Date(),tradingDayStatus="UNKNOWN",maxAgeMinutes=15}={}){
    const expected=new Set(symbols||[]),official=resolveFinalOnly({finalizedArtifact,targetDate,scoreVersion,symbols:expected});
    let marketState=resolveMarketState({targetDate,now,tradingDayStatus,finalizedSnapshot:official,intradaySnapshots});
    const liveResult=resolveLiveProjected({intradaySnapshots,targetDate,scoreVersion,symbols:expected,now,marketState,maxAgeMinutes});
    if(liveResult.reason===LIVE_REASONS.STALE_INTRADAY_SNAPSHOT)marketState=MARKET_STATES.STALE;
    const items={};
    for(const ticker of expected){
      const officialItem=official?.items?.[ticker]||null,liveItem=liveResult.display_eligible?liveResult.snapshot?.items?.[ticker]||null:null;
      const officialScore=finiteRaw(officialItem?.score),liveScore=finiteRaw(liveItem?.score);
      const rejectedItem=liveResult.snapshot?.items?.[ticker]||null;
      items[ticker]={ticker,score_version:scoreVersion,market_state:marketState,primary:"official",official:officialItem?{score:officialScore,display_score:Number(officialItem.display_score),trading_date:officialItem.trading_date,market_as_of:officialItem.market_as_of,status:"FINALIZED",source_status:"FINALIZED_EOD"}:null,live:liveItem?{score:liveScore,display_score:Number(liveItem.display_score),delta_vs_official:officialScore===null?null:liveScore-officialScore,trading_date:liveResult.snapshot.trading_date,slot:liveResult.snapshot.slot,market_as_of:liveItem.market_as_of,freshness:String(liveItem.freshness||"FRESH"),display_eligible:true,status:"LIVE_PROJECTED",reason:null}:{score:null,display_score:null,delta_vs_official:null,trading_date:String(liveResult.snapshot?.trading_date||targetDate),slot:String(liveResult.snapshot?.slot||""),market_as_of:String(rejectedItem?.market_as_of||""),freshness:liveResult.freshness,display_eligible:false,status:liveResult.status,reason:liveResult.reason}};
    }
    return{schema_version:1,score_version:scoreVersion,target_date:targetDate,market_state:marketState,primary:"official",official_snapshot:official,live_snapshot:liveResult.display_eligible?liveResult.snapshot:null,live_reason:liveResult.reason,items};
  }

  function selectFormalCoreScore(view,symbol){
    const ticker=String(symbol||""),item=view?.items?.[ticker]||null,marketState=String(view?.market_state||MARKET_STATES.STALE),targetDate=String(view?.target_date||"");
    const unavailable=reason=>({available:false,ticker,score:null,display_score:null,trading_date:null,market_as_of:null,source:null,status:"UNAVAILABLE",reason,market_state:marketState});
    if(!item)return unavailable("UNSUPPORTED_SYMBOL");
    if(marketState===MARKET_STATES.OPEN){
      const live=item.live,score=finiteRaw(live?.score),displayScore=finiteRaw(live?.display_score);
      if(live?.display_eligible!==true||live?.status!=="LIVE_PROJECTED"||live?.trading_date!==targetDate||score===null||displayScore===null)return unavailable(live?.reason||view?.live_reason||"LIVE_UNAVAILABLE");
      return{available:true,ticker,score,display_score:displayScore,trading_date:String(live.trading_date),market_as_of:String(live.market_as_of||""),source:"LIVE",status:"LIVE_PROJECTED",reason:null,market_state:marketState};
    }
    if(![MARKET_STATES.PREMARKET,MARKET_STATES.CLOSED,MARKET_STATES.HOLIDAY].includes(marketState))return unavailable("SCORE_STATE_STALE");
    const official=item.official,score=finiteRaw(official?.score),displayScore=finiteRaw(official?.display_score);
    if(official?.status!=="FINALIZED"||official?.source_status!=="FINALIZED_EOD"||score===null||displayScore===null||!boundedDate(String(official?.trading_date||""),targetDate))return unavailable("FINALIZED_UNAVAILABLE");
    return{available:true,ticker,score,display_score:displayScore,trading_date:String(official.trading_date),market_as_of:String(official.market_as_of||""),source:"FINALIZED",status:"FINALIZED",reason:null,market_state:marketState};
  }

  return Object.freeze({MARKET_STATES,LIVE_REASONS,snapshotMarketAsOf,normalizeFinalizedSnapshot,normalizeIntradaySnapshot,resolve,resolveFinalOnly,resolveMarketState,resolveLiveProjected,buildDualTrackView,selectFormalCoreScore});
});

;
/* sealed source: portfolio-etf-smart-allocation-core.js */
(function(root,factory){
 'use strict';
 const node=typeof module==='object'&&module.exports;
 const api=factory(node?require('./portfolio-c4-smart-acceleration-core'):root.HSPortfolioC4SmartAccelerationCore,node?require('./portfolio-plan-generation-core'):root.HSPortfolioPlanGenerationCore,node?require('./portfolio-capital-build-storage-adapter'):root.HSPortfolioCapitalBuildStorageAdapter);
 if(node)module.exports=api;if(root)root.HSPortfolioETFSmartAllocationCore=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(acceleration,g,adapter){
 'use strict';
 const SCHEMA='HS_ETF_ALLOCATION_INPUT_V1',VERSION='HS_ETF_GAP_C4_ALLOCATION_V1',fp=g.fp,MAX=BigInt(Number.MAX_SAFE_INTEGER);
 const fail=reason=>{throw Error(reason);},copy=v=>JSON.parse(JSON.stringify(v));
 function minor(n){if(!Number.isSafeInteger(n)||n<0||Object.is(n,-0))fail('INVALID_INTEGER_UNITS');return n;}
 function safe(n){if(n<0n||n>MAX)fail('INTEGER_OVERFLOW');return Number(n);}
 const sum=values=>safe(values.reduce((s,n)=>s+BigInt(minor(n)),0n));
 const down=(a,b,d)=>safe(BigInt(a)*BigInt(b)/BigInt(d));
 const up=(a,b,d)=>safe((BigInt(a)*BigInt(b)+BigInt(d)-1n)/BigInt(d));
 function time(s){
  if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(s)||!Number.isFinite(Date.parse(s))||new Date(s.slice(0,10)+'T00:00:00Z').toISOString().slice(0,10)!==s.slice(0,10)||+s.slice(11,13)>23||+s.slice(14,16)>59||+s.slice(17,19)>59||/[+-]14:(?!00$)/.test(s))fail('OFFSET_TIME_REQUIRED');return Date.parse(s);
 }
 function receipt(r,pin,schema,ctx,now){
  if(!r||typeof pin!=='string'||!/^[a-f0-9]{64}$/.test(pin))fail('EXTERNAL_SOURCE_PIN_REQUIRED');
  const {sha256,...body}=r;
  if(r.schema!==schema||fp(body)!==sha256||sha256!==pin)fail('SOURCE_HASH_OR_SCHEMA_CONFLICT');
  if(time(r.as_of)>now||time(r.valid_until)<now||time(r.valid_until)<time(r.as_of))fail('SOURCE_STALE_OR_FUTURE');
  for(const k of ['generation_id','plan_id','plan_revision','period_id','settings_sha256','phase4a_result_sha256'])if(r[k]!==ctx[k])fail('SOURCE_GENERATION_CONFLICT');
  if(r.evidence_status!=='VERIFIED'||typeof r.source_reference!=='string'||!r.source_reference||!r.raw_sha256||!/^[a-f0-9]{64}$/.test(r.raw_sha256))fail('SOURCE_PROVENANCE_REQUIRED');
  return r;
 }
 function positive(n){if(!minor(n))fail('POSITIVE_UNIT_REQUIRED');return n;}
 function rate(n){if(!Number.isInteger(n)||n<0||n>10000)fail('INVALID_BPS');return n;}
 function marketQuote(input,symbol,ctx,now,risk){
  const q=receipt(input.quotes?.[symbol],input.trust.quotes?.[symbol],'HS_VERIFIED_ALLOCATION_QUOTE_V1',ctx,now),quoted=time(q.quoted_at);
  if(q.symbol!==symbol||q.currency!=='TWD')fail('QUOTE_SYMBOL_OR_CURRENCY_CONFLICT');positive(q.price_minor);
  if(quoted>now||now-quoted>risk.maximum_quote_age_ms||time(q.valid_until)>quoted+risk.maximum_quote_age_ms||q.freshness!=='CURRENT'||q.price_kind!=='MARKET_REFERENCE'||q.trading_date!==new Date(now+28800000).toISOString().slice(0,10)||typeof q.session!=='string'||!q.session)fail('QUOTE_NOT_CURRENT_MARKET_REFERENCE');
  return q;
 }
 function checkHolding(holding,q,sourceSHA){
  if(q.corporate_action_consistent!==true||!q.corporate_action_version||q.valuation_sha256!==sourceSHA)fail('CORPORATE_ACTION_OR_VALUATION_CONFLICT');
  const match=/^(\d+)(?:\.(\d{1,6}))?$/.exec(String(holding.unit_price));if(!match)fail('QUOTE_VALUATION_PRICE_CONFLICT_REVERIFY_4A');
  const micros=BigInt(match[1])*1000000n+BigInt((match[2]||'').padEnd(6,'0')||'0');if(micros!==BigInt(q.price_minor)*10000n)fail('QUOTE_VALUATION_PRICE_CONFLICT_REVERIFY_4A');
 }
 function feeRule(r){
  if(!r||r.rounding!=='CEIL')fail('FEE_POLICY_INCOMPLETE');
  return {minimum_minor:minor(r.minimum_minor),fixed_minor:minor(r.fixed_minor),rate_bps:rate(r.rate_bps),buy_cost_bps:rate(r.buy_cost_bps)};
 }
 function orderFee(principal,r){return principal?sum([Math.max(r.minimum_minor,sum([r.fixed_minor,up(principal,r.rate_bps,10000)])),up(principal,r.buy_cost_bps,10000)]):0;}
 function quantities(shares,p){
  minor(shares);const lots=Math.floor(shares/p.board_lot_size);let odd=shares%p.board_lot_size;
  odd=p.odd_lot_allowed?Math.floor(odd/p.odd_step_shares)*p.odd_step_shares:0;
  if(odd<p.odd_minimum_shares)odd=0;
  return {whole_lots:lots,odd_lot_shares:odd,total_shares:sum([lots*p.board_lot_size,odd])};
 }
 function costs(shares,d){
  const q=quantities(shares,d.product),whole=down(q.whole_lots,d.product.board_lot_size,1),a=down(whole,d.price,1),b=down(q.odd_lot_shares,d.price,1),principal=sum([a,b]);
  return {...q,principal_minor:principal,added_market_value_minor:down(q.total_shares,d.reference,1),fees_minor:sum([orderFee(a,d.fees.whole),orderFee(b,d.fees.odd)])};
 }
 // Monetary targets first. Capped integer largest-remainder, stable symbol tie.
 function distribute(total,rows,weight,cap){
  const result=Object.fromEntries(rows.map(r=>[r.symbol,0]));let left=minor(total);
  for(let round=0;left&&round<64;round++){
   const active=rows.filter(r=>result[r.symbol]<cap(r)&&weight(r)>0),W=active.reduce((n,r)=>n+BigInt(weight(r)),0n);if(!W)break;
   const start=left,remainder=[];
   for(const r of active){const n=BigInt(start)*BigInt(weight(r)),add=Math.min(safe(n/W),cap(r)-result[r.symbol]);result[r.symbol]+=add;left-=add;remainder.push({r,rem:n%W});}
   remainder.sort((a,b)=>a.rem===b.rem?a.r.symbol.localeCompare(b.r.symbol):a.rem>b.rem?-1:1);
   for(const {r}of remainder)if(left&&result[r.symbol]<cap(r)){result[r.symbol]++;left--;}
   if(start===left)break;
  }return result;
 }
 function evaluate(input){
  const blocked=reason=>({schema:'HS_ETF_ALLOCATION_RESULT_V1',strategy_version:VERSION,status:'BLOCKED',reasons:[reason],rows:[],writes:false,creates_approval:false,production_activation:'BLOCKED'});
  try{
   if(input?.schema!==SCHEMA||input.strategy_version!==VERSION)fail('ALLOCATION_VERSION_CONFLICT');
   const now=time(input.asOf),ai=input.phase4a_input;if(ai?.asOf!==input.asOf)fail('PHASE4A_CLOCK_CONFLICT');
   // Never trust a caller-supplied ceiling just because it has a hash.
   const upstream=acceleration.evaluate(ai),resultSHA=fp(upstream);
   if(input.trust?.phase4a_result_sha256!==resultSHA||fp(input.phase4a_output)!==resultSHA)fail('PHASE4A_RESULT_CONFLICT');
   if(upstream.status==='RECONCILIATION_REQUIRED'||!upstream.source_references)fail('PHASE4A_BLOCKED:'+(upstream.reasons||[]).join('|'));
   const view=adapter.service(g.memory(copy(ai.portfolio.entries)),{clock:()=>input.asOf}).read({asOf:input.asOf,source:copy(ai.portfolio.source)}),plan=view.store.plan;
   const ctx={...upstream.source_references,phase4a_result_sha256:resultSHA};
   const E=minor(view.equity_minor),T=minor(view.total_assets_minor),P0=minor(upstream.final_budget_ceiling_minor),tolerance=Math.round(plan.allocation_tolerance_reference.value*100),maximum=plan.maximum_equity_limit_bps;
   const risk=receipt(input.risk,input.trust.risk_sha256,'HS_ALLOCATION_PRICE_RISK_V1',ctx,now);
   if(risk.confirmation?.kind!=='USER_CONFIRMATION'||!risk.confirmation.reference||time(risk.confirmation.confirmed_at)>now)fail('PRICE_RISK_CONFIRMATION_REQUIRED');
   const slippage=rate(risk.slippage_buffer_bps);if(!Number.isSafeInteger(risk.maximum_quote_age_ms)||risk.maximum_quote_age_ms<=0||risk.maximum_quote_age_ms>600000)fail('QUOTE_AGE_POLICY_REQUIRED');
   // Audit all existing holdings, even excluded/missing-C4/no-fee candidates.
   // A verified contradictory price changes the shared exposure of OTHER buys.
   for(const holding of ai.portfolio.source.valuation.rows){
    let q;try{q=marketQuote(input,holding.symbol,ctx,now,risk);}catch{continue;}
    checkHolding(holding,q,upstream.source_references.source_sha256);
    let p;try{p=receipt(input.products?.[holding.symbol],input.trust.products?.[holding.symbol],'HS_VERIFIED_TRADING_PRODUCT_V1',ctx,now);}catch{continue;}
    if(p.symbol===holding.symbol&&p.currency==='TWD'&&(p.corporate_action_consistent!==true||p.corporate_action_version!==q.corporate_action_version||p.valuation_sha256!==q.valuation_sha256))fail('CORPORATE_ACTION_OR_VALUATION_CONFLICT');
   }
   let globalReasons=[...upstream.reasons];
   const rows=upstream.rows.map(r=>{
    const upper=Math.min(10000,r.target_weight_bps+tolerance),current=r.current_equity_minor;
    const projectedGap=Math.max(0,down(sum([E,P0]),r.target_weight_bps,10000)-current);
    return {...r,reasons:[...r.reasons],eligibility_status:acceleration.ELIGIBLE.includes(r.symbol)?'ELIGIBLE':'EXCLUDED',current_weight_bps:E?down(current,10000,E):0,current_weight_gap_bps:r.target_weight_bps-(E?down(current,10000,E):0),projected_target_gap_minor:projectedGap,allocation_tolerance_bps:tolerance,maximum_weight_bps:upper,rank:null,recommendation_status:r.status==='VERIFIED'?'BUDGET_ESTIMATE':'INFORMATION_ONLY',recommended_principal_minor:0,added_market_value_minor:0,price_buffer_cost_minor:0,base_budget_component_minor:0,approved_acceleration_component_minor:0,whole_lots:0,odd_lot_shares:0,total_shares:0,estimated_fees_minor:0,total_cash_required_minor:0};
   });
   const details=new Map();
   for(const r of rows){
    if(r.status!=='VERIFIED'||r.eligibility_status!=='ELIGIBLE')continue;
    try{
     const q=marketQuote(input,r.symbol,ctx,now,risk),p=receipt(input.products?.[r.symbol],input.trust.products?.[r.symbol],'HS_VERIFIED_TRADING_PRODUCT_V1',ctx,now),fees=receipt(input.fees?.[r.symbol],input.trust.fees?.[r.symbol],'HS_VERIFIED_SPLIT_ORDER_FEES_V1',ctx,now);
     if([q,p,fees].some(x=>x.symbol!==r.symbol)||q.currency!=='TWD'||p.currency!=='TWD'||fees.currency!=='TWD')fail('QUOTE_SYMBOL_OR_CURRENCY_CONFLICT');
     const price=positive(q.price_minor),tick=positive(p.price_tick_minor),priceMin=positive(p.tick_band_min_minor),priceMax=positive(p.tick_band_max_minor);if(priceMin>priceMax||price<priceMin||price>priceMax||price%tick)fail('ILLEGAL_PRICE_TICK_OR_BAND');
     positive(p.board_lot_size);positive(p.odd_minimum_shares);positive(p.odd_step_shares);
     if(typeof p.odd_lot_allowed!=='boolean'||p.odd_minimum_shares>=p.board_lot_size||p.odd_step_shares>=p.board_lot_size||p.board_lot_size%p.odd_step_shares||p.trading_eligible!==true||!Array.isArray(p.allowed_sessions)||!p.allowed_sessions.includes(q.session))fail('TRADING_PRODUCT_RULES_INVALID');
     if(q.corporate_action_consistent!==true||p.corporate_action_consistent!==true||!q.corporate_action_version||q.corporate_action_version!==p.corporate_action_version||q.valuation_sha256!==upstream.source_references.source_sha256||p.valuation_sha256!==q.valuation_sha256)fail('CORPORATE_ACTION_OR_VALUATION_CONFLICT');
     if(fees.confirmation?.kind!=='USER_CONFIRMATION'||!fees.confirmation.reference||time(fees.confirmation.confirmed_at)>now||fees.order_model!=='WHOLE_AND_ODD_SEPARATE_ORDERS')fail('SPLIT_FEE_CONFIRMATION_REQUIRED');
     const buffered=up(up(price,10000+slippage,10000),1,tick)*tick;
     minor(buffered);if(buffered>priceMax)fail('BUFFERED_PRICE_OUTSIDE_VERIFIED_TICK_BAND');details.set(r.symbol,{product:p,price:buffered,reference:price,quote:q,fees:{whole:feeRule(fees.whole),odd:feeRule(fees.odd)},receipt:fees});
     Object.assign(r,{verified_reference_price_minor:price,buffered_estimate_price_minor:buffered,board_lot_size:p.board_lot_size,quote_timestamp:q.quoted_at,quote_source:q.source_reference,quote_sha256:q.sha256,product_sha256:p.sha256,fee_policy_sha256:fees.sha256,corporate_action_version:q.corporate_action_version});
    }catch(e){
     // Verified counter-evidence about an EXISTING position invalidates the
     // common exposure denominator, not just this ETF's proposed order.
     if(['QUOTE_VALUATION_PRICE_CONFLICT_REVERIFY_4A','CORPORATE_ACTION_OR_VALUATION_CONFLICT'].includes(e.message)&&ai.portfolio.source.valuation.rows.some(v=>v.symbol===r.symbol))throw e;
     r.reasons.push(e.message);r.recommendation_status='BUDGET_ESTIMATE';
    }
   }
   // Rank gap first, then raw verified C4, then canonical symbol. No multiplier copy.
   const ranked=rows.filter(r=>r.status==='VERIFIED'&&r.eligibility_status==='ELIGIBLE').sort((a,b)=>b.projected_target_gap_minor-a.projected_target_gap_minor||b.score-a.score||a.symbol.localeCompare(b.symbol));
   ranked.forEach((r,n)=>{r.rank=n+1;r.ranking_reason='PROJECTED_TARGET_GAP_DESC_THEN_RAW_C4_DESC_THEN_SYMBOL_ASC';});
   const candidates=ranked.filter(r=>details.has(r.symbol));
   const base=distribute(Math.min(P0,upstream.allocated_base_minor),candidates,r=>r.projected_target_gap_minor||r.target_weight_bps,r=>Math.min(r.allocated_base_minor,r.projected_target_gap_minor));
   const extra=distribute(Math.max(0,P0-sum(Object.values(base))),candidates,r=>Math.round(r.multiplier*10000)*r.target_weight_bps,r=>r.allocated_acceleration_minor);
   const shares=Object.fromEntries(candidates.map(r=>[r.symbol,costs(Math.floor(sum([base[r.symbol],extra[r.symbol]])/details.get(r.symbol).price),details.get(r.symbol)).total_shares]));
   let settled=false,basket=[];
   // Only shrink the authorized monetary basket: split fees never enlarge 4A.
   for(let round=0;round<256;round++){
    basket=candidates.map(r=>({r,...costs(shares[r.symbol],details.get(r.symbol))}));
    const P=sum(basket.map(b=>b.principal_minor)),V=sum(basket.map(b=>b.added_market_value_minor)),F=sum(basket.map(b=>b.fees_minor)),cash=upstream.available_investable_cash_minor,holds=sum([upstream.existing_fee_reserve_minor,upstream.additional_cash_holds_minor]);
    const globalLimit=Math.min(P0,Math.max(0,upstream.global_remaining_minor-F),Math.max(0,cash-holds-F),Math.max(0,down(Math.max(0,T-F),maximum,10000)-E),upstream.mode===acceleration.NORMAL?Math.max(0,down(Math.max(0,T-F),plan.normal_equity_target_bps,10000)-E):P0);
    let changed=false;
    for(const b of basket){
     const r=b.r,d=details.get(r.symbol),already=E>0&&BigInt(r.current_equity_minor)*10000n>BigInt(E)*BigInt(r.maximum_weight_bps),cap=already?0:Math.max(0,down(sum([E,V]),r.maximum_weight_bps,10000)-r.current_equity_minor),budget=sum([base[r.symbol],extra[r.symbol]]);
     const allowed=Math.min(budget,P>globalLimit?down(b.principal_minor,globalLimit,P):b.principal_minor),next=costs(Math.min(shares[r.symbol],Math.floor(allowed/d.price),Math.floor(cap/d.reference)),d).total_shares;
     if(next!==shares[r.symbol]){shares[r.symbol]=next;changed=true;}
    }
    if(!changed){settled=true;break;}
   }
   if(!settled){for(const r of candidates)shares[r.symbol]=0;globalReasons.push('ROUNDING_CONVERGENCE_REVIEW_REQUIRED');}
   basket=candidates.map(r=>({r,...costs(shares[r.symbol],details.get(r.symbol))}));
   const P=sum(basket.map(b=>b.principal_minor)),V=sum(basket.map(b=>b.added_market_value_minor)),F=sum(basket.map(b=>b.fees_minor)),slippageCost=P-V,postE=sum([E,V]),postT=T-F-slippageCost;
   if(slippageCost<0||postT<0||P>P0||sum([P,F])>upstream.global_remaining_minor||sum([P,F,upstream.existing_fee_reserve_minor,upstream.additional_cash_holds_minor])>upstream.available_investable_cash_minor&&P>0||P>0&&BigInt(postE)*10000n>BigInt(postT)*BigInt(maximum))fail('FINAL_BASKET_GLOBAL_INVARIANT');
   if(P>0&&upstream.mode===acceleration.NORMAL&&BigInt(postE)*10000n>BigInt(postT)*BigInt(plan.normal_equity_target_bps))fail('FINAL_BASKET_NORMAL_TARGET_INVARIANT');
   for(const b of basket){
    const r=b.r,bc=Math.min(base[r.symbol],b.principal_minor),ac=b.principal_minor-bc;
    if(b.principal_minor>sum([r.allocated_base_minor,r.allocated_acceleration_minor])||ac>r.allocated_acceleration_minor||b.principal_minor>0&&BigInt(r.current_equity_minor+b.added_market_value_minor)*10000n>BigInt(postE)*BigInt(r.maximum_weight_bps))fail('FINAL_BASKET_ROW_INVARIANT');
    Object.assign(r,{recommended_principal_minor:b.principal_minor,added_market_value_minor:b.added_market_value_minor,price_buffer_cost_minor:b.principal_minor-b.added_market_value_minor,base_budget_component_minor:bc,approved_acceleration_component_minor:ac,whole_lots:b.whole_lots,odd_lot_shares:b.odd_lot_shares,total_shares:b.total_shares,estimated_fees_minor:b.fees_minor,total_cash_required_minor:sum([b.principal_minor,b.fees_minor]),recommendation_status:b.total_shares?'EXECUTABLE_ESTIMATE':'BUDGET_ESTIMATE'});
    if(!b.total_shares)r.reasons.push('NO_SAFE_MINIMUM_TRADE');
   }
   for(const r of rows){r.projected_weight_bps=postE?down(sum([r.current_equity_minor,r.added_market_value_minor]),10000,postE):0;r.remaining_safe_allocation_minor=Math.max(0,down(postE,r.maximum_weight_bps,10000)-r.current_equity_minor-r.added_market_value_minor);r.recommendation_explanation=r.total_shares?'Verified gap/C4 rank; base first, then explicitly approved extra; quantity rounded down and common basket rechecked.':'No executable quantity; consult source, eligibility and budget reasons. Unused money is not reassigned beyond original row caps.';}
   const global=ai.budget.global;
   return {schema:'HS_ETF_ALLOCATION_RESULT_V1',strategy_version:VERSION,status:P?'EXECUTABLE_ESTIMATE':P0?'BUDGET_ESTIMATE':'INFORMATION_ONLY',mode:upstream.mode,mode_verified:upstream.mode_verified,global_approved_budget_minor:global.authorized_minor,previously_consumed_budget_minor:global.consumed_minor,reserved_global_budget_minor:global.reserved_minor,available_global_budget_minor:upstream.global_remaining_minor,base_budget_minor:upstream.effective_base_budget_minor,approved_acceleration_budget_minor:upstream.approved_acceleration_ceiling_minor,actually_allocatable_budget_minor:P0,estimated_total_principal_minor:P,estimated_market_value_added_minor:V,estimated_price_buffer_cost_minor:slippageCost,estimated_total_fees_minor:F,estimated_total_cash_required_minor:sum([P,F]),unallocated_principal_ceiling_minor:P0-P,remaining_global_budget_minor:upstream.global_remaining_minor-P-F,allocated_base_minor:sum(rows.map(r=>r.base_budget_component_minor)),allocated_acceleration_minor:sum(rows.map(r=>r.approved_acceleration_component_minor)),equity_weight_before_bps:T?down(E,10000,T):0,projected_equity_weight_after_bps:postT?down(postE,10000,postT):0,equity_before_minor:E,total_assets_before_minor:T,projected_equity_minor:postE,projected_total_assets_minor:postT,slippage_buffer_bps:slippage,rows:rows.sort((a,b)=>(a.rank??Number.MAX_SAFE_INTEGER)-(b.rank??Number.MAX_SAFE_INTEGER)||a.symbol.localeCompare(b.symbol)),reasons:globalReasons,phase4a_result_sha256:resultSHA,source_references:upstream.source_references,valuation_scope:'ALL_EXISTING_EQUITY_INCLUDING_NON_ELIGIBLE',residual_policy:'KEEP_UNALLOCATED_NO_SPECULATIVE_REUSE',estimate_only:true,execution_guarantee:false,writes:false,creates_approval:false,production_activation:'BLOCKED'};
  }catch(e){return blocked(e.message);}
 }
 return Object.freeze({SCHEMA,VERSION,evaluate});
});

;
/* sealed source: portfolio-local-only-contract.js */
(function(root,factory){const node=typeof module==='object'&&module.exports,api=factory(node?require('./portfolio-investable-cash-core'):root.HSPortfolioInvestableCashCore,node?require('./portfolio-capital-build-plan-core'):root.HSPortfolioCapitalBuildPlanCore);if(node)module.exports=api;if(root)root.HSPortfolioLocalOnlyContract=api;})(globalThis,function(cash,core){
 'use strict';const KEY='hsRadar.portfolio.localPlanReference.v1',SCHEMA='HS_PERSONAL_LOCAL_PLAN_V1',seal=x=>({...x,sha256:cash.fingerprint(x)});
 const defaults=()=>({duration_months:6,normal_equity_target_bps:7600,maximum_equity_limit_bps:9500,etf_target_weights:{'00830':100},allocation_tolerance_reference:{contract:'HS_PORTFOLIO_DASHBOARD_V1',mode:'ABSOLUTE_PERCENTAGE_POINTS',value:5,reference:'PERSONAL_LOCAL_ONLY_EXPLICIT_SETTINGS'}});
 function validateSettings(settings){core.localReference(settings,{equity_minor:0,available_cash_minor:0});return settings;}
 function create(previous,settings,at){validateSettings(settings);if(typeof at!=='string'||!/(Z|[+-]\d\d:\d\d)$/.test(at)||!Number.isFinite(Date.parse(at)))throw Error('LOCAL_SETTINGS_TIME_INVALID');if(previous)validate(previous);return seal({schema:SCHEMA,version:1,mode:'LOCAL_ONLY',reference_only:true,revision:(previous?.revision||0)+1,confirmed_at:at,previous_sha256:previous?.sha256??null,settings:JSON.parse(JSON.stringify(settings)),restrictions:{creates_buy:false,consumes_budget:false,external_high_water:false,production_writer:false}});}
 function validate(value){const{sha256,...body}=value||{};if(body.schema!==SCHEMA||body.version!==1||body.mode!=='LOCAL_ONLY'||body.reference_only!==true||!Number.isSafeInteger(body.revision)||body.revision<1||body.restrictions?.creates_buy!==false||body.restrictions?.consumes_budget!==false||body.restrictions?.external_high_water!==false||body.restrictions?.production_writer!==false||cash.fingerprint(body)!==sha256)throw Error('INVALID_LOCAL_ONLY_CONTRACT');validateSettings(body.settings);return value;}
 return Object.freeze({KEY,SCHEMA,defaults,create,validate});
});

;
/* sealed source: portfolio-local-portfolio-read-adapter.js */
(function(root,factory){const node=typeof module==='object'&&module.exports,api=factory(...(node?[require('./portfolio-local-first-core'),require('./portfolio-local-only-contract'),require('./portfolio-simple-holdings-core'),require('./portfolio-dashboard-core'),require('./portfolio-capital-build-plan-core'),require('./portfolio-native-market-core'),require('./canonical-score-resolver'),require('./portfolio-c4-smart-acceleration-core'),require('./portfolio-etf-smart-allocation-core')]:[root.HSPortfolioLocalFirstCore,root.HSPortfolioLocalOnlyContract,root.HSPortfolioSimpleHoldings,root.HSPortfolioDashboardCore,root.HSPortfolioCapitalBuildPlanCore,root.HSPortfolioNativeMarketCore,root.HSCanonicalScoreResolver,root.HSPortfolioC4SmartAccelerationCore,root.HSPortfolioETFSmartAllocationCore]));if(node)module.exports=api;if(root)root.HSPortfolioLocalPortfolioReadAdapter=api;})(globalThis,function(local,contract,simple,dashboard,plan,native,resolver,acceleration,allocation){
 'use strict';const observations=new WeakSet(),clone=x=>JSON.parse(JSON.stringify(x)),MODEL='FINAL_CORE_WEIGHT_V1';
 // A native, time-checked official response is a LOCAL reference observation,
 // not an HS formal Source Trust receipt or executable trading authorization.
 async function observation(record,asOf){if(record?.provider!=='TWSE_MIS'||record.transport!=='FIXED_OFFICIAL_HTTPS'||record.status!==200)return null;const result=await native.parse({...record.input,asOf});if(result.status!=='NATIVE_PARSE_PASS'||result.freshness_status!=='WITHIN_REQUESTED_AGE_UNTRUSTED'||result.normalized.price_type!=='INTRADAY_REFERENCE')return null;const q=Object.freeze({symbol:result.normalized.symbol,price:result.normalized.reference_price_minor/100,as_of:result.normalized.source_timestamp,valid_until:new Date(Date.parse(result.normalized.source_timestamp)+600000).toISOString(),source:result.source_endpoint,raw_sha256:result.raw_payload_sha256,scope:'LOCAL_OFFICIAL_REFERENCE_ONLY',formal_source_trust:false});observations.add(q);return q;}
 function score(artifact,symbol,now){if(symbol==='009815')return{score:null,status:'WAIT_NATIVE',date:null};if(symbol==='00631L')return{score:null,status:'NOT_GENERAL_C4',date:null};const day=new Date(Date.parse(now)+28800000).toISOString().slice(0,10);if(artifact?.core_score_version!==MODEL)return{score:null,status:'UNAVAILABLE',date:null};for(const snapshot of [...(artifact.snapshots||[])].sort((a,b)=>String(b.date).localeCompare(String(a.date)))){const rows=(snapshot.rows||[]).filter(r=>r.symbol===symbol),at=Date.parse(snapshot.finalized_at),dataAt=Date.parse(rows[0]?.data_as_of);if(rows.length!==1||typeof rows[0].final_core_score!=='number'||!Number.isFinite(rows[0].final_core_score)||!Number.isFinite(at)||!Number.isFinite(dataAt)||snapshot.date>day||at>Date.parse(now)||dataAt>Date.parse(now))continue;const normalized=resolver.normalizeFinalizedSnapshot(snapshot,{scoreVersion:MODEL,symbols:[symbol],targetDate:day}),item=normalized?.items?.[symbol];if(item)return{score:item.score,date:snapshot.date,source:'FINALIZED',version:MODEL,status:snapshot.date===day?'SAVED_FORMAL':'HISTORICAL_FORMAL',current_for_trade:false,multiplier_reference:acceleration.multiplier(item.score)};}return{score:null,status:'UNAVAILABLE',date:null};}
 function service(storage,{clock=()=>new Date().toISOString()}={}){const original=local.service(storage,{clock});
  function read({quotes=[],c4=null,catalog=[]}={}){const now=clock(),state=original.read();if(state.status!=='READY')return{status:'RECOVERY_REQUIRED',rows:[],allocation:[],equity_minor:null,reference:null,source_status:'行情待更新'};const before=state.snapshot.state_sha256,registry=original.simpleRead(),merged=new Map();for(const h of registry.legacy){if(merged.has(h.symbol))throw Error('DUPLICATE_LEGACY_POSITION');merged.set(h.symbol,h);}for(const h of registry.store.records)merged.set(h.symbol,h);const records=[...merged.values()],rows=records.map(h=>{const q=quotes.find(q=>q.symbol===h.symbol),estimated=simple.estimate(h,q,{now:Date.parse(now),verifyQuote:q=>observations.has(q)});return{...h,name:catalog.find(x=>x.symbol===h.symbol)?.name||h.name,code:h.symbol,quoteStatus:estimated.price===null?'unavailable':'current',...estimated,c4:score(c4,h.symbol,now),counts_in_equity:true,recommendation_eligible:acceleration.ELIGIBLE.includes(h.symbol)&&h.symbol!=='009815',quantity_source:h.legacy?'LEGACY_POSITION':'LOCAL_REGISTER_DISPLAY_OVERRIDE'};});
   for(const row of rows)row.market_value_minor=row.price===null?null:plan.localPositionValue(row.shares,row.price);const complete=rows.every(r=>r.market_value_minor!==null),equity=complete?rows.reduce((n,r)=>{const sum=n+r.market_value_minor;if(!Number.isSafeInteger(sum))throw Error('LOCAL_VALUATION_OVERFLOW');return sum;},0):null,distribution=complete?dashboard.allocation(rows.map(r=>({...r,marketValue:r.market_value_minor/100})),Math.max(1,rows.length)):[],raw=storage.getItem(contract.KEY),preferences=raw?contract.validate(JSON.parse(raw)):null,settings=preferences?.settings||contract.defaults(),cashMinor=['READY','PENDING'].includes(state.cash?.status)&&Number.isSafeInteger(state.cash?.amountMinor)?state.cash.amountMinor:null;
   let reference=null;if(equity!==null&&cashMinor!==null)reference=plan.localReference(settings,{equity_minor:equity,available_cash_minor:cashMinor});const total=reference?.total_assets_minor??null;const targets=Object.entries(settings.etf_target_weights).map(([symbol,weight])=>{const row=rows.find(r=>r.symbol===symbol),value=complete?(row?.market_value_minor||0):null,target=equity!==null?Number(BigInt(equity)*BigInt(Math.round(weight*10))/1000n):null;return{symbol,weight,current_value_minor:value,target_minor:target,gap_minor:target===null?null:target-value,c4:score(c4,symbol,now)};});
   const unchanged=original.read();if(unchanged.status!=='READY'||unchanged.snapshot.state_sha256!==before)throw Error('LOCAL_READ_REVISION_CHANGED');return{scope:'LOCAL_ONLY',status:complete?'REFERENCE_READY':'MARKET_PENDING',rows,allocation:distribution,equity_minor:equity,cash_minor:cashMinor,total_assets_minor:total,equity_weight_percent:total>0?equity/total*100:null,settings,preferences,reference,targets,snapshot:state.snapshot,source_status:complete?'本機官方參考行情；非正式交易授權':'行情待更新；配置暫不可計算',fourA:acceleration.evaluate(null),fourB:allocation.evaluate(null),executable_budget_minor:null,creates_buy:false,financial_writes:0,production_writer:false};
  }return Object.freeze({read});
 }
 return Object.freeze({service,observation,score,isLocalObservation:q=>observations.has(q)});
});

;(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.HSPersonalNamespace=api;})(globalThis,function(){
 'use strict';
 const PREFIX='hsPersonalV3.v1.',LEGACY_PREFIX='hsPersonalV2.v1.';
 function encode(key){return [...new TextEncoder().encode(String(key))].map(x=>x.toString(16).padStart(2,'0')).join('');}
 function decode(key,prefix){const x=key.slice(prefix.length);if(!/^(?:[a-f0-9]{2})+$/.test(x))throw Error('PERSONAL_STORAGE_KEY_INVALID');return new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(x.match(/../g),h=>parseInt(h,16)));}
 function scoped(storage,prefix,readonly){const keys=()=>{const a=[];for(let i=0;i<storage.length;i++){const k=storage.key(i);if(k?.startsWith(prefix))a.push(k);}return a;};return Object.freeze({namespace:prefix,get length(){return keys().length;},key(i){const k=keys()[i];return k===undefined?null:decode(k,prefix);},getItem(k){return storage.getItem(prefix+encode(k));},setItem(k,v){if(readonly)throw Error('LEGACY_STORAGE_IS_READ_ONLY');storage.setItem(prefix+encode(k),String(v));},removeItem(k){if(readonly)throw Error('LEGACY_STORAGE_IS_READ_ONLY');storage.removeItem(prefix+encode(k));}});}
 const create=storage=>scoped(storage,PREFIX,false),legacy=storage=>scoped(storage,LEGACY_PREFIX,true);
 return Object.freeze({PREFIX,LEGACY_PREFIX,create,legacy,isOwnKey:key=>key===null||typeof key==='string'&&key.startsWith(PREFIX)});
});

// Prices must first pass the existing HSRadarHistorySource.fetchArchive validator.
// Validate only the explicitly verified incremental window, never promote an
// OBSERVED_ONLY historical file into a complete exchange calendar.
(function(root,f){if(typeof module==='object'&&module.exports)module.exports=f();else root.HSPersonalV3HistoryBasis=f();})(globalThis,function(){
 function apply(q,archive,status,actions,now){try{
 if(!q||!archive||archive.verified!==true||archive.price_type!=='RAW_UNADJUSTED'||archive.currency!=='TWD'||archive.symbol!==q.symbol||!Number.isFinite(Date.parse(archive.fetched_at))||Date.parse(archive.fetched_at)>Date.parse(now)||!/^[a-f0-9]{64}$/.test(archive.content_sha256)||!Array.isArray(archive.price))return q;
 const inc=archive.incremental_verification;if(!inc||inc.corporate_actions!=='VERIFIED'||!Array.isArray(inc.sessions)||!Array.isArray(inc.calendar_evidence)||!inc.calendar_evidence.some(e=>/^https:\/\/www.twse.com.tw\/exchangeReport\/FMTQIK\?response=json&date=\d{8}$/.test(e.url)&&/^[a-f0-9]{64}$/.test(e.sha256)))return q;
 const sessions=inc.sessions;if(new Set(sessions).size!==sessions.length||sessions.some((d,i)=>d<inc.start||d>inc.end||i&&d<=sessions[i-1]))return q;
 const live=q.kind==='INTRADAY_REFERENCE';let previous;
 if(live){if(q.date!==status?.next_expected_trading_day||status.expected_completed_bar>archive.requested_end)return q;previous=status.expected_completed_bar;}
 else{const i=sessions.indexOf(q.date);if(i<1)return q;previous=sessions[i-1];if(!archive.price.some(p=>p.date===q.date&&p.close===q.price))return q;}
 const old=archive.price.find(p=>p.date===previous);if(!archive.action_coverage?.start||!archive.action_coverage?.end||!old||!Number.isFinite(old.close)||old.close<=0||!Number.isFinite(q.previous_reference)||archive.action_coverage?.start>previous||archive.action_coverage?.end<(live?previous:q.date))return q;
 const split=actions.find(a=>a.symbol===q.symbol&&a.effective&&previous<a.effective&&q.date>=a.effective),ratio=split?.ratio||1;
 const dividends=archive.dividends.filter(d=>d.date===q.date);if(live&&archive.action_coverage.end<q.date)return q; // no guessing today's action absence
 const entitlement=dividends.reduce((n,d)=>n+d.amount,0);if(!Number.isFinite(entitlement)||entitlement<0||ratio!==1&&entitlement!==0)return q;
 if(Math.abs(old.close/ratio-entitlement-q.previous_reference)>1e-6)return q;
 return{...q,previous_reference:old.close,previous_session_date:previous,reference_kind:'RAW_PREVIOUS_OFFICIAL',cash_entitlement_per_share:entitlement,history_sha256:archive.content_sha256,calendar_scope:'VERIFIED_INCREMENTAL_WINDOW'};
 }catch{return q;}}
 return Object.freeze({apply});
});

(function(root,f){if(typeof module==='object'&&module.exports)module.exports=Object.freeze({create:f});else root.HSPersonalV3Accounting=f(root.HSPortfolioLedgerCore,root.HSPortfolioInvestableCashCore);})(globalThis,function(L,C){
 'use strict';
 const KEY='hsRadar.portfolio.personalAccountingV3.v1',fp=C.fingerprint,fail=s=>{throw Error(s);},date=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
 const time=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(s)&&date(s.slice(0,10))&&+s.slice(11,13)<24&&+s.slice(14,16)<60&&+s.slice(17,19)<60&&Number.isFinite(Date.parse(s)),minor=n=>{if(!Number.isSafeInteger(n))fail('金額超過安全範圍');return n;},money=n=>n<0?-C.toMinorUnits(-n):C.toMinorUnits(n),sum=xs=>minor(xs.reduce((a,b)=>a+b,0));
 const actions=Object.freeze([{id:'TWSE-00662-20261117-5',symbol:'00662',effective:'2026-11-17',ratio:5,status:'ANNOUNCED',source:'https://www.twse.com.tw/zh/ETFortune/announcement?company=A00010&date=20260910&fund=00662&seq=1&type=all'},{id:'CATHAY-00830-20261119-VOTE',symbol:'00830',effective:null,ratio:null,review_after:'2026-11-19',status:'PENDING_VOTE',source:'https://www.cathaysite.com.tw/proj/00830stocksplit/index.html'}]);
 actions.forEach(Object.freeze);const binding=h=>fp({symbol:h.symbol,shares:h.shares,break_even_price:h.break_even_price??null,legacy:h.legacy===true,created_at:h.created_at??null,updated_at:h.updated_at??null});
 const seal=o=>({...o,sha256:fp(o)});
 function validateReceipt(r){const{sha256,...b}=r||{};if(b.schema!=='HS_PERSONAL_UNIT_CONFIRMATION_V1'||sha256!==fp(b)||!b.id||!date(b.quote_date)||!time(b.confirmed_at)||Date.parse(b.confirmed_at)<Date.parse(b.quote_date+'T00:00:00+08:00')||!['CURRENT_UNITS','PRE_SPLIT','POST_SPLIT'].includes(b.basis)||typeof b.holding_sha256!=='string'||b.registry_sha256!==fp(actions)||!Number.isFinite(b.shares)||b.shares<=0||b.shares>1e12||b.break_even_price!==null&&(!Number.isFinite(b.break_even_price)||b.break_even_price<=0)||b.evidence_classification!=='USER_CONFIRMED_NOT_BROKER_AUTHENTICATED')fail('價格單位確認紀錄需要核對');if(b.basis!=='CURRENT_UNITS'){const a=actions.find(a=>a.id===b.action_id);if(!a?.effective||b.symbol!==a.symbol||b.quote_date<a.effective||b.ratio!==a.ratio)fail('分割日期或官方比例不符');}else if(b.ratio!==1)fail('不可猜測分割比例');return r;}
 function confirmUnits(h,{basis,quoteDate,at,id,shares,breakEven}){if(!date(quoteDate)||!time(at)||!id)fail('需要完整確認時間');const a=actions.find(a=>a.symbol===h.symbol&&a.effective&&quoteDate>=a.effective);if(basis!=='CURRENT_UNITS'&&!a)fail('官方分割比例尚未確定');if(actions.some(a=>a.symbol===h.symbol&&a.effective&&new Date(Date.parse(at)+28800000).toISOString().slice(0,10)>=a.effective&&quoteDate<a.effective))fail('需先取得分割後行情');const factor=basis==='PRE_SPLIT'?a.ratio:1;return validateReceipt(seal({schema:'HS_PERSONAL_UNIT_CONFIRMATION_V1',id,symbol:h.symbol,holding_sha256:binding(h),quote_date:quoteDate,confirmed_at:at,basis,ratio:basis==='CURRENT_UNITS'?1:a.ratio,action_id:a?.id||null,registry_sha256:fp(actions),shares:basis==='CURRENT_UNITS'?Number(shares):h.shares*factor,break_even_price:basis==='CURRENT_UNITS'?(breakEven==null?null:Number(breakEven)):h.break_even_price===null?null:h.break_even_price/factor,evidence_classification:'USER_CONFIRMED_NOT_BROKER_AUTHENTICATED'}));}
 function project(h,receipts=[],quoteDate,now){const r=receipts.filter(r=>r.symbol===h.symbol).at(-1);if(r){validateReceipt(r);if(r.holding_sha256!==binding(h)||Date.parse(r.confirmed_at)>Date.parse(now))return{...h,unit_status:'UNIT_CONFIRMATION_CHANGED_REQUIRED'};if(actions.some(a=>a.symbol===h.symbol&&a.effective&&r.quote_date<a.effective&&quoteDate>=a.effective)||h.symbol==='00830'&&quoteDate>='2026-11-19'&&r.quote_date!==quoteDate)return{...h,unit_status:'NEW_ACTION_CONFIRMATION_REQUIRED'};if(quoteDate&&quoteDate<r.quote_date)return{...h,unit_status:'PRICE_UNIT_DATE_REQUIRED'};return{...h,shares:r.shares,break_even_price:r.break_even_price,unit_status:'AS_CONFIRMED',unit_receipt:r};}return{...h};}
 function validateStorage(entries,now=Date.now()){if(!Number.isFinite(now))fail('時鐘需要確認');const prefs=entries?.['hsRadar.portfolio.personalReferenceV3.v1'];if(prefs&&JSON.parse(prefs).referencePlan){const p=JSON.parse(prefs);validateReference(p.referencePlan);if(p.referencePlan.months!==p.months||Date.parse(p.referencePlan.start_at)>Date.parse(p.confirmed_at))fail('建倉參考版本不一致');}const ph=entries?.['hsRadar.portfolio.personalReferenceV3.v1.history'];if(ph)for(const p of JSON.parse(ph))if(p.referencePlan)validateReference(p.referencePlan);const text=entries?.[KEY],hist=entries?.[KEY+'.history'];if(text==null){if(hist!=null)fail('單位確認版本遺失');return{revision:0,receipts:[]};}const check=x=>{if(x?.schema!=='HS_PERSONAL_ACCOUNTING_V1'||!Number.isSafeInteger(x.revision)||x.revision<1||!time(x.at)||Date.parse(x.at)>now||!Array.isArray(x.receipts)||x.receipts.length>1000)fail('單位確認資料損壞');const ids=new Set();for(const r of x.receipts){validateReceipt(r);if(ids.has(r.id)||Date.parse(r.confirmed_at)>Date.parse(x.at))fail('重複或未來的單位確認');ids.add(r.id);}return x;};const current=check(JSON.parse(text)),history=JSON.parse(hist||'[]');if(!Array.isArray(history)||history.length!==current.revision-1)fail('單位確認歷史不完整');let previous=0;for(const[x,i]of history.map((x,i)=>[x,i])){check(x);if(x.revision!==i+1||Date.parse(x.at)<previous)fail('單位確認歷史不連續');previous=Date.parse(x.at);}if(Date.parse(current.at)<previous)fail('單位確認時間倒退');return current;}
 function appendReceipt(previous,receipt,at){validateReceipt(receipt);if(!time(at)||Date.parse(at)<Date.parse(receipt.confirmed_at)||previous.at&&Date.parse(at)<Date.parse(previous.at))fail('確認時鐘倒退，資料未寫入');if(previous.receipts.some(r=>r.id===receipt.id)){if(previous.receipts.some(r=>r.id===receipt.id&&fp(r)!==fp(receipt)))fail('相同確認ID內容不一致');return previous;}return{schema:'HS_PERSONAL_ACCOUNTING_V1',revision:previous.revision+1,at,receipts:[...previous.receipts,receipt]};}
 function replay(events){if(!Array.isArray(events)||events.some(e=>!date(e.tradeDate)||!time(e.timestamp)))fail('交易日期無效');const p=L.derivePortfolioStateFromLedger(events);if(!p.valid)fail('交易紀錄無效：'+p.status);return p;}
 function costs(holdings,events,asOf){try{if(asOf&&(!time(asOf)||events.some(e=>e.tradeDate>new Date(Date.parse(asOf)+28800000).toISOString().slice(0,10)||Date.parse(e.updatedAt)>Date.parse(asOf))))fail('未來交易需要核對');const p=replay(events),map=new Map(p.holdings.map(h=>[h.symbol,h]));const rows=holdings.map(h=>{const b=map.get(h.symbol);let compatible=b&&Math.abs(b.quantity-h.shares)<1e-8;if(b&&!compatible&&h.unit_receipt?.basis==='PRE_SPLIT'){const a=actions.find(a=>a.id===h.unit_receipt.action_id);compatible=a&&Math.abs(b.quantity*a.ratio-h.shares)<1e-8&&events.filter(e=>e.symbol===h.symbol).every(e=>e.tradeDate<a.effective);}return{symbol:h.symbol,cost_minor:compatible?money(b.costBasis):null,source:compatible?'LEDGER_REPLAY':b?'POSITION_RECONCILIATION_REQUIRED':'BROKER_REFERENCE_ONLY'};});return{rows,total_cost_minor:rows.every(r=>r.cost_minor!==null)?sum(rows.map(r=>r.cost_minor)):null,realized_minor:money(p.realizedPnL),dividend_gross_minor:money(p.dividendIncome),ledger_fingerprint:fp(events)};}catch(e){return{rows:holdings.map(h=>({symbol:h.symbol,cost_minor:null,source:'RECONCILIATION_REQUIRED'})),total_cost_minor:null,realized_minor:null,dividend_gross_minor:null,reason:e.message};}}
 // Stock trading P/L uses the exchange's ex-right/ex-dividend comparison basis.
 // It is not total-return performance; recorded dividend income is shown separately.
 function daily({holdings,events,metadata={},quotes,now,positionValue}){try{if(!time(now)||!holdings.length&&!events.length)fail('尚無完整持股');const ds=new Set((holdings.length?holdings.map(h=>h.symbol):[...new Set(events.filter(e=>e.symbol).map(e=>e.symbol))]).map(s=>quotes.get(s)?.date));if(ds.size!==1||!date([...ds][0]))fail('行情日期不一致');const d=[...ds][0],cut=d+'T09:00:00+08:00',nowMs=Date.parse(now);if(Date.parse(d+'T00:00:00+08:00')>nowMs)fail('行情日期在未來');const end=replay(events.filter(e=>e.tradeDate<=d)),start=replay(events.filter(e=>e.tradeDate<d)),byStart=new Map(start.holdings.map(h=>[h.symbol,h.quantity])),byEnd=new Map(end.holdings.map(h=>[h.symbol,h.quantity])),selected=new Set(holdings.map(h=>h.symbol));let opening=0,ending=0,buy=0,sell=0,entitlement=0,completeRaw=true;
 const all=new Map(holdings.map(h=>[h.symbol,h]));for(const s of new Set([...byStart.keys(),...byEnd.keys(),...events.filter(e=>e.tradeDate===d&&['BUY','SELL'].includes(e.type)).map(e=>e.symbol)]))if(!all.has(s))all.set(s,{symbol:s,shares:0});for(const h of all.values()){const q=quotes.get(h.symbol);if(!q||!Number.isFinite(q.price)||q.price<=0||!['OFFICIAL_CLOSE_REFERENCE','INTRADAY_REFERENCE'].includes(q.kind)||q.kind==='OFFICIAL_CLOSE_REFERENCE'&&nowMs<Date.parse(d+'T13:30:00+08:00')||!['EXCHANGE_COMPARISON_PRICE','RAW_PREVIOUS_OFFICIAL'].includes(q.reference_kind)||!Number.isFinite(q.previous_reference)||q.previous_reference<=0||q.date!==d||q.kind==='INTRADAY_REFERENCE'&&(!time(q.as_of)||Date.parse(q.as_of)>nowMs||nowMs-Date.parse(q.as_of)>Math.min(q.maxAgeMs||180000,600000)))fail('缺少有效的交易所比較基準');const action=actions.find(a=>a.id===h.unit_receipt?.action_id);const scale=h.unit_receipt?.basis==='PRE_SPLIT'&&action?.effective<=d&&events.filter(e=>e.symbol===h.symbol).every(e=>e.tradeDate<action.effective)?action.ratio:1;const raw=q.reference_kind==='RAW_PREVIOUS_OFFICIAL';if(raw&&(!date(q.previous_session_date)||q.previous_session_date>=d||!/^[a-f0-9]{64}$/.test(q.history_sha256)||q.calendar_scope!=='VERIFIED_INCREMENTAL_WINDOW'))fail('缺少前一交易日證據');completeRaw&&=raw;const openingScale=raw&&action?.effective&&q.previous_session_date<action.effective?1:scale;let qty=byStart.has(h.symbol)?byStart.get(h.symbol)*openingScale:undefined;
 if(byEnd.has(h.symbol)||qty!==undefined||events.some(e=>e.symbol===h.symbol&&e.tradeDate===d&&['BUY','SELL'].includes(e.type))){if(Math.abs((byEnd.get(h.symbol)||0)*scale-h.shares)>1e-8)fail('當日持股與帳本不一致');for(const e of events.filter(e=>e.symbol===h.symbol&&e.tradeDate===d)){if(['OPENING_POSITION','POSITION_CORRECTION'].includes(e.type))fail('當日持股調整需要核對');if(['SPLIT','REVERSE_SPLIT','STOCK_DIVIDEND'].includes(e.type)){if(!actions.some(a=>a.symbol===e.symbol&&a.effective===d&&a.ratio===e.ratio))fail('公司行動缺少官方比例');if(!raw)qty=(qty||0)*e.ratio;}if(['BUY','SELL'].includes(e.type)){const m=metadata[e.id];if(!m||m.event_sha256!==fp(e)||!time(m.occurred_at)||!time(m.recorded_at)||new Date(Date.parse(m.occurred_at)+28800000).toISOString().slice(0,10)!==d||Date.parse(m.occurred_at)>nowMs||Date.parse(m.recorded_at)>nowMs||Date.parse(e.updatedAt)>nowMs)fail('缺少當日交易時間核對');if(e.type==='BUY')buy+=money(-e.cashImpact);else sell+=money(e.cashImpact);}}}else{if(h.legacy||!time(h.updated_at)||Date.parse(h.updated_at)>=Date.parse(cut)||h.unit_receipt&&h.unit_receipt.quote_date>=d&&h.unit_receipt.basis!=='PRE_SPLIT')fail('未具備交易日前的持股確認');qty=raw&&action?.effective&&q.previous_session_date<action.effective&&h.unit_receipt?.basis==='PRE_SPLIT'?h.shares/action.ratio:h.shares;}
 if(raw){const per=q.cash_entitlement_per_share||0;if(!Number.isFinite(per)||per<0)fail('除息權利金額無效');entitlement+=positionValue(qty||0,per);}opening+=positionValue(qty||0,q.previous_reference);ending+=positionValue(h.shares,q.price);}
 if(events.some(e=>e.tradeDate===d&&['FEE','TAX'].includes(e.type)))fail('另列費稅需要核對，避免重複計算');const denominator=minor(opening+buy),pnl=minor(ending-opening-buy+sell+entitlement);return{status:completeRaw?'AVAILABLE':'REFERENCE_ONLY',entitlement_minor:minor(entitlement),date:d,pnl_minor:pnl,percent:denominator>0?pnl/denominator*100:null,denominator_minor:denominator,method:completeRaw?'VERIFIED_RAW_CLOSE_PLUS_NET_TRADES_AND_ENTITLEMENT':'EXCHANGE_COMPARISON_REFERENCE_ONLY',description:completeRaw?'期初正式收盤市值加當日買進支出為報酬率分母；含已驗證的當日除息權利（稅前），不代表款項已入帳。':'只有行情比較基準，不代表完整持股損益'};}catch(e){return{status:'INCOMPLETE',pnl_minor:null,percent:null,reason:e.message};}}
 function referencePlan({previous=null,at,months,gapMinor,events,splitMinor}){if(previous){validateReference(previous);return{...previous,months,forecast_minor:splitMinor(previous.initial_gap_minor,months)};}if(!time(at)||![3,6,12].includes(months)||!Number.isSafeInteger(gapMinor)||gapMinor<0)fail('建倉參考基準不足');replay(events);return{schema:'HS_PERSONAL_REFERENCE_PLAN_V1',start_at:at,months,initial_gap_minor:gapMinor,event_pins:events.map(e=>({id:e.id,sha256:fp(e)})),rule:'CONSERVATIVE_ACTUAL_BUY_PRINCIPAL_REFERENCE_ONLY',forecast_minor:splitMinor(gapMinor,months)};}
 function validateReference(p){if(p?.schema!=='HS_PERSONAL_REFERENCE_PLAN_V1'||!time(p.start_at)||![3,6,12].includes(p.months)||!Number.isSafeInteger(p.initial_gap_minor)||p.initial_gap_minor<0||p.rule!=='CONSERVATIVE_ACTUAL_BUY_PRINCIPAL_REFERENCE_ONLY'||!Array.isArray(p.event_pins)||new Set(p.event_pins.map(e=>e.id)).size!==p.event_pins.length||p.event_pins.some(e=>typeof e.id!=='string'||!/^[a-f0-9]{64}$/.test(e.sha256)))fail('建倉參考版本需要核對');if(!Array.isArray(p.forecast_minor)||p.forecast_minor.length!==p.months||p.forecast_minor.some((n,i)=>n!==Math.floor(p.initial_gap_minor/p.months)+(i<p.initial_gap_minor%p.months?1:0)))fail('建倉分期金額不一致');return p;}
 function planRemaining({formalPlan,reference,events,syncState,now,planCore,sourceSnapshot}){try{replay(events);if(!time(now))fail('時鐘無效');if(formalPlan){planCore.validatePlan(formalPlan);if(!sourceSnapshot||sourceSnapshot.revision<formalPlan.source_watermark.revision||sourceSnapshot.ledger_revision<formalPlan.ledger_at_creation.revision||sourceSnapshot.revision===formalPlan.source_watermark.revision&&sourceSnapshot.state_sha256!==formalPlan.source_watermark.state_sha256)fail('建倉來源版本與SHA不一致');if(Date.parse(now)<Date.parse(formalPlan.updated_at))fail('建倉時鐘倒退');if(!syncState||fp(syncState.events)!==fp(events))fail('建倉交易來源不一致');const totals=planCore.validateAttributions(formalPlan,events,syncState),p=planCore.periodAt(formalPlan,now),q=formalPlan.quota_records.find(q=>q.period_id===p.id),used=totals[p.id]||0;return{status:p.status==='ACTIVE'?(q?'READY':'NOT_ISSUED'):p.status,remaining_minor:p.status==='ACTIVE'&&q?Math.max(0,q.approved_minor-used):0,invested_minor:used,total_invested_minor:sum(Object.values(totals)),period:p.index,months:formalPlan.duration_months,source:'EXISTING_FORMAL_PLAN_READ_ONLY'};}
 if(!reference)return{status:'UNINITIALIZED',remaining_minor:null,invested_minor:null};validateReference(reference);if(Date.parse(now)<Date.parse(reference.start_at))fail('建倉時鐘倒退');const p=planCore.periodAt({plan_id:'LOCAL_REFERENCE',start_at:reference.start_at,duration_months:reference.months},now);for(const pin of reference.event_pins)if(!events.some(e=>e.id===pin.id&&fp(e)===pin.sha256))fail('原建倉交易已修改或撤銷');let used=0,total=0;for(const e of events.filter(e=>e.type==='BUY'&&!reference.event_pins.some(p=>p.id===e.id))){const m=syncState?.coverageReviews?.find(m=>m.event_id===e.id)||syncState?.metadata?.[e.id];if(!m||m.event_sha256!==fp(e)||!time(m.occurred_at)||!time(m.recorded_at)||Date.parse(m.recorded_at)>Date.parse(now)||Date.parse(m.occurred_at)>Date.parse(now))fail('新買進缺少已核對的時間與內容');if(Date.parse(m.occurred_at)<Date.parse(reference.start_at))continue;const principal=money(e.grossAmount);total+=principal;if(planCore.periodAt({plan_id:'LOCAL_REFERENCE',start_at:reference.start_at,duration_months:reference.months},m.occurred_at).id===p.id)used+=principal;}
 const quota=p.index?planCore.splitMinor(reference.initial_gap_minor,reference.months)[p.index-1]:0;return{status:p.status==='ACTIVE'?'READY':'COMPLETED',remaining_minor:p.status==='ACTIVE'?Math.max(0,quota-used):0,invested_minor:minor(used),total_invested_minor:minor(total),period:p.index,months:reference.months,source:'LOCAL_REFERENCE_NOT_FORMAL_ATTRIBUTION'};
 }catch(e){return{status:'RECONCILIATION_REQUIRED',remaining_minor:null,invested_minor:null,reason:e.message};}}
 return Object.freeze({KEY,actions,binding,validateReceipt,confirmUnits,project,validateStorage,appendReceipt,costs,daily,referencePlan,validateReference,planRemaining});
});

(function(root,f){const api=f();if(typeof module==='object'&&module.exports)module.exports=api;else root.HSPersonalV3Core=api;})(globalThis,function(){
 'use strict';const KEY='hsRadar.portfolio.personalReferenceV3.v1',SCHEMA='HS_PERSONAL_REFERENCE_V3';
 const referencePrice=v=>typeof v==='number'&&Number.isFinite(v)&&v>0&&Math.abs(v-Math.round(v*1e6)/1e6)<=1e-8?Math.round(v*1e6)/1e6:null;const day=now=>new Date(Date.parse(now)+28800000).toISOString().slice(0,10),validDate=s=>{try{return /^\d{4}-\d{2}-\d{2}$/.test(s||'')&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;}catch{return false;}};
 function validate(x){if(x?.schema!==SCHEMA||x.version!==1||!Number.isSafeInteger(x.revision)||x.revision<1||!Number.isFinite(Date.parse(x.confirmed_at))||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(x.confirmed_at)||!validDate(x.confirmed_at.slice(0,10))||+x.confirmed_at.slice(11,13)>23||+x.confirmed_at.slice(14,16)>59||+x.confirmed_at.slice(17,19)>59||!x.targets||typeof x.targets!=='object'||Array.isArray(x.targets)||![3,6,12].includes(x.months)||!Number.isInteger(x.equityTargetBps)||!Number.isInteger(x.equityMaxBps)||x.equityTargetBps<0||x.equityTargetBps>x.equityMaxBps||x.equityMaxBps>9500||x.feeReserveMinor!==null&&(!Number.isSafeInteger(x.feeReserveMinor)||x.feeReserveMinor<0)||![1,1000].includes(x.unit))throw Error('目標設定資料需要確認');for(const[k,v]of Object.entries(x.targets))if(!/^[0-9A-Z]{4,10}$/.test(k)||!Number.isFinite(v)||v<0||v>100||Math.abs(v*10-Math.round(v*10))>1e-7)throw Error('目標占比必須介於0至100%，最多一位小數');return x;}
 function preferences(previous,input,at){return validate({schema:SCHEMA,version:1,revision:(previous?.revision||0)+1,confirmed_at:at,months:input.months,equityTargetBps:input.equityTargetBps,equityMaxBps:input.equityMaxBps,targets:{...input.targets},feeReserveMinor:input.feeReserveMinor??null,unit:input.unit||1,referencePlan:input.referencePlan??previous?.referencePlan??null});}
 const defaults=()=>({months:6,equityTargetBps:7600,equityMaxBps:9500,targets:{},feeReserveMinor:null,unit:1});
 function session(status,now){if(!status||!validDate(status.expected_completed_bar)||!validDate(status.next_expected_trading_day)||status.next_expected_trading_day<=status.expected_completed_bar||day(now)<status.expected_completed_bar)return null;const today=day(now),next=status.next_expected_trading_day;if(today<next)return{completed:status.expected_completed_bar,live:false,known:true};if(today===next){const m=+new Date(Date.parse(now)+28800000).toISOString().slice(11,13)*60+ +new Date(Date.parse(now)+28800000).toISOString().slice(14,16);return{completed:m>=18*60?next:status.expected_completed_bar,live:m>=540&&m<=810,known:true};}return{completed:null,live:false,known:false};}
 function closeQuotes(cache,status,now){const s=session(status,now),out=new Map(),seen=new Set();if(cache?.version!==2||!Array.isArray(cache.items)||!Number.isFinite(Date.parse(cache.updated_at))||Date.parse(cache.updated_at)>Date.parse(now))return out;for(const row of cache.items){if(seen.has(row.code)){out.delete(row.code);continue;}seen.add(row.code);const market=row.market,endpoint=market==='TWSE'?'https://www.twse.com.tw/exchangeReport/MI_INDEX':market==='TPEx'?'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes':null;if(!/^[0-9A-Z]{4,10}$/.test(row.code)||s?.known&&row.date>status.expected_completed_bar&&row.date!==status.next_expected_trading_day||!endpoint||cache.sources?.[market+'_close']!==endpoint||!['official_closing_data_daily_report','official_closing_data'].includes(cache.source_status?.[market])||!Number.isFinite(Date.parse(cache.official_last_checked_at))||Date.parse(cache.official_last_checked_at)>Date.parse(now)||row.quote_mode!=='close'||!validDate(row.date)||row.date>day(now)||cache.official_source_dates?.[market]!==row.date||cache.source_dates?.[market]!==row.date||typeof row.price!=='number'||!Number.isFinite(row.price)||row.price<=0||Date.parse(cache.official_last_checked_at)<Date.parse(row.date+'T13:30:00+08:00'))continue;out.set(row.code,{symbol:row.code,price:row.price,date:row.date,label:row.date+' 收盤',source:endpoint,kind:'OFFICIAL_CLOSE_REFERENCE',latest:s?.known&&!s.live&&row.date===s.completed&&!(day(now)===status.next_expected_trading_day&&Date.parse(now)>=Date.parse(day(now)+'T13:30:00+08:00')&&row.date!==day(now)),previous_close:null,previous_reference:referencePrice(row.previous_close),reference_kind:'EXCHANGE_COMPARISON_PRICE'});}return out;}
 function view({holdings,cashMinor,prefs,quotes,c4={},eligibleSymbols=['0050','00662','00830','00935','009815'],now,positionValue,allocate,planProgress=null}){const p=prefs||defaults();if(prefs)validate(prefs);const rows=holdings.map(h=>{const candidate=quotes.get(h.symbol),q=candidate&&validDate(candidate.date)&&typeof candidate.price==='number'&&Number.isFinite(candidate.price)&&candidate.price>0?candidate:null,mv=q?positionValue(h.shares,q.price):null,be=typeof h.break_even_price==='number'?positionValue(h.shares,h.break_even_price):null,rawScore=c4[h.symbol],score=typeof rawScore?.score==='number'&&Number.isFinite(rawScore.score)&&rawScore.score>=0&&rawScore.score<=100?rawScore:{score:null,status:'UNAVAILABLE'},pnlBasis=Number.isSafeInteger(h.ledger_cost_minor)&&h.ledger_cost_minor>=0?h.ledger_cost_minor:be,target=Object.hasOwn(p.targets,h.symbol)?p.targets[h.symbol]:null;return{...h,quote:q||null,price:q?.price??null,market_value_minor:mv,reference_basis_minor:be,pnl_basis_minor:pnlBasis,pnl_minor:mv!==null&&pnlBasis!==null?mv-pnlBasis:null,return_percent:mv!==null&&pnlBasis>0?(mv/pnlBasis-1)*100:null,target,c4:score,weight:null,recommendation_eligible:eligibleSymbols.includes(h.symbol)&&!['00631L','009815'].includes(h.symbol)&&score.score!==null&&score.latest===true};});
 const complete=rows.every(r=>r.market_value_minor!==null),dates=new Set(rows.map(r=>r.quote?.date).filter(Boolean)),consistent=complete&&dates.size<=1,equity=consistent?rows.reduce((s,r)=>s+r.market_value_minor,0):null,cash=Number.isSafeInteger(cashMinor)&&cashMinor>=0?cashMinor:null,total=equity!==null&&cash!==null?equity+cash:null;if([equity,total].some(x=>x!==null&&!Number.isSafeInteger(x)))throw Error('金額超過安全範圍');for(const r of rows)r.weight=equity>0?r.market_value_minor/equity*100:null;
 const actualCost=rows.every(r=>Number.isSafeInteger(r.ledger_cost_minor)&&r.ledger_cost_minor>=0)?rows.reduce((s,r)=>s+r.ledger_cost_minor,0):null;const targetsComplete=rows.length>0&&rows.every(r=>r.target!==null)&&Math.abs(rows.reduce((n,r)=>n+Math.round(r.target*10),0)-1000)===0&&Object.keys(p.targets).every(k=>rows.some(r=>r.symbol===k)||p.targets[k]===0),latest=rows.every(r=>r.quote?.latest===true),pnlBase=rows.every(r=>r.pnl_basis_minor!==null)?rows.reduce((s,r)=>s+r.pnl_basis_minor,0):null,pnl=consistent&&rows.every(r=>r.pnl_minor!==null)?rows.reduce((s,r)=>s+r.pnl_minor,0):null,basis=rows.every(r=>r.reference_basis_minor!==null)?rows.reduce((s,r)=>s+r.reference_basis_minor,0):null;
 if([pnl,basis].some(n=>n!==null&&!Number.isSafeInteger(n))||!Number.isSafeInteger((p.feeReserveMinor||0)*rows.length))throw Error('金額超過安全範圍');let budget=null,plan=null;if(total!==null&&targetsComplete&&latest){const afterFees=Math.max(0,total-(p.feeReserveMinor||0)*rows.length),gap=Math.max(0,Number(BigInt(afterFees)*BigInt(p.equityTargetBps)/10000n)-equity),headroom=Math.max(0,Number(BigInt(afterFees)*BigInt(p.equityMaxBps)/10000n)-equity);budget=planProgress?(planProgress.status==='READY'?Math.min(cash,planProgress.remaining_minor,gap,headroom):null):Math.min(cash,Math.floor(gap/p.months),headroom);const candidates=rows.map(r=>({code:r.symbol,marketValue:r.market_value_minor/100,weight:r.weight,targetAllocation:r.target,price:r.price,coreScore:r.recommendation_eligible?r.c4.score:null}));const available=rows.filter(r=>r.weight<=r.target&&r.target>0&&r.recommendation_eligible&&r.c4.score>=40);plan=budget===null?null:allocate({rows:candidates.map(r=>available.some(a=>a.symbol===r.code)?r:{...r,targetAllocation:0}),availableCash:budget/100});}
 let spent=0,reserved=0;for(const r of rows){r.advice=r.target===null?'尚未設定目標':r.weight===null?'行情待更新':r.weight>r.target?'暫緩：目前高於目標':!targetsComplete?'請補齊目標，合計100%':!latest?'行情待更新，暫不分配額度':cash===null?'請先設定可投資現金':planProgress&&planProgress.status!=='READY'?'建倉資料需要確認，暫不分配':budget<=0?'暫緩：已達股票部位目標或本期無可用額度':!r.recommendation_eligible?'觀察：C4資料不足或非適用標的':r.c4.score<40?'觀察：尚未達既有加碼條件':r.weight<r.target?'優先考慮：低於目標且符合C4條件':'符合目標：可依原建倉節奏參考';const allocated=plan?.rows.find(x=>x.symbol===r.symbol)?.allocationAmount;r.reference_budget_minor=typeof allocated==='number'?Math.min(budget-reserved,Math.max(0,Math.round(allocated*100))):null;if(r.reference_budget_minor!==null)reserved+=r.reference_budget_minor;r.estimated_shares=null;r.estimated_outlay_minor=null;if(r.reference_budget_minor!==null&&p.feeReserveMinor!==null&&r.recommendation_eligible&&r.weight<=r.target&&r.target>0){const usable=Math.max(0,r.reference_budget_minor-p.feeReserveMinor);let n=Math.floor(usable/(r.price*100)/p.unit)*p.unit;if(!Number.isSafeInteger(n))continue;while(n>0&&positionValue(n,r.price)>usable)n-=p.unit;r.estimated_shares=n;r.estimated_outlay_minor=n>0?positionValue(n,r.price)+p.feeReserveMinor:0;spent+=r.estimated_outlay_minor;}}
 if(new Set(rows.map(r=>r.symbol)).size!==rows.length)throw Error('重複持股來源需要確認');return{version:3,rows,equity_minor:equity,cash_minor:cash,total_assets_minor:total,pnl_minor:pnl,pnl_percent:pnl!==null&&pnlBase>0?pnl/pnlBase*100:null,reference_basis_minor:basis,actual_cost_minor:actualCost,today_pnl_minor:null,today_pnl_percent:null,today_reason:'缺少可核對的前期持股、當日交易及除權息證據，不推算完整今日損益',price_date:dates.size===1?[...dates][0]:null,complete:consistent,latest,targets_complete:targetsComplete,settings:p,period_reference_minor:budget,remaining_cash_minor:cash===null||rows.some(r=>r.reference_budget_minor>0&&r.estimated_outlay_minor===null)?null:cash-spent,advanced_acceleration:'原4A/4B正式證據與額外額度批准未齊，不發行正式加碼額度',production_writer:false,executable_budget_minor:null};}
 function validateStorage(entries,now=Date.now()){if(!Number.isFinite(now))throw Error('時鐘資料需要確認');const raw=entries?.[KEY],hr=entries?.[KEY+'.history'];if(raw==null){if(hr!=null)throw Error('目標設定歷史缺少目前版本');return null;}const current=validate(JSON.parse(raw)),history=JSON.parse(hr??'[]');if(!Array.isArray(history)||history.length!==current.revision-1)throw Error('目標設定版本不連續');let at=0;for(const[x,i]of history.map((x,i)=>[x,i])){validate(x);if(x.revision!==i+1||Date.parse(x.confirmed_at)<at)throw Error('目標設定歷史需要確認');at=Date.parse(x.confirmed_at);}if(Date.parse(current.confirmed_at)<at||Date.parse(current.confirmed_at)>now)throw Error('目標設定時間需要確認');return current;}
 function unitStatus(h,q){if(h.legacy)return 'LEGACY_UNIT_REVIEW_REQUIRED';if(!q)return 'PRICE_MISSING';if(h.symbol==='00662'&&q.date>='2026-11-17'&&(!h.created_at||h.created_at<'2026-11-17'))return 'SPLIT_BASIS_REVIEW_REQUIRED';if(h.symbol==='00830'&&q.date>='2026-11-19')return 'ACTION_EVIDENCE_REQUIRED';return 'AS_REPORTED';}
 return Object.freeze({KEY,SCHEMA,unitStatus,validate,validateStorage,preferences,defaults,session,closeQuotes,view,day});
});

const {HSPortfolioCore,HSPortfolioLedgerCore,HSPortfolioPerformanceCore,HSPortfolioDashboardCore,HSPortfolioInvestableCashCore,HSPortfolioAnalyticsCore,HSPortfolioWorkflowCore,HSPortfolioResilienceCore,HSPortfolioTransactionCashSyncCore,HSPortfolioWriteCoordinator,HSPortfolioDividendReceiptV2Core,HSPortfolioPlanGenerationCore,HSPortfolioFullBackupCore,HSPortfolioCapitalBuildPlanCore,HSPortfolioApprovalConsumptionCore,HSPortfolioCapitalBuildStorageAdapter,HSCanonicalScoreResolver,HSPortfolioC4SmartAccelerationCore,HSPortfolioApprovalConsumptionAdapter,HSPortfolioTransactionStorageAdapter,HSPortfolioBackupCrypto,HSPortfolioSimpleHoldings,HSPortfolioLocalFirstCore,HSPortfolioLocalOnlyContract,HSPortfolioMarketEvidenceCore,HSPortfolioNativeMarketCore,HSPortfolioETFSmartAllocationCore,HSPortfolioLocalPortfolioReadAdapter}=window;
const scope=document.getElementById('hpv2'),localStorage=window.HSPersonalNamespace.create(host.localStorage),base=new URL('../',document.currentScript.src);
const HSLocalSiteConfig={quote_endpoint:'hpv2:quotes'},HSLocalSiteRuntime={allowed:l=>(l.hostname==='wl03049329-blip.github.io'&&l.pathname.startsWith('/-hs-invest/'))||['127.0.0.1','localhost'].includes(l.hostname),quoteURL:(c,symbols)=> 'hpv2:quotes?symbols='+symbols.join(',')};
const addEventListener=(type,fn)=>host.addEventListener(type,type==='storage'?e=>{if(window.HSPersonalNamespace.isOwnKey(e.key))fn(e);}:fn);
// Read-only official MIS transport. No position quantities, cash or backup leave
// the browser. A blocked CORS request or missing z remains MARKET_PENDING.
async function safeWorker(){
 const registrations=await navigator.serviceWorker?.getRegistrations()||[];
 const relevant=registrations.filter(r=>location.href.startsWith(r.scope));
 if(!relevant.length&&!navigator.serviceWorker?.controller)return true;
 const expected=new URL('push-service-worker.js',base).href;
 if(navigator.serviceWorker?.controller&&navigator.serviceWorker.controller.scriptURL!==expected)return false;
 for(const r of relevant){const worker=r.active||r.waiting||r.installing;if(!worker||worker.scriptURL!==expected)return false;}
 // The HTTPS build pins the exact Worker bytes. No data or financial guard is bypassed.
 const pin=document.querySelector('meta[name="hs-app-worker-sha"]')?.content;
 if(pin!==undefined&&!/^[a-f0-9]{64}$/.test(pin))return false;
 try{const response=await host.fetch(expected+(pin?'?v='+pin:''),{cache:'no-store'});if(!response.ok)return false;const bytes=await response.arrayBuffer(),hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');return hash===(pin||'cfec8b1973d2e37aaeab3ff3de8f84cc69611ef5f8a96ec5efbc95bcdf962311');}catch{return false;}
}
async function fetch(input,options){
 if(!String(input).startsWith('hpv2:quotes'))return host.fetch(input,options);
 const symbols=new URL(String(input).replace('hpv2:','https://local.invalid/')).searchParams.get('symbols')?.split(',').filter(s=>/^\d{4,6}[A-Z]?$/.test(s))||[];
 if(!symbols.length)return{ok:true,json:async()=>({records:[]})};
 const endpoint=new URL('https://mis.twse.com.tw/stock/api/getStockInfo.jsp');endpoint.searchParams.set('ex_ch',symbols.flatMap(s=>['tse_'+s+'.tw','otc_'+s+'.tw']).join('|'));endpoint.searchParams.set('json','1');endpoint.searchParams.set('delay','0');
 const response=await host.fetch(endpoint,{cache:'no-store',credentials:'omit',redirect:'error'});if(!response.ok)throw Error('OFFICIAL_QUOTE_UNAVAILABLE');
 const raw=await response.text(),acquired_at=new Date().toISOString(),payload=JSON.parse(raw),hash=await HSPortfolioMarketEvidenceCore.rawSHA(raw);
 const records=symbols.flatMap(symbol=>{const rows=(payload.msgArray||[]).filter(r=>r.c===symbol);if(rows.length!==1)return[];const market=rows[0].ex==='tse'?'TWSE':rows[0].ex==='otc'?'TPEX':null;if(!market)return[];return[{provider:'TWSE_MIS',transport:'FIXED_OFFICIAL_HTTPS',status:200,input:{provider:'TWSE_MIS',source_revision:'MIS_D_T_Z_V1',source_endpoint:endpoint.href,raw,expected_raw_sha256:hash,acquired_at,raw_reference:endpoint.href,source_receipt_reference:'HTTPS_OFFICIAL_RESPONSE:'+hash,instrument:{symbol,market,currency:'TWD',instrument_id:market+':'+symbol},maximum_quote_age_ms:600000}}];});
 return{ok:true,json:async()=>({records})};
}

'use strict';
(async()=>{
 const $=id=>document.getElementById('hpv2-'+id),simple=HSPortfolioSimpleHoldings,cryptoBackup=HSPortfolioBackupCrypto,api=HSPortfolioLocalFirstCore.service(localStorage,{locks:navigator.locks});let busy=false,catalog=[],cashTicket=null,restoreTicket=null,exportedSha=null,holdingExpected=null,undoTicket=null,undoTimer=null,deletedExpected=null;
 const message=s=>$('status').textContent=/[A-Z]{3,}_[A-Z]/.test(s)?explain(s):s,number=n=>Number.isFinite(n)?n.toLocaleString('zh-TW',{maximumFractionDigits:8}):'—';
 const explain=e=>{const raw=String(e?.message||e||'UNKNOWN_ERROR');$('diagnostics').textContent=raw;if(/CASH_DIFFERENCE/.test(raw))return'輸入金額與記錄不同，需先完成現金差額核對；原現金未變更。';if(/PASSWORD_MIN/.test(raw))return'請設定至少12字元的備份密碼。';if(/AUTHENTICATION_FAILED/.test(raw))return'密碼不正確，或加密備份已損壞；沒有還原資料。';if(/BACKUP_TOO_LARGE/.test(raw))return'備份檔案太大，無法匯入。';if(/JSON|Unexpected token/.test(raw))return'檔案格式不正確，請選擇完整備份檔案。';if(/[\u3400-\u9fff]/.test(raw)&&!/[A-Z]{3,}_[A-Z]/.test(raw))return raw;return'尚未完成，資料需要確認。請勿重複提交，可展開「進階資訊／問題診斷」查看原因。';};globalThis.HSLocalUXError=explain;
 if(!HSLocalSiteRuntime.allowed(location,HSLocalSiteConfig)||!isSecureContext||!navigator.locks||false){message('目前網址或瀏覽器不支援安全保存，已停止操作。請使用指定本機網址與支援的瀏覽器。');return;}
 if(!(await safeWorker())){message('此網址有舊版離線程式，已停止操作以保護資料；請勿自行清除原資料。');return;}
 function render(){queueMicrotask(()=>host.dispatchEvent(new Event('hs-personal-v2-base-rendered')));const state=api.read();$('welcome').hidden=state.initialized;const ready=state.status==='READY'&&state.initialized;for(const id of['add','cashOpen','export','import'])$(id).disabled=busy||!ready;$('recover').disabled=busy||!state.journal||state.journal.status==='COMMITTED';$('cashStatus').textContent=state.cash?.amountMinor!==null&&state.cash?.amountMinor!==undefined?`已確認可投資現金：NT$ ${number(state.cash.amountMinor/100)}（登記持股不會扣款）`:'尚未設定可用現金，或需核對；不推測買進額度。';$('events').textContent=JSON.stringify(state.events||[],null,2);$('legacy').textContent='舊版資料未變更；新版使用獨立記錄，不讀取或搬移舊帳本。';if(state.plan)$('plans').textContent=`已保留原 ${state.plan.plan?.duration_months||'—'} 月計畫與預算紀錄；進階交易僅供查看，不能在此執行。`;
  $('holdings').replaceChildren();try{const s=api.simpleRead(),all=[...s.store.records,...s.legacy.filter(r=>!s.store.records.some(x=>x.symbol===r.symbol))];$('recentDeleted').disabled=!ready||busy;$('recentDeleted').textContent='最近刪除（'+(s.store.deleted||[]).filter(d=>d.status==='DELETED').length+'）';for(const h of all){const card=document.createElement('article');card.className='holding';card.dataset.symbol=h.symbol;const title=document.createElement('h3');title.textContent=h.name===h.symbol?h.symbol:`${h.symbol} ${h.name}`;card.append(title);const dl=document.createElement('dl');for(const[label,value]of[['持有股數',number(h.shares)],['損益平衡價',h.break_even_price===null?'尚未提供':number(h.break_even_price)],['目前股價','行情待更新'],['目前市值','—'],['估算損益','—'],['估算報酬率','—']]){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;dl.append(dt,dd);}card.append(dl);const note=document.createElement('p');note.className='muted';note.textContent=h.legacy?'舊資料未變更；沒有損益平衡價時不猜測。':'僅登記券商損益平衡價；估算不另扣費用或稅額。';card.append(note);const edit=document.createElement('button');edit.textContent='編輯';edit.disabled=!ready;edit.onclick=()=>openHolding(h);card.append(edit);const protectedPosition=h.legacy||state.holdings?.some(x=>(x.code||x.symbol)===h.symbol);appendHolding(card,h,ready&&!protectedPosition,state.snapshot?.state_sha256);if(protectedPosition){const n=document.createElement('p');n.className='muted';n.textContent='此部位含原持股或交易紀錄，不支援簡易左滑刪除。';card.append(n);}}if(!all.length)$('holdings').textContent='還沒有持股。按「新增持股」，只需填寫3項資料。';}catch(e){message('資料需要核對：'+e.message);for(const id of['add','cashOpen','import','recentDeleted'])$(id).disabled=true;}
  $('undoDelete').disabled=busy||!undoTicket;$('restoreConfirm').disabled=busy||!$('restoreAck').checked||!exportedSha;if(state.status!=='READY')message('資料需要確認：'+explain(state.reason));dispatchEvent(new Event('hs-personal-v2-changed'));
 }
 function success(result){if(!result.ok)throw Error(result.reason||result.status);message('已在此瀏覽器保存。沒有下單，也沒有自動買進。');}
 function closeUndo(){clearTimeout(undoTimer);$('undoBar').hidden=true;undoTicket=null;}
 function removeHolding(h,expectedSha){if(busy)return;run(async()=>{if(api.read().snapshot?.state_sha256!==expectedSha)throw Error('資料已變更，請重新確認持股再刪除；未刪除新資料。');const p=api.previewHolding({action:'DELETE',symbol:h.symbol});success(await api.commit(p));closeUndo();const d=p.after.deleted.at(-1);try{undoTicket=api.previewHolding({action:'RESTORE',deletion_id:d.deletion_id});}catch(e){undoTicket=null;$('diagnostics').textContent=e.message;}$('undoLabel').textContent='已刪除 '+h.symbol;$('undoBar').hidden=false;message('已刪除 '+h.symbol+'，可按復原或到最近刪除找回。');undoTimer=setTimeout(closeUndo,15000);});}
 function appendHolding(card,h,enabled,expectedSha){if(!enabled){$('holdings').append(card);return;}const shell=document.createElement('div');shell.className='swipeShell';const reveal=document.createElement('button');reveal.className='deleteReveal';reveal.textContent='刪除';reveal.setAttribute('aria-label','刪除 '+h.symbol);reveal.onclick=()=>removeHolding(h,expectedSha);const del=document.createElement('button');del.className='deleteDirect';del.textContent='🗑 刪除';del.setAttribute('aria-label','刪除');del.onclick=()=>removeHolding(h,expectedSha);card.append(del);shell.append(reveal,card);$('holdings').append(shell);let g=null;const reset=()=>{card.style.transform='';shell.classList.remove('revealed');g=null;};card.addEventListener('pointerdown',e=>{if(!e.isPrimary){reset();return;}if(e.pointerType!=='touch'||busy||e.target.closest('button,input,a'))return;g={x:e.clientX,y:e.clientY,dx:0,locked:false,vertical:false};});card.addEventListener('pointermove',e=>{if(!g)return;const dx=e.clientX-g.x,dy=e.clientY-g.y;if(!g.locked&&!g.vertical){if(Math.abs(dy)>14&&Math.abs(dy)>Math.abs(dx))g.vertical=true;else if(Math.abs(dx)>18&&Math.abs(dx)>Math.abs(dy)*1.5)g.locked=true;}if(g.vertical)return;if(g.locked){e.preventDefault();g.dx=Math.min(0,dx);card.style.transform=`translateX(${Math.max(g.dx,-card.clientWidth+24)}px)`;}},{passive:false});card.addEventListener('pointercancel',reset);card.addEventListener('pointerup',()=>{if(!g)return;const full=g.locked&&g.dx<-Math.max(160,card.clientWidth*.68),partial=g.locked&&g.dx<-45;reset();if(full)removeHolding(h,expectedSha);else if(partial){shell.classList.add('revealed');card.style.transform='translateX(-88px)';}});}
 $('dismissUndo').onclick=closeUndo;$('undoDelete').onclick=()=>{if(!undoTicket||busy)return;const ticket=undoTicket;run(async()=>{success(await api.commit(ticket));closeUndo();message('已復原持股，股數與損益平衡價保持原樣。');});};
 $('recentDeleted').onclick=()=>{const state=api.read();deletedExpected=state.snapshot?.state_sha256;$('deletedError').textContent='';$('deletedList').replaceChildren();for(const d of (api.simpleRead().store.deleted||[]).filter(d=>d.status==='DELETED').reverse()){const p=document.createElement('p'),b=document.createElement('button');p.textContent=`${d.record.symbol}｜${number(d.record.shares)} 股｜損益平衡價 ${number(d.record.break_even_price)}`;b.textContent='復原 '+d.record.symbol;b.onclick=()=>run(async()=>{if(api.read().snapshot?.state_sha256!==deletedExpected)throw Error('資料已變更，請關閉最近刪除後重新確認。');success(await api.commit(api.previewHolding({action:'RESTORE',deletion_id:d.deletion_id})));closeUndo();$('deletedDialog').close();message('已復原 '+d.record.symbol);});p.append(b);$('deletedList').append(p);}if(!$('deletedList').children.length)$('deletedList').textContent='目前沒有可復原的持股。';$('deletedDialog').showModal();};
 async function run(fn){if(busy)return;busy=true;scope.dataset.saving="true";for(const e of scope.querySelectorAll('button'))e.disabled=true;try{await fn();}catch(e){const text=/RESTORE_WOULD_OVERWRITE/.test(e.message)?'此代號已有新的持股，無法直接復原；沒有覆蓋新資料。':explain(e);message('未完成：'+text);$('holdingError').textContent=text;if($('deletedDialog').open)$('deletedError').textContent=text;}finally{busy=false;scope.dataset.saving="false";for(const e of scope.querySelectorAll('button'))e.disabled=false;render();}}
 function openHolding(h){holdingExpected=api.read().snapshot?.state_sha256;$('holdingError').textContent='';$('symbol').value=h?.symbol||'';$('symbol').readOnly=!!h;$('shares').value=h?.shares??'';$('breakEven').value=h?.break_even_price??'';$('holdingDialog').showModal();$('symbol').focus();}
 function download(data,name){const url=URL.createObjectURL(new Blob([JSON.stringify(data)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
 async function encryptedDownload(payload,name){const p=$('password').value,data=await cryptoBackup.encrypt({schema:'HS_PERSONAL_V3_EXPORT_V1',payload},p);download(data,name);}
 $('start').onclick=()=>run(async()=>{if(!$('consent').checked)throw Error('請先確認本機保存限制');success(await api.initialize({confirmed:true}));});$('add').onclick=()=>openHolding(null);
 $('holdingForm').onsubmit=e=>{e.preventDefault();run(async()=>{if(api.read().snapshot?.state_sha256!==holdingExpected)throw Error('其他操作已變更資料，請關閉後重新編輯；未覆蓋新資料。');const resolved=simple.resolve($('symbol').value,catalog),p=api.previewHolding({action:'SAVE',holding:{...resolved,shares:$('shares').value,break_even_price:$('breakEven').value}});success(await api.commit(p));$('holdingDialog').close();});};
 for(const button of scope.querySelectorAll('[data-close]'))button.onclick=()=>{if(!busy)$(button.dataset.close).close();};for(const d of scope.querySelectorAll('dialog'))d.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
 $('cashOpen').onclick=()=>{cashTicket=null;$('cashAmount').value='';$('cashPreview').textContent='';$('cashConfirm').textContent='查看確認摘要';$('cashDialog').showModal();};$('cashAmount').oninput=()=>{cashTicket=null;$('cashConfirm').textContent='查看確認摘要';};$('cashForm').onsubmit=e=>{e.preventDefault();run(async()=>{if(!cashTicket){cashTicket=await api.previewCash($('cashAmount').value);$('cashPreview').textContent=`將以 NT$ ${$('cashAmount').value} 建立新的確認餘額，不是增加入金。請再次確認。`;$('cashConfirm').textContent='確認建立現金基準';}else{success(await api.commit(cashTicket));cashTicket=null;$('cashDialog').close();}});};
 $('export').onclick=()=>run(async()=>{await encryptedDownload(api.exportBackup(),'HS-加密完整備份.json');$('password').value='';message('已開始下載加密備份，請確認檔案妥善保存；密碼不會儲存。');});
 $('import').onchange=()=>run(async()=>{const file=$('import').files[0];if(!file)return;if(file.size>8*1024*1024)throw Error('BACKUP_TOO_LARGE');let payload=JSON.parse(await file.text());if(payload.schema===cryptoBackup.SCHEMA)payload=await cryptoBackup.decrypt(payload,$('password').value);if(!['HS_PERSONAL_V2_EXPORT_V1','HS_PERSONAL_V3_EXPORT_V1'].includes(payload.schema))throw Error('請選擇新版個人持股備份；不會自動搬移舊帳本。');payload=payload.payload;window.HSPersonalV3Core.validateStorage(payload.storage);window.HSPersonalV3Accounting.validateStorage(payload.storage);restoreTicket=api.previewRestore(payload);exportedSha=null;$('restoreAck').checked=false;$('restoreConfirm').disabled=true;const rows=payload.storage?.[simple.KEY]?simple.validate(JSON.parse(payload.storage[simple.KEY])).records:[];$('restorePreview').textContent=`即將還原 ${rows.length} 筆簡易登記；原交易可能被替換的事件：${restoreTicket.preview.affected_event_ids.length} 筆。需先下載目前備份。`;const detail=document.createElement('p');detail.textContent=restoreTicket.preview.affected_event_ids.join('、')||'沒有移除或變更現有交易';$('restorePreview').append(detail);$('restoreDialog').showModal();});
 $('exportBeforeRestore').onclick=()=>run(async()=>{await encryptedDownload(restoreTicket.local_backup,'HS-還原前安全備份.json');exportedSha=restoreTicket.local_backup_sha256;});$('restoreAck').onchange=()=>{$('restoreConfirm').disabled=!$('restoreAck').checked||!exportedSha;};$('restoreConfirm').onclick=()=>run(async()=>{if(!$('restoreAck').checked||!exportedSha)throw Error('請先保存目前備份並確認');success(await api.restore(restoreTicket,{confirmed:true,digest:restoreTicket.preview.digest,backupExportedSha:exportedSha}));$('restoreDialog').close();restoreTicket=null;exportedSha=null;$('password').value='';});$('recover').onclick=()=>run(async()=>success(await api.recovery()));
 let storageRefresh=null;addEventListener('storage',()=>{if(storageRefresh!==null)return;storageRefresh=setTimeout(()=>{storageRefresh=null;cashTicket=null;exportedSha=null;$('restoreConfirm').disabled=true;render();message('另一分頁資料已變更，請重新核對尚未提交的操作。');},0);});addEventListener('hs-personal-v2-market-updated',render);
 try{catalog=(await(await fetch(new URL('personal-v2/instrument-names.json',base))).json()).items.map(r=>({symbol:r.code,name:r.name}));for(const r of catalog){const option=document.createElement('option');option.value=r.name;option.label=r.symbol;$('catalog').append(option);}}catch{message('名稱清單暫不可用，仍可輸入正確代號。');}render();
})();

(async function(){
 'use strict';const V=window.HSPersonalV3Core,A=window.HSPersonalV3Accounting,$=id=>document.getElementById('hpv2-'+id),api=HSPortfolioLocalFirstCore.service(localStorage,{locks:navigator.locks}),coordinator=HSPortfolioWriteCoordinator.service(localStorage,{locks:navigator.locks}),fp=HSPortfolioInvestableCashCore.fingerprint,HISTORY=V.KEY+'.history',opened=new Set();const histories=new Map();let quotes=new Map(),status=null,cache=null,c4=null,busy=false,settingsSha=null,marketInFlight=null,portfolioRefreshPending=false,lastPortfolioReadKey=null,quoteSequence=0;
 const pendingControls=new Map();function setBusy(value){busy=value;scope.dataset.v3Saving=String(value);scope.dataset.saving=String(value);if(value){for(const e of scope.querySelectorAll('button,input,select')){pendingControls.set(e,e.disabled);e.disabled=true;}}else{for(const[e,disabled]of pendingControls)e.disabled=disabled;pendingControls.clear();host.dispatchEvent(new Event('hs-personal-v2-market-updated'));}}
 function section(id){return $(id)?.closest('section.hsCpDashboard');}
 const shell=document.createElement('div');shell.className='pv3';shell.innerHTML='<div class="pv3bar"><h2>我的投資組合</h2><button id="pv3-settings">設定與備份</button></div><section class="pv3assets"><div class="pv3label">總資產 <small id="pv3-asof"></small></div><strong class="pv3hero" id="pv3-total">暫不可計算</strong><div class="pv3pnl"><div><span id="pv3-daily-label">最近交易日損益</span><b id="pv3-daily">資料不足</b><small id="pv3-daily-reason"></small></div><div><span>目前持股未實現損益（估算）</span><b id="pv3-pnl">暫不可計算</b><small id="pv3-return"></small></div></div><div class="pv3facts"><div>股票市值 <b id="pv3-equity">—</b></div><div>帳本持股成本 <b id="pv3-cost">未提供</b></div><div>可投資現金 <button id="pv3-cash">設定現金</button></div><div>股票部位 <b id="pv3-weight">—</b></div></div><small id="pv3-basis"></small><p id="pv3-market" role="status"></p></section><section class="pv3allocation"><h3>持股占比</h3><div class="pv3donutrow"><div id="pv3-donut"></div><div id="pv3-legend"></div></div></section><section class="pv3rebalance"><div class="pv3title"><h3>智慧再平衡</h3><button id="pv3-targets">設定目標</button></div><div id="pv3-advice"></div><button id="pv3-plan">查看完整再平衡計畫</button><div class="pv3months"><button data-v3-month="3">3個月</button><button data-v3-month="6">6個月</button><button data-v3-month="12">12個月</button></div></section><section class="pv3positions"><div class="pv3title"><h3>我的持股</h3><div id="pv3-actions"></div></div><div id="pv3-list"></div></section>';
 const oldSections=[...scope.children].filter(n=>n.matches('header,section,details,footer'));for(const n of oldSections)n.hidden=true;scope.prepend(shell);const welcome=$('welcome');welcome.hidden=false;scope.insertBefore(welcome,shell);scope.insertBefore($('status'),shell);
 document.getElementById('pv3-list').append($('holdings'));document.getElementById('pv3-actions').append($('add'),$('recentDeleted'));$('add').textContent='＋ 新增';
 const settings=document.createElement('dialog');settings.className='pv3settings';settings.innerHTML='<header><h2>設定與備份</h2><button type="button">關閉</button></header><div class="pv3-settings-body"></div>';scope.append(settings);const settingsBody=settings.querySelector('div');for(const n of oldSections){if(n===welcome||n===section('holdings'))continue;if(n.contains($('password'))||n.matches('details')){n.hidden=false;settingsBody.append(n);}}
 const bookIncome=document.createElement('p');bookIncome.id='pv3-book-income';settingsBody.append(bookIncome);settingsBody.append($('cashOpen'),$('updatePrices'));$('cashOpen').hidden=false;$('updatePrices').hidden=false;settings.querySelector('button').onclick=()=>settings.close();document.getElementById('pv3-settings').onclick=()=>settings.showModal();document.getElementById('pv3-cash').onclick=()=>$('cashOpen').click();

 const oldStorage=window.HSPersonalNamespace.legacy(host.localStorage),oldApi=HSPortfolioLocalFirstCore.service(oldStorage,{locks:navigator.locks});
 const upgrade=document.createElement('aside');upgrade.className='pv3upgrade';upgrade.innerHTML='<b>舊版資料仍完整保留</b><p>新版使用獨立記錄，舊頁面不會覆蓋新版。請先備份舊資料，再於「設定與備份」匯入；不會自動搬移或刪除。</p><button id="pv3-legacy-export">備份舊版資料</button><button id="pv3-upgrade-import">匯入已有備份</button>';scope.insertBefore(upgrade,shell);
 const oldDialog=document.createElement('dialog');oldDialog.id='pv3-legacy-dialog';oldDialog.innerHTML='<header><h2>備份舊版資料</h2><button type="button">關閉</button></header><p>先保存這份加密檔案，再於新版匯入並確認。原來的資料不會變更。</p><label>備份密碼（至少12個字）<input type="password" autocomplete="new-password"></label><p role="alert"></p><button type="button" data-export-legacy>下載加密備份</button>';scope.append(oldDialog);oldDialog.querySelector('header button').onclick=()=>oldDialog.close();
 document.getElementById('pv3-legacy-export').onclick=()=>oldDialog.showModal();document.getElementById('pv3-upgrade-import').onclick=()=>settings.showModal();
 oldDialog.querySelector('[data-export-legacy]').onclick=async()=>{const button=oldDialog.querySelector('[data-export-legacy]');button.disabled=true;try{const before=oldApi.read();if(before.status!=='READY')throw Error('舊資料需要確認，沒有搬移或刪除任何資料');const payload=oldApi.exportBackup();if(oldApi.read().snapshot.state_sha256!==before.snapshot.state_sha256)throw Error('舊資料已變更，請重新備份');const encrypted=await HSPortfolioBackupCrypto.encrypt({schema:'HS_PERSONAL_V2_EXPORT_V1',payload},oldDialog.querySelector('input').value),url=URL.createObjectURL(new Blob([JSON.stringify(encrypted)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='HS-舊版資料-加密備份.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);oldDialog.querySelector('input').value='';oldDialog.querySelector('[role=alert]').textContent='下載已開始。請確認已保存檔案及密碼，再於新版設定匯入。';}catch(e){oldDialog.querySelector('[role=alert]').textContent=e.message;}finally{button.disabled=false;}};
 const exportOldSettings=document.createElement('button');exportOldSettings.type='button';exportOldSettings.textContent='備份仍保留的舊版資料';exportOldSettings.onclick=()=>oldDialog.showModal();settingsBody.append(exportOldSettings);function showLegacyNotice(){try{const exists=oldStorage.length>0;exportOldSettings.hidden=!exists;upgrade.hidden=!exists||api.simpleRead().store.records.length>0;}catch{upgrade.hidden=oldStorage.length===0;}}
 showLegacyNotice();host.addEventListener('hs-personal-v2-base-rendered',showLegacyNotice);

 const targets=document.createElement('dialog');targets.id='pv3-target-dialog';targets.innerHTML='<header><h2>配置與建倉設定</h2><button type="button">關閉</button></header><form><p>以下目標以股票／ETF部位為100%，不包含現金。此參考計畫會保守扣除設定後已核對的買進本金；不會新增正式核准、交易或額度。</p><div id="pv3-target-inputs"></div><p id="pv3-target-total"></p><label>建倉期程<select name="months"><option value="3">3個月</option><option value="6">6個月</option><option value="12">12個月</option></select></label><label>股票目標（%）<input name="normal" type="number" min="0" max="95" required></label><label>股票上限（%，不高於原風控95%）<input name="maximum" type="number" min="0" max="95" required></label><details><summary>股數試算進階設定</summary><p>未核對交易費用時不提供建議股數。此為你自行確認的保留額，非券商驗證。</p><label>每筆買進保留費用（元）<input name="fees" inputmode="decimal" placeholder="尚未確認"></label><label>試算單位<select name="unit"><option value="1">零股（1股）</option><option value="1000">整張（1000股）</option></select></label></details><p role="alert" id="pv3-target-error"></p><button type="submit">儲存設定</button></form>';scope.append(targets);const form=targets.querySelector('form');
 const planDialog=document.createElement('dialog');planDialog.id='pv3-plan-dialog';planDialog.innerHTML='<header><h2>再平衡參考計畫</h2><button>關閉</button></header><div></div>';scope.append(planDialog);planDialog.querySelector('button').onclick=()=>planDialog.close();
 const colors=i=>i<6?['#e6c873','#6da5da','#66bd9a','#bd8fd7','#df8b70','#8ebbc1'][i]:`hsl(${(i*137.508%360).toFixed(3)} 65% 65%)`,money=n=>Number.isSafeInteger(n)?'NT$ '+(n/100).toLocaleString('zh-TW',{maximumFractionDigits:2}):'暫不可計算',percent=n=>Number.isFinite(n)?n.toFixed(1)+'%':'—',node=(tag,text,cls)=>{const n=document.createElement(tag);n.textContent=text;if(cls)n.className=cls;return n;};
 function prefRead(){const raw=localStorage.getItem(V.KEY);const current=V.validateStorage({[V.KEY]:raw,[HISTORY]:localStorage.getItem(HISTORY)});if(current)return current;const old=localStorage.getItem(HSPortfolioLocalOnlyContract.KEY);if(old){const s=HSPortfolioLocalOnlyContract.validate(JSON.parse(old)).settings;return V.preferences(null,{...V.defaults(),months:s.duration_months,targets:s.etf_target_weights,equityTargetBps:s.normal_equity_target_bps,equityMaxBps:s.maximum_equity_limit_bps},new Date().toISOString());}return null;}
 function read(){
 const state=api.read();if(state.status!=='READY')throw Error('資料需要確認，請至設定恢復未完成操作');
 const registry=api.simpleRead(),merged=new Map(registry.legacy.map(h=>[h.symbol,h]));
 for(const h of state.holdings||[])merged.set(h.symbol||h.code,{symbol:h.symbol||h.code,name:h.name||merged.get(h.symbol||h.code)?.name||h.symbol||h.code,shares:h.quantity??h.shares,break_even_price:h.breakEvenPrice??null,legacy:true});
 for(const h of registry.store.records)merged.set(h.symbol,h);
 const rawHoldings=[...merged.values()],now=new Date().toISOString(),session=V.session(status,now),effectiveQuotes=V.closeQuotes(cache,status,now),scores={},entries=Object.fromEntries(Array.from({length:localStorage.length},(_,i)=>localStorage.key(i)).map(k=>[k,localStorage.getItem(k)]));
 const units=A.validateStorage(entries),storedPlan=state.plan?HSPortfolioPlanGenerationCore.validateStore(state.plan,entries):null,formal=storedPlan?.plan;let pref=prefRead();if(formal){pref=pref||V.preferences(null,{...V.defaults(),months:formal.duration_months,targets:formal.etf_target_weights,equityTargetBps:Math.min(formal.normal_equity_target_bps,formal.maximum_equity_limit_bps,9500),equityMaxBps:Math.min(formal.maximum_equity_limit_bps,9500)},now);pref={...pref,months:formal.duration_months,equityTargetBps:Math.min(pref.equityTargetBps,formal.normal_equity_target_bps),equityMaxBps:Math.min(pref.equityMaxBps,formal.maximum_equity_limit_bps)};}let syncState=null;const sr=localStorage.getItem(HSPortfolioWriteCoordinator.SYNC_KEY);if(sr)syncState=HSPortfolioTransactionCashSyncCore.validateStore(JSON.parse(sr),{asOf:now}).state;
 for(const [code,q]of quotes)if(q.kind==='INTRADAY_REFERENCE'&&session?.live&&Number.isFinite(Date.parse(q.as_of))&&Date.parse(q.as_of)<=Date.parse(now)&&Date.parse(now)-Date.parse(q.as_of)<=Math.min(q.maxAgeMs||600000,600000)&&q.date===V.day(now))effectiveQuotes.set(code,q);
 const projected=rawHoldings.map(h=>{const q=effectiveQuotes.get(h.symbol),x=A.project(h,units.receipts,q?.date,now);x.unit_status=x.unit_status||V.unitStatus(x,q);if(!['AS_REPORTED','AS_CONFIRMED','PRICE_MISSING'].includes(x.unit_status))effectiveQuotes.delete(h.symbol);return x;});
 const book=A.costs(projected,state.events||[],now);for(const h of projected){const c=book.rows.find(c=>c.symbol===h.symbol);h.ledger_cost_minor=c.cost_minor;h.cost_source=c.source;const sc=HSPortfolioLocalPortfolioReadAdapter.score(c4,h.symbol,now);scores[h.symbol]={...sc,latest:sc.score!==null&&session?.completed===sc.date};}
 let progress=A.planRemaining({formalPlan:formal,reference:pref?.referencePlan,events:state.events||[],syncState,now,sourceSnapshot:state.snapshot,planCore:HSPortfolioCapitalBuildPlanCore});if(storedPlan&&storedPlan.status!=='ACTIVE')progress={...progress,status:storedPlan.status,remaining_minor:0};if(book.rows.some(r=>['POSITION_RECONCILIATION_REQUIRED','RECONCILIATION_REQUIRED'].includes(r.source)))progress={status:'RECONCILIATION_REQUIRED',remaining_minor:null,invested_minor:null,reason:'持股與帳本數量需要核對，暫不分配'};
 const v=V.view({holdings:projected,cashMinor:['READY','PENDING'].includes(state.cash?.status)?state.cash.amountMinor:null,prefs:pref,quotes:effectiveQuotes,c4:scores,eligibleSymbols:HSPortfolioC4SmartAccelerationCore.ELIGIBLE,now,positionValue:HSPortfolioCapitalBuildPlanCore.localPositionValue,allocate:HSPortfolioPerformanceCore.buildCapitalAllocationPlan,planProgress:progress});
 const dailyQuotes=V.closeQuotes(cache,status,now);for(const[k,q]of effectiveQuotes)dailyQuotes.set(k,q);for(const[k,q]of dailyQuotes)dailyQuotes.set(k,window.HSPersonalV3HistoryBasis.apply(q,histories.get(k),status,A.actions,now));for(const h of projected)if(!['AS_REPORTED','AS_CONFIRMED','PRICE_MISSING'].includes(h.unit_status))dailyQuotes.delete(h.symbol);
 const day=A.daily({holdings:projected,events:state.events||[],metadata:{...(syncState?.metadata||{}),...Object.fromEntries((syncState?.coverageReviews||[]).map(r=>[r.event_id,r]))},quotes:dailyQuotes,now,positionValue:HSPortfolioCapitalBuildPlanCore.localPositionValue});
 const after=api.read();if(after.status!=='READY'||after.snapshot.state_sha256!==state.snapshot.state_sha256)throw Error('資料更新中，請稍候重新核對');
 return{...v,snapshot:state.snapshot,raw_holdings:rawHoldings,plan_progress:progress,actual_cost_minor:book.total_cost_minor,realized_pnl_minor:book.realized_minor,dividend_income_gross_minor:book.dividend_gross_minor,today_pnl_minor:day.pnl_minor,today_pnl_percent:day.percent,today_reason:day.reason||day.description,today_status:day.status,price_date:v.price_date??day.date??null};
 }
 host.HSPersonalV2=Object.freeze({read,mode:'LOCAL_ONLY_V3',storagePrefix:window.HSPersonalNamespace.PREFIX,productionWriter:false});host.HSPersonalV3=host.HSPersonalV2;
 let uiStorage;try{uiStorage=host.localStorage;}catch(_){}
 const uiColors=host.HSPortfolioDisplayUI.colors(uiStorage);
 function setColor(symbol,color){if(document.activeElement?.matches('#pv3-legend input'))document.activeElement.blur();const ok=uiColors.set(symbol,color);render();if(!ok)$('status').textContent='顏色無法儲存，持股資料未變更。';}
 host.addEventListener('storage',e=>{if(e.key===host.HSPortfolioDisplayUI.KEY||e.key===null)render();});
 function donut(v){const legendNode=document.getElementById('pv3-legend');if(document.activeElement?.matches('#pv3-legend input')){legendNode.setAttribute('aria-busy','true');return;}legendNode.removeAttribute('aria-busy');v={...v,rows:host.HSPortfolioDisplayUI.displayRows(v)};const holder=document.getElementById('pv3-donut'),legend=document.getElementById('pv3-legend');holder.replaceChildren();legend.replaceChildren();const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 160 160');svg.setAttribute('aria-label','股票部位內持股占比');const circle=(color,pct,offset)=>{const c=document.createElementNS(svg.namespaceURI,'circle');for(const[k,val]of Object.entries({cx:80,cy:80,r:60,fill:'none',stroke:color,'stroke-width':17,pathLength:100,'stroke-dasharray':`${pct} ${100-pct}`,'stroke-dashoffset':-offset,transform:'rotate(-90 80 80)'}))c.setAttribute(k,val);svg.append(c);};circle('#282a2c',100,0);let offset=0;if(v.equity_minor>0&&v.complete)v.rows.forEach((r,i)=>{circle(uiColors.get(r.symbol),r.weight,offset);offset+=r.weight;const item=node('div','', 'pv3legend');item.style.setProperty('--color',uiColors.get(r.symbol));const picker=document.createElement('input');picker.type='color';picker.value=uiColors.get(r.symbol);picker.setAttribute('aria-label','設定 '+r.symbol+' 顏色');picker.onchange=()=>setColor(r.symbol,picker.value);picker.onblur=()=>queueMicrotask(()=>{if(!legendNode.contains(document.activeElement)){try{donut(read());}catch(_){}}});const reset=node('button','↺','pv3colorReset');reset.type='button';reset.setAttribute('aria-label','恢復 '+r.symbol+' 預設顏色');reset.onclick=()=>setColor(r.symbol,null);item.append(picker,node('span',r.symbol+' '+r.name),node('b',percent(r.weight)),reset);legend.append(item);});else legend.append(node('p',v.rows.length?'部分持股行情待更新，暫時無法計算完整占比。':'尚未新增持股'));const text=document.createElementNS(svg.namespaceURI,'text');text.setAttribute('x',80);text.setAttribute('y',85);text.setAttribute('text-anchor','middle');text.textContent=v.total_assets_minor>0?percent(v.equity_minor/v.total_assets_minor*100):'—';svg.append(text);holder.append(svg);}
 function cards(v){for(const card of scope.querySelectorAll('#hpv2-holdings .holding')){const symbol=card.dataset.symbol,r=v.rows.find(r=>r.symbol===symbol);if(!r)continue;card.querySelectorAll('[data-v3-generated]').forEach(n=>n.remove());const old=card.querySelector(':scope > details.pv3row'),original=old?[...old.querySelector('.pv3detail').children]:[...card.children],details=document.createElement('details'),summary=document.createElement('summary');details.className='pv3row';details.open=opened.has(symbol);details.addEventListener('toggle',()=>{if(details.isConnected)details.open?opened.add(symbol):opened.delete(symbol);});card.style.setProperty('--holding-color',uiColors.get(symbol));summary.append(node('b',symbol+' '+r.name),node('strong',money(r.market_value_minor)),node('small',r.pnl_minor===null?'損益待確認':money(r.pnl_minor)+' / '+percent(r.return_percent),r.pnl_minor>0?'pvProfit':r.pnl_minor<0?'pvLoss':''),node('small','占比 '+percent(r.weight)+' ／目標 '+percent(r.target)),node('small',r.c4.score===null?'C4 資料不足':`C4 ${host.HSC4Display.score(r.c4.score)} · ${host.HSFinalCoreProduction.labelFor(r.c4.score).label}`));const body=node('div','', 'pv3detail');const dl=card.querySelector('dl'),cells=dl?.querySelectorAll('dd');if(cells?.length===6){cells[0].textContent=Number(r.shares).toLocaleString('zh-TW',{maximumFractionDigits:8});cells[1].textContent=r.break_even_price===null?'尚未提供':Number(r.break_even_price).toLocaleString('zh-TW',{maximumFractionDigits:8});cells[2].textContent=r.quote?r.price+'｜'+r.quote.label:r.unit_status?.endsWith('REQUIRED')?'價格單位待核對；請先確認券商股數及損益平衡價，原帳本未變更':'行情待更新';cells[3].textContent=money(r.market_value_minor);cells[4].textContent=money(r.pnl_minor);cells[5].textContent=percent(r.return_percent);}for(const n of original)if(n.tagName!=='H3')body.append(n);const advice=node('p',r.advice),budget=node('p','本期參考金額：'+money(r.reference_budget_minor));advice.dataset.v3Generated='';budget.dataset.v3Generated='';const unitButton=node('button','核對股數與分割單位');unitButton.type='button';unitButton.dataset.v3Generated='';unitButton.onclick=()=>openUnits(symbol);body.append(unitButton);const detail=node('p',`目前占比 ${percent(r.weight)}／目標 ${percent(r.target)}｜C4 ${r.c4.score===null?'資料不足':host.HSC4Display.score(r.c4.score)+' '+host.HSFinalCoreProduction.labelFor(r.c4.score).label}｜資料日期 ${r.c4.date||'—'}`);detail.dataset.v3Generated='';body.append(detail,advice,budget);const editTarget=node('button','編輯目標占比');editTarget.dataset.v3Generated='';editTarget.onclick=openTargets;body.append(editTarget);const remove=[...body.querySelectorAll('button')].find(b=>b.textContent==='刪除');if(remove){const shortcut=node('button','×','pv3desktopDelete');shortcut.type='button';shortcut.setAttribute('aria-label','刪除 '+symbol);shortcut.disabled=remove.disabled;shortcut.onclick=e=>{e.preventDefault();e.stopPropagation();remove.click();};summary.append(shortcut);}details.append(summary,body);card.replaceChildren(details);summary.addEventListener('click',e=>{if(scope.dataset.saving==='true'||card.closest('.revealed')){e.preventDefault();return;}if(!e.target.closest('button,input,a')){if(details.open)opened.delete(symbol);else opened.add(symbol);}});}}
 function render(){try{const source=read(),v={...source,rows:host.HSPortfolioDisplayUI.displayRows(source)};document.getElementById('pv3-total').textContent=money(v.total_assets_minor);document.getElementById('pv3-equity').textContent=money(v.equity_minor);document.getElementById('pv3-cash').textContent=v.cash_minor===null?'設定現金':money(v.cash_minor);document.getElementById('pv3-weight').textContent=percent(v.total_assets_minor>0?v.equity_minor/v.total_assets_minor*100:null);const pnl=document.getElementById('pv3-pnl');pnl.textContent=money(v.pnl_minor);pnl.className=v.pnl_minor>0?'pvProfit':v.pnl_minor<0?'pvLoss':'';document.getElementById('pv3-return').textContent=percent(v.pnl_percent);document.getElementById('pv3-basis').textContent='損益平衡參考額 '+money(v.reference_basis_minor)+'；不是歷史成交成本。';document.getElementById('pv3-cost').textContent=money(v.actual_cost_minor);bookIncome.textContent='原帳本已實現損益 '+money(v.realized_pnl_minor)+'；已記錄股息毛額 '+money(v.dividend_income_gross_minor)+'。兩者均未混入未實現損益。';document.getElementById('pv3-daily').textContent=v.today_status==='AVAILABLE'?money(v.today_pnl_minor)+' / '+percent(v.today_pnl_percent):'資料不足';document.getElementById('pv3-daily').className=v.today_pnl_minor>0?'pvProfit':v.today_pnl_minor<0?'pvLoss':'';document.getElementById('pv3-daily-reason').textContent=v.today_status==='AVAILABLE'?'含已驗證除息權利（稅前）；入帳股息另列':'缺少可核對的歷史資料';document.getElementById('pv3-daily-reason').title=v.today_reason;document.getElementById('pv3-asof').textContent=v.price_date?'截至 '+v.price_date+'（參考）':'';document.getElementById('pv3-daily-label').textContent=(!v.latest?'已載入交易日損益':v.price_date===V.day(new Date().toISOString())?'今日損益':'最近交易日損益')+(v.price_date?'（'+v.price_date.slice(5).replace('-','/')+'）':'');document.getElementById('pv3-market').textContent=!v.rows.length?'新增持股後顯示行情':v.complete?(v.latest?'已載入最近有效行情':'沿用已標示日期的收盤資料，等待更新'):'行情資料不完整，總資產與配置暫不可計算';donut(v);const advice=document.getElementById('pv3-advice');advice.replaceChildren();if(!v.rows.length)advice.append(node('p','新增持股、設定現金與目標後，查看配置參考。'));for(const r of v.rows.slice().sort((a,b)=>(b.target-(b.weight||0))-(a.target-(a.weight||0))).slice(0,3))advice.append(node('p',r.symbol+'｜'+r.advice),node('small','C4資料日 '+(r.c4.date||'尚未取得')+(r.c4.date&&r.c4.date!==V.day(new Date().toISOString())?'（非今日盤中分數）':'')));if(!v.targets_complete&&v.rows.length)advice.append(node('small','請設定每檔目標，合計100%；未設定時不分配預算。'));for(const b of scope.querySelectorAll('[data-v3-month]'))b.setAttribute('aria-pressed',String(Number(b.dataset.v3Month)===v.settings.months));cards(v);host.HSPortfolioDisplayUI.reorder($('holdings'),v.rows);}catch(e){for(const id of['pv3-total','pv3-equity','pv3-pnl','pv3-return','pv3-weight','pv3-basis','pv3-asof'])document.getElementById(id).textContent='資料需要確認';document.getElementById('pv3-cash').textContent='資料需要確認';document.getElementById('pv3-donut').replaceChildren();document.getElementById('pv3-legend').textContent='資料需要確認';document.getElementById('pv3-advice').textContent=e.message;for(const id of['add','cashOpen'])$(id).disabled=true;}}
 function openTargets(){if(busy||!api.read().initialized)return;const v=read();settingsSha=api.read().snapshot.state_sha256;const box=document.getElementById('pv3-target-inputs');box.replaceChildren();for(const r of v.rows){const label=node('label',r.symbol+' '+r.name+'（%）'),input=document.createElement('input');input.dataset.targetSymbol=r.symbol;input.inputMode='decimal';input.value=r.target??'';label.append(input);box.append(label);}form.elements.months.value=v.settings.months;form.elements.normal.value=v.settings.equityTargetBps/100;form.elements.maximum.value=v.settings.equityMaxBps/100;form.elements.fees.value=v.settings.feeReserveMinor===null?'':v.settings.feeReserveMinor/100;form.elements.unit.value=v.settings.unit;showTargetTotal();document.getElementById('pv3-target-error').textContent='';targets.showModal();}
 function showTargetTotal(){const inputs=[...form.querySelectorAll('[data-target-symbol]')],sum=inputs.reduce((n,x)=>n+(Number(x.value)||0),0);document.getElementById('pv3-target-total').textContent=`目標合計 ${sum.toFixed(1)}%（應為100%）`;}form.addEventListener('input',showTargetTotal);document.getElementById('pv3-targets').onclick=openTargets;targets.querySelector('header button').onclick=()=>{if(!busy)targets.close();};targets.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
 async function save(input,expected){if(!HSLocalSiteRuntime.allowed(location)||!isSecureContext||!navigator.locks||!(await safeWorker()))throw Error('目前環境無法安全儲存，資料未變更');const captured=api.read().snapshot;const previousRaw=localStorage.getItem(V.KEY),previous=previousRaw?V.validate(JSON.parse(previousRaw)):null,at=new Date().toISOString();const current=read();if(current.snapshot.state_sha256!==captured.state_sha256)throw Error('資料已變更');const state=api.read();if(state.plan&&input.months!==state.plan.plan.duration_months)throw Error('原建倉計畫需由原流程確認修改期程');if(!state.plan&&current.total_assets_minor!==null&&current.rows.length>0&&current.rows.every(r=>Object.hasOwn(input.targets,r.symbol))&&Math.abs(Object.values(input.targets).reduce((n,v)=>n+v,0)-100)<1e-8){const fees=(input.feeReserveMinor||0)*current.rows.length,gap=Math.max(0,Number(BigInt(Math.max(0,current.total_assets_minor-fees))*BigInt(input.equityTargetBps)/10000n)-current.equity_minor);input={...input,referencePlan:A.referencePlan({previous:previous?.referencePlan,at,months:input.months,gapMinor:gap,events:state.events,splitMinor:HSPortfolioCapitalBuildPlanCore.splitMinor})};}const next=V.preferences(previous,input,at);if(captured.state_sha256!==expected)throw Error('另一分頁已修改資料，請重新開啟設定');const result=await coordinator.execute({operationId:crypto.randomUUID(),kind:'LOCAL_REFERENCE_V3',asOf:at,expected:captured,intent:{settings_sha:fp(next)},plan:entries=>{const history=JSON.parse(entries[HISTORY]||'[]');if(previous)history.push(previous);return{...entries,[V.KEY]:JSON.stringify(next),[HISTORY]:JSON.stringify(history)};}});if(!result.ok)throw Error('尚未完成，請至設定確認或恢復資料');dispatchEvent(new Event('hs-personal-v2-changed'));}
 form.onsubmit=async e=>{e.preventDefault();if(busy||scope.dataset.saving==='true')return;setBusy(true);try{const weights={};for(const input of form.querySelectorAll('[data-target-symbol]'))if(input.value.trim()!==''){if(!/^\d+(?:\.\d)?$/.test(input.value))throw Error('請填有效的目標比例');weights[input.dataset.targetSymbol]=Number(input.value);}const normal=Number(form.elements.normal.value),maximum=Number(form.elements.maximum.value);if(maximum>95)throw Error('股票上限不可超過原風控95%');await save({months:Number(form.elements.months.value),targets:weights,equityTargetBps:Math.round(normal*100),equityMaxBps:Math.round(maximum*100),feeReserveMinor:form.elements.fees.value===''?null:HSPortfolioInvestableCashCore.toMinorUnits(form.elements.fees.value),unit:Number(form.elements.unit.value)},settingsSha);targets.close();}catch(err){document.getElementById('pv3-target-error').textContent=err.message;}finally{setBusy(false);render();}};
 // A real protected commit, not a new trade or synthetic approval.
 for(const b of scope.querySelectorAll('[data-v3-month]'))b.onclick=async()=>{if(busy||scope.dataset.saving==='true'||!api.read().initialized)return;setBusy(true);try{await save({...read().settings,months:Number(b.dataset.v3Month)},api.read().snapshot.state_sha256);}catch(e){$('status').textContent=e.message;}finally{setBusy(false);render();}};
 document.getElementById('pv3-plan').onclick=()=>{const v=read(),body=planDialog.querySelector('div');body.replaceChildren(node('p',v.settings.months+'個月｜本期參考上限 '+money(v.period_reference_minor)),node('p','僅試算，不會下單或扣款。'+v.advanced_acceleration+' 已核對投入本金：'+money(v.plan_progress.invested_minor)+'；本期未用參考額度：'+money(v.plan_progress.remaining_minor)+(v.plan_progress.reason?'；'+v.plan_progress.reason:'')));for(const r of v.rows)body.append(node('p',`${r.symbol}｜目標 ${percent(r.target)}／目前 ${percent(r.weight)}｜C4 ${r.c4.score??'資料不足'}（${r.c4.date||'—'}）｜${money(r.reference_budget_minor)}｜${r.estimated_shares===null?'股數需先確認費用與資料':r.estimated_shares+'股'}｜${r.advice}`));body.append(node('p','試算後剩餘現金：'+money(v.remaining_cash_minor)));planDialog.showModal();};
 // Runs inside the existing private LOCAL_ONLY bundle; writes only display confirmations.
const unitDialog=document.createElement('dialog');unitDialog.id='pv3-unit-dialog';unitDialog.innerHTML='<header><h2>核對股數與價格單位</h2><button type="button">關閉</button></header><form><p data-original></p><p data-official></p><label>目前資料的單位<select name="basis" required><option value="">請選擇</option><option value="CURRENT_UNITS">我已依券商核對目前股數</option><option value="PRE_SPLIT">原資料仍是分割前單位</option><option value="POST_SPLIT">原資料已是分割後單位</option></select></label><label>券商目前股數<input name="shares" inputmode="decimal" required></label><label>券商每股損益平衡價（無資料可留空）<input name="be" inputmode="decimal"></label><p data-preview></p><p>只保存本機顯示確認，不會修改原持股、交易帳本或現金。手動確認不是券商外部驗證。</p><label><input type="checkbox" name="ack" required>我已核對預覽及券商資料</label><p role="alert"></p><button type="submit">確認保存</button></form>';scope.append(unitDialog);
const unitForm=unitDialog.querySelector('form');let unitTicket=null;
unitDialog.querySelector('header button').onclick=()=>{if(!busy)unitDialog.close();};unitDialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
function openUnits(symbol){const v=read(),h=v.raw_holdings.find(h=>h.symbol===symbol),q=v.rows.find(r=>r.symbol===symbol)?.quote||V.closeQuotes(cache,status,new Date().toISOString()).get(symbol);if(!h||!q){$('status').textContent='請先取得可核對日期的行情，再確認股數。';return;}unitTicket={h,quoteDate:q.date,snapshot:v.snapshot,id:crypto.randomUUID()};unitForm.reset();unitForm.elements.shares.value=h.shares;unitForm.elements.be.value=h.break_even_price??'';const a=A.actions.find(a=>a.symbol===symbol);unitDialog.querySelector('[data-original]').textContent=`${symbol}｜原股數 ${h.shares}｜原損益平衡價 ${h.break_even_price??'未提供'}｜行情 ${q.date}`;const known=a?.effective&&q.date>=a.effective;for(const option of unitForm.elements.basis.options)if(['PRE_SPLIT','POST_SPLIT'].includes(option.value))option.disabled=!known;unitDialog.querySelector('[data-official]').textContent=a?.effective?`官方公告：${a.effective} 恢復交易，1拆${a.ratio}。未到生效日不套用。`:a?'官方比例及生效日尚未定案，不會自動換算。':'請依券商確認目前資料；不推測歷史分割比例。';unitDialog.querySelector('[role=alert]').textContent='';unitDialog.querySelector('[data-preview]').textContent='選擇單位後顯示預覽';unitDialog.showModal();}
function unitDraft(){if(!unitTicket)throw Error('請重新開啟確認');return A.confirmUnits(unitTicket.h,{basis:unitForm.elements.basis.value,quoteDate:unitTicket.quoteDate,at:new Date().toISOString(),id:unitTicket.id,shares:unitForm.elements.shares.value,breakEven:unitForm.elements.be.value.trim()===''?null:unitForm.elements.be.value});}
unitForm.addEventListener('input',()=>{try{const r=unitDraft();unitDialog.querySelector('[data-preview]').textContent=`確認後顯示：${r.shares.toLocaleString('zh-TW')}股，損益平衡價 ${r.break_even_price??'未提供'}；原資料保留。`;}catch(e){unitDialog.querySelector('[data-preview]').textContent=e.message;}});
unitForm.onsubmit=async e=>{e.preventDefault();if(busy||scope.dataset.saving==='true'||!unitForm.elements.ack.checked)return;setBusy(true);try{if(!HSLocalSiteRuntime.allowed(location)||!isSecureContext||!navigator.locks||!(await safeWorker()))throw Error('目前環境無法安全儲存');const r=unitDraft(),current=api.read();if(current.status!=='READY'||current.snapshot.state_sha256!==unitTicket.snapshot.state_sha256)throw Error('另一分頁已修改資料，請重新開啟核對');const at=new Date().toISOString(),result=await coordinator.execute({operationId:r.id,kind:'LOCAL_UNIT_CONFIRMATION_V1',asOf:at,expected:unitTicket.snapshot,intent:{receipt_sha256:r.sha256},plan:entries=>{const old=A.validateStorage(entries),next=A.appendReceipt(old,r,at);return{...entries,[A.KEY]:JSON.stringify(next),[A.KEY+'.history']:JSON.stringify([...JSON.parse(entries[A.KEY+'.history']||'[]'),...(old.revision?[old]:[])])};}});if(!result.ok)throw Error('尚未完成，請至設定核對或恢復，不要重複提交');unitDialog.close();host.dispatchEvent(new Event('hs-personal-v2-changed'));}catch(err){unitDialog.querySelector('[role=alert]').textContent=err.message;}finally{setBusy(false);render();}};

 const historySource=host.HSRadarHistorySource?new host.HSRadarHistorySource.Source({storage:null}):null;
 async function refresh(){if(marketInFlight)return marketInFlight;portfolioRefreshPending=false;const sequence=++quoteSequence;marketInFlight=(async()=>{try{const [market,manifest,artifact]=await Promise.all([fetch(new URL('market-quotes.json',base),{cache:'no-store'}).then(r=>{if(!r.ok)throw Error();return r.json();}),historySource?.updateStatus().catch(()=>null),fetch(new URL('finalized-core-score-snapshots-v1.json',base),{cache:'no-store'}).then(r=>r.ok?r.json():null).catch(()=>null)]);cache=market;if(manifest)status=manifest;if(artifact)c4=artifact;if(historySource){const state=api.read(),syms=new Set([...api.simpleRead().store.records.map(h=>h.symbol),...(state.holdings||[]).map(h=>h.symbol||h.code),...(state.events||[]).filter(e=>['BUY','SELL'].includes(e.type)&&e.tradeDate>=new Date(Date.now()-35*86400000).toISOString().slice(0,10)).map(e=>e.symbol)]);await Promise.all([...syms].map(async code=>{try{const a=await historySource.archive(code);if(a)histories.set(code,a);}catch{}}));}let fresh=V.closeQuotes(cache,status,new Date().toISOString());const s=V.session(status,new Date().toISOString());if(s?.live){try{const codes=read().rows.map(r=>r.symbol),data=await(await fetch(HSLocalSiteRuntime.quoteURL(HSLocalSiteConfig,codes))).json();for(const r of data.records||[]){const q=await HSPortfolioLocalPortfolioReadAdapter.observation(r,new Date().toISOString());if(q)fresh.set(q.symbol,{...q,date:q.as_of.slice(0,10),label:'盤中延遲參考 '+q.as_of,latest:true,kind:'INTRADAY_REFERENCE'});}}catch{}}
 if(sequence===quoteSequence)quotes=fresh;dispatchEvent(new Event('hs-personal-v2-market-updated'));}catch{$('status').textContent='行情更新暫時失敗，保留已標示日期的資料；不會當作即時行情。';}finally{marketInFlight=null;render();if(portfolioRefreshPending)setTimeout(refresh,0);}})();return marketInFlight;}
 $('updatePrices').onclick=refresh;host.addEventListener('hs-personal-v2-changed',()=>{render();const key=(localStorage.getItem(HSPortfolioSimpleHoldings.KEY)||'')+'|'+(localStorage.getItem(HSPortfolioLedgerCore.STORAGE_KEY)||'');if(key!==lastPortfolioReadKey){lastPortfolioReadKey=key;portfolioRefreshPending=true;void refresh();}});host.addEventListener('hs-personal-v2-market-updated',render);host.addEventListener('hs-personal-v2-base-rendered',()=>queueMicrotask(render));function ingestShared(detail){const s=V.session(status,new Date().toISOString());if(!s?.live||!['authorized_proxy','github_actions_cache'].includes(detail?.source)||!(detail.quotes instanceof Map))return;const now=Date.now();for(const [symbol,q]of detail.quotes){const suppliedTime=String(q.quoteTime||''),at=/^\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(suppliedTime)?Date.parse(q.date+'T'+suppliedTime+'+08:00'):/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(suppliedTime)?Date.parse(suppliedTime):NaN,price=q.price;if(q.quoteMode!=='delayed'||q.date!==V.day(new Date(now).toISOString())||!Number.isFinite(at)||at>now||now-at>180000||typeof price!=='number'||!Number.isFinite(price)||price<=0)continue;quotes.set(symbol,{symbol,price,date:q.date,as_of:new Date(at).toISOString(),previous_reference:typeof q.previousClose==='number'&&q.previousClose>0?q.previousClose:null,reference_kind:'EXCHANGE_COMPARISON_PRICE',kind:'INTRADAY_REFERENCE',maxAgeMs:180000,latest:true,label:q.date+' '+q.quoteTime+' 延遲參考'});}render();}host.addEventListener('hs:delayed-quotes',e=>ingestShared(e.detail));setInterval(refresh,60000);render();await refresh();ingestShared({source:'github_actions_cache',quotes:host.HSLiveMarket?.latestQuotes?.()});
})();

})(self);
