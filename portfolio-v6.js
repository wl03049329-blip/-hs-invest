(function () {
  "use strict";

  const core = window.HSPortfolioCore;
  const performanceCore = window.HSPortfolioPerformanceCore;
  const ledgerCore = window.HSPortfolioLedgerCore;
  if (!core || !performanceCore || !ledgerCore) return;

  const storageKeys = window.HSPersistenceCore?.keys || {};
  const HOLDINGS_KEY = storageKeys.holdings || "hsRadar.portfolio.holdings";
  const QUOTES_KEY = storageKeys.quotes || "hsRadar.portfolio.quotes";
  const AUTO_KEY = storageKeys.portfolioAuto || "hsRadar.portfolio.autoRefresh";
  const MARKET_VERSION_KEY = storageKeys.portfolioMarketVersion || "hsRadar.portfolio.marketVersion";
  const REBALANCE_SETTINGS_KEY = storageKeys.portfolioRebalanceSettings || "hsRadar.portfolio.rebalanceSettings";
  const TWSE_URL = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL";
  const TPEX_URL = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes";
  const MARKET_CACHE_URL = "market-quotes.json";
  const MARKET_META_URL = "market-quotes-meta.json";
  const BENCHMARK_URL = "backtest/long-term/historical-adjusted.json";
  const COLORS = ["#52e38c", "#72b8ff", "#ff9d42", "#bd72ff", "#ff6674", "#ffd84d", "#42d7d1", "#d9a7ff"];
  const $v6 = selector => document.querySelector(selector);
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[char]));

  let holdings = loadHoldings();
  let quoteMap = loadQuoteCache();
  let publicQuoteMap = new Map();
  let computed = core.calculatePortfolio(holdings, quoteMap, {now: Date.now()});
  let pendingDuplicate = null;
  let editingCode = null;
  let catalog = [];
  let catalogLoading = null;
  let refreshTimer = null;
  let refreshInFlight = null;
  let lastAttemptAt = 0;
  let lastSuccessAt = latestCachedFetchTime();
  let failureCount = 0;
  let pendingManualPortfolioApply = false;
  let marketCacheVersion = localStorage.getItem(MARKET_VERSION_KEY) || "";
  let chartSegments = [];
  let chartSelection = -1;
  let resizeFrame = 0;
  let rebalanceSettings = loadRebalanceSettings();
  let latestRebalanceAdvice = null;
  let portfolioHistoryInvalidCount = 0;
  let portfolioHistory = loadPortfolioHistory();
  let benchmarkRows = [];
  let performancePeriod = "1M";
  let ledger = loadLedger();
  let ledgerState = ledger ? ledgerCore.derivePortfolioStateFromLedger(ledger.events) : null;
  let ledgerFilter = "ALL";
  let editingLedgerEventId = null;

  function loadPortfolioHistory() {
    try {
      const parsed = JSON.parse(localStorage.getItem(performanceCore.STORAGE_KEY) || "[]");
      const source = Array.isArray(parsed) ? parsed : [];
      const validated = source.map(performanceCore.validateSnapshot);
      portfolioHistoryInvalidCount = validated.filter(row => !row).length;
      return validated.filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));
    } catch { portfolioHistoryInvalidCount = 1; return []; }
  }

  function savePortfolioHistory() {
    localStorage.setItem(performanceCore.STORAGE_KEY, JSON.stringify(portfolioHistory));
  }

  function loadRebalanceSettings() {
    const fallback = {cash: 0, profile: "trend", customTolerance: 3, reminder: "90", customDays: 60, cashFirst: true, trendProtection: true};
    try {
      const raw = JSON.parse(localStorage.getItem(REBALANCE_SETTINGS_KEY) || "null");
      if (!raw || typeof raw !== "object") return fallback;
      const cash = Number(raw.cash), customTolerance = Number(raw.customTolerance), customDays = Number(raw.customDays);
      return {
        cash: Number.isFinite(cash) && cash >= 0 ? cash : 0,
        profile: ["conservative", "balanced", "trend", "custom"].includes(raw.profile) ? raw.profile : "trend",
        customTolerance: Number.isFinite(customTolerance) && customTolerance > 0 && customTolerance <= 20 ? customTolerance : 3,
        reminder: ["30", "90", "custom"].includes(String(raw.reminder)) ? String(raw.reminder) : "90",
        customDays: Number.isFinite(customDays) && customDays >= 7 && customDays <= 365 ? Math.round(customDays) : 60,
        cashFirst: raw.cashFirst !== false,
        trendProtection: raw.trendProtection !== false
      };
    } catch { return fallback; }
  }

  function saveRebalanceSettings() {
    localStorage.setItem(REBALANCE_SETTINGS_KEY, JSON.stringify(rebalanceSettings));
  }

  function loadHoldings() {
    try {
      const parsed = JSON.parse(localStorage.getItem(HOLDINGS_KEY) || "[]");
      return core.validateImportPayload(parsed);
    } catch {
      return [];
    }
  }

  function saveHoldings() {
    localStorage.setItem(HOLDINGS_KEY, JSON.stringify(holdings));
  }

  function loadLedger() {
    try { return ledgerCore.validateLedger(JSON.parse(localStorage.getItem(ledgerCore.STORAGE_KEY) || "null")); }
    catch { return null; }
  }

  function metadataForSymbol(code) { return holdings.find(item => item.code === code) || {}; }

  function syncDerivedPortfolio() {
    if (!ledger) return;
    ledgerState = ledgerCore.derivePortfolioStateFromLedger(ledger.events);
    if (!ledgerState.valid) return;
    const previous = new Map(holdings.map(item => [item.code, item]));
    holdings = ledgerState.holdings.map(row => {
      const meta = previous.get(row.symbol) || {};
      return core.validateHolding({code: row.symbol, shares: row.quantity, averageCost: row.averageCost, customName: meta.customName || "", name: meta.name || "", strategyType: meta.strategyType || "", targetAllocation: meta.targetAllocation});
    });
    rebalanceSettings = {...rebalanceSettings, cash: ledgerState.cash};
    saveHoldings(); saveRebalanceSettings();
  }

  function applyLedgerUiMode() {
    const active=Boolean(ledger),add=$v6("#portfolioAddBtn"),cash=$v6("#rebalanceCash"),planCash=$v6("#capitalPlanCash");
    if(add){add.textContent=active?"＋ 新增交易":"＋ 新增持股";add.setAttribute("aria-label",active?"新增交易":"新增持股")}
    if(cash)cash.disabled=active;if(planCash)planCash.disabled=active;
  }

  function persistLedger(nextLedger) {
    const valid = ledgerCore.validateLedger(nextLedger);
    if (!valid) throw new Error("交易帳本驗證失敗，未儲存任何變更。");
    localStorage.setItem(ledgerCore.STORAGE_KEY, JSON.stringify(valid));
    ledger = valid; syncDerivedPortfolio(); applyLedgerUiMode();
  }

  if (ledger) syncDerivedPortfolio();

  function loadQuoteCache() {
    try {
      const parsed = JSON.parse(localStorage.getItem(QUOTES_KEY) || "{}");
      const map = new Map();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return map;
      for (const [rawCode, quote] of Object.entries(parsed)) {
        const code = core.normalizeCode(rawCode);
        const price = Number(quote?.price);
        const previousClose = Number(quote?.previousClose);
        if (!core.CODE_PATTERN.test(code) || !Number.isFinite(price) || price <= 0) continue;
        map.set(code, {
          price,
          previousClose: Number.isFinite(previousClose) && previousClose > 0 ? previousClose : null,
          name: core.sanitizeName(quote.name),
          date: String(quote.date || ""),
          fetchedAt: String(quote.fetchedAt || ""),
          market: quote.market === "TPEx" ? "TPEx" : "TWSE",
          quoteMode: quote.quoteMode === "delayed" ? "delayed" : "close",
          quoteTime: String(quote.quoteTime || ""),
          stale: quote.stale === true,
          fallback: quote.fallback === true,
          staleReason: String(quote.staleReason || ""),
          sourceUpdatedAt: String(quote.sourceUpdatedAt || "")
        });
      }
      return map;
    } catch {
      return new Map();
    }
  }

  function saveQuoteCache() {
    const codes = new Set(holdings.map(item => item.code));
    const output = {};
    for (const [code, quote] of quoteMap) {
      if (codes.has(code)) output[code] = quote;
    }
    localStorage.setItem(QUOTES_KEY, JSON.stringify(output));
  }

  function latestCachedFetchTime() {
    let latest = 0;
    for (const quote of quoteMap.values()) {
      const time = Date.parse(quote.fetchedAt);
      if (Number.isFinite(time)) latest = Math.max(latest, time);
    }
    return latest;
  }

  function money(value) {
    if (!Number.isFinite(value)) return "資料更新中";
    return new Intl.NumberFormat("zh-TW", {style: "currency", currency: "TWD", maximumFractionDigits: 0}).format(value);
  }

  function number(value, digits = 2) {
    if (!Number.isFinite(value)) return "—";
    return new Intl.NumberFormat("zh-TW", {maximumFractionDigits: digits}).format(value);
  }

  function percent(value) {
    if (!Number.isFinite(value)) return "—";
    const sign = value > 0 ? "+" : "";
    return `${sign}${number(value, 2)}%`;
  }

  function plainPercent(value) {
    if (!Number.isFinite(value)) return "—";
    return `${number(value, 1)}%`;
  }

  function point(value) {
    if (!Number.isFinite(value)) return "—";
    const sign = value > 0 ? "+" : "";
    return `${sign}${number(value, 1)}pt`;
  }

  function valueClass(value) {
    if (!Number.isFinite(value) || value === 0) return "twFlat";
    return value > 0 ? "twUp" : "twDown";
  }

  function quoteTimeLabel() {
    if (!lastSuccessAt) return "尚未成功更新";
    return `最後成功更新 ${new Intl.DateTimeFormat("zh-TW", {
      timeZone: "Asia/Taipei", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    }).format(new Date(lastSuccessAt))}`;
  }

  function portfolioFreshnessLabel() {
    if (!holdings.length) return "尚未新增持股";
    const current = computed.rows.filter(row => row.quoteStatus === "current").length;
    const stale = computed.rows.filter(row => row.quoteStatus === "stale").length;
    const missing = holdings.length - current - stale;
    const parts = [];
    if (current) parts.push(`${current} 檔最新`);
    if (stale) parts.push(`${stale} 檔最後有效資料`);
    if (missing) parts.push(`${missing} 檔行情暫缺`);
    return `持股行情：${parts.join("、") || "行情暫缺"}`;
  }

  function taipeiToday() {
    return new Intl.DateTimeFormat("en-CA", {timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit"}).format(new Date());
  }

  function marketModeText() {
    return core.isTaipeiMarketOpen() ? "盤中動態延遲｜來源時間為準" : "收盤資料模式";
  }

  function renderQuoteStatus(message) {
    $v6("#portfolioMarketMode").textContent = marketModeText();
    $v6("#portfolioQuoteStatus").textContent = `${message || quoteTimeLabel()}｜${portfolioFreshnessLabel()}`;
  }

  function renderSummary() {
    const element = $v6("#portfolioSummary");
    const heroValue = $v6("#portfolioHeroMarketValue");
    const holdingCount = $v6("#portfolioHoldingCount");
    const currentRows = computed.rows.filter(row => row.quoteStatus === "current" && Number.isFinite(row.marketValue));
    const marketReady = holdings.length > 0 && currentRows.length === holdings.length;
    const marketValue = marketReady ? currentRows.reduce((sum, row) => sum + row.marketValue, 0) : null;
    const pnlReady = marketReady && currentRows.every(row => Number.isFinite(row.totalPnl));
    const totalPnl = pnlReady ? currentRows.reduce((sum, row) => sum + row.totalPnl, 0) : null;
    const totalCost = pnlReady ? currentRows.reduce((sum, row) => sum + row.totalCost, 0) : null;
    const returnRate = pnlReady && totalCost > 0 ? totalPnl / totalCost * 100 : null;
    let cashConfigured = false;
    try {
      const stored = JSON.parse(localStorage.getItem(REBALANCE_SETTINGS_KEY) || "null");
      cashConfigured = Boolean(stored && Object.prototype.hasOwnProperty.call(stored, "cash"));
    } catch {}
    holdingCount.textContent = holdings.length ? `持有 ${holdings.length} 檔` : "尚未建立持股";
    heroValue.textContent = Number.isFinite(marketValue) ? money(marketValue) : holdings.length ? "行情資料暫缺" : "—";
    if (!holdings.length) {
      element.innerHTML = [
        ["今日損益", "—", "尚無持股"],
        ["未實現損益", "—", "尚無持股"],
        ["可投入現金", cashConfigured ? money(rebalanceSettings.cash) : "尚未設定", "可於智慧再平衡設定"]
      ].map(([label, value, note]) => `<article class="summaryCard"><span>${label}</span><b class="dataPending">${value}</b><small>${note}</small></article>`).join("");
      return;
    }
    const todayValue = computed.complete ? money(computed.todayPnl) : "—";
    const todayNote = computed.complete ? `今日報酬率 ${percent(computed.todayRate)}` : "尚無可靠盤中損益資料";
    const totalValue = Number.isFinite(totalPnl) ? money(totalPnl) : "—";
    const totalNote = Number.isFinite(returnRate) ? `總報酬率 ${percent(returnRate)}` : "缺少價格不會誤算為 0";
    element.innerHTML = `
      <article class="summaryCard"><span>今日損益</span><b class="${valueClass(computed.todayPnl)}">${todayValue}</b><small class="${valueClass(computed.todayRate)}">${todayNote}</small></article>
      <article class="summaryCard"><span>未實現損益</span><b class="${valueClass(totalPnl)}">${totalValue}</b><small class="${valueClass(returnRate)}">${totalNote}</small></article>
      ${ledgerState?.valid ? `<article class="summaryCard"><span>已實現損益</span><b class="${valueClass(ledgerState.realizedPnL)}">${money(ledgerState.realizedPnL)}</b><small>股息收入 ${money(ledgerState.dividendIncome)}</small></article>` : ""}
      <article class="summaryCard"><span>可投入現金</span><b>${cashConfigured ? money(rebalanceSettings.cash) : "尚未設定"}</b><small>可於智慧再平衡設定</small></article>`;
  }

  function holdingName(row) {
    return row.customName || row.quote?.name || row.name || row.code;
  }

  function radarFor(code) {
    try {
      const item = Array.isArray(all) ? all.find(entry => entry.id === code) : null;
      if (!item) return null;
      const score = Number(item.formalScore ?? item.strategyDecisions?.long_term_core?.score ?? item.score);
      const classification = Number.isFinite(score) ? window.HSFinalCoreProduction?.labelFor?.(score) : null;
      return {score: Number.isFinite(score) ? score : null, coreLabel: classification?.label || item.strategyDecisions?.long_term_core?.label || "正式訊號暫缺", trend: item.trend?.label || "趨勢資料暫缺", action: item.action || "買點資料暫缺", strategyType: item.activeStrategyMode || "", swing: item.swingDecision || null};
    } catch {
      return null;
    }
  }

  function lossNote(row) {
    if (!Number.isFinite(row.returnRate) || row.returnRate >= 0) return "";
    return `目前低於平均成本 ${number(Math.abs(row.returnRate), 1)}%，請搭配趨勢與資金配置評估。`;
  }

  function sortedRows() {
    const mode = $v6("#portfolioSort").value;
    const rows = computed.rows.map(row => ({...row, coreScore: radarFor(row.code)?.score ?? null}));
    return core.sortPortfolioRows(rows, mode);
  }

  function renderPortfolioDecisionSupport() {
    const targetState = core.validateTargetAllocations(holdings);
    const health = targetState.complete ? core.allocationHealthScore(computed.rows) : null;
    const healthElement = $v6("#portfolioAllocationHealth");
    const healthLabel = $v6("#portfolioAllocationHealthLabel");
    healthElement.textContent = Number.isFinite(health) ? String(health) : "—";
    healthLabel.textContent = Number.isFinite(health) ? health >= 90 ? "接近目標" : health >= 75 ? "輕度偏離" : "需要檢視" : "等待完整目標配置";
    const attentionRows = computed.rows.map(row => {
      const radar = radarFor(row.code);
      return {...row, name: holdingName(row), coreScore: radar?.score ?? null, coreLabel: radar?.coreLabel || ""};
    });
    const attention = core.buildPortfolioAttention(attentionRows);
    const output = $v6("#portfolioAttentionList");
    if (!holdings.length) {
      output.innerHTML = '<div class="portfolioAttentionEmpty"><b>尚未建立個人持股</b><span>新增持股後，系統會整理配置與正式 HS 訊號。</span></div>';
      return;
    }
    if (!attention.length) {
      output.innerHTML = '<div class="portfolioAttentionEmpty is-clear"><b>✓ 目前沒有需要特別注意的持股</b><span>配置與 HS 訊號目前沒有明顯異常。</span></div>';
      return;
    }
    output.innerHTML = attention.map(item => {
      const allocationText = item.allocationState === "under" ? `配置低於目標 ${number(Math.abs(item.gap), 1)}pt` : item.allocationState === "over" ? `配置高於目標 ${number(item.gap, 1)}pt` : "";
      const scoreText = Number.isFinite(item.coreScore) ? `HS ${number(item.coreScore, 0)}｜${escapeHtml(item.coreLabel)}` : "";
      return `<article class="portfolioAttentionItem priority-${item.priority}"><div><b>${escapeHtml(item.code)}</b><span>${escapeHtml(item.name || item.code)}</span></div><p>${[allocationText, scoreText].filter(Boolean).join("<br>")}</p></article>`;
    }).join("");
  }

  function renderList() {
    const list = $v6("#portfolioList");
    if (!holdings.length) {
      list.innerHTML = '<div class="portfolioEmpty"><b>尚未建立個人持股</b><span>新增持股後，HS 將自動整理總市值、損益、配置、目標比例與 Core Score 狀態。</span><button class="btn" type="button" data-portfolio-empty-add>＋ 新增第一筆持股</button></div>';
      list.querySelector("[data-portfolio-empty-add]")?.addEventListener("click", () => openPortfolioModal());
      return;
    }
    list.innerHTML = sortedRows().map(row => {
      const radar = radarFor(row.code);
      const quoteMissing = !row.quote;
      const quoteStale = row.quoteStatus === "stale";
      const quoteState = quoteMissing ? "行情暫缺" : quoteStale ? "最後有效資料" : "最新行情";
      const name = holdingName(row);
      const radarHtml = radar
        ? `<span class="radarPill">HS ${radar.score === null ? "—" : number(radar.score, 0)}</span><b>${escapeHtml(radar.coreLabel)}</b><span>正式 Core Score</span>`
        : '<span class="radarPill">HS —</span><span>正式 Core Score 暫缺</span>';
      const tradeLabel = radar?.strategyType === "swing00733" ? "00733 強勢趨勢拉回" : radar?.strategyType === "swing006201" ? "006201 上櫃低檔轉折" : "";
      const trendProtected = radar?.swing?.strategyType === "swing00733" && radar.swing.stage?.number >= 3;
      const rebalance = core.rebalanceDecision({actualWeight: row.weight, targetAllocation: row.targetAllocation, trendProtected});
      const trade = tradeLabel ? window.HSPersistenceCore?.loadTradeState?.(row.code) : null;
      const peakProfit = trade?.entryPrice > 0 && trade?.peakPrice > 0 ? (trade.peakPrice / trade.entryPrice - 1) * 100 : null;
      const allocationGap = Number.isFinite(row.weight) && Number.isFinite(row.targetAllocation) ? row.weight - row.targetAllocation : null;
      const allocationState = !Number.isFinite(allocationGap) ? "尚未設定目標" : Math.abs(allocationGap) <= 1 ? "接近目標" : allocationGap > 0 ? `高於目標 ${number(allocationGap, 1)}pt` : `低於目標 ${number(Math.abs(allocationGap), 1)}pt`;
      return `<article class="holdingCard${quoteStale ? " holdingQuoteStale" : ""}" data-holding-code="${escapeHtml(row.code)}">
        <header class="holdingCardHead"><div class="holdingIdentity"><b>${escapeHtml(row.code)}</b><span>${escapeHtml(name)}</span></div><div class="holdingDayMove"><span>今日漲跌</span><b class="${valueClass(row.changeRate)}">${quoteMissing || quoteStale ? "—" : percent(row.changeRate)}</b></div></header>
        <div class="holdingMarketValue"><span>市值</span><b>${Number.isFinite(row.marketValue) ? money(row.marketValue) : "行情暫缺"}</b><small>${quoteStale ? "最後有效資料" : quoteMissing ? "尚無價格" : "目前部位價值"}</small></div>
        <div class="holdingAllocationRow"><span>配置 <b>${plainPercent(row.weight)}</b></span><span>目標 <b>${Number.isFinite(row.targetAllocation) ? plainPercent(row.targetAllocation) : "未設定"}</b></span><span class="holdingAllocationGap">偏差 <b>${point(allocationGap)}</b><small>${allocationState}</small></span></div>
        <div class="holdingPositionRow"><span>均價 <b>${money(row.averageCost)}</b></span><span>現價 <b>${quoteMissing ? "行情暫缺" : money(row.quote.price)}</b></span><span>未實現損益 <b class="${valueClass(row.returnRate)}">${percent(row.returnRate)}</b></span></div>
        <footer class="holdingCardFooter"><div class="holdingRadar">${radarHtml}</div><div class="holdingActions"><button type="button" data-edit-holding="${escapeHtml(row.code)}" aria-label="修改 ${escapeHtml(row.code)} 持股">修改</button><button type="button" data-delete-holding="${escapeHtml(row.code)}" aria-label="刪除 ${escapeHtml(row.code)} 持股">刪除</button></div></footer>
        <details class="holdingDetails">
          <summary>展開股數、成本、市值與占比</summary>
          <div class="holdingRadar">${radarHtml}</div>
          <div class="holdingDetailsGrid">
            <div><span>股數</span><b>${number(row.shares, 4)}</b></div>
            <div><span>平均成本</span><b>${money(row.averageCost)}</b></div>
            <div><span>總成本</span><b>${money(row.totalCost)}</b></div>
            <div><span>目前股價</span><b>${quoteMissing ? "行情暫缺" : `${money(row.quote.price)}${quoteStale ? "（最後有效）" : ""}`}</b></div>
            <div><span>目前市值</span><b>${quoteMissing ? `${money(row.allocationValue)}（成本暫估）` : `${money(row.marketValue)}${quoteStale ? "（最後有效）" : ""}`}</b></div>
            <div><span>市值占比</span><b>${plainPercent(row.weight)}</b></div>
            <div><span>累積報酬率</span><b class="${valueClass(row.returnRate)}">${percent(row.returnRate)}</b></div>
            <div><span>行情狀態</span><b>${escapeHtml(quoteState)}</b></div>
            <div><span>行情時間</span><b>${escapeHtml(row.quote?.asOf || row.quote?.date || "行情暫缺")}</b></div>
            <div><span>策略類型</span><b>${escapeHtml(tradeLabel || row.strategyType || "使用預設模型")}</b></div>
            <div><span>目標配置</span><b>${Number.isFinite(row.targetAllocation) ? percent(row.targetAllocation) : "未設定"}</b></div>
            ${tradeLabel ? `<div><span>Trade ID</span><b>${escapeHtml(trade?.tradeId || "尚未建立")}</b></div>
            <div><span>Trade Mode／Stage</span><b>${escapeHtml(trade?.state || "CLOSED")}／${radar?.swing?.stage?.number ?? 0}</b></div>
            <div><span>策略部位</span><b>${Number.isFinite(trade?.position) ? percent(trade.position) : "0%"}</b></div>
            <div><span>買點／出場壓力</span><b>${Number.isFinite(radar?.swing?.buyScore) ? radar.swing.buyScore : "—"}／${Number.isFinite(radar?.swing?.exitPressure?.score) ? radar.swing.exitPressure.score : "—"}</b></div>
            <div><span>最高浮盈／持有日</span><b>${Number.isFinite(peakProfit) ? percent(peakProfit) : "—"}／${Number(trade?.holdingDays)||0}</b></div>
            <div><span>冷卻狀態</span><b>${Number(trade?.cooldownRemaining)>0 ? `${trade.cooldownRemaining} 交易日` : "無"}</b></div>` : ""}
          </div>
          <p class="holdingNote">${escapeHtml(rebalance.label)}</p>
          ${lossNote(row) ? `<p class="holdingNote">${escapeHtml(lossNote(row))}</p>` : ""}
        </details>
      </article>`;
    }).join("");
    list.querySelectorAll("[data-edit-holding]").forEach(button => button.addEventListener("click", () => ledger ? openLedger() : openPortfolioModal(button.dataset.editHolding)));
    list.querySelectorAll("[data-delete-holding]").forEach(button => button.addEventListener("click", () => ledger ? openLedger() : deleteHolding(button.dataset.deleteHolding)));
  }

  function rebalanceTrend(row) {
    const radar = radarFor(row.code);
    const label = `${radar?.trend || ""} ${radar?.action || ""}`;
    if (radar?.swing?.stage?.number >= 3 || /強勢|多頭|轉強|回升|突破/.test(label)) return "strong";
    if (/偏弱|空頭|轉弱|破底|下跌/.test(label)) return "weak";
    return "neutral";
  }

  function targetTotalMessage(total, complete) {
    if (Math.abs(total - 100) <= .01 && complete) return {text: `目標配置目前合計 ${number(total, 1)}%｜正常`, className: "valid"};
    if (Math.abs(total - 100) <= .01) return {text: `目標配置目前合計 ${number(total, 1)}%｜尚有持股未設定`, className: ""};
    if (total < 100) return {text: `目標配置目前合計 ${number(total, 1)}%｜尚有 ${number(100 - total, 1)}% 未配置`, className: ""};
    return {text: `目標配置目前合計 ${number(total, 1)}%｜超額配置 ${number(total - 100, 1)}%`, className: "invalid"};
  }

  function recommendationText(adviceRow) {
    if (!adviceRow) return {label: "請先完成目標配置", amount: "", detail: "目標合計 100% 後才產生正式建議"};
    if (adviceRow.suggestedAmount > 0) return {label: "建議買入", amount: money(adviceRow.suggestedAmount), detail: adviceRow.action};
    if (adviceRow.suggestedAmount < 0) return {label: "部分調整", amount: money(Math.abs(adviceRow.suggestedAmount)), detail: adviceRow.action};
    if (/暫停/.test(adviceRow.action)) return {label: "暫停加碼", amount: "", detail: adviceRow.action};
    if (adviceRow.level === "配置正常") return {label: "維持", amount: "", detail: adviceRow.action};
    return {label: "先觀察", amount: "", detail: adviceRow.action};
  }

  function renderRebalance(focusTarget = "") {
    const status = $v6("#rebalanceStatus"), output = $v6("#rebalanceAdvice"), targetRows = $v6("#rebalanceTargetRows");
    if (!status || !output || !targetRows) return;
    const advice = core.calculateRebalanceAdvice({
      rows: computed.rows.map(row => ({code: row.code, marketValue: row.allocationValue, targetAllocation: row.targetAllocation, trend: rebalanceTrend(row)})),
      ...rebalanceSettings
    });
    latestRebalanceAdvice = advice;
    const allocationState = core.validateTargetAllocations(holdings);
    const total = allocationState.total;
    const totalMessage = targetTotalMessage(total, allocationState.complete);
    const cash = Number.isFinite(rebalanceSettings.cash) && rebalanceSettings.cash >= 0 ? rebalanceSettings.cash : 0;
    const allocationTotal = Number.isFinite(computed.allocationTotal) ? computed.allocationTotal : 0;
    const estimated = Boolean(computed.allocationEstimated);
    const totalAssets = allocationTotal + cash;
    $v6("#rebalanceTotalAssets").textContent = holdings.length ? money(totalAssets) : "—";
    $v6("#rebalanceValueMode").textContent = holdings.length ? (estimated ? "依成本暫估" : "依目前市值") : "等待持股資料";
    $v6("#rebalanceCashSummary").textContent = money(cash);
    $v6("#rebalanceEstimateNote").hidden = !estimated || !holdings.length;
    $v6("#rebalanceTargetTotal").textContent = totalMessage.text;
    $v6("#rebalanceTargetTotal").className = `rebalanceTargetTotal ${totalMessage.className}`.trim();
    const currentDeviations = computed.rows.map(row => Number.isFinite(row.targetAllocation) && Number.isFinite(row.weight) ? Math.abs(row.weight - row.targetAllocation) : null).filter(Number.isFinite);
    const meanDeviation = currentDeviations.length ? currentDeviations.reduce((sum, value) => sum + value, 0) / currentDeviations.length : null;
    if (advice.formal) {
      const healthLabel = advice.health >= 80 ? "良好" : advice.health >= 60 ? "普通" : "偏離較大";
      $v6("#rebalanceHealth").textContent = advice.health;
      $v6("#rebalanceHealthLabel").textContent = healthLabel;
      $v6("#rebalanceDeviationValue").textContent = Number.isFinite(meanDeviation) ? `${number(meanDeviation, 1)}%` : "—";
      $v6("#rebalanceDeviation").textContent = "目前配置與目標配置平均偏離";
      status.innerHTML = `<b>${escapeHtml(advice.level)}</b><span>${escapeHtml(advice.profileLabel)}容忍區間｜目標合計 100%${estimated ? "｜暫估" : ""}</span>`;
    } else {
      $v6("#rebalanceHealth").textContent = "待完成";
      $v6("#rebalanceHealthLabel").textContent = "等待完整目標配置";
      $v6("#rebalanceDeviationValue").textContent = Number.isFinite(meanDeviation) ? `${number(meanDeviation, 1)}%` : "—";
      $v6("#rebalanceDeviation").textContent = "目前配置與目標配置平均偏離";
      if (advice.status === "target_over") status.textContent = `超額配置 ${number(Math.abs(advice.gap), 1)}%；表格保留，但暫不產生正式建議。`;
      else if (advice.status === "target_incomplete") status.textContent = Math.abs(advice.gap) <= .01 ? "尚有持股未設定目標；表格保留，但暫不產生正式建議。" : `尚有 ${number(Math.max(0, advice.gap), 1)}% 未配置；表格保留，但暫不產生正式建議。`;
      else status.textContent = holdings.length ? "目前依可用持股價值暫估配置。" : "新增持股並設定每檔目標配置後，即可產生建議。";
    }

    const readout = core.buildRebalanceReadout({rows: computed.rows, advice});
    const readoutByCode = new Map(readout.items.map(item => [item.code, item]));
    $v6("#rebalanceRecommendation").textContent = readout.recommendation;
    $v6("#rebalanceFundingMode").textContent = readout.fundingMode;
    $v6("#rebalanceFundingPriority").textContent = readout.fundingPriority.length ? readout.fundingPriority.slice(0, 5).map(item => item.code).join(" → ") : advice.formal ? "目前無明顯低配部位" : "完成目標配置後顯示";
    targetRows.innerHTML = computed.rows.length ? computed.rows.map(row => {
      const item = readoutByCode.get(row.code);
      const stateClass = item ? `is-${item.state}` : "is-pending";
      const gapText = item ? `${item.allocationGap > 0 ? "+" : ""}${number(item.allocationGap, 1)}%` : "—";
      return `<label class="rebalanceTargetRow ${stateClass}"><span class="rebalanceTargetIdentity"><b>${escapeHtml(row.code)}</b><span>${escapeHtml(holdingName(row))}</span></span><span class="rebalanceTargetCompare"><small>目前 ${item ? `${number(item.currentWeight, 1)}%` : "—"}</small><span>→</span><span class="rebalanceTargetInput"><small>目標</small><input type="number" min="0" max="100" step="0.1" inputmode="decimal" value="${Number.isFinite(row.targetAllocation) ? row.targetAllocation : ""}" data-rebalance-target="${escapeHtml(row.code)}" aria-label="${escapeHtml(row.code)} 目標配置">%</span></span><span class="rebalanceGapBadge ${stateClass}">${item ? `${item.stateLabel} ${gapText}` : "尚未設定"}</span></label>`;
    }).join("") : '<p class="rebalancePending">新增持股後即可設定目標配置。</p>';

    output.innerHTML = computed.rows.length ? computed.rows.map(row => {
      const adviceRow = advice.formal ? advice.rows.find(item => item.code === row.code) : null;
      const currentWeight = Number.isFinite(row.weight) ? row.weight : null;
      const difference = Number.isFinite(currentWeight) && Number.isFinite(row.targetAllocation) ? currentWeight - row.targetAllocation : null;
      const differenceClass = !Number.isFinite(difference) || Math.abs(difference) <= .1 ? "even" : difference > 0 ? "over" : "under";
      const recommendation = recommendationText(adviceRow);
      const tone = adviceRow?.level === "主動再平衡" ? "active" : adviceRow?.level === "配置正常" ? "normal" : "observe";
      return `<article class="rebalanceItem ${tone}" role="row"><div class="rebalanceItemIdentity" role="cell"><b>${escapeHtml(row.code)}</b><small>${escapeHtml(holdingName(row))}</small></div><div class="rebalanceItemMetric rebalanceMarketValue" role="cell"><span>持有市值</span><b>${Number.isFinite(row.allocationValue) ? money(row.allocationValue) : "—"}</b></div><div class="rebalanceItemMetric" role="cell"><span>目前</span><b>${percent(currentWeight)}</b></div><div class="rebalanceItemMetric" role="cell"><span>目標</span><b>${Number.isFinite(row.targetAllocation) ? percent(row.targetAllocation) : "未設定"}</b></div><div class="rebalanceItemMetric rebalanceDifference ${differenceClass}" role="cell"><span>偏離</span><b>${percent(difference)}</b></div><div class="rebalanceAction" role="cell"><span>建議</span><b>${escapeHtml(recommendation.label)}</b>${recommendation.amount ? `<strong>${escapeHtml(recommendation.amount)}</strong>` : ""}<small>${escapeHtml(recommendation.detail)}${estimated ? "｜暫估" : ""}</small></div></article>`;
    }).join("") : '<p class="rebalancePending">尚未新增持股。</p>';

    const suggestedTotal = advice.formal ? advice.rows.reduce((sum, row) => sum + Math.max(0, Number(row.suggestedAmount) || 0), 0) : 0;
    $v6("#rebalanceSuggestedTotal").textContent = advice.formal ? money(suggestedTotal) : "—";
    $v6("#rebalanceApplyBtn").disabled = !advice.formal;
    targetRows.querySelectorAll("[data-rebalance-target]").forEach(input => input.addEventListener("input", updateTargetAllocation));
    if (focusTarget) {
      const input = targetRows.querySelector(`[data-rebalance-target="${CSS.escape(focusTarget)}"]`);
      if (input) {
        input.focus({preventScroll: true});
      }
    }
  }

  function quoteTimestamp(quote) {
    const candidates = [quote?.asOf, quote?.fetchedAt, quote?.date && quote?.quoteTime ? `${quote.date}T${quote.quoteTime}+08:00` : ""];
    return candidates.map(value => ({value: String(value || ""), time: Date.parse(value)})).filter(item => Number.isFinite(item.time)).sort((a, b) => b.time - a.time)[0] || null;
  }

  function recordPortfolioSnapshot() {
    if (!holdings.length || computed.rows.length !== holdings.length) return "EMPTY_OR_INCOMPLETE";
    const currentRows = computed.rows.filter(row => row.quoteStatus === "current" && Number.isFinite(row.marketValue) && Number.isFinite(row.totalPnl));
    if (currentRows.length !== holdings.length) return "INVALID_OR_STALE_QUOTES";
    const dates = [...new Set(currentRows.map(row => String(row.quote?.date || "")))];
    const timestamps = currentRows.map(row => quoteTimestamp(row.quote));
    if (dates.length !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(dates[0]) || timestamps.some(item => !item)) return "MIXED_OR_INVALID_QUOTE_TIME";
    if (dates[0] !== taipeiToday()) return "NOT_CURRENT_TRADING_DATE";
    const totalMarketValue = currentRows.reduce((sum, row) => sum + row.marketValue, 0);
    const unrealizedPnL = currentRows.reduce((sum, row) => sum + row.totalPnl, 0);
    const snapshot = {
      date: dates[0],
      timestamp: new Date(Math.max(...timestamps.map(item => item.time))).toISOString(),
      totalMarketValue,
      cash: rebalanceSettings.cash,
      totalAssets: totalMarketValue + rebalanceSettings.cash,
      unrealizedPnL,
      ledgerVersion: ledger?.version || null,
      ledgerLastEventId: ledgerState?.lastEventId || null,
      portfolioSignature: ledger ? ledgerState?.holdings.map(row => `${row.symbol}:${row.quantity}`).join("|") : null,
      holdings: Object.fromEntries(currentRows.map(row => [row.code, {quantity: row.shares, marketPrice: row.quote.price, marketValue: row.marketValue}]))
    };
    const result = performanceCore.appendDailySnapshot(portfolioHistory, snapshot);
    portfolioHistory = result.history;
    if (result.changed) savePortfolioHistory();
    return result.status;
  }

  function displayDate(value) {
    const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match ? `${match[1]}/${match[2]}/${match[3]}` : "—";
  }

  function drawPerformanceChart(points, benchmarkVisible) {
    const canvas = $v6("#portfolioPerformanceChart"), ctx = canvas.getContext("2d"), wrap = canvas.parentElement;
    const width = Math.max(260, Math.round(wrap.clientWidth || 640)), height = matchMedia("(max-width:430px)").matches ? 190 : 220, ratio = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, width, height);
    if (!points.length) return;
    const pad = {left: 38, right: 14, top: 18, bottom: 25}, plotW = width - pad.left - pad.right, plotH = height - pad.top - pad.bottom;
    const values = points.flatMap(point => benchmarkVisible ? [point.portfolio, point.benchmark] : [point.portfolio]).filter(Number.isFinite), min = Math.min(...values), max = Math.max(...values), spread = Math.max(2, max - min), low = min - spread * .14, high = max + spread * .14;
    ctx.lineWidth = 1; ctx.font = "9px system-ui"; ctx.textAlign = "right"; ctx.fillStyle = "#756f65";
    for (let index = 0; index < 4; index += 1) { const y = pad.top + plotH * index / 3, label = high - (high - low) * index / 3; ctx.strokeStyle = "#262720"; ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke(); ctx.fillText(label.toFixed(0), pad.left - 6, y + 3); }
    const draw = (key, color) => { ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath(); points.forEach((point, index) => { const x = pad.left + plotW * (points.length === 1 ? 0 : index / (points.length - 1)), y = pad.top + (high - point[key]) / (high - low) * plotH; if (index) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.stroke(); };
    if (benchmarkVisible) draw("benchmark", "#7088a4"); draw("portfolio", "#dfbd63");
    ctx.textAlign = "left"; ctx.fillStyle = "#777168"; ctx.fillText(displayDate(points[0].date).slice(5), pad.left, height - 7); ctx.textAlign = "right"; ctx.fillText(displayDate(points.at(-1).date).slice(5), width - pad.right, height - 7);
  }

  function renderPerformance() {
    const rows = performanceCore.selectPeriod(portfolioHistory, performancePeriod), change = performanceCore.assetChange(rows), continuity = performanceCore.analyzePortfolioContinuity(rows, {tradingDates: benchmarkRows.map(row => row.date), invalidCount: portfolioHistoryInvalidCount}), rawComparison = performanceCore.alignBenchmark(rows, benchmarkRows), comparison = performanceCore.guardBenchmark(rawComparison, continuity), benchmarkVisible = $v6("#portfolioBenchmarkToggle").checked;
    const empty = $v6("#portfolioPerformanceEmpty"), metrics = $v6("#portfolioPerformanceMetrics"), coverage = $v6("#portfolioPerformanceCoverage"), integrity = $v6("#portfolioPerformanceIntegrity");
    $v6("#portfolioPerformancePeriods").querySelectorAll("[data-performance-period]").forEach(button => button.classList.toggle("active", button.dataset.performancePeriod === performancePeriod));
    if (rows.length < 2) {
      const firstDate = portfolioHistory[0]?.date;
      empty.innerHTML = `<b>績效紀錄將從現在開始累積</b><span>目前歷史資料尚不足，HS 不會以目前持股反推過去績效。${firstDate ? `已開始記錄：${displayDate(firstDate)}` : "建立完整持股與有效行情後開始記錄。"}</span>`;
      metrics.innerHTML = '<article class="portfolioPerformanceMetric"><span>區間資產變化</span><b>尚未解鎖</b><small>至少需要 2 個有效交易日</small></article>';
      coverage.textContent = firstDate ? `FORWARD_SNAPSHOT_ONLY｜資料起始 ${displayDate(firstDate)}` : "FORWARD_SNAPSHOT_ONLY｜尚無有效日資料";
      integrity.hidden = true; integrity.textContent = ""; drawPerformanceChart([], false); return;
    }
    empty.innerHTML = "";
    const twr=ledger?ledgerCore.calculateTwr({snapshots:portfolioHistory,events:ledger.events,startDate:ledger.performanceStartDate,period:performancePeriod}):{available:false},terminal=rows.at(-1),xirr=ledger&&terminal?ledgerCore.calculateXirr(ledgerCore.buildXirrCashFlows(ledger,{date:terminal.date,value:terminal.totalAssets})):{available:false};
    const benchmarkGap=twr.available&&rawComparison.available?twr.value-rawComparison.benchmarkChange:null;
    const metricRows = [
      ["時間加權報酬", twr.available?percent(twr.value):"—", ledger?"TWR｜外部資金流採收盤後 EOD 方法":"建立交易帳本後開始"],
      ["資金加權年化報酬", xirr.available?percent(xirr.value):"—", "XIRR｜依實際入出金日期"],
      ["資產變化率", percent(change.rate), "未校正入出金，與投資報酬分開顯示"],
      ["區間資產變化", money(change.amount), `${displayDate(rows[0].date)} 至 ${displayDate(rows.at(-1).date)}`],
      ["0050 Benchmark", rawComparison.available ? percent(rawComparison.benchmarkChange) : "資料不足", rawComparison.available ? "既有還原權息收盤價｜相同交易日" : "既有還原權息歷史｜無足夠對齊日期"],
      ["相對差異", Number.isFinite(benchmarkGap)?point(benchmarkGap):"—", Number.isFinite(benchmarkGap)?"Portfolio TWR 減 0050 normalized return":"需完整 Ledger TWR 與對齊基準"]
    ];
    metrics.innerHTML = metricRows.map(([label, value, note]) => `<article class="portfolioPerformanceMetric"><span>${label}</span><b>${escapeHtml(value)}</b><small>${escapeHtml(note)}</small></article>`).join("");
    coverage.textContent = `FORWARD_SNAPSHOT_ONLY｜實際涵蓋 ${displayDate(rows[0].date)} 至 ${displayDate(rows.at(-1).date)}｜${rows.length} 個交易日`;
    integrity.hidden = Boolean(ledger)||!continuity.hasCapitalEvent;
    integrity.textContent = !ledger&&continuity.hasCapitalEvent ? "此區間包含資金或持股異動，資產變化不等同投資報酬率。" : "";
    let points = rawComparison.available ? rawComparison.points : rows.map(row => ({date: row.date, portfolio: row.totalAssets / rows[0].totalAssets * 100, benchmark: null}));
    if(ledger)points=points.map(point=>{const value=ledgerCore.calculateTwr({snapshots:rows.filter(row=>row.date<=point.date),events:ledger.events,startDate:ledger.performanceStartDate,period:"ALL"});return{...point,portfolio:value.available?100+value.value:100}});
    drawPerformanceChart(points, benchmarkVisible && rawComparison.available);
  }

  function riskStatusText(status) {
    return ({COMPLETE:"資料完整",CAPITAL_EVENT:"有投資組合異動",INSUFFICIENT_HISTORY:"歷史累積中",INVALID_DATA:"資料無法驗證"})[status] || "歷史累積中";
  }

  function historicalRiskNote(result, kind) {
    if (result.status === "CAPITAL_EVENT") return kind === "drawdown" ? "期間內投資組合有異動，暂不計算" : "期間內持股或資金變動，暂不計算";
    if (result.status === "INVALID_DATA") return "資料無法驗證";
    return "資料累積中";
  }

  function renderRiskCenter() {
    const rows = performanceCore.selectPeriod(portfolioHistory, performancePeriod);
    const continuity = performanceCore.analyzePortfolioContinuity(rows, {tradingDates: benchmarkRows.map(row => row.date), invalidCount: portfolioHistoryInvalidCount});
    const concentration = performanceCore.calculateConcentration(computed.rows.filter(row => row.quoteStatus === "current").map(row => ({code: row.code, marketValue: row.marketValue, weight: row.weight})));
    const allocation = performanceCore.calculateAllocationDeviation(computed.rows.map(row => ({code: row.code, weight: row.weight, targetAllocation: row.targetAllocation})));
    const drawdown = performanceCore.calculateMaxDrawdown(rows, {continuity});
    const volatility = performanceCore.calculateAnnualizedVolatility(rows, {continuity});
    const quality = portfolioHistoryInvalidCount ? "INVALID_DATA" : continuity.hasCapitalEvent ? "CAPITAL_EVENT" : rows.length < 10 || continuity.hasDataGap ? "INSUFFICIENT_HISTORY" : "COMPLETE";
    const qualityNode = $v6("#portfolioRiskQuality");
    qualityNode.dataset.quality = quality; qualityNode.textContent = riskStatusText(quality);
    $v6("#portfolioRiskPeriod").textContent = `目前區間：${performancePeriod}`;
    const metricRows = [
      ["最大單一部位", concentration.available ? plainPercent(concentration.largest) : "—", concentration.available ? "依目前持股市值" : "等待完整市值"],
      ["前三大部位", concentration.available ? plainPercent(concentration.top3) : "—", concentration.available ? "依目前持股市值" : "等待完整市值"],
      ["最大回撤", drawdown.available ? percent(drawdown.value) : "—", drawdown.available ? `${drawdown.observations} 個有效 snapshots` : historicalRiskNote(drawdown, "drawdown")],
      ["年化波動率", volatility.available ? plainPercent(volatility.value) : "—", volatility.available ? `${volatility.observations} 個 daily returns` : historicalRiskNote(volatility, "volatility")]
    ];
    $v6("#portfolioRiskMetrics").innerHTML = metricRows.map(([label,value,note]) => `<article class="portfolioRiskMetric"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b><small>${escapeHtml(note)}</small></article>`).join("");
    const concentrationRows = [
      ["有效分散程度", concentration.available ? `約 ${number(concentration.effectiveHoldings, 1)} 檔` : "—", "依持股權重估算，未對 ETF 成分股去重"],
      ["配置偏離", allocation.available ? point(allocation.totalDeviation) : "—", Number.isFinite(core.allocationHealthScore(computed.rows)) ? `配置健康度 ${core.allocationHealthScore(computed.rows)}` : "目標配置尚未完整"],
      ["最大低配", allocation.largestUnderweight ? allocation.largestUnderweight.symbol : "—", allocation.largestUnderweight ? point(allocation.largestUnderweight.gap) : "無可驗證低配"],
      ["最大高配", allocation.largestOverweight ? allocation.largestOverweight.symbol : "—", allocation.largestOverweight ? point(allocation.largestOverweight.gap) : "無可驗證高配"]
    ];
    $v6("#portfolioConcentration").innerHTML = `<div class="portfolioRiskRows">${concentrationRows.map(([label,value,note]) => `<div class="portfolioRiskRow"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b><small>${escapeHtml(note)}</small></div>`).join("")}</div>`;
  }

  function capitalReasonText(codes) {
    const labels = {UNDERWEIGHT:"低於目標配置",OVERWEIGHT:"高於目標，不投入新資金",NEAR_TARGET:"接近目標配置",HIGH_CORE_SCORE:"正式 HS 分數提供次要加權",PRICE_UNAVAILABLE:"價格暫缺",TARGET_MISSING:"目標配置未設定",INSUFFICIENT_CASH:"尚未設定投入金額"};
    return codes.map(code => labels[code] || code).join("｜");
  }

  function renderCapitalPlan() {
    const plan = performanceCore.buildCapitalAllocationPlan({
      rows: computed.rows.map(row => ({code: row.code, marketValue: row.quoteStatus === "current" ? row.marketValue : null, weight: row.weight, targetAllocation: row.targetAllocation, price: row.quoteStatus === "current" ? row.quote?.price : null, coreScore: radarFor(row.code)?.score ?? null})),
      availableCash: rebalanceSettings.cash,
      allocationHealthScore: core.allocationHealthScore
    });
    const summary = $v6("#capitalPlanSummary"), output = $v6("#capitalPlanRows");
    summary.innerHTML = [["可投入",money(plan.cash)],["建議配置",money(plan.allocated)],["保留現金",money(plan.remaining)],["健康度",Number.isFinite(plan.healthBefore)&&Number.isFinite(plan.healthAfter)?`${plan.healthBefore} → ${plan.healthAfter}`:"—"]].map(([label,value])=>`<article><span>${label}</span><b>${escapeHtml(value)}</b></article>`).join("");
    if (!holdings.length) { output.innerHTML = '<div class="capitalPlanEmpty">新增持股後才會建立投入模擬。</div>'; return; }
    if (plan.cash <= 0) { output.innerHTML = '<div class="capitalPlanEmpty">輸入本次可投入金額後，系統會依目標配置差異產生模擬。</div>'; return; }
    const visible = plan.rows.filter(row => row.allocationAmount > 0 || row.reasonCodes.includes("PRICE_UNAVAILABLE") || row.reasonCodes.includes("TARGET_MISSING"));
    output.innerHTML = visible.length ? visible.map(row => `<article class="capitalPlanRow"><div class="capitalPlanIdentity"><b>${escapeHtml(row.symbol)}</b><small>目標 ${Number.isFinite(row.targetAllocation)?plainPercent(row.targetAllocation):"未設定"}</small></div><div class="capitalPlanReason"><b>${escapeHtml(capitalReasonText(row.reasonCodes))}</b><span>${Number.isFinite(row.coreScore)?`正式 HS ${number(row.coreScore,0)}`:"正式 HS 分數暫缺，不阻斷配置"}</span></div><div class="capitalPlanAmount"><b>${row.allocationAmount>0?money(row.allocationAmount):"不配置"}</b><small>${Number.isFinite(row.estimatedUnits)&&row.allocationAmount>0?`約 ${number(row.estimatedUnits,2)} 股｜模擬`:"等待必要資料"}</small></div></article>`).join("") : '<div class="capitalPlanEmpty">目前沒有符合投入條件的低配部位，資金維持保留。</div>';
  }

  const LEDGER_LABELS={OPENING_POSITION:"期初部位",OPENING_CASH:"期初現金",BUY:"買入",SELL:"賣出",DEPOSIT:"入金",WITHDRAWAL:"出金",DIVIDEND:"股息",FEE:"其他費用",TAX:"額外稅額"};
  function ledgerEventDetail(event){if(["OPENING_POSITION","BUY","SELL"].includes(event.type))return`${event.symbol}｜${number(event.quantity,4)} 股 × ${money(event.unitPrice)}`;if(event.type==="DIVIDEND")return`${event.symbol}｜現金股息`;return event.note||LEDGER_LABELS[event.type]||event.type}
  function ledgerEventAmount(event){if(event.type==="OPENING_POSITION")return money(event.grossAmount);const sign=event.cashImpact>0?"+":"";return`${sign}${money(event.cashImpact)}`}
  function ledgerRow(event,actions=true){return`<article class="portfolioLedgerRow" data-ledger-event="${escapeHtml(event.id)}"><time>${escapeHtml(displayDate(event.tradeDate))}</time><b class="portfolioLedgerType">${escapeHtml(LEDGER_LABELS[event.type]||event.type)}</b><span class="portfolioLedgerDetail">${escapeHtml(ledgerEventDetail(event))}</span><strong class="portfolioLedgerAmount ${valueClass(event.cashImpact)}">${escapeHtml(ledgerEventAmount(event))}</strong>${actions?`<span class="portfolioLedgerActions"><button type="button" data-ledger-edit="${escapeHtml(event.id)}">編輯</button><button type="button" data-ledger-delete="${escapeHtml(event.id)}">刪除</button></span>`:""}</article>`}
  function renderLedger(){
    const content=$v6("#portfolioLedgerContent"),start=$v6("#portfolioLedgerStart"),reconciliation=$v6("#portfolioLedgerReconciliation");
    if(!ledger){start.textContent="交易帳本尚未建立";content.innerHTML='<div class="portfolioLedgerOnboarding"><b>建立可驗證的交易帳本</b><p>既有持股只會成為期初部位，不會被偽造成過去的買入紀錄。</p><button class="btn" type="button" data-ledger-migrate-open>建立交易帳本</button></div>';reconciliation.hidden=true;return}
    ledgerState=ledgerCore.derivePortfolioStateFromLedger(ledger.events);start.textContent=`正式績效起始 ${displayDate(ledger.performanceStartDate)}｜${ledger.events.length} 筆`;
    const rows=[...ledger.events].sort((a,b)=>b.tradeDate.localeCompare(a.tradeDate)||b.timestamp.localeCompare(a.timestamp)||b.id.localeCompare(a.id));content.innerHTML=rows.length?`<div class="portfolioLedgerRows">${rows.slice(0,5).map(row=>ledgerRow(row,false)).join("")}</div>`:'<div class="portfolioLedgerEmpty">尚無交易紀錄。</div>';
    const snapshot=portfolioHistory.at(-1),result=snapshot?ledgerCore.reconcileLedgerWithSnapshot(ledgerState,snapshot):{status:"UNAVAILABLE"};reconciliation.hidden=result.status!=="UNRECONCILED_STATE";reconciliation.innerHTML=result.status==="UNRECONCILED_STATE"?'交易帳本與目前持股資料不一致　<button class="miniBtn" type="button" data-ledger-view>檢查交易紀錄</button>':"";
  }
  function openMigration(){const modal=$v6("#portfolioLedgerMigrationModal"),cost=holdings.reduce((sum,row)=>sum+row.shares*row.averageCost,0);$v6("#portfolioLedgerMigrationSummary").innerHTML=[["持股",`${holdings.length} 檔`],["期初成本",money(cost)],["期初現金",money(rebalanceSettings.cash)],["績效起始",displayDate(taipeiToday())]].map(([label,value])=>`<article><span>${label}</span><b>${escapeHtml(value)}</b></article>`).join("");modal.classList.add("show");modal.setAttribute("aria-hidden","false")}
  function closeLedgerModals(){["#portfolioLedgerMigrationModal","#portfolioTransactionModal","#portfolioLedgerModal"].forEach(selector=>{const node=$v6(selector);node.classList.remove("show");node.setAttribute("aria-hidden","true")});editingLedgerEventId=null}
  function migrateLedger(){if(ledger)return;const now=new Date().toISOString();if(!localStorage.getItem(ledgerCore.LEGACY_BACKUP_KEY))localStorage.setItem(ledgerCore.LEGACY_BACKUP_KEY,JSON.stringify({version:1,createdAt:now,holdings,rebalanceSettings}));persistLedger(ledgerCore.migrateLegacyPortfolio({holdings,cash:rebalanceSettings.cash,tradeDate:taipeiToday(),timestamp:now}));closeLedgerModals();refreshPortfolio()}
  function transactionVisibility(){const type=$v6("#portfolioTransactionType").value,trade=["OPENING_POSITION","BUY","SELL"].includes(type),symbol=trade||type==="DIVIDEND";$v6("[data-transaction-symbol]").hidden=!symbol;$v6("[data-transaction-trade]").hidden=!trade;$v6("[data-transaction-amount]").hidden=trade;$v6("[data-transaction-costs]").hidden=!trade||type==="OPENING_POSITION";$v6("[data-transaction-tax]").hidden=type!=="SELL"}
  function openTransaction(eventId=null){if(!ledger){openMigration();return}editingLedgerEventId=eventId;const event=eventId?ledger.events.find(row=>row.id===eventId):null,select=$v6("#portfolioTransactionType");select.querySelectorAll("[data-opening-option]").forEach(node=>node.remove());if(event?.type.startsWith("OPENING_")){const option=document.createElement("option");option.value=event.type;option.textContent=LEDGER_LABELS[event.type];option.dataset.openingOption="true";select.prepend(option)}$v6("#portfolioTransactionTitle").textContent=event?`${LEDGER_LABELS[event.type]}紀錄`:"新增交易";select.value=event?.type||"BUY";select.disabled=Boolean(event?.type.startsWith("OPENING_"));$v6("#portfolioTransactionDate").value=event?.tradeDate||taipeiToday();$v6("#portfolioTransactionSymbol").value=event?.symbol||"";$v6("#portfolioTransactionQuantity").value=event?.quantity||"";$v6("#portfolioTransactionPrice").value=event?.unitPrice||"";$v6("#portfolioTransactionAmount").value=event?.grossAmount||"";$v6("#portfolioTransactionFee").value=event?.fee||0;$v6("#portfolioTransactionTax").value=event?.tax||0;$v6("#portfolioTransactionNote").value=event?.note||"";$v6("#portfolioTransactionError").textContent="";$v6("#portfolioTransactionWarning").hidden=true;transactionVisibility();const modal=$v6("#portfolioTransactionModal");modal.classList.add("show");modal.setAttribute("aria-hidden","false")}
  function transactionFormEvent(){const type=$v6("#portfolioTransactionType").value,trade=["OPENING_POSITION","BUY","SELL"].includes(type);return{type,tradeDate:$v6("#portfolioTransactionDate").value,timestamp:editingLedgerEventId?ledger.events.find(row=>row.id===editingLedgerEventId)?.timestamp:new Date().toISOString(),symbol:$v6("#portfolioTransactionSymbol").value,quantity:trade?$v6("#portfolioTransactionQuantity").value:null,unitPrice:trade?$v6("#portfolioTransactionPrice").value:null,grossAmount:trade?null:$v6("#portfolioTransactionAmount").value,fee:type==="OPENING_POSITION"?0:$v6("#portfolioTransactionFee").value,tax:type==="OPENING_POSITION"?0:$v6("#portfolioTransactionTax").value,note:$v6("#portfolioTransactionNote").value,source:editingLedgerEventId?ledger.events.find(row=>row.id===editingLedgerEventId)?.source||"MANUAL":"MANUAL",updatedAt:new Date().toISOString()}}
  function submitTransaction(event){event.preventDefault();const input=transactionFormEvent(),normalized=ledgerCore.normalizeEvent(input),warning=$v6("#portfolioTransactionWarning");if(!normalized){$v6("#portfolioTransactionError").textContent="請確認日期、代號、股數、價格或金額皆為有效正數。";return}if(!editingLedgerEventId&&ledgerCore.detectLikelyDuplicate(ledger.events,normalized)&&warning.hidden){warning.textContent="可能為重複交易；若確實為另一筆交易，請再次按儲存。";warning.hidden=false;return}if(normalized.type==="OPENING_POSITION"&&!confirm("修改期初部位會改變正式績效基準，確定繼續？"))return;const result=ledgerCore.mutateLedger(ledger,{type:editingLedgerEventId?"EDIT":"ADD",id:editingLedgerEventId,event:normalized});if(!result.ok){$v6("#portfolioTransactionError").textContent=result.error||"交易後帳本狀態無效，未儲存任何變更。";return}persistLedger(result.ledger);closeLedgerModals();refreshPortfolio();updateQuotes({force:true})}
  function deleteLedgerEvent(id){const event=ledger?.events.find(row=>row.id===id);if(!event||!confirm(`刪除這筆「${LEDGER_LABELS[event.type]}」紀錄？`))return;if(event.type==="OPENING_POSITION"&&!confirm("刪除期初部位會改變正式績效基準，確定繼續？"))return;const result=ledgerCore.mutateLedger(ledger,{type:"DELETE",id});if(!result.ok){alert(result.error||"刪除後會造成後續交易無效，未刪除任何資料。");return}persistLedger(result.ledger);renderAllLedger();refreshPortfolio()}
  function filterLedgerEvent(event){return ledgerFilter==="ALL"||event.type===ledgerFilter||ledgerFilter==="CASH"&&["DEPOSIT","WITHDRAWAL"].includes(event.type)||ledgerFilter==="COST"&&["FEE","TAX"].includes(event.type)}
  function renderAllLedger(){if(!ledger)return;const rows=[...ledger.events].filter(filterLedgerEvent).sort((a,b)=>b.tradeDate.localeCompare(a.tradeDate)||b.timestamp.localeCompare(a.timestamp)||b.id.localeCompare(a.id));$v6("#portfolioLedgerAllList").innerHTML=rows.length?rows.map(row=>ledgerRow(row)).join(""):'<div class="portfolioLedgerEmpty">這個分類尚無交易紀錄。</div>'}
  function openLedger(){if(!ledger){openMigration();return}renderAllLedger();const modal=$v6("#portfolioLedgerModal");modal.classList.add("show");modal.setAttribute("aria-hidden","false")}

  function refreshPortfolio(animate = false, {focusTarget = ""} = {}) {
    computed = core.calculatePortfolio(holdings, quoteMap, {now: Date.now()});
    const simulation = $v6("#rebalanceSimulation");
    if (simulation) simulation.hidden = true;
    renderSummary();
    renderPortfolioDecisionSupport();
    renderList();
    drawAllocation();
    renderRebalance(focusTarget);
    recordPortfolioSnapshot();
    renderPerformance();
    renderRiskCenter();
    renderCapitalPlan();
    renderLedger();
    renderQuoteStatus();
    window.dispatchEvent(new CustomEvent("hs:portfolio-state"));
    if (animate) {
      const page = $v6("#portfolio");
      page.classList.remove("portfolioFlash");
      requestAnimationFrame(() => page.classList.add("portfolioFlash"));
    }
  }

  function drawAllocation() {
    const canvas = $v6("#portfolioChart");
    const ctx = canvas.getContext("2d");
    const wrap = canvas.parentElement;
    const size = Math.max(112, Math.min(560, Math.round(wrap.clientWidth || 320)));
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(size * ratio) || canvas.height !== Math.round(size * ratio)) {
      canvas.width = Math.round(size * ratio);
      canvas.height = Math.round(size * ratio);
    }
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const marketRows = computed.rows
      .filter(row => Number.isFinite(row.marketValue) && row.marketValue > 0)
      .map(row => ({...row, allocationValue: row.marketValue, valueSource: "market"}));
    const allocation = core.buildAllocation(marketRows);
    const marketTotal = allocation.reduce((sum, item) => sum + item.value, 0);
    $v6("#portfolioAllocationMode").textContent = "依目前市值";
    chartSegments = [];
    if (!allocation.length) {
      ctx.strokeStyle = "#244332";
      ctx.lineWidth = Math.max(22, size * .12);
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size * .32, 0, Math.PI * 2);
      ctx.stroke();
      $v6("#portfolioChartCenter").innerHTML = `<b>${holdings.length ? "資料暫缺" : "尚無持股"}</b><span>${holdings.length} 檔持股</span>`;
      $v6("#portfolioChartDetail").innerHTML = `<p class="allocationLegendEmpty">${holdings.length ? "行情資料暫缺，無法以市值計算配置。" : "新增持股後會在此顯示目前市值配置。"}</p>`;
      return;
    }
    const center = size / 2;
    const radius = size * .29;
    const lineWidth = size * .14;
    let start = -Math.PI / 2;
    allocation.forEach((item, index) => {
      const end = start + item.weight / 100 * Math.PI * 2;
      ctx.strokeStyle = COLORS[index % COLORS.length];
      ctx.lineWidth = lineWidth;
      ctx.lineCap = "butt";
      ctx.beginPath();
      ctx.arc(center, center, radius, start, end);
      ctx.stroke();
      chartSegments.push({...item, start, end, color: ctx.strokeStyle});
      start = end;
    });
    if (chartSelection >= chartSegments.length) chartSelection = -1;
    if (chartSelection >= 0) {
      const segment = chartSegments[chartSelection];
      const mid = (segment.start + segment.end) / 2;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(center, center, radius + lineWidth / 2 + 4, segment.start + .015, segment.end - .015);
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(center + Math.cos(mid) * (radius + lineWidth / 2 + 4), center + Math.sin(mid) * (radius + lineWidth / 2 + 4), 3, 0, Math.PI * 2);
      ctx.fill();
    }
    $v6("#portfolioChartCenter").innerHTML = `<b>${money(marketTotal)}</b><span>${marketRows.length} 檔持股<em>｜總市值</em></span>`;
    renderAllocationLegend();
  }

  function renderAllocationLegend() {
    const detail = $v6("#portfolioChartDetail");
    detail.innerHTML = chartSegments.map((item, index) => {
      const pnl = Number.isFinite(item.pnl)
        ? `<span>累積損益 <b class="${valueClass(item.pnl)}">${money(item.pnl)}</b></span>`
        : "";
      const members = item.code === "其他" ? `<small>包含 ${escapeHtml(item.members.join("、"))}</small>` : "";
      return `<button class="allocationLegendItem${index === chartSelection ? " selected" : ""}" type="button" data-allocation-index="${index}" aria-pressed="${index === chartSelection}"><i style="--allocation-color:${item.color}"></i><span class="allocationLegendIdentity"><b><span class="allocationCode">${escapeHtml(item.code)}</span><span class="allocationName">・${escapeHtml(item.name)}</span></b></span><strong class="allocationLegendWeight">${number(item.weight, 1)}%</strong><span class="allocationLegendValues"><b>${money(item.value)}</b>${pnl}</span>${members}</button>`;
    }).join("");
    detail.querySelectorAll("[data-allocation-index]").forEach(button => button.addEventListener("click", () => showChartDetail(Number(button.dataset.allocationIndex))));
  }

  function showChartDetail(index) {
    if (!chartSegments.length) return;
    chartSelection = (index + chartSegments.length) % chartSegments.length;
    drawAllocation();
  }

  function chartHit(event) {
    if (!chartSegments.length) return;
    const canvas = $v6("#portfolioChart");
    const rect = canvas.getBoundingClientRect();
    const point = event.touches?.[0] || event;
    const x = point.clientX - rect.left - rect.width / 2;
    const y = point.clientY - rect.top - rect.height / 2;
    const distance = Math.hypot(x, y);
    if (distance < rect.width * .20 || distance > rect.width * .38) return;
    let angle = Math.atan2(y, x);
    if (angle < -Math.PI / 2) angle += Math.PI * 2;
    const index = chartSegments.findIndex(segment => angle >= segment.start && angle <= segment.end);
    if (index >= 0) showChartDetail(index);
  }

  async function loadCatalog() {
    if (catalog.length) return catalog;
    if (catalogLoading) return catalogLoading;
    catalogLoading = (async () => {
      const fallback = [];
      try {
        if (Array.isArray(watchlist)) fallback.push(...watchlist.map(item => ({code: item.id, name: item.name})));
      } catch {
        // The current ETF list may still be loading.
      }
      try {
        const rows = await apiGet({dataset: "TaiwanStockInfo"}, {soft: true});
        const seen = new Set();
        catalog = [...fallback, ...(Array.isArray(rows) ? rows.map(row => ({code: String(row.stock_id || ""), name: String(row.stock_name || "")})) : [])]
          .map(item => ({code: core.normalizeCode(item.code), name: core.sanitizeName(item.name)}))
          .filter(item => core.CODE_PATTERN.test(item.code) && !seen.has(item.code) && seen.add(item.code));
      } catch {
        catalog = fallback;
      }
      return catalog;
    })().finally(() => { catalogLoading = null; });
    return catalogLoading;
  }

  function searchCatalog(query) {
    const normalized = String(query || "").trim().toLowerCase();
    const element = $v6("#portfolioSearchResults");
    if (!normalized) {
      element.innerHTML = "";
      return;
    }
    const rows = catalog.filter(item => item.code.toLowerCase().includes(normalized) || item.name.toLowerCase().includes(normalized)).slice(0, 8);
    element.innerHTML = rows.map(item => `<button class="portfolioSearchResult" type="button" role="option" data-portfolio-result="${escapeHtml(item.code)}"><span><b>${escapeHtml(item.code)}</b> · ${escapeHtml(item.name)}</span><small>選取</small></button>`).join("");
    element.querySelectorAll("[data-portfolio-result]").forEach(button => button.addEventListener("click", () => {
      const item = catalog.find(entry => entry.code === button.dataset.portfolioResult);
      $v6("#portfolioCode").value = item.code;
      if (!$v6("#portfolioCustomName").value) $v6("#portfolioCustomName").placeholder = item.name || "自訂名稱";
      element.innerHTML = "";
      $v6("#portfolioShares").focus();
    }));
  }

  function openPortfolioModal(code = null) {
    editingCode = code;
    pendingDuplicate = null;
    const item = code ? holdings.find(entry => entry.code === code) : null;
    $v6("#portfolioModalTitle").textContent = item ? `修改 ${item.code}` : "新增持股";
    $v6("#portfolioCode").value = item?.code || "";
    $v6("#portfolioCode").readOnly = Boolean(item);
    $v6("#portfolioShares").value = item?.shares || "";
    $v6("#portfolioAverageCost").value = item?.averageCost || "";
    $v6("#portfolioCustomName").value = item?.customName || "";
    $v6("#portfolioStrategyType").value = item?.strategyType || "";
    $v6("#portfolioTargetAllocation").value = Number.isFinite(item?.targetAllocation) ? item.targetAllocation : "";
    $v6("#portfolioFormError").textContent = "";
    $v6("#portfolioSearchResults").innerHTML = "";
    $v6("#portfolioDuplicateActions").hidden = true;
    $v6("#portfolioSaveBtn").hidden = false;
    $v6("#portfolioModal").classList.add("show");
    loadCatalog().then(() => searchCatalog($v6("#portfolioCode").value));
    setTimeout(() => (item ? $v6("#portfolioShares") : $v6("#portfolioCode")).focus(), 40);
  }

  function closePortfolioModal() {
    $v6("#portfolioModal").classList.remove("show");
    editingCode = null;
    pendingDuplicate = null;
  }

  function formHolding() {
    const code = core.normalizeCode($v6("#portfolioCode").value);
    const catalogItem = catalog.find(item => item.code === code);
    return core.validateHolding({
      code,
      shares: $v6("#portfolioShares").value,
      averageCost: $v6("#portfolioAverageCost").value,
      customName: $v6("#portfolioCustomName").value,
      strategyType: $v6("#portfolioStrategyType").value,
      targetAllocation: $v6("#portfolioTargetAllocation").value,
      name: catalogItem?.name || holdings.find(item => item.code === code)?.name || ""
    });
  }

  function commitHolding(item, mode = "add") {
    const index = holdings.findIndex(entry => entry.code === item.code);
    const nextHoldings = [...holdings];
    if (mode === "edit" || mode === "overwrite") {
      if (index < 0) throw new Error("找不到要更新的持股。");
      nextHoldings[index] = item;
    } else if (mode === "merge") {
      if (index < 0) throw new Error("找不到要合併的持股。");
      nextHoldings[index] = core.mergeHolding(holdings[index], item);
    } else {
      if (holdings.length >= core.MAX_HOLDINGS) throw new Error("為避免手機載入過慢，最多只能有 30 檔持股。");
      nextHoldings.push(item);
    }
    const allocation = core.validateTargetAllocations(nextHoldings);
    if (!allocation.ok) throw new Error(`目標配置合計不可超過 100%（目前 ${allocation.total}%）。`);
    holdings = nextHoldings;
    saveHoldings();
    marketCacheVersion = "";
    closePortfolioModal();
    refreshPortfolio();
    updateQuotes({force: true});
  }

  function submitPortfolio(event) {
    event.preventDefault();
    try {
      const item = formHolding();
      if (editingCode) {
        commitHolding(item, "edit");
        return;
      }
      const existing = holdings.some(entry => entry.code === item.code);
      if (existing) {
        pendingDuplicate = item;
        $v6("#portfolioDuplicateActions").hidden = false;
        $v6("#portfolioSaveBtn").hidden = true;
        $v6("#portfolioFormError").textContent = "";
        return;
      }
      commitHolding(item);
    } catch (error) {
      $v6("#portfolioFormError").textContent = error.message;
    }
  }

  function duplicateAction(action) {
    if (action === "cancel") {
      pendingDuplicate = null;
      $v6("#portfolioDuplicateActions").hidden = true;
      $v6("#portfolioSaveBtn").hidden = false;
      return;
    }
    if (!pendingDuplicate) return;
    try {
      commitHolding(pendingDuplicate, action);
    } catch (error) {
      $v6("#portfolioFormError").textContent = error.message;
    }
  }

  function deleteHolding(code) {
    const item = holdings.find(entry => entry.code === code);
    if (!item || !confirm(`刪除 ${item.code} ${holdingName({...item, quote: quoteMap.get(item.code)})}？`)) return;
    holdings = holdings.filter(entry => entry.code !== code);
    quoteMap.delete(code);
    saveHoldings();
    saveQuoteCache();
    refreshPortfolio();
    scheduleNext();
  }

  function clearHoldings() {
    if (ledger) { alert("交易帳本已啟用，請從交易紀錄修正部位；不會直接清除衍生持股。"); return; }
    if (!holdings.length || !confirm("確定清除這台裝置上的全部持股？此動作無法復原，建議先匯出備份。")) return;
    holdings = [];
    quoteMap.clear();
    localStorage.removeItem(HOLDINGS_KEY);
    localStorage.removeItem(QUOTES_KEY);
    refreshPortfolio();
    scheduleNext();
  }

  function exportHoldings() {
    const payload = {version: ledger ? 4 : 2, exportedAt: new Date().toISOString(), holdings: holdings.map(({code, shares, averageCost, customName, name, strategyType, targetAllocation}) => ({code, shares, averageCost, customName, name, strategyType, targetAllocation})),ledger:ledger||null,ledgerVersion:ledger?.version||null,performanceStartDate:ledger?.performanceStartDate||null,migrationMetadata:ledger?{ledgerInitializedAt:ledger.ledgerInitializedAt,legacyMigrationVersion:ledger.legacyMigrationVersion}:null,snapshots:portfolioHistory,rebalanceSettings};
    const blob = new Blob([JSON.stringify(payload, null, 2)], {type: "application/json"});
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `hs-invest-portfolio-${taipeiToday()}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function importHoldings(file) {
    if (!file) return;
    try {
      if (file.size > 1024 * 1024) throw new Error("備份檔不可超過 1 MB。");
      const parsed = JSON.parse(await file.text());
      const imported = core.validateImportPayload(parsed);
      const importedLedger = parsed?.ledger ? ledgerCore.validateLedger(parsed.ledger) : null;
      if (parsed?.ledger && !importedLedger) throw new Error("交易帳本格式無效。");
      holdings = imported;
      if (importedLedger) { ledger=importedLedger; persistLedger(importedLedger); }
      else { ledger=null; ledgerState=null; localStorage.removeItem(ledgerCore.STORAGE_KEY); }
      if(Array.isArray(parsed?.snapshots)){const restored=parsed.snapshots.map(performanceCore.validateSnapshot).filter(Boolean);portfolioHistory=restored.sort((a,b)=>a.date.localeCompare(b.date));savePortfolioHistory()}
      if(parsed?.rebalanceSettings&&typeof parsed.rebalanceSettings==="object"){rebalanceSettings={...rebalanceSettings,...parsed.rebalanceSettings};if(ledgerState?.valid)rebalanceSettings.cash=ledgerState.cash;saveRebalanceSettings()}
      marketCacheVersion = "";
      quoteMap = new Map([...quoteMap].filter(([code]) => holdings.some(item => item.code === code)));
      saveHoldings();
      saveQuoteCache();
      applyLedgerUiMode();
      refreshPortfolio();
      updateQuotes({force: true});
      alert(`已匯入 ${holdings.length} 檔持股${ledger?"與完整交易帳本":"；可接著建立交易帳本"}，資料只儲存在此裝置。`);
    } catch (error) {
      alert(`匯入失敗：${error.message}`);
    } finally {
      $v6("#portfolioImportFile").value = "";
    }
  }

  function mergeQuoteMaps(maps) {
    const merged = new Map();
    for (const map of maps) for (const [code, quote] of map) merged.set(code, quote);
    return merged;
  }

  async function fetchJson(url, timeoutMs = 16000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {cache: "no-store", signal: controller.signal, headers: {"Accept": "application/json"}});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async function fetchBulkQuotes() {
    const fetchedAt = new Date().toISOString();
    let metadata = null;
    try {
      metadata = await fetchJson(`${MARKET_META_URL}?ts=${Date.now()}`);
      const metadataTime = Date.parse(metadata?.updated_at);
      if (!Number.isFinite(metadataTime)) throw new Error("行情版本資訊無效");
      if (marketCacheVersion === metadata.updated_at && publicQuoteMap.size) {
        return {quotes: new Map(publicQuoteMap), fetchedAt: metadata.updated_at, partial: false, changed: false};
      }
    } catch {
      metadata = null;
    }
    try {
      const cached = await fetchJson(`${MARKET_CACHE_URL}?ts=${Date.now()}`);
      const quotes = core.parseCachedQuotes(cached);
      marketCacheVersion = String(cached.updated_at);
      localStorage.setItem(MARKET_VERSION_KEY, marketCacheVersion);
      return {quotes, fetchedAt: marketCacheVersion, partial: false, changed: true};
    } catch {
      // Development and first-deploy fallback: try the two official bulk endpoints directly.
    }
    const results = await Promise.allSettled([fetchJson(TWSE_URL), fetchJson(TPEX_URL)]);
    const maps = [];
    if (results[0].status === "fulfilled") maps.push(core.parseTwseRows(results[0].value, fetchedAt));
    if (results[1].status === "fulfilled") maps.push(core.parseTpexRows(results[1].value, fetchedAt));
    if (!maps.length) throw new Error("兩個公開行情來源皆無法取得");
    return {quotes: mergeQuoteMaps(maps), fetchedAt, partial: maps.length < 2, changed: true};
  }

  function scheduleNext(delayOverride) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
    // 行情輪詢由首頁 HSLiveMarket 的單一控制器負責，持股只消費同一批公開行情。
  }

  function reconcilePortfolioQuotes(incoming, {applyPortfolio = true, sourceUpdatedAt = ""} = {}) {
    if (!holdings.length) return {currentCount: 0, staleCount: 0, missingCount: 0};
    const merged = core.mergePortfolioQuoteRefresh({
      previous: quoteMap,
      incoming,
      holdings,
      applyPortfolio,
      sourceUpdatedAt
    });
    quoteMap = merged.quotes;
    saveQuoteCache();
    refreshPortfolio(true);
    return merged;
  }

  async function updateQuotes({force = false, applyPortfolio = $v6("#portfolioAutoRefresh").checked} = {}) {
    if (applyPortfolio && !$v6("#portfolioAutoRefresh").checked) pendingManualPortfolioApply = true;
    if (window.HSLiveMarket) return window.HSLiveMarket.refresh();
    if (refreshInFlight) return refreshInFlight;
    const now = Date.now();
    if (!force && now - lastAttemptAt < 55000) {
      scheduleNext(60000 - (now - lastAttemptAt));
      return;
    }
    lastAttemptAt = now;
    renderQuoteStatus(holdings.length ? "行情快取檢查中…" : "首頁行情快取檢查中…");
    $v6("#portfolioRefreshBtn").disabled = true;
    refreshInFlight = (async () => {
      try {
        const result = await fetchBulkQuotes();
        publicQuoteMap = new Map(result.quotes);
        lastSuccessAt = Date.parse(result.fetchedAt);
        failureCount = 0;
        const checkedAt = new Date().toISOString();
        if (result.changed) {
          window.dispatchEvent(new CustomEvent("hs:delayed-quotes", {detail: {
            quotes: new Map(publicQuoteMap),
            sourceUpdatedAt: result.fetchedAt,
            checkedAt
          }}));
        } else {
          window.dispatchEvent(new CustomEvent("hs:quote-cache-checked", {detail: {
            sourceUpdatedAt: result.fetchedAt,
            checkedAt
          }}));
        }
        const reconciliation = !result.changed && holdings.length
          ? reconcilePortfolioQuotes(publicQuoteMap, {applyPortfolio, sourceUpdatedAt: result.fetchedAt})
          : null;
        const suffix = result.partial ? "；部分市場來源暫時無法取得" : "";
        if (!holdings.length) renderQuoteStatus("首頁行情快取已檢查；尚未新增持股");
        else if (!applyPortfolio) renderQuoteStatus(`${quoteTimeLabel()}；持股自動更新已關閉`);
        else renderQuoteStatus(`${quoteTimeLabel()}${reconciliation?.missingCount ? `；${reconciliation.missingCount} 檔行情暫缺` : ""}${suffix}`);
        scheduleNext(60000);
      } catch {
        failureCount += 1;
        window.dispatchEvent(new CustomEvent("hs:delayed-quotes-error"));
        renderQuoteStatus("行情更新失敗，已保留最後資料");
        scheduleNext();
      } finally {
        refreshInFlight = null;
        $v6("#portfolioRefreshBtn").disabled = false;
      }
    })();
    return refreshInFlight;
  }

  function renderHomeSentiment() {
    {
      const risk=typeof marketChip!=="undefined"?marketChip?.marginRisk:null;
      const values=risk&&typeof HSMarginRiskCore!=="undefined"?HSMarginRiskCore.displayValues(risk):null;
      const cnn=typeof cnnFearGreed!=="undefined"?cnnFearGreed:null;
      const futures=typeof futuresPosition!=="undefined"?futuresPosition:null;
      const foreign=futures?.foreign_tx,tmf=futures?.estimated_non_institutional_tmf;
      const waitingSnapshot=typeof HSDataFreshnessCore!=="undefined"?HSDataFreshnessCore.normalize({}):{status:"WAITING"};
      const freshnessLabel=snapshot=>typeof HSDataFreshnessCore!=="undefined"?HSDataFreshnessCore.label(snapshot?.status):"等待更新";
      const card=(selector,title,value,status,date,snapshot=waitingSnapshot)=>{
        const node=$v6(selector);if(!node)return;
        const titleNode=node.querySelector("span"),valueNode=node.querySelector("b"),statusNode=node.querySelector("em"),dateNode=node.querySelector("small");
        if(titleNode)titleNode.textContent=title;
        if(valueNode)valueNode.textContent=value;
        if(statusNode)statusNode.textContent=status;
        if(dateNode)dateNode.textContent=`${date||"資料日期待更新"}｜${freshnessLabel(snapshot)}`;
        node.dataset.freshness=String(snapshot?.status||"WAITING").toLowerCase();
      };
      const marginDate=values?.dataDate||risk?.data_date||"—",futuresDate=futures?.dataDate||"—";
      card("#homeMarginBalanceCard","台股融資餘額",Number.isFinite(values?.financingPrincipal)?`${number(values.financingPrincipal/1e8,2)}億`:"—",risk?.interpretation?.label||risk?.risk_state||"資料暫缺",marginDate,risk?.snapshot);
      card("#homeMaintenanceCard","市場推估融資維持率",Number.isFinite(values?.maintenanceRatio)?`${number(values.maintenanceRatio,2)}%`:"—",Number.isFinite(values?.maintenanceRatio)?HSMarginRiskCore.ratioBand(values.maintenanceRatio).label:"資料暫缺",marginDate,risk?.snapshot);
      card("#homeCnnCard","CNN Fear & Greed",Number.isFinite(cnn?.score)?number(cnn.score,0):"—",cnn?.label||"資料暫缺",cnn?.snapshot?.data_date||"—",cnn?.snapshot);
      card("#homeForeignFuturesCard","外資台指期",Number.isFinite(foreign?.net)?`${foreign.net<0?"淨空":"淨多"} ${number(Math.abs(foreign.net),0)}口`:"—",Number.isFinite(foreign?.net)?(foreign.net<0?"偏空":"偏多"):"資料暫缺",futuresDate,futures?.snapshot);
      const tmfRatio=Number.isFinite(tmf?.long)&&Number.isFinite(tmf?.short)&&tmf.short>0?tmf.long/tmf.short:null;
      const tmfState=Number.isFinite(tmfRatio)?(tmfRatio>1.1?"偏多":tmfRatio<.9?"偏空":"中性"):"資料暫缺";
      card("#homeTmfRatioCard","散戶微台多空比",Number.isFinite(tmfRatio)?number(tmfRatio,2):"—",tmfState,futuresDate,futures?.snapshot);
      let conclusion="市場情緒資料仍在更新，長期 ETF 維持分批原則。";
      if(Number.isFinite(cnn?.score)){
        if(cnn.score>=56&&tmfState==="偏多")conclusion="市場情緒偏熱且散戶偏多，避免追高，等待週線回檔。";
        else if(cnn.score<=44)conclusion=`市場情緒偏恐懼，融資壓力${values?.maintenanceRatio<140?"偏高":"中性"}，長期 ETF 可留意低檔分批。`;
        else conclusion=`市場情緒中性，融資壓力${values?.maintenanceRatio<140?"偏高":"中性"}，依長期加碼排名分批評估。`;
      }
      const conclusionNode=$v6("#homeSentimentConclusion");if(conclusionNode)conclusionNode.textContent=conclusion;
      const details=$v6("#homeSentimentDetails");if(details)details.innerHTML=`<summary>展開資料方法與日期</summary><div><p>融資餘額與推估維持率：最近交易日盤後資料 ${escapeHtml(marginDate)}。</p><p>外資台指期與微台非三大法人部位：期交所盤後資料 ${escapeHtml(futuresDate)}；微台多空比＝推估多單÷推估空單，不等同官方純自然人持倉。</p><p>CNN：${escapeHtml(cnn?.sourceUpdatedAt||"資料暫缺")}。</p></div>`;
      return;
    }
    let margin = null;
    let marginRisk = null;
    let cnn = null;
    try {
      margin = marketChip?.margin || null;
      marginRisk = marketChip?.marginRisk || null;
      cnn = cnnFearGreed || null;
    } catch {
      // Sentiment data is still loading.
    }
    const fomoCard = $v6("#homeFomoCard");
    const cnnCard = $v6("#homeCnnCard");
    const marginValues = marginRisk && typeof HSMarginRiskCore !== "undefined" ? HSMarginRiskCore.displayValues(marginRisk) : null;
    if (marginRisk && Number.isFinite(marginValues?.financingPrincipal)) {
      const balance = marginRisk.margin_balance;
      const ratio = marginRisk.maintenance_ratio;
      const riskLabel = marginRisk.interpretation?.label || marginRisk.risk_state || "資料不完整";
      const balanceText = `${number(marginValues.financingPrincipal / 1e8, 2)}億`;
      const collateralText = Number.isFinite(marginValues.collateralMarketValue) ? `${number(marginValues.collateralMarketValue / 1e8, 2)}億` : "—";
      const dailyText = Number.isFinite(balance.daily_change) ? `${balance.daily_change > 0 ? "+" : ""}${number(balance.daily_change / 1e8, 1)}億` : "—";
      const change20Text = Number.isFinite(balance.change_20d) ? `${balance.change_20d > 0 ? "+" : ""}${number(balance.change_20d / 1e8, 1)}億` : "—";
      const balancePosition = Number.isFinite(balance.percentile_60d) ? `${number(balance.percentile_60d, 0)}%` : "—";
      const ratioValue = Number.isFinite(marginValues.maintenanceRatio) ? `${number(marginValues.maintenanceRatio, 2)}%` : "暫無可靠資料";
      const ratioDay = Number.isFinite(ratio?.daily_change) ? `${ratio.daily_change > 0 ? "+" : ""}${number(ratio.daily_change, 1)}點` : "—";
      const ratioAverage = Number.isFinite(ratio?.average_20d) ? `${number(ratio.average_20d, 1)}%` : "—";
      const ratioPosition = Number.isFinite(ratio?.percentile_60d) ? `${number(ratio.percentile_60d, 0)}%` : "—";
      const updateTime = Number.isFinite(Date.parse(marginRisk.updated_at)) ? new Intl.DateTimeFormat("zh-TW", {timeZone:"Asia/Taipei",hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date(marginRisk.updated_at)) : "—";
      const tone=marginRisk.interpretation?.tone||"neutral";
      const verdict=["danger","orange"].includes(tone)||marginValues.maintenanceRatio<140
        ? "偏危險｜若指數轉弱，去槓桿可能加劇賣壓"
        : tone==="calm"&&marginValues.maintenanceRatio>=160
          ? "偏安全｜市場槓桿壓力較低，可留意回檔佈局"
          : "中性｜仍可分批，但不宜過度追價";
      const method=marginRisk.methodology||"逐檔融資餘額搭配還原收盤價與滾動成本，推估市場整體擔保品市值與融資本金。";
      fomoCard.innerHTML = `<header class="homeMarginHeader"><div><span>台股融資風險</span><small>最近交易日盤後｜${escapeHtml(marginValues.dataDate||"—")}</small></div><button type="button" data-open-margin>完整籌碼</button></header><div class="homeMarginKpiGrid"><div><span>融資餘額</span><b>${escapeHtml(balanceText)}</b><small>近20日 ${escapeHtml(change20Text)}</small></div><div><span>單日增減</span><b>${escapeHtml(dailyText)}</b><small>60日位置 ${escapeHtml(balancePosition)}</small></div><div><span>推估維持率</span><b>${escapeHtml(ratioValue)}</b><small>${escapeHtml(riskLabel)}</small></div><div><span>20日均／區間</span><b>${escapeHtml(ratioAverage)}</b><small>60日位置 ${escapeHtml(ratioPosition)}</small></div></div><p class="homeMarginVerdict tone-${escapeHtml(tone)}">${escapeHtml(verdict)}</p><details class="homeMarginDetails"><summary>展開融資風險明細</summary><div class="homeMarginDetailGrid"><span>擔保品估值 <b>${escapeHtml(collateralText)}</b></span><span>推估融資本金 <b>${escapeHtml(balanceText)}</b></span><span>資料覆蓋率 <b>${Number.isFinite(marginRisk.coverage?.coverage_ratio)?escapeHtml(`${number(marginRisk.coverage.coverage_ratio,2)}%`):"—"}</b></span><span>配對檔數 <b>${Number.isFinite(marginRisk.coverage?.matched_count)?escapeHtml(number(marginRisk.coverage.matched_count,0)):"—"}</b></span><span>維持率單日 <b>${escapeHtml(ratioDay)}</b></span><span>最後更新 <b>${escapeHtml(updateTime)}</b></span></div><p>${escapeHtml(method)}</p><small>市場推估融資維持率不代表個人帳戶維持率或追繳狀態。${marginRisk.stale?"｜資料可能過期":""}</small></details>`;
    } else {
      fomoCard.innerHTML = '<header class="homeMarginHeader"><div><span>台股融資風險</span><small>最近交易日盤後資料</small></div><button type="button" data-open-margin>完整籌碼</button></header><div class="newsEmpty">資料尚未更新；首頁與融資風險頁共用最後一筆有效快取，不以舊欄位或 0 代替。</div>';
    }
    if (cnn && Number.isFinite(cnn.score)) {
      const cnnTime = Number.isFinite(Date.parse(cnn.sourceUpdatedAt)) ? new Intl.DateTimeFormat("zh-TW", {timeZone: "Asia/Taipei", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false}).format(new Date(cnn.sourceUpdatedAt)) : "—";
      cnnCard.innerHTML = `<span>CNN Fear &amp; Greed</span><b class="${cnn.score >= 56 ? "twUp" : cnn.score <= 44 ? "twDown" : "twFlat"}">${number(cnn.score, 0)}</b><em>${escapeHtml(cnn.label)}</em><small>${escapeHtml(cnn.summary)}<i class="sentimentFreshness">更新 ${escapeHtml(cnnTime)}</i></small>`;
    } else {
      cnnCard.innerHTML = "<span>CNN Fear &amp; Greed</span><b>—</b><em>資料暫時無法取得</em><small>不會以 0 分代替失敗資料</small>";
    }
    try {
      $v6("#homeSentimentConclusion").textContent = combinedSentimentConclusion();
    } catch {
      $v6("#homeSentimentConclusion").textContent = "情緒資料彙整中…";
    }
  }

  function applySharedQuotes(event) {
    const incoming=event?.detail?.quotes;
    if(!(incoming instanceof Map))return;
    publicQuoteMap=new Map(incoming);
    const sourceTime=Date.parse(event.detail.sourceUpdatedAt||"");
    if(Number.isFinite(sourceTime))lastSuccessAt=sourceTime;
    const applyPortfolio=$v6("#portfolioAutoRefresh").checked||pendingManualPortfolioApply;
    pendingManualPortfolioApply=false;
    reconcilePortfolioQuotes(publicQuoteMap, {applyPortfolio, sourceUpdatedAt: event.detail.sourceUpdatedAt||""});
    renderQuoteStatus(`${quoteTimeLabel()}｜${event.detail.source==="authorized_proxy"?"授權延遲行情":"公開快取"}`);
  }

  function updateTargetAllocation(event) {
    const input = event.currentTarget;
    const code = core.normalizeCode(input.dataset.rebalanceTarget);
    const raw = String(input.value || "").trim();
    const targetAllocation = raw === "" ? null : Number(raw);
    if (targetAllocation !== null && (!Number.isFinite(targetAllocation) || targetAllocation < 0 || targetAllocation > 100)) {
      input.setCustomValidity("目標配置必須介於 0 到 100%。");
      return;
    }
    input.setCustomValidity("");
    holdings = holdings.map(item => item.code === code ? core.validateHolding({...item, targetAllocation}) : item);
    saveHoldings();
    refreshPortfolio(false, {focusTarget: code});
  }

  function useCurrentAllocationAsTargets() {
    const targets = core.targetsFromAllocation(computed.rows);
    if (!targets.length) return;
    const targetMap = new Map(targets.map(item => [item.code, item.targetAllocation]));
    holdings = holdings.map(item => core.validateHolding({...item, targetAllocation: targetMap.get(item.code) ?? item.targetAllocation}));
    saveHoldings();
    refreshPortfolio();
  }

  function showRebalanceSimulation() {
    const simulation = $v6("#rebalanceSimulation");
    if (!latestRebalanceAdvice?.formal) {
      simulation.hidden = false;
      simulation.textContent = "請先將目標配置完成至 100%，再查看模擬後配置。";
      return;
    }
    const actions = latestRebalanceAdvice.rows.filter(row => Number(row.suggestedAmount) !== 0).map(row => {
      const action = row.suggestedAmount > 0 ? `模擬投入 ${money(row.suggestedAmount)}` : `模擬部分調整 ${money(Math.abs(row.suggestedAmount))}`;
      return `${row.code}：${action}，調整後約 ${number(row.afterWeight, 1)}%`;
    });
    simulation.hidden = false;
    simulation.innerHTML = `<b>本次建議摘要（僅模擬，不會改變持股）</b><br>${escapeHtml(actions.length ? actions.join("；") : "目前配置位於容忍區間，本次不需調整。")}`;
  }

  function bindEvents() {
    $v6("#portfolioAddBtn").addEventListener("click", () => ledger ? openTransaction() : openPortfolioModal());
    $v6("#portfolioModalClose").addEventListener("click", closePortfolioModal);
    $v6("#portfolioModal").addEventListener("click", event => { if (event.target === $v6("#portfolioModal")) closePortfolioModal(); });
    $v6("#portfolioForm").addEventListener("submit", submitPortfolio);
    $v6("#portfolioCode").addEventListener("input", event => {
      event.target.value = core.normalizeCode(event.target.value).replace(/[^0-9A-Z]/g, "").slice(0, 10);
      searchCatalog(event.target.value);
    });
    $v6("#portfolioDuplicateActions").querySelectorAll("[data-duplicate-action]").forEach(button => button.addEventListener("click", () => duplicateAction(button.dataset.duplicateAction)));
    $v6("#portfolioSort").addEventListener("change", renderList);
    $v6("#portfolioExportBtn").addEventListener("click", exportHoldings);
    $v6("#portfolioImportBtn").addEventListener("click", () => $v6("#portfolioImportFile").click());
    $v6("#portfolioImportFile").addEventListener("change", event => importHoldings(event.target.files?.[0]));
    $v6("#portfolioClearBtn").addEventListener("click", clearHoldings);
    $v6("#portfolioTransactionAddBtn").addEventListener("click", () => openTransaction());
    $v6("#portfolioLedgerViewBtn").addEventListener("click", openLedger);
    $v6("#portfolioLedgerMigrateBtn").addEventListener("click", migrateLedger);
    document.querySelectorAll("[data-ledger-close]").forEach(button=>button.addEventListener("click",closeLedgerModals));
    $v6("#portfolioTransactionType").addEventListener("change",transactionVisibility);
    $v6("#portfolioTransactionForm").addEventListener("submit",submitTransaction);
    $v6("#portfolioLedgerFilters").addEventListener("click",event=>{const button=event.target.closest("[data-ledger-filter]");if(!button)return;ledgerFilter=button.dataset.ledgerFilter;$v6("#portfolioLedgerFilters").querySelectorAll("button").forEach(node=>node.classList.toggle("active",node===button));renderAllLedger()});
    $v6("#portfolioLedgerAllList").addEventListener("click",event=>{const edit=event.target.closest("[data-ledger-edit]"),remove=event.target.closest("[data-ledger-delete]");if(edit)openTransaction(edit.dataset.ledgerEdit);else if(remove)deleteLedgerEvent(remove.dataset.ledgerDelete)});
    $v6("#portfolioLedgerContent").addEventListener("click",event=>{if(event.target.closest("[data-ledger-migrate-open]"))openMigration()});
    $v6("#portfolioLedgerReconciliation").addEventListener("click",event=>{if(event.target.closest("[data-ledger-view]"))openLedger()});
    $v6("#portfolioRefreshBtn").addEventListener("click", () => updateQuotes({force: true, applyPortfolio: true}));
    $v6("#portfolioAutoRefresh").checked = localStorage.getItem(AUTO_KEY) !== "0";
    $v6("#portfolioAutoRefresh").addEventListener("change", event => {
      localStorage.setItem(AUTO_KEY, event.target.checked ? "1" : "0");
      if (event.target.checked) updateQuotes({force: true, applyPortfolio: true});
      else {
        reconcilePortfolioQuotes(new Map(), {applyPortfolio: false, sourceUpdatedAt: ""});
        renderQuoteStatus(`${quoteTimeLabel()}；持股自動更新已關閉`);
      }
    });
    const rebalanceIds = ["rebalanceCash", "rebalanceProfile", "rebalanceCustomTolerance", "rebalanceReminder", "rebalanceCustomDays", "rebalanceCashFirst", "rebalanceTrendProtection"];
    $v6("#rebalanceCash").value = rebalanceSettings.cash;
    $v6("#capitalPlanCash").value = rebalanceSettings.cash;
    $v6("#rebalanceCash").disabled = Boolean(ledger);
    $v6("#capitalPlanCash").disabled = Boolean(ledger);
    applyLedgerUiMode();
    $v6("#rebalanceProfile").value = rebalanceSettings.profile;
    $v6("#rebalanceCustomTolerance").value = rebalanceSettings.customTolerance;
    $v6("#rebalanceReminder").value = rebalanceSettings.reminder;
    $v6("#rebalanceCustomDays").value = rebalanceSettings.customDays;
    $v6("#rebalanceCashFirst").checked = rebalanceSettings.cashFirst;
    $v6("#rebalanceTrendProtection").checked = rebalanceSettings.trendProtection;
    const syncRebalanceControls = () => {
      $v6("#rebalanceCustomToleranceWrap").hidden = $v6("#rebalanceProfile").value !== "custom";
      $v6("#rebalanceCustomDaysWrap").hidden = $v6("#rebalanceReminder").value !== "custom";
    };
    const updateRebalanceSettings = () => {
      rebalanceSettings = {
        cash: ledgerState?.valid ? ledgerState.cash : Math.max(0, Number($v6("#rebalanceCash").value) || 0), profile: $v6("#rebalanceProfile").value,
        customTolerance: Number($v6("#rebalanceCustomTolerance").value), reminder: $v6("#rebalanceReminder").value,
        customDays: Number($v6("#rebalanceCustomDays").value), cashFirst: $v6("#rebalanceCashFirst").checked,
        trendProtection: $v6("#rebalanceTrendProtection").checked
      };
      $v6("#capitalPlanCash").value = rebalanceSettings.cash;
      saveRebalanceSettings(); syncRebalanceControls(); refreshPortfolio();
    };
    $v6("#rebalanceCash").addEventListener("input", updateRebalanceSettings);
    $v6("#capitalPlanCash").addEventListener("input", event => {
      $v6("#rebalanceCash").value = Math.max(0, Number(event.target.value) || 0);
      updateRebalanceSettings();
    });
    rebalanceIds.filter(id => id !== "rebalanceCash").forEach(id => $v6(`#${id}`).addEventListener("change", updateRebalanceSettings));
    $v6("#rebalanceUseCurrentBtn").addEventListener("click", useCurrentAllocationAsTargets);
    $v6("#rebalanceApplyBtn").addEventListener("click", showRebalanceSimulation);
    syncRebalanceControls();
    $v6("#portfolioPerformancePeriods").addEventListener("click", event => {
      const button = event.target.closest("[data-performance-period]");
      if (!button) return;
      performancePeriod = button.dataset.performancePeriod;
      renderPerformance();
      renderRiskCenter();
    });
    $v6("#portfolioBenchmarkToggle").addEventListener("change", renderPerformance);
    $v6("#portfolioChart").addEventListener("click", chartHit);
    $v6("#portfolioChart").addEventListener("touchstart", chartHit, {passive: true});
    $v6("#portfolioChart").addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Enter", " "].includes(event.key) || !chartSegments.length) return;
      event.preventDefault();
      if (event.key === "ArrowLeft") showChartDetail(chartSelection - 1);
      else if (event.key === "ArrowRight") showChartDetail(chartSelection + 1);
      else showChartDetail(chartSelection < 0 ? 0 : chartSelection);
    });
    $v6("#homeSentimentCards").addEventListener("click", event => { const card=event.target.closest("[data-home-chip]");if(!card)return;switchTab("sentiment");if(typeof switchChipTab==="function")switchChipTab(card.dataset.homeChip,{scroll:false}); });
    document.querySelector('[data-tab="portfolio"]').addEventListener("click", () => {
      refreshPortfolio();
      if ($v6("#portfolioAutoRefresh").checked) updateQuotes();
    });
    window.addEventListener("hs:delayed-quotes",applySharedQuotes);
    window.addEventListener("hs:delayed-quotes-error",()=>{
      reconcilePortfolioQuotes(new Map(), {applyPortfolio: true, sourceUpdatedAt: ""});
      renderQuoteStatus("行情更新失敗，已保留最後有效資料");
    });
    window.addEventListener("resize", () => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => { drawAllocation(); renderPerformance(); renderRiskCenter(); });
    }, {passive: true});
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && $v6("#portfolioModal").classList.contains("show")) closePortfolioModal();
      if (event.key === "Escape") closeLedgerModals();
    });
    const sentimentObserver = new MutationObserver(renderHomeSentiment);
    sentimentObserver.observe($v6("#fomoContent"), {childList: true});
    sentimentObserver.observe($v6("#cnnFearGreedContent"), {childList: true});
  }

  bindEvents();
  refreshPortfolio();
  fetch(BENCHMARK_URL, {cache: "no-store", headers: {"Accept": "application/json"}}).then(response => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }).then(payload => {
    benchmarkRows = Array.isArray(payload?.items?.["0050"]?.rows) ? payload.items["0050"].rows : [];
    renderPerformance(); renderRiskCenter();
  }).catch(() => { benchmarkRows = []; renderPerformance(); renderRiskCenter(); });
  renderHomeSentiment();
  const initialShared=window.HSLiveMarket?.latestQuotes?.();
  if(initialShared instanceof Map&&initialShared.size)applySharedQuotes({detail:{quotes:initialShared,sourceUpdatedAt:"",source:"shared_cache"}});

  window.HSPortfolioV6 = Object.freeze({
    storageKey: HOLDINGS_KEY,
    quoteStorageKey: QUOTES_KEY,
    quoteSources: Object.freeze([TWSE_URL, TPEX_URL]),
    snapshotMode: "FORWARD_SNAPSHOT_ONLY",
    refresh: () => updateQuotes({force: true, applyPortfolio: true}),
    getState: () => ({holdings: holdings.map(item => ({...item})), quotes: new Map([...quoteMap].map(([code, quote]) => [code, {...quote}]))})
  });
  window.dispatchEvent(new CustomEvent("hs:portfolio-state"));
})();
