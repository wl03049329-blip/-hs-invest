(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.HSSwingStrategyCore = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const MODEL_VERSION = "HS Swing Radar V1.2.1 Beta Validated Frozen";
  const STRATEGY_TYPES = Object.freeze({
    LONG_TERM: "longTerm",
    LEVERAGED: "leveraged",
    SWING_00733: "swing00733",
    SWING_006201: "swing006201"
  });
  const CORE_MA_PERIODS = Object.freeze([20, 60, 200]);
  const TREND_STRUCTURE_PERIODS = Object.freeze([43, 87, 284]);
  const TRADE_STATES = Object.freeze(["ACCUMULATION", "HOLDING", "EXIT", "CLOSED"]);
  const SWING_006201_POSITION_CONFIG = Object.freeze({first: 15, highQuality: 35, breakout: 60});

  const finite = value => {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  const clamp = (value, minimum = 0, maximum = 100) => Math.min(maximum, Math.max(minimum, value));
  const mean = values => {
    const valid = values.map(finite).filter(value => value !== null);
    return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
  };
  const change = (current, previous) => {
    const now = finite(current), before = finite(previous);
    return now !== null && before !== null && before !== 0 ? (now / before - 1) * 100 : null;
  };
  const round = (value, digits = 2) => {
    const number = finite(value);
    return number === null ? null : Number(number.toFixed(digits));
  };
  const safeDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : "";

  function normalizeOhlcv(rows) {
    const byDate = new Map();
    for (const raw of Array.isArray(rows) ? rows : []) {
      const date = safeDate(raw?.date ?? raw?.Date);
      const close = finite(raw?.close ?? raw?.Close);
      if (!date || close === null || close <= 0) continue;
      const open = finite(raw?.open ?? raw?.Open);
      const high = finite(raw?.high ?? raw?.max ?? raw?.High);
      const low = finite(raw?.low ?? raw?.min ?? raw?.Low);
      const volume = finite(raw?.volume ?? raw?.Trading_Volume ?? raw?.trading_volume ?? raw?.Volume);
      const normalized = {
        date,
        open: open !== null && open > 0 ? open : null,
        high: high !== null && high > 0 ? high : null,
        low: low !== null && low > 0 ? low : null,
        close,
        volume: volume !== null && volume >= 0 ? volume : null
      };
      if (normalized.high !== null && normalized.high < close) normalized.high = close;
      if (normalized.low !== null && normalized.low > close) normalized.low = close;
      if (normalized.high !== null && normalized.low !== null && normalized.high < normalized.low) continue;
      normalized.coverage = [normalized.open, normalized.high, normalized.low, normalized.volume]
        .filter(value => value !== null).length / 4;
      byDate.set(date, normalized);
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  function simpleMovingAverage(values, period, endIndex = values.length - 1) {
    if (!Number.isInteger(period) || period <= 0 || endIndex + 1 < period) return null;
    return mean(values.slice(endIndex - period + 1, endIndex + 1));
  }

  function movingAverageSnapshot(rows, periods, slopeLookback = 5) {
    const closes = rows.map(row => row.close);
    const end = closes.length - 1;
    const output = {};
    for (const period of periods) {
      const value = simpleMovingAverage(closes, period, end);
      const previous = simpleMovingAverage(closes, period, end - slopeLookback);
      output[`ma${period}`] = round(value, 4);
      output[`ma${period}Slope`] = round(change(value, previous), 4);
    }
    return output;
  }

  function dailyKdj(rows, period = 9) {
    let k = 50, d = 50, previousK = 50, previousD = 50, previousJ = 50;
    const output = [];
    for (let index = 0; index < rows.length; index += 1) {
      const window = rows.slice(Math.max(0, index - period + 1), index + 1);
      const highs = window.map(row => row.high ?? row.close);
      const lows = window.map(row => row.low ?? row.close);
      const high = Math.max(...highs), low = Math.min(...lows);
      const rsv = high === low ? 50 : (rows[index].close - low) / (high - low) * 100;
      k = 2 / 3 * k + 1 / 3 * rsv;
      d = 2 / 3 * d + 1 / 3 * k;
      const j = 3 * k - 2 * d;
      output.push({date: rows[index].date, k, d, j, previousK, previousD, previousJ});
      previousK = k; previousD = d; previousJ = j;
    }
    return output;
  }

  function weeklyKdj(rows, period = 9) {
    const weeks = new Map();
    for (const row of rows) {
      const parsed = new Date(`${row.date}T12:00:00+08:00`);
      if (!Number.isFinite(parsed.getTime())) continue;
      const day = parsed.getDay() || 7;
      const monday = new Date(parsed);
      monday.setDate(parsed.getDate() - day + 1);
      const key = monday.toISOString().slice(0, 10);
      const existing = weeks.get(key);
      const high = row.high ?? row.close, low = row.low ?? row.close;
      if (!existing) weeks.set(key, {weekStart: key, date: row.date, open: row.open ?? row.close, high, low, close: row.close, volume: row.volume});
      else {
        existing.date = row.date;
        existing.high = Math.max(existing.high, high);
        existing.low = Math.min(existing.low, low);
        existing.close = row.close;
        existing.volume = existing.volume === null || row.volume === null ? null : existing.volume + row.volume;
      }
    }
    const bars = [...weeks.values()].sort((a, b) => a.date.localeCompare(b.date));
    let k = 50, d = 50, previousK = 50, previousD = 50, previousJ = 50;
    return bars.map((bar, index) => {
      const window = bars.slice(Math.max(0, index - period + 1), index + 1);
      const high = Math.max(...window.map(item => item.high));
      const low = Math.min(...window.map(item => item.low));
      const rsv = high === low ? 50 : (bar.close - low) / (high - low) * 100;
      k = 2 / 3 * k + 1 / 3 * rsv;
      d = 2 / 3 * d + 1 / 3 * k;
      const j = 3 * k - 2 * d;
      const result = {...bar, k, d, j, previousK, previousD, previousJ,
        direction: j > previousJ + .01 ? "up" : j < previousJ - .01 ? "down" : "flat"};
      previousK = k; previousD = d; previousJ = j;
      return result;
    });
  }

  function relativeStrength(rows, benchmarkRows) {
    const benchmarkByDate = new Map(benchmarkRows.map(row => [row.date, row.close]));
    const aligned = rows.filter(row => benchmarkByDate.has(row.date)).map(row => ({
      date: row.date,
      ratio: row.close / benchmarkByDate.get(row.date),
      close: row.close,
      benchmark: benchmarkByDate.get(row.date)
    })).filter(row => Number.isFinite(row.ratio) && row.ratio > 0);
    const last = aligned.at(-1);
    if (!last) return {available: false, alignedCount: 0, value: null, return20: null, return60: null, recovery20: null};
    const prior20 = aligned.at(-21), prior60 = aligned.at(-61);
    const recent20 = aligned.slice(-20).map(row => row.ratio);
    const low20 = recent20.length ? Math.min(...recent20) : null;
    return {
      available: aligned.length >= 21,
      alignedCount: aligned.length,
      value: round(last.ratio, 6),
      return20: round(prior20 ? change(last.ratio, prior20.ratio) : null),
      return60: round(prior60 ? change(last.ratio, prior60.ratio) : null),
      recovery20: round(low20 ? change(last.ratio, low20) : null)
    };
  }

  function trendStructure(indicators, price) {
    const values = Object.fromEntries(TREND_STRUCTURE_PERIODS.map(period => [`ma${period}`, indicators[`ma${period}`]]));
    const slopes = Object.fromEntries(TREND_STRUCTURE_PERIODS.map(period => [`ma${period}Slope`, indicators[`ma${period}Slope`]]));
    const available = TREND_STRUCTURE_PERIODS.filter(period => finite(values[`ma${period}`]) !== null);
    let label = "資料不足";
    if (available.length === 3) {
      if (price > values.ma43 && values.ma43 > values.ma87 && values.ma87 > values.ma284) label = "多頭排列";
      else if (price < values.ma43 && values.ma43 < values.ma87 && values.ma87 < values.ma284) label = "空頭排列";
      else if (price >= values.ma87 && (slopes.ma43Slope ?? 0) >= 0) label = "結構改善";
      else label = "結構整理";
    }
    return {status: available.length === 3 ? "full" : available.length ? "partial" : "unavailable", label, values, slopes};
  }

  function dataConfidence(rows, benchmarkRows, required = []) {
    const latest = rows.at(-1);
    const flags = {
      enoughCoreHistory: rows.length >= 200,
      enoughTrendHistory: rows.length >= 284,
      latestOhlcvCoverage: latest?.coverage ?? 0,
      benchmarkAligned: benchmarkRows.length ? relativeStrength(rows, benchmarkRows).alignedCount >= 60 : false
    };
    const missing = required.filter(key => !flags[key]);
    const label = !flags.enoughCoreHistory ? "INSUFFICIENT" : missing.length ? "LOW" :
      flags.enoughTrendHistory && flags.latestOhlcvCoverage >= .75 ? "HIGH" : "MEDIUM";
    return {label, flags, missing};
  }

  function buildIndicators(rawRows, rawBenchmarkRows = []) {
    const rows = normalizeOhlcv(rawRows), benchmarkRows = normalizeOhlcv(rawBenchmarkRows);
    const price = rows.at(-1)?.close ?? null;
    const core = movingAverageSnapshot(rows, CORE_MA_PERIODS);
    const structureValues = movingAverageSnapshot(rows, TREND_STRUCTURE_PERIODS);
    const weeklySeries = weeklyKdj(rows), dailySeries = dailyKdj(rows);
    const weekly = weeklySeries.at(-1) || null, daily = dailySeries.at(-1) || null;
    const closes = rows.map(row => row.close), volumes = rows.map(row => row.volume);
    const highest60 = rows.length ? Math.max(...rows.slice(-60).map(row => row.high ?? row.close)) : null;
    const previous20DayHighestClose = rows.length > 1 ? Math.max(...rows.slice(-21, -1).map(row => row.close)) : null;
    const low5 = rows.length >= 5 ? Math.min(...rows.slice(-5).map(row => row.low ?? row.close)) : null;
    const priorLow5 = rows.length >= 10 ? Math.min(...rows.slice(-10, -5).map(row => row.low ?? row.close)) : null;
    const indicators = {
      rows, benchmarkRows, date: rows.at(-1)?.date || "", price,
      core,
      trendStructure: trendStructure(structureValues, price),
      weekly: weekly ? {...weekly, k: round(weekly.k), d: round(weekly.d), j: round(weekly.j), previousJ: round(weekly.previousJ)} : null,
      daily: daily ? {...daily, k: round(daily.k), d: round(daily.d), j: round(daily.j), previousJ: round(daily.previousJ)} : null,
      drawdown60: round(highest60 ? change(price, highest60) : null),
      return10: round(rows.length > 10 ? change(price, rows.at(-11).close) : null),
      return20: round(rows.length > 20 ? change(price, rows.at(-21).close) : null),
      previous20DayHighestClose: round(previous20DayHighestClose, 4),
      volumeMa5: round(simpleMovingAverage(volumes, 5), 0),
      volumeMa20: round(simpleMovingAverage(volumes, 20), 0),
      lowStopped: low5 !== null && priorLow5 !== null ? low5 >= priorLow5 * .99 : null,
      relativeStrength: relativeStrength(rows, benchmarkRows)
    };
    return indicators;
  }

  function scoreFactor(value, points) {
    const number = finite(value);
    return number === null ? null : clamp(number, 0, 100) * points / 100;
  }

  function weightedFactors(definitions) {
    const available = definitions.filter(item => finite(item.value) !== null);
    const availableWeight = available.reduce((sum, item) => sum + item.weight, 0);
    const score = availableWeight ? available.reduce((sum, item) => sum + clamp(item.value, 0, 100) * item.weight / availableWeight, 0) : null;
    return {
      rawScore: score === null ? null : Math.round(clamp(score)),
      coverage: definitions.reduce((sum, item) => sum + item.weight, 0) ? round(availableWeight / definitions.reduce((sum, item) => sum + item.weight, 0) * 100, 1) : 0,
      factors: definitions.map(item => ({...item, value: finite(item.value), contribution: finite(item.value) === null || !availableWeight ? null : round(item.value * item.weight / availableWeight, 2)})),
      missing: definitions.filter(item => finite(item.value) === null).map(item => item.key)
    };
  }

  function trendFactor(indicators) {
    const {price, core} = indicators;
    if (finite(price) === null || finite(core.ma60) === null || finite(core.ma200) === null) return null;
    return clamp((price >= core.ma60 ? 30 : 8) + (price >= core.ma200 ? 35 : 5) + ((core.ma60Slope ?? 0) > 0 ? 20 : 5) + ((core.ma200Slope ?? 0) >= 0 ? 15 : 5));
  }

  function pullbackFactor(drawdown, minimum, maximum) {
    const value = finite(drawdown);
    if (value === null) return null;
    if (value > maximum || value < minimum) return 20;
    const depth = Math.abs(value);
    return clamp(45 + depth / Math.abs(minimum) * 55);
  }

  function kdRecoveryFactor(series) {
    if (!series) return null;
    const j = finite(series.j), previousJ = finite(series.previousJ);
    if (j === null || previousJ === null) return null;
    const low = j < 20 ? 50 + (20 - j) * 2 : Math.max(0, 40 - j);
    return clamp(low + (j > previousJ ? 25 : -15) + (series.k >= series.d ? 10 : 0));
  }

  function volumeFactor(indicators) {
    const volume = indicators.rows.at(-1)?.volume;
    if (finite(volume) === null || finite(indicators.volumeMa20) === null) return null;
    const rising = indicators.price > (indicators.rows.at(-2)?.close ?? indicators.price);
    if (rising && volume >= indicators.volumeMa20 * 1.2) return 90;
    if (rising && volume >= indicators.volumeMa20) return 75;
    if (!rising && volume < indicators.volumeMa20) return 60;
    return 40;
  }

  function stage00733(score, indicators, gates) {
    if (score === null) return {number: 0, key: "insufficient", label: "資料不足", targetPosition: 0};
    if (!gates.setupGate.passed) return {number: 0, key: "wait", label: "等待強勢回檔條件", targetPosition: 0};
    const breakout = indicators.previous20DayHighestClose !== null && indicators.price > indicators.previous20DayHighestClose &&
      indicators.rows.at(-1)?.volume !== null && indicators.volumeMa20 !== null && indicators.rows.at(-1).volume >= indicators.volumeMa20 * 1.2 && (indicators.core.ma20Slope ?? -1) > 0;
    if (breakout && score >= 80) return {number: 4, key: "stage4", label: "Stage 4 趨勢重新發動｜突破確認", targetPosition: 100};
    if (score >= 90) return {number: 3, key: "stage3", label: "Stage 3 趨勢重新發動", targetPosition: 80};
    if (score >= 80) return {number: 2, key: "stage2", label: "Stage 2 轉強加碼", targetPosition: 50};
    if (score >= 70) return {number: 1, key: "stage1", label: "Stage 1 第一批試單", targetPosition: 20};
    return {number: 0, key: score >= 55 ? "near" : "wait", label: score >= 55 ? "接近買點" : "等待", targetPosition: 0};
  }

  function exitPressure00733(indicators, trade = {}) {
    const rs = indicators.relativeStrength;
    const weekly = indicators.weekly;
    const price = indicators.price;
    const below200 = price !== null && indicators.core.ma200 !== null && price < indicators.core.ma200;
    const falling200 = (indicators.core.ma200Slope ?? 0) < 0;
    const structureRisk = price !== null && indicators.core.ma200 !== null && indicators.core.ma60 !== null
      ? (below200 ? (falling200 ? 100 : 80) : price < indicators.core.ma60 ? 65 : 20)
      : null;
    const factors = [
      {key: "relativeStrength", weight: 25, value: rs.return20 === null ? null : clamp(50 - rs.return20 * 8)},
      {key: "structure", weight: 25, value: structureRisk},
      {key: "weeklyReversal", weight: 20, value: weekly ? clamp((weekly.j > 80 ? 35 : 5) + (weekly.direction === "down" ? 55 : 0) + (weekly.k < weekly.d ? 10 : 0)) : null},
      {key: "overextension", weight: 15, value: price !== null && indicators.core.ma20 !== null ? clamp((price / indicators.core.ma20 - 1) * 500) : null},
      {key: "volume", weight: 10, value: volumeFactor(indicators) === null ? null : clamp(100 - volumeFactor(indicators))},
      {key: "market", weight: 5, value: finite(trade.marketRisk)}
    ];
    const result = weightedFactors(factors);
    let pressure = result.rawScore;
    if (below200 && falling200 && pressure !== null) pressure = Math.max(90, pressure);
    const entry = finite(trade.entryPrice), peak = finite(trade.peakPrice), pnl = entry && price ? change(price, entry) : null;
    const peakGain = entry && peak ? change(peak, entry) : null;
    const giveback = peak && price ? change(price, peak) : null;
    const profitProtection = peakGain !== null && peakGain >= 20 && giveback !== null && giveback <= -10;
    return {...result, score: pressure, profitProtection, pnl: round(pnl), recommendation: profitProtection ? "高點回吐達保護條件，總部位降至 50%，狀態轉為 EXIT，不再加碼。" : pressure >= 80 ? "退出壓力偏高，優先保護既有部位。" : "退出壓力尚未達強制條件。"};
  }

  function engine00733(input = {}) {
    const indicators = buildIndicators(input.rows, input.benchmarkRows);
    const confidence = dataConfidence(indicators.rows, indicators.benchmarkRows, ["enoughCoreHistory", "benchmarkAligned"]);
    const weekly = indicators.weekly, core = indicators.core;
    const coreAcceptable = indicators.price !== null && core.ma200 !== null && (indicators.price >= core.ma200 * .97 || (core.ma60Slope ?? -1) >= 0);
    const setupGate = {passed: Boolean(coreAcceptable && weekly && weekly.j < 20 && weekly.direction === "up" && indicators.drawdown60 >= -15 && indicators.drawdown60 <= -3),
      checks: {coreAcceptable, weeklyOversold: Boolean(weekly && weekly.j < 20), weeklyRecovering: weekly?.direction === "up", pullbackRange: indicators.drawdown60 !== null && indicators.drawdown60 >= -15 && indicators.drawdown60 <= -3}};
    const benchmark = buildIndicators(input.benchmarkRows || []);
    const benchmarkShock = benchmark.price !== null && benchmark.core.ma60 !== null && benchmark.price < benchmark.core.ma60 && ((benchmark.core.ma60Slope ?? 0) <= 0 || (benchmark.return10 ?? 0) < -3);
    const marketShockGate = {triggered: benchmarkShock, cap: benchmarkShock ? 69 : 100};
    const rs = indicators.relativeStrength;
    const weighted = weightedFactors([
      {key:"relativeStrength",label:"相對強弱",weight:20,value:rs.return60 === null ? null : clamp(55 + rs.return60 * 4)},
      {key:"relativeStrengthRecovery",label:"相對強弱回升",weight:15,value:rs.recovery20 === null ? null : clamp(45 + rs.recovery20 * 8)},
      {key:"trend",label:"核心趨勢",weight:15,value:trendFactor(indicators)},
      {key:"pullback",label:"強勢回檔",weight:15,value:pullbackFactor(indicators.drawdown60,-15,-3)},
      {key:"weeklyKd",label:"週 KD 回升",weight:15,value:kdRecoveryFactor(weekly)},
      {key:"dailyKd",label:"日 KD",weight:8,value:kdRecoveryFactor(indicators.daily)},
      {key:"priceVolume",label:"價量",weight:7,value:volumeFactor(indicators)},
      {key:"market",label:"市場環境",weight:5,value:benchmarkShock ? 10 : 75}
    ]);
    let score = weighted.rawScore;
    const caps = [];
    if (!setupGate.passed && score !== null) { score = Math.min(score, 54); caps.push({reason:"setup_gate",value:54}); }
    if (marketShockGate.triggered && score !== null) { score = Math.min(score, 69); caps.push({reason:"0050_market_shock",value:69}); }
    if (confidence.label === "INSUFFICIENT") score = null;
    const stage = stage00733(score, indicators, {setupGate, marketShockGate});
    const exitPressure = exitPressure00733(indicators, input.tradeState || {});
    const belowMa200Days = Math.max(Number(input.tradeState?.belowMa200Days)||0, consecutiveBelowMa(indicators.rows, 200, 2));
    const emergencyExit = Boolean(belowMa200Days >= 2 && finite(exitPressure.pnl) !== null && exitPressure.pnl <= -8);
    return sanitizeResult({modelVersion:MODEL_VERSION,strategyType:STRATEGY_TYPES.SWING_00733,symbol:"00733",date:indicators.date,buyScore:score,rawBuyScore:weighted.rawScore,coverage:weighted.coverage,confidence,stage,exitPressure,emergencyExit,trendStructure:indicators.trendStructure,coreIndicators:core,weeklyKd:weekly,dailyKd:indicators.daily,relativeStrength:rs,drawdown60:indicators.drawdown60,gates:{setupGate,marketShockGate},caps,scoreFactors:weighted.factors,recommendedAction:emergencyExit?"核心風險條件觸發，退出優先。":stage.label,reasons:buildReasons(indicators, setupGate, marketShockGate),indicators});
  }

  function stage006201(score, input, gates) {
    if (score === null) return {number:0,key:"insufficient",label:"資料不足",targetPosition:0};
    if (gates.hardFail.triggered) return {number:0,key:"wait",label:"長期趨勢未通過",targetPosition:0};
    if (!gates.setupGate.passed || score < 80) return {number:0,key:score >= 70?"wait_confirm":"wait",label:score >= 70?"Setup成立／等待止跌":"等待",targetPosition:0};
    if (score >= 90 && input.breakoutConfirmed) return {number:2,key:"quality",label:"高品質強買點",targetPosition:SWING_006201_POSITION_CONFIG.breakout};
    if (score >= 90) return {number:1,key:"quality_wait",label:"高分但等待突破",targetPosition:SWING_006201_POSITION_CONFIG.highQuality};
    return {number:1,key:"first",label:"第一買點",targetPosition:SWING_006201_POSITION_CONFIG.first};
  }

  function consecutiveBelowMa(rows, period, maximumDays) {
    const normalized=normalizeOhlcv(rows);let count=0;
    for(let index=normalized.length-1;index>=Math.max(period-1,normalized.length-maximumDays);index-=1){
      const ma=simpleMovingAverage(normalized.slice(0,index+1).map(row=>row.close),period);
      if(ma===null||normalized[index].close>=ma)break;
      count+=1;
    }
    return count;
  }

  function exitPressure006201(indicators, input = {}) {
    const weekly = indicators.weekly;
    const breakout = input.breakoutConfirmed === true;
    const positionRisk = breakout ? 25 : indicators.price !== null && indicators.core.ma20 !== null ? clamp((indicators.price / indicators.core.ma20 - 1) * 450) : null;
    const trendRisk = indicators.price !== null && indicators.core.ma200 !== null && indicators.core.ma60 !== null
      ? (indicators.price < indicators.core.ma200 ? 90 : indicators.price < indicators.core.ma60 ? 65 : 20)
      : null;
    const weighted = weightedFactors([
      {key:"pricePosition",label:"價格位置",weight:25,value:positionRisk},
      {key:"weeklyReversal",label:"週 KD/J 反轉",weight:25,value:weekly ? clamp((weekly.j > 80 ? 30 : 5)+(weekly.direction === "down" ? 55 : 0)+(weekly.k < weekly.d ? 15 : 0)) : null},
      {key:"trend",label:"核心趨勢",weight:20,value:trendRisk},
      {key:"otc",label:"櫃買市場",weight:15,value:finite(input.otcRisk)},
      {key:"volume",label:"量能",weight:15,value:volumeFactor(indicators) === null ? null : clamp(100-volumeFactor(indicators))}
    ]);
    return {...weighted,score:weighted.rawScore,recommendation:weighted.rawScore >= 80?"退出壓力偏高；突破成立時已降低高檔誤判。":"退出壓力尚未達強制條件。"};
  }

  function engine006201(input = {}) {
    const indicators = buildIndicators(input.rows, input.benchmarkRows);
    const confidence = dataConfidence(indicators.rows, indicators.benchmarkRows, ["enoughCoreHistory", "benchmarkAligned"]);
    const weekly = indicators.weekly, core = indicators.core, rs = indicators.relativeStrength;
    const setupGate = {passed:Boolean(weekly && weekly.j < 20 && weekly.direction === "up" && indicators.drawdown60 >= -20 && indicators.drawdown60 <= -8),checks:{weeklyOversold:Boolean(weekly&&weekly.j<20),weeklyRecovering:weekly?.direction==="up",drawdownRange:indicators.drawdown60!==null&&indicators.drawdown60>=-20&&indicators.drawdown60<=-8}};
    const hardFail = {triggered:Boolean(indicators.price !== null && core.ma200 !== null && indicators.price < core.ma200 && (core.ma60Slope ?? 0) < 0),reason:"close_below_ma200_and_ma60_falling"};
    const benchmark = buildIndicators(input.benchmarkRows || []);
    const bearGateTriggered = Boolean(benchmark.price !== null && benchmark.core.ma200 !== null && benchmark.price < benchmark.core.ma200 && (benchmark.core.ma60Slope ?? 0) < 0);
    const relativeWeaknessGate = {triggered:rs.return60 !== null && rs.return60 < 0 && rs.recovery20 !== null && rs.recovery20 < 0,cap:69};
    const priceAboveMa20 = indicators.price !== null && core.ma20 !== null && indicators.price >= core.ma20;
    const weeklyKAboveD = finite(weekly?.k) !== null && finite(weekly?.d) !== null && weekly.k >= weekly.d;
    const stopConfirmationConfirmed = Boolean(weekly?.direction==="up"&&priceAboveMa20&&(core.ma20Slope??-1)>=0);
    const stopConfirmation = clamp((weekly?.direction === "up" ? 35 : 0)+(weeklyKAboveD ? 20 : 0)+(priceAboveMa20 ? 20 : 0)+(indicators.lowStopped ? 15 : 0)+((indicators.return10 ?? -99)>0?10:0));
    const breakoutConfirmed = Boolean(!bearGateTriggered&&indicators.previous20DayHighestClose !== null && indicators.price > indicators.previous20DayHighestClose && indicators.rows.at(-1)?.volume !== null && indicators.volumeMa20 !== null && indicators.rows.at(-1).volume >= indicators.volumeMa20 * 1.2);
    const weighted = weightedFactors([
      {key:"bottom",label:"底部位置",weight:25,value:pullbackFactor(indicators.drawdown60,-20,-8)},
      {key:"stopConfirmation",label:"止跌確認",weight:20,value:stopConfirmation},
      {key:"relativeStrength",label:"相對強弱",weight:15,value:rs.return60===null?null:clamp(55+rs.return60*4)},
      {key:"relativeStrengthRecovery",label:"相對強弱回升",weight:10,value:rs.recovery20===null?null:clamp(45+rs.recovery20*8)},
      {key:"trend",label:"核心趨勢",weight:10,value:trendFactor(indicators)},
      {key:"dailyKd",label:"日 KD",weight:5,value:kdRecoveryFactor(indicators.daily)},
      {key:"volume",label:"量能",weight:5,value:volumeFactor(indicators)},
      {key:"market",label:"0050 市場",weight:5,value:bearGateTriggered?10:75},
      {key:"otc",label:"櫃買環境",weight:5,value:finite(input.otcStrength)}
    ]);
    let score = weighted.rawScore;
    const caps=[];
    if (!setupGate.passed && score !== null) {score=Math.min(score,69);caps.push({reason:"setup_gate",value:69});}
    if ((bearGateTriggered || relativeWeaknessGate.triggered) && score !== null) {score=Math.min(score,69);caps.push({reason:bearGateTriggered?"0050_bear_gate":"relative_weakness",value:69});}
    if (hardFail.triggered && score !== null) {score=Math.min(score,49);caps.push({reason:"hard_fail",value:49});}
    if (confidence.label === "INSUFFICIENT") score=null;
    const stage=stage006201(score,{breakoutConfirmed},{hardFail,setupGate});
    const exitPressure=exitPressure006201(indicators,{...input,breakoutConfirmed});
    const below200Days=Math.max(Number(input.tradeState?.belowMa200Days)||0,consecutiveBelowMa(indicators.rows,200,10));
    const pnl=finite(input.tradeState?.entryPrice)&&indicators.price?change(indicators.price,input.tradeState.entryPrice):null;
    const emergencyExit=Boolean(below200Days>=10&&(core.ma60Slope??0)<0&&pnl!==null&&pnl<=-8);
    const timeExit=Boolean((Number(input.tradeState?.holdingDays)||0)>=120);
    return sanitizeResult({modelVersion:MODEL_VERSION,strategyType:STRATEGY_TYPES.SWING_006201,symbol:"006201",date:indicators.date,buyScore:score,rawBuyScore:weighted.rawScore,coverage:weighted.coverage,confidence,stage,exitPressure,emergencyExit,timeExit,cooldownDays:20,stopConfirmation,stopConfirmationConfirmed,breakoutConfirmed,trendStructure:indicators.trendStructure,coreIndicators:core,weeklyKd:weekly,dailyKd:indicators.daily,relativeStrength:rs,drawdown60:indicators.drawdown60,gates:{setupGate,hardFail,bearGate:{triggered:bearGateTriggered},relativeWeaknessGate},caps,scoreFactors:weighted.factors,recommendedAction:emergencyExit||timeExit?"退出條件優先。":stage.label,reasons:buildReasons(indicators,setupGate,{triggered:bearGateTriggered}),indicators});
  }

  function buildReasons(indicators, setupGate, marketGate) {
    const reasons=[];
    if (indicators.weekly) reasons.push(`週 J ${round(indicators.weekly.j,1)}，方向${indicators.weekly.direction==="up"?"回升":indicators.weekly.direction==="down"?"下彎":"持平"}`);
    if (indicators.drawdown60!==null) reasons.push(`距 60 日高點 ${round(indicators.drawdown60,1)}%`);
    reasons.push(setupGate.passed?"Setup Gate 通過":"Setup Gate 未通過");
    if (marketGate.triggered) reasons.push("0050 市場風險上限生效");
    return reasons;
  }

  function normalizeTradeState(raw = {}) {
    const state = TRADE_STATES.includes(raw.state) ? raw.state : "CLOSED";
    return {tradeId:String(raw.tradeId||""),symbol:String(raw.symbol||""),state,position:clamp(finite(raw.position)??0,0,100),entryPrice:finite(raw.entryPrice),peakPrice:finite(raw.peakPrice),entryDate:safeDate(raw.entryDate),exitDate:safeDate(raw.exitDate),highestStage:Math.max(0,Math.floor(finite(raw.highestStage)??0)),lastExecutedStage:Math.max(0,Math.floor(finite(raw.lastExecutedStage)??finite(raw.highestStage)??0)),lastStageDate:safeDate(raw.lastStageDate),lastEntryPrice:finite(raw.lastEntryPrice),holdingDays:Math.max(0,Math.floor(finite(raw.holdingDays)??0)),belowMa200Days:Math.max(0,Math.floor(finite(raw.belowMa200Days)??0)),cooldownRemaining:Math.max(0,Math.floor(finite(raw.cooldownRemaining)??0))};
  }

  function transitionTradeState(rawState, event = {}) {
    const current=normalizeTradeState(rawState), action=String(event.action||"");
    const allowed={ACCUMULATION:["HOLDING","EXIT"],HOLDING:["EXIT"],EXIT:["CLOSED"],CLOSED:["ACCUMULATION"]};
    const next=String(event.nextState||current.state);
    if (action==="ADD" && current.state==="EXIT") return {...current,error:"exit_mode_no_add"};
    if (action==="OPEN" && current.state==="CLOSED" && (Number(event.cooldownRemaining)||0)>0) return {...current,error:"cooldown_active"};
    if (next!==current.state && !allowed[current.state].includes(next)) return {...current,error:"invalid_transition"};
    const output={...current,state:next};
    if (action==="OPEN"&&current.state==="CLOSED"&&next==="ACCUMULATION") {
      output.tradeId=String(event.tradeId||`${event.symbol||current.symbol}-${event.date||""}`);
      output.symbol=String(event.symbol||current.symbol);output.entryDate=safeDate(event.date);output.entryPrice=finite(event.price);output.peakPrice=finite(event.price);output.position=clamp(finite(event.position)??0,0,100);output.highestStage=Math.max(0,Math.floor(finite(event.stage)??0));output.lastExecutedStage=output.highestStage;output.lastStageDate=safeDate(event.date);output.lastEntryPrice=finite(event.price);
    }
    if (action==="ADD"&&["ACCUMULATION","HOLDING"].includes(current.state)) {
      const requestedStage=Math.max(0,Math.floor(finite(event.stage)??0));
      if(safeDate(event.date)&&safeDate(event.date)===current.lastStageDate)return{...current,error:"one_stage_per_day"};
      const repeatAllowed=requestedStage===current.highestStage&&event.stageCondition===true&&finite(event.price)!==null&&finite(current.lastEntryPrice)!==null&&event.price<=current.lastEntryPrice*.95;
      if (requestedStage<current.highestStage||(requestedStage===current.highestStage&&!repeatAllowed)) return {...current,error:"stage_already_executed"};
      output.position=clamp(finite(event.position)??current.position,0,100);output.highestStage=Math.max(current.highestStage,requestedStage);output.lastExecutedStage=requestedStage;output.lastStageDate=safeDate(event.date);output.lastEntryPrice=finite(event.price)??current.lastEntryPrice;
    }
    if (action==="PROTECT"&&next==="EXIT") output.position=Math.min(50,output.position);
    if (action==="CLOSE"&&next==="CLOSED") {output.position=0;output.exitDate=safeDate(event.date);}
    return output;
  }

  function runStrategy({strategyType,input={},adapters={}}={}) {
    if (strategyType===STRATEGY_TYPES.SWING_00733) return engine00733(input);
    if (strategyType===STRATEGY_TYPES.SWING_006201) return engine006201(input);
    if (strategyType===STRATEGY_TYPES.LONG_TERM && typeof adapters.longTerm==="function") return adapters.longTerm(input);
    if (strategyType===STRATEGY_TYPES.LEVERAGED && typeof adapters.leveraged==="function") return adapters.leveraged(input);
    return {modelVersion:MODEL_VERSION,strategyType:String(strategyType||""),buyScore:null,confidence:{label:"INSUFFICIENT",missing:["strategy_adapter"]},stage:{number:0,key:"insufficient",label:"策略資料不足",targetPosition:0},exitPressure:{score:null},recommendedAction:"暫不提供策略訊號",reasons:["找不到對應策略引擎"]};
  }

  function backtestSignals(rows, benchmarkRows, strategyType, options = {}) {
    const normalized=normalizeOhlcv(rows), cooldown=Math.max(1,Math.floor(finite(options.cooldownDays)??20));
    const minimum=Number(options.minimumRows)||284, signals=[];
    let lastIndex=-cooldown;
    for(let index=minimum-1;index<normalized.length;index+=1){
      if(index-lastIndex<cooldown)continue;
      const date=normalized[index].date;
      const benchmarkSlice=normalizeOhlcv(benchmarkRows).filter(row=>row.date<=date);
      const result=runStrategy({strategyType,input:{rows:normalized.slice(0,index+1),benchmarkRows:benchmarkSlice,otcStrength:50}});
      if(!result.stage||result.stage.number<1)continue;
      const entry=normalized[index].close;
      const outcomes={};
      for(const horizon of [20,60,120]){
        const future=normalized[index+horizon]?.close;
        outcomes[`return${horizon}`]=future?round(change(future,entry)):null;
      }
      signals.push({date,stage:result.stage.number,buyScore:result.buyScore,outcomes});lastIndex=index;
    }
    return {strategyType,cooldownDays:cooldown,signals,sampleCount:signals.length,noLookahead:true,splitAdjustedRequired:true};
  }

  function sanitizeResult(value) {
    if (Array.isArray(value)) return value.map(sanitizeResult);
    if (!value || typeof value!=="object") return typeof value==="number"&&!Number.isFinite(value)?null:value;
    return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,sanitizeResult(item)]));
  }

  return Object.freeze({MODEL_VERSION,STRATEGY_TYPES,CORE_MA_PERIODS,TREND_STRUCTURE_PERIODS,TRADE_STATES,SWING_006201_POSITION_CONFIG,normalizeOhlcv,simpleMovingAverage,movingAverageSnapshot,dailyKdj,weeklyKdj,relativeStrength,trendStructure,dataConfidence,buildIndicators,weightedFactors,stage00733,stage006201,consecutiveBelowMa,engine00733,engine006201,exitPressure00733,exitPressure006201,normalizeTradeState,transitionTradeState,runStrategy,backtestSignals,sanitizeResult});
});
