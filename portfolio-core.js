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
    return String(value ?? "").trim().toUpperCase();
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
      updatedAt: new Date().toISOString()
    };
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

  function validQuote(quote) {
    const price = Number(quote?.price);
    const previousClose = Number(quote?.previousClose);
    if (!Number.isFinite(price) || price <= 0) return null;
    return {
      price,
      previousClose: Number.isFinite(previousClose) && previousClose > 0 ? previousClose : null,
      name: sanitizeName(quote?.name),
      date: String(quote?.date ?? ""),
      fetchedAt: String(quote?.fetchedAt ?? ""),
      quoteMode: quote?.quoteMode === "delayed" ? "delayed" : "close",
      quoteTime: String(quote?.quoteTime ?? "")
    };
  }

  function calculatePortfolio(holdings, quotes) {
    const quoteLookup = quotes instanceof Map ? quotes : new Map(Object.entries(quotes || {}));
    const rows = holdings.map(raw => {
      const item = validateHolding(raw);
      const quote = validQuote(quoteLookup.get(item.code));
      const totalCost = item.shares * item.averageCost;
      if (!quote) return {...item, quote: null, totalCost, marketValue: null, allocationValue: totalCost, valueSource: "cost", totalPnl: null, returnRate: null, todayPnl: null, changeRate: null, weight: null};
      const marketValue = item.shares * quote.price;
      const totalPnl = marketValue - totalCost;
      const returnRate = totalCost > 0 ? totalPnl / totalCost * 100 : null;
      const todayPnl = quote.previousClose ? item.shares * (quote.price - quote.previousClose) : null;
      const changeRate = quote.previousClose ? (quote.price / quote.previousClose - 1) * 100 : null;
      return {...item, quote, totalCost, marketValue, allocationValue: marketValue, valueSource: "market", totalPnl, returnRate, todayPnl, changeRate, weight: null};
    });
    const complete = rows.length > 0 && rows.every(row => row.quote && Number.isFinite(row.todayPnl));
    const quotedRows = rows.filter(row => Number.isFinite(row.marketValue));
    const totalMarketValue = quotedRows.reduce((sum, row) => sum + row.marketValue, 0);
    const allocationTotal = rows.reduce((sum, row) => sum + (Number.isFinite(row.allocationValue) && row.allocationValue > 0 ? row.allocationValue : 0), 0);
    const allocationEstimated = rows.some(row => row.valueSource === "cost");
    for (const row of rows) {
      row.weight = Number.isFinite(row.allocationValue) && allocationTotal > 0 ? row.allocationValue / allocationTotal * 100 : null;
    }
    if (!complete) {
      return {rows, complete: false, totalMarketValue: null, allocationTotal, allocationEstimated, totalCost: null, totalPnl: null, returnRate: null, todayPnl: null, todayRate: null};
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
        quoteMode: row.quote_mode === "delayed" ? "delayed" : "close",
        quoteTime: String(row.quote_time || ""),
        high: high !== null && high > 0 ? high : null,
        low: low !== null && low > 0 ? low : null,
        volume: volume !== null && volume >= 0 ? volume : null
      });
    }
    if (!result.size) throw new Error("行情快取沒有有效資料。");
    return result;
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
    validateHolding,
    validateImportPayload,
    mergeHolding,
    validateTargetAllocations,
    REBALANCE_PROFILES,
    allocationBand,
    calculateRebalanceAdvice,
    rebalanceDecision,
    buildRebalanceReadout,
    calculatePortfolio,
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
