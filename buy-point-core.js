(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.HSBuyPointCore = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const GENERAL_HORIZONS = [20, 60, 120];
  const LEVERAGED_HORIZONS = [10, 20, 40];
  const SIGNAL_COOLDOWN_DAYS = 20;

  function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function mean(values) {
    const valid = values.map(finite).filter(value => value !== null);
    return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
  }

  function median(values) {
    const valid = values.map(finite).filter(value => value !== null).sort((a, b) => a - b);
    if (!valid.length) return null;
    const middle = Math.floor(valid.length / 2);
    return valid.length % 2 ? valid[middle] : (valid[middle - 1] + valid[middle]) / 2;
  }

  function percentileRank(values, current) {
    const target = finite(current);
    const valid = values.map(finite).filter(value => value !== null);
    if (target === null || !valid.length) return null;
    const below = valid.filter(value => value < target).length;
    const equal = valid.filter(value => value === target).length;
    return clamp((below + equal * 0.5) / valid.length * 100, 0, 100);
  }

  function safeDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : "";
  }

  function dateSpanDays(start, end) {
    const first = Date.parse(`${start}T00:00:00Z`);
    const last = Date.parse(`${end}T00:00:00Z`);
    return Number.isFinite(first) && Number.isFinite(last) ? Math.max(0, Math.round((last - first) / 86400000)) : 0;
  }

  function fiveYearsBefore(date) {
    const parsed = new Date(`${date}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime())) return "";
    parsed.setUTCFullYear(parsed.getUTCFullYear() - 5);
    return parsed.toISOString().slice(0, 10);
  }

  function normalizeCorporateEvent(raw, fallbackKind = "") {
    const date = safeDate(raw?.date);
    const before = finite(raw?.before_price ?? raw?.before_close);
    const after = finite(raw?.reference_price ?? raw?.after_price ?? raw?.after_ref_close);
    if (!date || before === null || after === null || before <= 0 || after <= 0) return null;
    const ratio = after / before;
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 100) return null;
    const rawType = String(raw?.type ?? raw?.stock_or_cache_dividend ?? "");
    const kind = fallbackKind || (/分割|面額/.test(rawType) ? "split" : "distribution");
    return {date, ratio, kind, label: rawType || kind};
  }

  function adjustPriceHistory(rows, corporateEvents = []) {
    const normalizedRows = (Array.isArray(rows) ? rows : [])
      .filter(row => safeDate(row?.date))
      .map(row => ({...row}))
      .sort((a, b) => a.date.localeCompare(b.date));
    const events = (Array.isArray(corporateEvents) ? corporateEvents : [])
      .map(event => normalizeCorporateEvent(event, event?.kind || ""))
      .filter(Boolean)
      .sort((a, b) => a.date.localeCompare(b.date));
    const seen = new Set();
    const uniqueEvents = events.filter(event => {
      const key = `${event.date}:${event.ratio.toFixed(8)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const adjusted = normalizedRows.map(row => {
      let priceFactor = 1;
      let volumeFactor = 1;
      for (const event of uniqueEvents) {
        if (row.date >= event.date) continue;
        priceFactor *= event.ratio;
        if (event.kind === "split" || event.ratio < 0.8 || event.ratio > 1.25) volumeFactor /= event.ratio;
      }
      const output = {...row};
      for (const key of ["open", "max", "min", "close"]) {
        const value = finite(row[key]);
        if (value !== null) output[key] = value * priceFactor;
      }
      const volumeKey = row.Trading_Volume != null ? "Trading_Volume" : row.trading_volume != null ? "trading_volume" : "";
      if (volumeKey) {
        const volume = finite(row[volumeKey]);
        if (volume !== null) output[volumeKey] = volume * volumeFactor;
      }
      return output;
    });
    return {rows: adjusted, events: uniqueEvents};
  }

  function weeklyKdj(rows) {
    const weeks = new Map();
    for (const row of rows) {
      const date = safeDate(row?.date);
      const close = finite(row?.close);
      const high = finite(row?.max ?? row?.close);
      const low = finite(row?.min ?? row?.close);
      if (!date || close === null || high === null || low === null) continue;
      const parsed = new Date(`${date}T00:00:00+08:00`);
      const weekday = parsed.getDay() || 7;
      const monday = new Date(parsed);
      monday.setDate(parsed.getDate() - weekday + 1);
      const key = monday.toISOString().slice(0, 10);
      if (!weeks.has(key)) weeks.set(key, {date, close, high, low});
      const week = weeks.get(key);
      week.date = date;
      week.close = close;
      week.high = Math.max(week.high, high);
      week.low = Math.min(week.low, low);
    }
    let k = 50;
    let d = 50;
    let previousJ = 50;
    let previousK = 50;
    let previousD = 50;
    const output = [];
    const values = [...weeks.values()].sort((a, b) => a.date.localeCompare(b.date));
    for (let index = 0; index < values.length; index++) {
      const window = values.slice(Math.max(0, index - 8), index + 1);
      const high = Math.max(...window.map(item => item.high));
      const low = Math.min(...window.map(item => item.low));
      const rsv = high === low ? 50 : (values[index].close - low) / (high - low) * 100;
      k = 2 / 3 * k + 1 / 3 * rsv;
      d = 2 / 3 * d + 1 / 3 * k;
      const j = 3 * k - 2 * d;
      output.push({...values[index], k, d, j, previousJ, previousK, previousD});
      previousJ = j;
      previousK = k;
      previousD = d;
    }
    return output;
  }

  function sliceMean(values, endIndex, length) {
    if (endIndex + 1 < length) return null;
    return mean(values.slice(endIndex - length + 1, endIndex + 1));
  }

  function rowVolume(row) {
    return finite(row?.Trading_Volume ?? row?.trading_volume ?? row?.volume);
  }

  function stopConfirmation(rows, dailyIndex, weeklySeries, weeklyIndex) {
    const closes = rows.map(row => finite(row.close));
    const lows = rows.map(row => finite(row.min ?? row.close));
    const volumes = rows.map(rowVolume);
    const current = weeklySeries[weeklyIndex];
    const previous = weeklySeries[Math.max(0, weeklyIndex - 1)] || current;
    const recentJLow = Math.min(...weeklySeries.slice(Math.max(0, weeklyIndex - 3), weeklyIndex + 1).map(item => item.j));
    const jRise = current.j - recentJLow;
    const jPoints = current.j > previous.j && jRise >= 8 ? 16 : current.j > previous.j && jRise >= 3 ? 10 : current.j > previous.j ? 5 : 0;
    const crossed = current.k >= current.d && previous.k < previous.d;
    const kdPoints = crossed ? 16 : current.k >= current.d && current.k > previous.k ? 12 : current.k > previous.k ? 7 : 0;
    const ma5 = sliceMean(closes, dailyIndex, 5);
    const ma10 = sliceMean(closes, dailyIndex, 10);
    const price = closes[dailyIndex];
    const ma5Points = ma5 !== null && price >= ma5 ? 12 : 0;
    const ma10Points = ma10 !== null && price >= ma10 ? 12 : 0;
    const latestLow = Math.min(...lows.slice(Math.max(0, dailyIndex - 4), dailyIndex + 1).filter(value => value !== null));
    const priorLow = Math.min(...lows.slice(Math.max(0, dailyIndex - 9), Math.max(0, dailyIndex - 4)).filter(value => value !== null));
    const lowPoints = Number.isFinite(latestLow) && Number.isFinite(priorLow) && latestLow >= priorLow ? 16 :
      Number.isFinite(latestLow) && Number.isFinite(priorLow) && latestLow >= priorLow * 0.99 ? 8 : 0;
    const recentVolume = mean(volumes.slice(Math.max(0, dailyIndex - 4), dailyIndex + 1));
    const panicVolume = mean(volumes.slice(Math.max(0, dailyIndex - 9), Math.max(0, dailyIndex - 4)));
    const normalVolume = mean(volumes.slice(Math.max(0, dailyIndex - 29), Math.max(0, dailyIndex - 9)));
    const volumePoints = recentVolume !== null && panicVolume !== null && normalVolume !== null &&
      panicVolume > normalVolume * 1.25 && recentVolume < panicVolume * 0.85 ? 14 :
      recentVolume !== null && panicVolume !== null && recentVolume < panicVolume ? 8 : 0;
    const fiveDayBase = closes[dailyIndex - 5];
    const oneDayBase = closes[dailyIndex - 1];
    const return5 = finite(fiveDayBase) !== null && fiveDayBase > 0 ? (price / fiveDayBase - 1) * 100 : null;
    const return1 = finite(oneDayBase) !== null && oneDayBase > 0 ? (price / oneDayBase - 1) * 100 : null;
    const momentumPoints = return5 !== null && return5 > 2 && return1 > 0 ? 14 : return5 !== null && return5 > 0 ? 10 : return1 !== null && return1 > 0 ? 5 : 0;
    const components = [
      {key: "j_rebound", label: "J 值自低點回升", points: jPoints, maximum: 16},
      {key: "kd_turn", label: "K 向上接近或突破 D", points: kdPoints, maximum: 16},
      {key: "ma5", label: "站回 5 日線", points: ma5Points, maximum: 12},
      {key: "ma10", label: "站回 10 日線", points: ma10Points, maximum: 12},
      {key: "low_stable", label: "近期低點停止破底", points: lowPoints, maximum: 16},
      {key: "volume_contract", label: "恐慌量能轉為收斂", points: volumePoints, maximum: 14},
      {key: "momentum", label: "短期價格動能改善", points: momentumPoints, maximum: 14}
    ];
    const score = Math.round(clamp(components.reduce((sum, item) => sum + item.points, 0), 0, 100));
    return {score, label: stopLabel(score), components, ma5, ma10, return5};
  }

  function stopLabel(score) {
    if (score <= 29) return "仍在下探";
    if (score <= 49) return "尚未確認";
    if (score <= 69) return "初步止跌";
    if (score <= 84) return "止跌回升";
    return "反轉確認較強";
  }

  function classifyEnvironment(input) {
    const price = finite(input?.price);
    const ma60 = finite(input?.ma60);
    const ma200 = finite(input?.ma200);
    const ma60Slope = finite(input?.ma60Slope) ?? 0;
    const ma200Slope = finite(input?.ma200Slope) ?? 0;
    const volatility = finite(input?.volatility) ?? 0;
    const drawdown = finite(input?.fromHigh) ?? 0;
    const return20 = finite(input?.return20) ?? 0;
    const stop = finite(input?.stopScore) ?? 0;
    if ([price, ma60, ma200].some(value => value === null)) return "趨勢不明";
    if (drawdown <= -15 && return20 <= -8 && volatility >= 28 && stop < 50) return "恐慌急跌";
    if (stop >= 60 && return20 > 0 && (price < ma60 || price < ma200)) return "築底回升";
    if (price < ma200 && return20 > 0) return "空頭反彈";
    if (price >= ma200 && ma200Slope >= 0 && drawdown <= -3) return "多頭回檔";
    if (price >= ma60 && price >= ma200 && drawdown > -6 && Math.abs(ma60Slope) < 0.03) return "高檔震盪";
    if (price < ma60 && price < ma200 && stop >= 50) return "築底回升";
    return "趨勢不明";
  }

  function buildWeeklyFeatures(rows, strategyType = "equity") {
    const cleanRows = rows.filter(row => safeDate(row?.date) && finite(row?.close) !== null);
    const closes = cleanRows.map(row => Number(row.close));
    const weekly = weeklyKdj(cleanRows);
    const indexByDate = new Map(cleanRows.map((row, index) => [row.date, index]));
    return weekly.map((week, weeklyIndex) => {
      const dailyIndex = indexByDate.get(week.date);
      const price = closes[dailyIndex];
      const weeklyCloses40 = weekly.slice(Math.max(0, weeklyIndex - 39), weeklyIndex + 1).map(item => finite(item.close));
      const ma40w = weeklyCloses40.length === 40 && weeklyCloses40.every(value => value !== null) ? mean(weeklyCloses40) : null;
      const bias40w = ma40w !== null && ma40w > 0 ? (price / ma40w - 1) * 100 : null;
      const ma20 = sliceMean(closes, dailyIndex, 20);
      const ma60 = sliceMean(closes, dailyIndex, 60);
      const ma120 = sliceMean(closes, dailyIndex, 120);
      const ma200 = sliceMean(closes, dailyIndex, 200);
      const priorMa60 = sliceMean(closes, dailyIndex - 20, 60);
      const priorMa200 = sliceMean(closes, dailyIndex - 20, 200);
      const highWindow = cleanRows.slice(Math.max(0, dailyIndex - 251), dailyIndex + 1);
      const high52 = highWindow.length ? Math.max(...highWindow.map(row => Number(row.max ?? row.close))) : price;
      const fromHigh = high52 > 0 ? (price / high52 - 1) * 100 : null;
      const return20 = dailyIndex >= 20 ? (price / closes[dailyIndex - 20] - 1) * 100 : null;
      const logReturns = [];
      for (let index = Math.max(1, dailyIndex - 59); index <= dailyIndex; index++) {
        if (closes[index] > 0 && closes[index - 1] > 0) logReturns.push(Math.log(closes[index] / closes[index - 1]));
      }
      const averageReturn = mean(logReturns);
      const variance = averageReturn === null || logReturns.length < 2 ? null :
        logReturns.reduce((sum, value) => sum + (value - averageReturn) ** 2, 0) / (logReturns.length - 1);
      const volatility = variance === null ? null : Math.sqrt(variance) * Math.sqrt(252) * 100;
      const stop = stopConfirmation(cleanRows, dailyIndex, weekly, weeklyIndex);
      const ma60Slope = ma60 !== null && priorMa60 !== null && priorMa60 !== 0 ? (ma60 / priorMa60 - 1) * 100 : null;
      const ma200Slope = ma200 !== null && priorMa200 !== null && priorMa200 !== 0 ? (ma200 / priorMa200 - 1) * 100 : null;
      const relativePosition = ma60 !== null && ma200 !== null && (ma60 + ma200) > 0 ? price / ((ma60 + ma200) / 2) - 1 : null;
      const feature = {
        ...week,
        dailyIndex,
        price,
        ma40w,
        bias40w,
        ma20,
        ma60,
        ma120,
        ma200,
        ma60Slope,
        ma200Slope,
        volatility,
        high52,
        fromHigh,
        return20,
        relativePosition,
        direction: week.j > week.previousJ ? "回升" : "下探",
        above20: ma20 !== null ? price >= ma20 : false,
        above60: ma60 !== null ? price >= ma60 : false,
        above120: ma120 !== null ? price >= ma120 : false,
        above200: ma200 !== null ? price >= ma200 : false,
        strategyType,
        stop
      };
      feature.environment = classifyEnvironment({...feature, stopScore: stop.score});
      return feature;
    });
  }

  function historicalPosition(features, rows, current = features.at(-1)) {
    if (!current || !rows.length) return {available: false, label: "歷史樣本不足"};
    const boundary = fiveYearsBefore(current.date);
    const sample = features.filter(item => item.date >= boundary && item.date <= current.date);
    const dailySample = rows.filter(row => row.date >= boundary && row.date <= current.date);
    const sampleStart = dailySample[0]?.date || rows[0]?.date || "";
    const sampleEnd = dailySample.at(-1)?.date || current.date;
    const spanDays = dateSpanDays(sampleStart, sampleEnd);
    const periodLabel = spanDays >= 5 * 365 - 45 ? "最近五年" : `上市以來 ${Math.max(1, Math.round(spanDays / 30))} 個月`;
    if (spanDays < 365 || dailySample.length < 220 || sample.length < 40) {
      return {available: false, label: "歷史樣本不足", sampleStart, sampleEnd, sampleDays: dailySample.length, periodLabel};
    }
    const jPercentile = percentileRank(sample.map(item => item.j), current.j);
    const drawdownPercentile = percentileRank(sample.map(item => Math.abs(Math.min(0, item.fromHigh ?? 0))), Math.abs(Math.min(0, current.fromHigh ?? 0)));
    const pricePositionPercentile = percentileRank(sample.map(item => item.relativePosition), current.relativePosition);
    const lowPercentile = Math.round(mean([jPercentile, 100 - drawdownPercentile, pricePositionPercentile]));
    return {
      available: true,
      label: `歷史位置偏低 ${lowPercentile}%`,
      lowPercentile,
      jPercentile: Math.round(jPercentile),
      oversoldDegree: Math.round(100 - jPercentile),
      drawdownPercentile: Math.round(drawdownPercentile),
      pricePositionPercentile: Math.round(pricePositionPercentile),
      sampleStart,
      sampleEnd,
      sampleDays: dailySample.length,
      sampleWeeks: sample.length,
      periodLabel
    };
  }

  function sameSignal(candidate, current, requireEnvironment) {
    const jSimilar = Math.abs(candidate.j - current.j) <= 12;
    const drawdownSimilar = Math.abs((candidate.fromHigh ?? 0) - (current.fromHigh ?? 0)) <= 7.5;
    return jSimilar &&
      candidate.direction === current.direction &&
      candidate.above60 === current.above60 &&
      candidate.above200 === current.above200 &&
      drawdownSimilar &&
      candidate.strategyType === current.strategyType &&
      (!requireEnvironment || candidate.environment === current.environment);
  }

  function calculateSimilarStats(rows, features, current = features.at(-1), options = {}) {
    const leveraged = options.leveraged ?? ["leveraged", "inverse"].includes(current?.strategyType);
    const horizons = leveraged ? LEVERAGED_HORIZONS : GENERAL_HORIZONS;
    const cooldown = options.cooldownDays ?? SIGNAL_COOLDOWN_DAYS;
    const requireEnvironment = options.requireEnvironment !== false;
    const maximumHorizon = Math.max(...horizons);
    const candidates = [];
    let lastSelectedIndex = -Infinity;
    for (const feature of features) {
      if (!current || feature.date >= current.date) continue;
      if (feature.dailyIndex + maximumHorizon >= rows.length) continue;
      if (!sameSignal(feature, current, requireEnvironment)) continue;
      if (feature.dailyIndex - lastSelectedIndex < cooldown) continue;
      candidates.push(feature);
      lastSelectedIndex = feature.dailyIndex;
    }
    const outcomes = candidates.map(candidate => {
      const entry = finite(rows[candidate.dailyIndex]?.close);
      const returns = {};
      for (const horizon of horizons) {
        const exit = finite(rows[candidate.dailyIndex + horizon]?.close);
        returns[horizon] = entry !== null && entry > 0 && exit !== null ? (exit / entry - 1) * 100 : null;
      }
      const adverse = rows.slice(candidate.dailyIndex + 1, candidate.dailyIndex + maximumHorizon + 1)
        .map(row => finite(row.min ?? row.close))
        .filter(value => value !== null);
      const mae = entry !== null && entry > 0 && adverse.length ? Math.min(0, (Math.min(...adverse) / entry - 1) * 100) : null;
      return {date: candidate.date, dailyIndex: candidate.dailyIndex, returns, mae};
    });
    const byHorizon = {};
    for (const horizon of horizons) {
      const values = outcomes.map(item => item.returns[horizon]).filter(value => value !== null);
      byHorizon[horizon] = {
        count: values.length,
        positiveRate: values.length ? values.filter(value => value > 0).length / values.length * 100 : null,
        medianReturn: median(values)
      };
    }
    const adverseValues = outcomes.map(item => item.mae).filter(value => value !== null);
    return {
      scope: requireEnvironment ? "same_environment" : "all_environments",
      environment: current?.environment || "趨勢不明",
      horizons,
      cooldownDays: cooldown,
      sampleCount: outcomes.length,
      sampleWarning: outcomes.length < 10 ? "樣本數偏少，參考性有限" : "",
      byHorizon,
      medianAdverseExcursion: median(adverseValues),
      worstAdverseExcursion: adverseValues.length ? Math.min(...adverseValues) : null,
      signalDates: outcomes.map(item => item.date),
      signalIndexes: outcomes.map(item => item.dailyIndex)
    };
  }

  function similarSignalReport(rows, features, current = features.at(-1), strategyType = "equity") {
    const highVolatility = ["leveraged", "inverse"].includes(strategyType);
    return {
      model: highVolatility ? "high_volatility_short_horizon" : "general",
      sameEnvironment: calculateSimilarStats(rows, features, current, {leveraged: highVolatility, requireEnvironment: true}),
      allEnvironments: calculateSimilarStats(rows, features, current, {leveraged: highVolatility, requireEnvironment: false})
    };
  }

  function marketRisk(input = {}) {
    const cnn = finite(input.cnnScore);
    const fomo = finite(input.fomoScore);
    const eventDays = finite(input.eventDays);
    if ((eventDays !== null && eventDays <= 1) || (fomo !== null && fomo >= 65) || (cnn !== null && (cnn <= 24 || cnn >= 75))) {
      return {key: "high", label: "市場風險偏高", text: "事件或情緒波動偏高，分批條件宜更嚴格。"};
    }
    if ((fomo !== null && fomo >= 55) || (cnn !== null && (cnn <= 35 || cnn >= 65))) {
      return {key: "medium", label: "市場風險中等", text: "情緒仍有波動，等待價格與止跌訊號互相確認。"};
    }
    return {key: "normal", label: "市場風險一般", text: "市場風險未明顯升高，仍應依條件分批評估。"};
  }

  function buyStage(input = {}) {
    const score = finite(input.score) ?? 0;
    const j = finite(input.j) ?? 50;
    const stop = finite(input.stopScore) ?? 0;
    const oversold = finite(input.oversoldDegree) ?? clamp((20 - j) / 40 * 100, 0, 100);
    const rising = input.direction === "回升";
    const kdImproving = Boolean(input.kdImproving);
    const environment = input.environment || "趨勢不明";
    const risk = input.marketRisk?.key || "normal";
    if ((j >= 75 || environment === "高檔震盪") && score < 40 && oversold < 35) {
      return {key: "overheated", label: "過熱暫停", conclusion: "位置偏高，暫停追價並等待新的風險報酬空間。"};
    }
    if (score >= 72 && stop >= 70 && rising && kdImproving && risk !== "high") {
      return {key: "staged", label: "分批布局", conclusion: "超賣後回升條件較完整，可依規劃分批觀察。"};
    }
    if (score >= 58 && stop >= 50 && rising && kdImproving) {
      return {key: "first", label: "第一批觀察", conclusion: "已出現初步止跌，仍需控制第一批比例。"};
    }
    if (score >= 45 || oversold >= 70 || j < 20) {
      return {key: "near", label: "接近買點", conclusion: stop < 50 ? "很超賣，但尚未止跌。" : "位置轉低，等待更多止跌確認。"};
    }
    return {key: "wait", label: "等待", conclusion: rising ? "訊號改善但買點條件仍不足。" : "條件尚未成熟，繼續等待。"};
  }

  function installmentMap(mode = "balanced", leveraged = false) {
    const modes = {
      conservative: {label: "保守", ratios: [20, 30, 50]},
      balanced: {label: "均衡", ratios: [30, 30, 40]},
      aggressive: {label: "積極", ratios: [40, 35, 25]}
    };
    const selected = modes[mode] || modes.balanced;
    const scale = leveraged ? 0.5 : 1;
    return {
      mode: modes[mode] ? mode : "balanced",
      label: selected.label,
      leveragedCap: leveraged ? 50 : 100,
      steps: [
        {label: "第一批觀察位置", ratio: Math.round(selected.ratios[0] * scale), condition: "止跌確認度達 60 以上"},
        {label: "第二批風險位置", ratio: Math.round(selected.ratios[1] * scale), condition: "再回檔 5% 且基本趨勢未破壞"},
        {label: "趨勢確認位置", ratio: Math.round(selected.ratios[2] * scale), condition: "重新站回重要均線"}
      ]
    };
  }

  return {
    GENERAL_HORIZONS,
    LEVERAGED_HORIZONS,
    SIGNAL_COOLDOWN_DAYS,
    adjustPriceHistory,
    weeklyKdj,
    buildWeeklyFeatures,
    historicalPosition,
    calculateSimilarStats,
    similarSignalReport,
    stopConfirmation,
    stopLabel,
    classifyEnvironment,
    marketRisk,
    buyStage,
    installmentMap,
    median,
    percentileRank
  };
});
