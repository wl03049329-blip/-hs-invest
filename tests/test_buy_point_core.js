const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../buy-point-core.js");

function check(name, fn) {
  fn();
  process.stdout.write(`PASS ${name}\n`);
}

function tradingRows(count, start = "2020-01-02", priceFn = index => 100 + index * 0.03) {
  const rows = [];
  const date = new Date(`${start}T00:00:00Z`);
  let index = 0;
  while (rows.length < count) {
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) {
      const close = priceFn(index);
      rows.push({
        date: date.toISOString().slice(0, 10),
        open: close * 0.998,
        max: close * 1.012,
        min: close * 0.988,
        close,
        Trading_Volume: 1_000_000 + (index % 20) * 10_000
      });
      index += 1;
    }
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return rows;
}

check("公司行動會還原拆分與配息前價格", () => {
  const rows = [
    {date: "2025-01-01", open: 100, max: 102, min: 98, close: 100, Trading_Volume: 1000},
    {date: "2025-01-02", open: 50, max: 51, min: 49, close: 50, Trading_Volume: 2000}
  ];
  const adjusted = core.adjustPriceHistory(rows, [
    {date: "2025-01-02", before_price: 100, after_price: 50, kind: "split"}
  ]);
  assert.equal(adjusted.rows[0].close, 50);
  assert.equal(adjusted.rows[0].Trading_Volume, 2000);
  assert.equal(adjusted.rows[1].close, 50);
  const dividendAdjusted = core.adjustPriceHistory([
    {date: "2025-06-30", close: 100},
    {date: "2025-07-01", close: 95}
  ], [{date: "2025-07-01", before_price: 100, reference_price: 95, kind: "distribution"}]);
  assert.equal(dividendAdjusted.rows[0].close, 95);
  assert.equal(dividendAdjusted.rows[1].close, 95);
});

check("最近五年與上市以來百分位正確區分", () => {
  const fiveYearRows = tradingRows(1400);
  const fiveYearFeatures = core.buildWeeklyFeatures(fiveYearRows);
  const fiveYear = core.historicalPosition(fiveYearFeatures, fiveYearRows);
  assert.equal(fiveYear.available, true);
  assert.equal(fiveYear.periodLabel, "最近五年");
  for (const key of ["lowPercentile", "jPercentile", "drawdownPercentile", "pricePositionPercentile"]) {
    assert.ok(Number.isFinite(fiveYear[key]) && fiveYear[key] >= 0 && fiveYear[key] <= 100);
  }

  const youngRows = tradingRows(650, "2024-01-02");
  const youngFeatures = core.buildWeeklyFeatures(youngRows);
  const young = core.historicalPosition(youngFeatures, youngRows);
  assert.equal(young.available, true);
  assert.match(young.periodLabel, /^上市以來/);
});

check("上市不足一年不硬算百分位", () => {
  const rows = tradingRows(180, "2026-01-02");
  const result = core.historicalPosition(core.buildWeeklyFeatures(rows), rows);
  assert.equal(result.available, false);
  assert.equal(result.label, "歷史樣本不足");
});

check("相似訊號固定條件、20日冷卻且僅選當日前訊號", () => {
  const rows = tradingRows(680, "2023-01-02", index => 80 + index * 0.05);
  const base = {
    j: -5,
    direction: "回升",
    above60: true,
    above200: true,
    fromHigh: -12,
    strategyType: "equity"
  };
  const candidates = [];
  for (let dailyIndex = 220, sequence = 0; dailyIndex <= 520; dailyIndex += 25, sequence += 1) {
    candidates.push({
      ...base,
      date: rows[dailyIndex].date,
      dailyIndex,
      environment: sequence % 2 ? "築底回升" : "多頭回檔"
    });
  }
  const current = {...base, date: rows[670].date, dailyIndex: 670, environment: "多頭回檔"};
  const features = [...candidates, current];
  const same = core.calculateSimilarStats(rows, features, current, {requireEnvironment: true});
  const all = core.calculateSimilarStats(rows, features, current, {requireEnvironment: false});
  assert.equal(all.cooldownDays, 20);
  assert.ok(all.sampleCount >= 10);
  assert.ok(same.sampleCount < all.sampleCount);
  assert.equal(same.sampleWarning, "樣本數偏少，參考性有限");
  assert.deepEqual(all.horizons, [20, 60, 120]);
  for (let index = 1; index < all.signalIndexes.length; index++) {
    assert.ok(all.signalIndexes[index] - all.signalIndexes[index - 1] >= 20);
  }
  assert.ok(all.signalIndexes.every(index => index < current.dailyIndex));
  for (const horizon of all.horizons) {
    assert.equal(all.byHorizon[horizon].positiveRate, 100);
    assert.ok(all.byHorizon[horizon].medianReturn > 0);
  }
  assert.ok(all.medianAdverseExcursion <= 0);
  assert.ok(all.worstAdverseExcursion <= all.medianAdverseExcursion);
});

check("當日指標不會因後續價格改變而產生前視偏誤", () => {
  const rows = tradingRows(420, "2024-01-02", index => 100 + Math.sin(index / 12) * 4 + index * 0.02);
  const cutoff = 300;
  const prefixFeatures = core.buildWeeklyFeatures(rows.slice(0, cutoff));
  const target = prefixFeatures.at(-2);
  const manipulated = rows.map((row, index) => index < cutoff ? row : {
    ...row,
    open: row.open * 8,
    max: row.max * 8,
    min: row.min * 8,
    close: row.close * 8,
    Trading_Volume: row.Trading_Volume * 20
  });
  const extendedTarget = core.buildWeeklyFeatures(manipulated).find(feature => feature.date === target.date);
  for (const key of ["k", "d", "j", "ma60", "ma200", "fromHigh", "volatility", "environment"]) {
    assert.equal(extendedTarget[key], target[key]);
  }
  assert.equal(extendedTarget.stop.score, target.stop.score);
});

check("止跌確認由七項條件組成且限制於 0 到 100", () => {
  const rows = tradingRows(330, "2025-01-02", index => 120 - index * 0.04 + Math.max(0, index - 300) * 0.25);
  const current = core.buildWeeklyFeatures(rows).at(-1);
  assert.equal(current.stop.components.length, 7);
  assert.equal(current.stop.components.reduce((sum, item) => sum + item.maximum, 0), 100);
  assert.equal(current.stop.components.reduce((sum, item) => sum + item.points, 0), current.stop.score);
  assert.ok(current.stop.score >= 0 && current.stop.score <= 100);
  assert.equal(core.stopLabel(29), "仍在下探");
  assert.equal(core.stopLabel(49), "尚未確認");
  assert.equal(core.stopLabel(69), "初步止跌");
  assert.equal(core.stopLabel(84), "止跌回升");
  assert.equal(core.stopLabel(100), "反轉確認較強");
});

check("市場環境分類涵蓋主要狀態", () => {
  assert.equal(core.classifyEnvironment({price: 80, ma60: 95, ma200: 100, fromHigh: -25, return20: -12, volatility: 45, stopScore: 20}), "恐慌急跌");
  assert.equal(core.classifyEnvironment({price: 95, ma60: 100, ma200: 110, fromHigh: -15, return20: 4, volatility: 20, stopScore: 70}), "築底回升");
  assert.equal(core.classifyEnvironment({price: 120, ma60: 118, ma200: 110, ma60Slope: 1, ma200Slope: 1, fromHigh: -8, return20: -2, volatility: 15, stopScore: 30}), "多頭回檔");
  assert.equal(core.classifyEnvironment({price: 90, ma60: 95, ma200: 100, fromHigh: -8, return20: 3, volatility: 15, stopScore: 30}), "空頭反彈");
});

check("買點階段綜合分數、方向、K/D、環境與風險", () => {
  assert.equal(core.buyStage({score: 25, j: 85, stopScore: 10, oversoldDegree: 10, environment: "高檔震盪"}).label, "過熱暫停");
  assert.equal(core.buyStage({score: 30, j: 40, stopScore: 20, direction: "下探", environment: "趨勢不明"}).label, "等待");
  assert.equal(core.buyStage({score: 52, j: 10, stopScore: 35, oversoldDegree: 80, direction: "下探", environment: "恐慌急跌"}).label, "接近買點");
  assert.equal(core.buyStage({score: 65, j: -2, stopScore: 60, direction: "回升", kdImproving: true, environment: "築底回升"}).label, "第一批觀察");
  assert.equal(core.buyStage({score: 80, j: -4, stopScore: 78, direction: "回升", kdImproving: true, environment: "多頭回檔", marketRisk: {key: "normal"}}).label, "分批布局");
});

check("槓桿 ETF 使用短週期統計與較低投入上限", () => {
  const rows = tradingRows(680);
  const base = {j: 0, direction: "回升", above60: true, above200: true, fromHigh: -10, strategyType: "leveraged", environment: "多頭回檔"};
  const features = [];
  for (let index = 220; index <= 570; index += 25) features.push({...base, date: rows[index].date, dailyIndex: index});
  const current = {...base, date: rows[670].date, dailyIndex: 670};
  features.push(current);
  const report = core.similarSignalReport(rows, features, current, "leveraged");
  assert.equal(report.model, "high_volatility_short_horizon");
  assert.deepEqual(report.allEnvironments.horizons, [10, 20, 40]);
  const inverseCurrent = {...current, strategyType: "inverse"};
  const inverseFeatures = features.slice(0, -1).map(item => ({...item, strategyType: "inverse"})).concat(inverseCurrent);
  const inverseReport = core.similarSignalReport(rows, inverseFeatures, inverseCurrent, "inverse");
  assert.equal(inverseReport.model, "high_volatility_short_horizon");
  assert.deepEqual(inverseReport.allEnvironments.horizons, [10, 20, 40]);
  const plan = core.installmentMap("balanced", true);
  assert.equal(plan.leveragedCap, 50);
  assert.equal(plan.steps.reduce((sum, step) => sum + step.ratio, 0), 50);
});

check("核心輸出不含非有限數字或保證字眼", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "buy-point-core.js"), "utf8");
  assert.doesNotMatch(source, /必買|穩賺|保證上漲|最低點|未來勝率|保證勝率/);
  for (const value of [core.percentileRank([], 1), core.median([])]) assert.equal(value, null);
  assert.doesNotMatch(JSON.stringify(core.installmentMap("balanced", false)), /NaN|undefined|Infinity/);
});
