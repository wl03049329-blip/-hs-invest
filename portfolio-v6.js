(function () {
  "use strict";

  const core = window.HSPortfolioCore;
  const performanceCore = window.HSPortfolioPerformanceCore;
  const ledgerCore = window.HSPortfolioLedgerCore;
  const analyticsCore = window.HSPortfolioAnalyticsCore;
  const workflowCore = window.HSPortfolioWorkflowCore;
  const resilienceCore = window.HSPortfolioResilienceCore;
  const dashboardCore = window.HSPortfolioDashboardCore;
  const fullBackupCore = window.HSPortfolioFullBackupCore;
  if (!core || !performanceCore || !ledgerCore || !analyticsCore || !workflowCore || !resilienceCore || !dashboardCore || !fullBackupCore) return;
  if (!fullBackupCore.recoverPendingRestore(localStorage).ok) { console.error("Portfolio 備份還原中斷，請勿修改資料。 "); return; }

  const storageKeys = window.HSPersistenceCore?.keys || {};
  const HOLDINGS_KEY = storageKeys.holdings || "hsRadar.portfolio.holdings";
  const QUOTES_KEY = storageKeys.quotes || "hsRadar.portfolio.quotes";
  const AUTO_KEY = storageKeys.portfolioAuto || "hsRadar.portfolio.autoRefresh";
  const MARKET_VERSION_KEY = storageKeys.portfolioMarketVersion || "hsRadar.portfolio.marketVersion";
  const REBALANCE_SETTINGS_KEY = storageKeys.portfolioRebalanceSettings || "hsRadar.portfolio.rebalanceSettings";
  const TWSE_URL = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL";
  const TPEX_URL = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes";
  const MARKET_CACHE_URL = "market-quotes.json";
  const ETF_UNIVERSE_URL = "etf-universe.json";
  const MARKET_META_URL = "market-quotes-meta.json";
  const BENCHMARK_URL = "backtest/long-term/historical-adjusted.json";
  const COLORS = ["#52e38c", "#72b8ff", "#ff9d42", "#bd72ff", "#ff6674", "#ffd84d", "#42d7d1", "#d9a7ff"];
  const $v6 = selector => document.querySelector(selector);
  const etfCatalog = window.HSPortfolioEtfCatalog;
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[char]));

  let holdings = loadHoldings();
  let quoteMap = loadQuoteCache();
  let publicQuoteMap = new Map();
  let computed = core.calculatePortfolio(dashboardCore.effectiveHoldings(holdings), quoteMap, {now: Date.now()});
  let pendingDuplicate = null;
  let editingCode = null;
  let catalog = [];
  let catalogLoading = null;
  let refreshTimer = null;
  let refreshInFlight = null;
  let lastAttemptAt = 0;
  let lastSuccessAt = latestCachedFetchTime();
  let officialCheckedAt = [...quoteMap.values()].map(quote => Date.parse(quote.officialCheckedAt)).filter(Number.isFinite).sort((a,b) => b-a)[0] || 0;
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
  let historicalRowsBySymbol = new Map();
  let holdingsSortDirection = "desc";
  let activePortfolioTool = "overview";
  let targetDraft = new Map();
  let portfolioAnalysisPeriod = "1M";
  let ledger = loadLedger();
  let ledgerState = ledger ? ledgerCore.derivePortfolioStateFromLedger(ledger.events) : null;
  let ledgerFilter = "ALL";
  let editingLedgerEventId = null;
  let analyticsTab = "OVERVIEW";
  let analyticsDividendYear = "";
  let analyticsMonth = "";
  let portfolioGoal = loadWorkflowValue(workflowCore.GOAL_STORAGE_KEY, workflowCore.normalizeGoal);
  let portfolioMonthlyPlan = loadWorkflowValue(workflowCore.PLAN_STORAGE_KEY, workflowCore.normalizeMonthlyPlan);
  let portfolioImportState = loadWorkflowValue(workflowCore.IMPORT_STORAGE_KEY, value => value && typeof value === "object" ? value : null);
  let portfolioRecoveryPoints = loadWorkflowValue(resilienceCore.RECOVERY_STORAGE_KEY, value => Array.isArray(value) ? value : []) || [];
  let portfolioImportHistory = loadWorkflowValue(resilienceCore.IMPORT_HISTORY_STORAGE_KEY, value => Array.isArray(value) ? value : []) || [];
  let portfolioAudit = null;
  let csvImportPreview = null;
  let csvImportFileName = "";
  let annualReport = null;

  function loadWorkflowValue(key, validator) { try { return validator(JSON.parse(localStorage.getItem(key) || "null")); } catch { return null; } }
  function saveWorkflowValue(key, value) { if (value) localStorage.setItem(key, JSON.stringify(value)); else localStorage.removeItem(key); }
  function resilienceState(){return{holdings:holdings.map(({code,shares,averageCost,customName,name,strategyType,targetAllocation})=>({code,shares,averageCost,customName,name,strategyType,targetAllocation})),ledger,snapshots:portfolioHistory,rebalanceSettings,goal:portfolioGoal,monthlyPlan:portfolioMonthlyPlan,importState:portfolioImportState,importHistory:portfolioImportHistory,audit:portfolioAudit}}
  function createRecovery(reason){const point=resilienceCore.createRecoveryPoint({reason,state:resilienceState()});portfolioRecoveryPoints=resilienceCore.appendRecoveryPoint(portfolioRecoveryPoints,point);saveWorkflowValue(resilienceCore.RECOVERY_STORAGE_KEY,portfolioRecoveryPoints);return point}

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
    const fallback = {cash: 0, profile: "trend", customTolerance: 3, reminder: "90", customDays: 60, cashFirst: true, trendProtection: true, targets: {}};
    try {
      const raw = JSON.parse(localStorage.getItem(REBALANCE_SETTINGS_KEY) || "null");
      if (!raw || typeof raw !== "object") return fallback;
      const cash = Number(raw.cash), customTolerance = Number(raw.customTolerance), customDays = Number(raw.customDays);
      return {
        cash: Number.isFinite(cash) ? cash : 0,
        profile: ["conservative", "balanced", "trend", "custom"].includes(raw.profile) ? raw.profile : "trend",
        customTolerance: Number.isFinite(customTolerance) && customTolerance > 0 && customTolerance <= 20 ? customTolerance : 3,
        reminder: ["30", "90", "custom"].includes(String(raw.reminder)) ? String(raw.reminder) : "90",
        customDays: Number.isFinite(customDays) && customDays >= 7 && customDays <= 365 ? Math.round(customDays) : 60,
        cashFirst: raw.cashFirst !== false,
        trendProtection: raw.trendProtection !== false,
        targets: Object.fromEntries(Object.entries(raw.targets && typeof raw.targets === "object" && !Array.isArray(raw.targets) ? raw.targets : {}).map(([code,value])=>[core.normalizeCode(code),dashboardCore.normalizeTarget(value)]).filter(([code,target])=>core.CODE_PATTERN.test(code)&&target.ok).map(([code,target])=>[code,target.value]))
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
  function effectiveHoldings() { return dashboardCore.effectiveHoldings(holdings); }
  function targetAllocationItems() {
    return dashboardCore.targetAllocationItems(effectiveHoldings(),rebalanceSettings.targets).map(item=>item.shares>0?item:{...item,name:catalog.find(entry=>entry.code===item.code)?.name||item.code,marketValue:0,allocationValue:0,weight:0,quoteStatus:"not_held"});
  }
  function rebalanceRows() {
    const actual=new Map(computed.rows.map(row=>[row.code,row]));
    return targetAllocationItems().map(item=>actual.get(item.code)||item);
  }

  function syncDerivedPortfolio() {
    if (!ledger) return;
    ledgerState = ledgerCore.derivePortfolioStateFromLedger(ledger.events);
    if (!ledgerState.valid) return;
    const previous = new Map(holdings.map(item => [item.code, item]));
    const nextCodes=new Set(ledgerState.holdings.map(row=>row.symbol));
    for(const item of holdings)if(!nextCodes.has(item.code)&&Number.isFinite(item.targetAllocation))rebalanceSettings.targets[item.code]=item.targetAllocation;
    holdings = ledgerState.holdings.map(row => {
      const meta = previous.get(row.symbol) || {};
      return core.validateHolding({code: row.symbol, shares: row.quantity, averageCost: row.averageCost, customName: meta.customName || "", name: meta.name || "", strategyType: meta.strategyType || "", targetAllocation: meta.targetAllocation ?? rebalanceSettings.targets[row.symbol]});
    });
    rebalanceSettings = {...rebalanceSettings, cash: ledgerState.cash};
    saveHoldings(); saveRebalanceSettings();
  }

  function applyLedgerUiMode() {
    const add=$v6("#portfolioAddBtn"),cash=$v6("#rebalanceCash");
    if(add){add.textContent="＋ 新增交易";add.setAttribute("aria-label","新增交易")}
    if(cash)cash.disabled=Boolean(ledger);
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
          officialMarketDate: String(quote.officialMarketDate || ""),
          officialCheckedAt: String(quote.officialCheckedAt || ""),
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

  function cost(value) {
    return Number.isFinite(value) ? dashboardCore.fixedCost(value) : "—";
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
    const published = new Intl.DateTimeFormat("zh-TW", {
      timeZone: "Asia/Taipei", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    }).format(new Date(lastSuccessAt));
    const checked = officialCheckedAt ? `｜官方抓取 ${new Intl.DateTimeFormat("zh-TW", {timeZone: "Asia/Taipei", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false}).format(new Date(officialCheckedAt))}` : "";
    return `快取發佈 ${published}${checked}`;
  }

  function portfolioFreshnessLabel() {
    const count=effectiveHoldings().length;
    if (!count) return "尚未新增持股";
    const lagged = computed.rows.filter(row => quoteSessionLagged(row)).length;
    const current = computed.rows.filter(row => row.quoteStatus === "current").length - lagged;
    const stale = computed.rows.filter(row => row.quoteStatus === "stale").length;
    const missing = count - current - stale;
    const parts = [];
    if (current) parts.push(`${current} 檔最新`);
    if (lagged) parts.push(`${lagged} 檔沿用最後有效收盤`);
    if (stale) parts.push(`${stale} 檔最後有效資料`);
    if (missing) parts.push(`${missing} 檔行情暫缺`);
    return `持股行情：${parts.join("、") || "行情暫缺"}`;
  }

  function quoteSessionLagged(row) {
    const quote = row?.quote;
    return row?.quoteStatus === "current" && /^\d{4}-\d{2}-\d{2}$/.test(quote?.date || "")
      && /^\d{4}-\d{2}-\d{2}$/.test(quote?.officialMarketDate || "")
      && quote.date < quote.officialMarketDate;
  }

  function quoteSessionLabel(row) {
    return quoteSessionLagged(row) ? `最後有效收盤｜${row.quote.date}` : "";
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
    const heroValue = $v6("#portfolioHeroMarketValue");
    const holdingCount = $v6("#portfolioHoldingCount");
    const summary=dashboardCore.hero(computed.rows);
    holdingCount.textContent = summary.holdingCount ? `持有 ${summary.holdingCount} 檔` : "尚未建立持股";
    const fields=[
      ["#portfolioHeroTodayPnl",summary.todayPnl,"#portfolioHeroTodayRate",summary.todayStatus==="partial"?"部分行情缺失":Number.isFinite(summary.todayRate)?percent(summary.todayRate):summary.holdingCount?"行情資料不完整":"尚無持股"],
      ["#portfolioHeroUnrealizedPnl",summary.unrealizedPnl,"#portfolioHeroUnrealizedRate",summary.unrealizedStatus==="partial"?summary.unrealizedReason:Number.isFinite(summary.unrealizedRate)?percent(summary.unrealizedRate):summary.holdingCount?"成本或行情資料不完整":"尚無持股"]
    ];
    fields.forEach(([valueSelector,value,noteSelector,note])=>{const valueNode=$v6(valueSelector),noteNode=$v6(noteSelector);valueNode.textContent=Number.isFinite(value)?money(value):"—";valueNode.className=valueClass(value);noteNode.textContent=note;noteNode.className=valueClass(Number.isFinite(value)?value:null)});
    heroValue.textContent=Number.isFinite(summary.stockMarketValue)?money(summary.stockMarketValue):"—";
    const cash=ledgerState?.valid?ledgerState.cash:rebalanceSettings.cash;
    $v6("#portfolioHeroCash").textContent=money(cash);
    $v6("#portfolioHeroTotalAssets").textContent=summary.marketValueStatus==="complete"||summary.holdingCount===0?money((summary.stockMarketValue||0)+cash):"—";
    $v6("#portfolioHeroAssetNote").textContent=summary.marketValueStatus==="partial"?"部分行情缺失，總資產暫不估算":summary.holdingCount&&summary.marketValueStatus!=="complete"?"行情暫缺，總資產暫不估算":"持股市值＋現金";
    $v6("#portfolioHeroCostBasis").textContent=summary.marketValueStatus==="partial"?"部分行情缺失":Number.isFinite(summary.remainingCostBasis)?`成本 ${money(summary.remainingCostBasis)}`:summary.holdingCount?"成本資料不完整":"成本 —";
  }

  function holdingName(row) {
    return row.customName || catalog.find(item => item.code === row.code)?.name || row.name || row.quote?.name || row.code;
  }

  function radarFor(code) {
    try {
      const formal = window.HSFormalCoreScoreAdapter?.scoreFor?.(code);
      if (!formal?.available) return formal?.reason==="UNSUPPORTED_SYMBOL"?null:{score:null,rawScore:null,scoreSource:null,scoreDate:null,scoreStatus:formal?.reason||"UNAVAILABLE",coreLabel:formal?.reason==="WAIT_NATIVE"?"WAIT_NATIVE":"正式分數暫不可用",trend:"趨勢資料暫缺",action:"買點資料暫缺",strategyType:"",swing:null};
      const item = Array.isArray(all) ? all.find(entry => entry.id === code) : null;
      const score = Number(formal.display_score),rawScore=Number(formal.score);
      const classification = Number.isFinite(rawScore) ? window.HSFinalCoreProduction?.labelFor?.(rawScore) : null;
      return {score: Number.isFinite(score) ? score : null, rawScore: Number.isFinite(rawScore) ? rawScore : null, scoreSource: formal.source, scoreDate: formal.trading_date, coreLabel: classification?.label || "正式訊號暫缺", trend: item?.trend?.label || "趨勢資料暫缺", action: item?.action || "買點資料暫缺", strategyType: item?.activeStrategyMode || "", swing: item?.swingDecision || null};
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
    const rows = computed.rows.map(row => ({...row, coreScore: radarFor(row.code)?.score ?? null,...dashboardCore.trends(historicalRowsBySymbol.get(row.code)||[])}));
    return dashboardCore.sortRows(rows,mode,holdingsSortDirection);
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
    const list=$v6("#portfolioList"),viewport=$v6("#portfolioHoldingsTableViewport"),empty=$v6("#portfolioHoldingsEmpty");
    if (!effectiveHoldings().length) {
      list.innerHTML="";$v6("#portfolioMobileHoldings").innerHTML="";viewport.hidden=true;empty.hidden=false;empty.querySelector("[data-portfolio-empty-add]")?.addEventListener("click",()=>ledger?openTransaction():openPortfolioModal());
      return;
    }
    viewport.hidden=false;empty.hidden=true;
    list.innerHTML = sortedRows().map(row => {
      const radar = radarFor(row.code);
      const current=row.quoteStatus==="current",name=holdingName(row),score=radar?.score;
      const totalPnlRate=Number.isFinite(row.returnRate)?row.returnRate:null;
      return `<article class="portfolioHoldingRow" role="row" data-holding-code="${escapeHtml(row.code)}">
        <button type="button" class="holdingColSymbol" role="cell" data-edit-holding="${escapeHtml(row.code)}" aria-label="開啟 ${escapeHtml(row.code)} 持股編輯"><b>${escapeHtml(name)}</b><span>${escapeHtml(row.code)}${radar?` <em>HS ${Number.isFinite(score)?number(score,0):"—"}</em>`:""}</span></button>
        <div role="cell"><b class="${valueClass(current?row.todayPnl:null)}">${current&&Number.isFinite(row.todayPnl)?money(row.todayPnl):"—"}</b></div>
        <div role="cell"><b class="${valueClass(current?row.changeRate:null)}">${current&&Number.isFinite(row.changeRate)?percent(row.changeRate):"—"}</b><small>${current&&Number.isFinite(row.quote?.price)?money(row.quote.price):"行情暫缺"}</small>${quoteSessionLagged(row)?`<small class="portfolioQuoteAge">${escapeHtml(quoteSessionLabel(row))}</small>`:""}</div>
        <div role="cell"><b class="${valueClass(current?row.totalPnl:null)}">${current&&Number.isFinite(row.totalPnl)?money(row.totalPnl):"—"}</b><small class="${valueClass(totalPnlRate)}">${current?percent(totalPnlRate):"—"}</small></div>
        <div role="cell"><b>${number(row.shares,4)}</b></div>
        <div role="cell"><b>${cost(row.averageCost)}</b><small>${cost(row.totalCost)}</small></div>
        <div role="cell"><b>${current?plainPercent(row.weight):"—"}</b></div>
        <div role="cell" class="holdingTargetCell"><button type="button" class="holdingTargetButton ${Number.isFinite(row.targetAllocation)?"is-set":"is-unset"}" data-target-edit="${escapeHtml(row.code)}"><span>${dashboardCore.targetDisplay(row.targetAllocation)}</span><small>點擊編輯</small></button></div>
        <div role="cell"><b class="${valueClass(row.fiveDay)}">${percent(row.fiveDay)}</b></div>
        <div role="cell"><b class="${valueClass(row.twentyDay)}">${percent(row.twentyDay)}</b></div>
        <div role="cell"><b class="${valueClass(row.ytd)}">${percent(row.ytd)}</b></div>
      </article>`;
    }).join("");
    const mobile=$v6("#portfolioMobileHoldings");
    mobile.innerHTML=sortedRows().map(row=>{const current=row.quoteStatus==="current",name=holdingName(row),radar=radarFor(row.code);return `<article class="portfolioMobileHolding"><button type="button" data-mobile-holding="${escapeHtml(row.code)}" class="portfolioMobileHoldingHead"><span><b>${escapeHtml(name)}</b><small>${escapeHtml(row.code)}${radar?`｜HS ${Number.isFinite(radar.score)?number(radar.score,0):"—"}`:""}</small></span><span aria-hidden="true">›</span></button><div class="portfolioMobileHoldingValue"><span>持股市值</span><b>${current&&Number.isFinite(row.marketValue)?money(row.marketValue):"行情暫缺"}</b>${quoteSessionLagged(row)?`<small class="portfolioQuoteAge">${escapeHtml(quoteSessionLabel(row))}</small>`:""}<small>目前資產占比 ${current&&Number.isFinite(row.weight)?plainPercent(row.weight):"—"}</small></div><div class="portfolioMobileHoldingMetrics"><span>今日損益 <b class="${valueClass(current?row.todayPnl:null)}">${current&&Number.isFinite(row.todayPnl)?money(row.todayPnl):"—"}</b></span><span>未實現損益 <b class="${valueClass(current?row.totalPnl:null)}">${current&&Number.isFinite(row.totalPnl)?money(row.totalPnl):"—"}</b></span><span>股數 <b>${number(row.shares,4)}</b></span><span>平均成本 <b>${cost(row.averageCost)}</b></span></div></article>`}).join("");
    mobile.querySelectorAll("[data-mobile-holding]").forEach(button=>button.addEventListener("click",()=>ledger?openLedger():openPortfolioModal(button.dataset.mobileHolding)));
    list.querySelectorAll("[data-edit-holding]").forEach(button=>button.addEventListener("click",()=>ledger?openLedger():openPortfolioModal(button.dataset.editHolding)));
    list.querySelectorAll("[data-target-edit]").forEach(button=>button.addEventListener("click",openTargetModal));
  }

  function targetBatchSummary() {
    const inputs=[...$v6("#portfolioTargetBatchRows").querySelectorAll("[data-target-batch]")];
    const summary=dashboardCore.targetSummary(inputs.map(input=>input.value));
    const output=$v6("#portfolioTargetBatchTotal");
    output.className=`portfolioTargetBatchTotal is-${summary.status}`;
    output.textContent=summary.status==="complete"?`目標配置合計 ${dashboardCore.fixedOne(summary.total)} ✓`:summary.status==="under"?`目標配置合計 ${dashboardCore.fixedOne(summary.total)}｜尚差 ${dashboardCore.fixedOne(summary.gap)}`:`目標配置合計 ${dashboardCore.fixedOne(summary.total)}｜超出 ${dashboardCore.fixedOne(Math.abs(summary.gap))}`;
    return{inputs,summary};
  }

  function renderTargetDraft() {
    const rows=$v6("#portfolioTargetBatchRows");
    rows.innerHTML=targetDraft.size?[...targetDraft].map(([code,value])=>{
      const item=targetAllocationItems().find(row=>row.code===code);
      const name=item?holdingName(item):catalog.find(row=>row.code===code)?.name||code;
      return `<div class="portfolioTargetBatchRow"><label for="target-${escapeHtml(code)}"><b>${escapeHtml(code)}</b><small>${escapeHtml(name)}${item?.shares===0?"｜尚未持有":""}</small></label><span><input id="target-${escapeHtml(code)}" type="number" min="0" max="100" step="0.1" inputmode="decimal" value="${escapeHtml(value)}" data-target-batch="${escapeHtml(code)}" aria-label="${escapeHtml(code)} 目標佔比"><em>%</em><button type="button" data-target-remove="${escapeHtml(code)}" aria-label="移除 ${escapeHtml(code)} 的目標配置">移除</button></span></div>`;
    }).join(""):'<p class="rebalancePending">尚未設定目標；可搜尋代號或名稱加入 ETF。</p>';
    rows.querySelectorAll("[data-target-batch]").forEach(input=>input.addEventListener("input",()=>{targetDraft.set(input.dataset.targetBatch,input.value);targetBatchSummary()}));
    rows.querySelectorAll("[data-target-remove]").forEach(button=>button.addEventListener("click",()=>{targetDraft.delete(button.dataset.targetRemove);renderTargetDraft()}));
    targetBatchSummary();
  }

  function openTargetModal() {
    const modal=$v6("#portfolioTargetModal"),rows=$v6("#portfolioTargetBatchRows");
    targetDraft=new Map(targetAllocationItems().filter(item=>Number.isFinite(item.targetAllocation)).map(item=>[item.code,String(item.targetAllocation)]));
    $v6("#portfolioTargetBatchError").textContent="";
    renderTargetDraft();modal.classList.add("show");modal.setAttribute("aria-hidden","false");
    loadCatalog().then(()=>{$v6("#portfolioTargetSuggestions").innerHTML=catalog.map(item=>`<option value="${escapeHtml(item.code)}" label="${escapeHtml(item.name)}"></option>`).join("")});
  }

  function closeTargetModal(){const modal=$v6("#portfolioTargetModal");modal.classList.remove("show");modal.setAttribute("aria-hidden","true")}

  function addTargetSymbol() {
    const input=$v6("#portfolioTargetSymbol"),query=input.value.trim(),match=catalog.find(row=>row.code===core.normalizeCode(query)||row.name===query),code=core.normalizeCode(match?.code||query),error=$v6("#portfolioTargetBatchError");
    if(!core.CODE_PATTERN.test(code)){error.textContent="請輸入有效的 4–10 碼標的代號。";return}
    if(targetDraft.has(code)){error.textContent="此標的已在目標配置清單。";return}
    targetDraft.set(code,"");error.textContent="";renderTargetDraft();input.value="";
    $v6(`[data-target-batch="${CSS.escape(code)}"]`)?.focus();
  }

  function saveTargetBatch(event) {
    event.preventDefault();
    const {inputs,summary}=targetBatchSummary(),error=$v6("#portfolioTargetBatchError");
    if(!summary.valid||inputs.some(input=>dashboardCore.normalizeTarget(input.value).value===null)){error.textContent="每檔目標配置需為 0–100，最多一位小數。";return}
    if(!summary.complete){error.textContent=`儲存前目標配置須合計 100%（目前 ${number(summary.total,1)}%）。`;return}
    const nextTargets={},next=holdings.map(item=>{const targetAllocation=targetDraft.has(item.code)?dashboardCore.normalizeTarget(targetDraft.get(item.code)).value:null;return item.targetAllocation===targetAllocation?item:core.validateHolding({...item,targetAllocation})});
    for(const [code,value] of targetDraft)if(!next.some(item=>item.code===code))nextTargets[code]=dashboardCore.normalizeTarget(value).value;
    holdings=next;rebalanceSettings.targets=nextTargets;saveHoldings();saveRebalanceSettings();closeTargetModal();refreshPortfolio();
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
    const rows = rebalanceRows();
    const advice = core.calculateRebalanceAdvice({
      rows: rows.map(row => ({code: row.code, marketValue: row.allocationValue, targetAllocation: row.targetAllocation, trend: rebalanceTrend(row)})),
      ...rebalanceSettings
    });
    latestRebalanceAdvice = advice;
    const allocationState = dashboardCore.targetSummary(rows.map(row=>row.targetAllocation));
    const total = allocationState.total;
    const totalMessage = targetTotalMessage(total, allocationState.complete);
    const cash = Number.isFinite(rebalanceSettings.cash) ? rebalanceSettings.cash : 0;
    const allocationTotal = Number.isFinite(computed.allocationTotal) ? computed.allocationTotal : 0;
    const estimated = Boolean(computed.allocationEstimated);
    const totalAssets = allocationTotal + cash;
    $v6("#rebalanceTotalAssets").textContent = rows.length ? money(totalAssets) : "—";
    $v6("#rebalanceValueMode").textContent = effectiveHoldings().length ? (estimated ? "依成本暫估" : "依目前市值") : "尚未持有標的";
    $v6("#rebalanceCashSummary").textContent = money(cash);
    $v6("#rebalanceEstimateNote").hidden = !estimated || !holdings.length;
    $v6("#rebalanceTargetTotal").textContent = totalMessage.text;
    $v6("#rebalanceTargetTotal").className = `rebalanceTargetTotal ${totalMessage.className}`.trim();
    const currentDeviations = rows.map(row => Number.isFinite(row.targetAllocation) && Number.isFinite(row.weight) ? Math.abs(row.weight - row.targetAllocation) : null).filter(Number.isFinite);
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
       else status.textContent = rows.length ? "目前依可用持股價值暫估配置。" : "加入目標標的並設定配置後，即可產生建議。";
    }

    const readout = core.buildRebalanceReadout({rows, advice});
    const readoutByCode = new Map(readout.items.map(item => [item.code, item]));
    $v6("#rebalanceRecommendation").textContent = readout.recommendation;
    $v6("#rebalanceFundingMode").textContent = readout.fundingMode;
    $v6("#rebalanceFundingPriority").textContent = readout.fundingPriority.length ? readout.fundingPriority.slice(0, 5).map(item => item.code).join(" → ") : advice.formal ? "目前無明顯低配部位" : "完成目標配置後顯示";
    targetRows.innerHTML = rows.length ? rows.map(row => {
      const item = readoutByCode.get(row.code);
      const stateClass = item ? `is-${item.state}` : "is-pending";
      const gapText = item ? `${item.allocationGap > 0 ? "+" : ""}${number(item.allocationGap, 1)}%` : "—";
      return `<label class="rebalanceTargetRow ${stateClass}"><span class="rebalanceTargetIdentity"><b>${escapeHtml(row.code)}</b><span>${escapeHtml(holdingName(row))}</span></span><span class="rebalanceTargetCompare"><small>目前 ${item ? `${number(item.currentWeight, 1)}%` : "—"}</small><span>→</span><span class="rebalanceTargetInput"><small>目標</small><input type="number" min="0" max="100" step="0.1" inputmode="decimal" value="${Number.isFinite(row.targetAllocation) ? row.targetAllocation : ""}" data-rebalance-target="${escapeHtml(row.code)}" aria-label="開啟 ${escapeHtml(row.code)} 目標配置" readonly>%</span></span><span class="rebalanceGapBadge ${stateClass}">${item ? `${item.stateLabel} ${gapText}` : "尚未設定"}</span></label>`;
    }).join("") : '<p class="rebalancePending">新增持股後即可設定目標配置。</p>';

    output.innerHTML = rows.length ? rows.map(row => {
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
    targetRows.querySelectorAll("[data-rebalance-target]").forEach(input => input.addEventListener("click",openTargetModal));
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
    const rows = performanceCore.selectPeriod(portfolioHistory, portfolioAnalysisPeriod), change = performanceCore.assetChange(rows), continuity = performanceCore.analyzePortfolioContinuity(rows, {tradingDates: benchmarkRows.map(row => row.date), invalidCount: portfolioHistoryInvalidCount}), rawComparison = performanceCore.alignBenchmark(rows, benchmarkRows), comparison = performanceCore.guardBenchmark(rawComparison, continuity), benchmarkVisible = $v6("#portfolioBenchmarkToggle").checked;
    const empty = $v6("#portfolioPerformanceEmpty"), metrics = $v6("#portfolioPerformanceMetrics"), coverage = $v6("#portfolioPerformanceCoverage"), integrity = $v6("#portfolioPerformanceIntegrity");
    $v6("#portfolioPerformancePeriods").querySelectorAll("[data-performance-period]").forEach(button => button.classList.toggle("active", button.dataset.performancePeriod === portfolioAnalysisPeriod));
    if (rows.length < 2) {
      const firstDate = portfolioHistory[0]?.date;
      empty.innerHTML = `<b>績效紀錄將從現在開始累積</b><span>目前歷史資料尚不足，HS 不會以目前持股反推過去績效。${firstDate ? `已開始記錄：${displayDate(firstDate)}` : "建立完整持股與有效行情後開始記錄。"}</span>`;
      metrics.innerHTML = '<article class="portfolioPerformanceMetric"><span>區間資產變化</span><b>尚未解鎖</b><small>至少需要 2 個有效交易日</small></article>';
      coverage.textContent = firstDate ? `FORWARD_SNAPSHOT_ONLY｜資料起始 ${displayDate(firstDate)}` : "FORWARD_SNAPSHOT_ONLY｜尚無有效日資料";
      integrity.hidden = true; integrity.textContent = ""; drawPerformanceChart([], false); return;
    }
    empty.innerHTML = "";
    const twr=ledger?ledgerCore.calculateTwr({snapshots:portfolioHistory,events:ledger.events,startDate:ledger.performanceStartDate,period:portfolioAnalysisPeriod}):{available:false},terminal=rows.at(-1),xirr=ledger&&terminal?ledgerCore.calculateXirr(ledgerCore.buildXirrCashFlows(ledger,{date:terminal.date,value:terminal.totalAssets})):{available:false};
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

  function analyticsMoney(value) {
    if (!Number.isFinite(value)) return "—";
    const absolute = Math.abs(Math.round(value)).toLocaleString("en-US");
    return `${value > 0 ? "+" : value < 0 ? "-" : ""}NT$ ${absolute}`;
  }

  function analyticsMarketRows() {
    return computed.rows.filter(row => row.quoteStatus === "current" && Number.isFinite(row.marketValue)).map(row => ({code: row.code, marketValue: row.marketValue}));
  }

  function analyticsMetric(label, value, note = "", toneValue = null) {
    return `<article class="portfolioAnalyticsMetric"><span>${escapeHtml(label)}</span><b class="${valueClass(toneValue)}">${escapeHtml(value)}</b><small>${escapeHtml(note)}</small></article>`;
  }

  function analyticsCard(label, value, note = "", toneValue = null) {
    return `<article class="portfolioAnalyticsCard"><span>${escapeHtml(label)}</span><b class="${valueClass(toneValue)}">${escapeHtml(value)}</b><small>${escapeHtml(note)}</small></article>`;
  }

  function renderContribution(contribution) {
    const output = $v6("#portfolioContributionRows");
    if (!contribution.available) { output.innerHTML = '<div class="portfolioAnalyticsEmpty">此期間尚無足夠歷史資料。</div>'; return; }
    const rows = contribution.rows.slice(0, 3), scale = Math.max(1, ...rows.map(row => Math.abs(row.amount)));
    output.innerHTML = rows.length ? rows.map(row => `<article class="portfolioContributionRow ${row.amount < 0 ? "is-negative" : ""}"><b>${escapeHtml(row.symbol)}</b><span class="portfolioContributionBar" aria-hidden="true"><i style="width:${Math.max(3, Math.abs(row.amount) / scale * 100).toFixed(1)}%"></i></span><strong class="${valueClass(row.amount)}">${escapeHtml(analyticsMoney(row.amount))}</strong></article>`).join("") : '<div class="portfolioAnalyticsEmpty">此期間沒有可歸屬的 ETF 損益貢獻。</div>';
  }

  function renderMonthlyPreview(report) {
    const period = $v6("#portfolioMonthlyPreviewPeriod"), output = $v6("#portfolioMonthlyPreview");
    if (!report.available) { period.textContent = "等待正式 snapshots"; output.innerHTML = '<div class="portfolioAnalyticsEmpty">月報資料尚未開始累積。</div>'; return; }
    period.textContent = `資料期間 ${displayDate(report.startDate)}–${displayDate(report.endDate)}${report.partialMonth ? "｜部分月份" : ""}`;
    output.innerHTML = [["月內 TWR", report.twr === null ? "資料不完整" : percent(report.twr), report.twr],["淨入金",analyticsMoney(report.netDeposits),report.netDeposits],["股息",analyticsMoney(report.dividends),report.dividends],["已實現損益",analyticsMoney(report.realizedPnL),report.realizedPnL]].map(([label,value,tone])=>`<article><span>${escapeHtml(label)}</span><b class="${valueClass(tone)}">${escapeHtml(value)}</b></article>`).join("");
  }

  function renderProfitAnalytics(profit, holdingsBreakdown) {
    if (!ledger) return '<div class="portfolioAnalyticsEmpty">建立交易帳本後才會提供可信的損益分析。</div>';
    const costs = (profit.standaloneFees || 0) + (profit.standaloneTaxes || 0);
    const cards = [["未實現損益",analyticsMoney(profit.unrealizedPnL),"依目前市值減剩餘成本",profit.unrealizedPnL],["已實現損益",analyticsMoney(profit.realizedPnL),"SELL 已扣該筆 fee／tax",profit.realizedPnL],["股息收入",analyticsMoney(profit.dividendIncome),"僅計 DIVIDEND events",profit.dividendIncome],["其他費用與稅",analyticsMoney(-costs),"僅獨立 FEE／TAX events",-costs]].map(row=>analyticsCard(...row)).join("");
    const ranked = holdingsBreakdown.length ? `<div class="portfolioAnalyticsRanked">${holdingsBreakdown.map(row=>`<article><b>${escapeHtml(row.symbol)}</b><div><span>未實現</span><b class="${valueClass(row.unrealizedPnL)}">${escapeHtml(analyticsMoney(row.unrealizedPnL))}</b></div><div><span>已實現</span><b class="${valueClass(row.realizedPnL)}">${escapeHtml(analyticsMoney(row.realizedPnL))}</b></div><div><span>股息</span><b class="${valueClass(row.dividendIncome)}">${escapeHtml(analyticsMoney(row.dividendIncome))}</b></div><div><span>合計貢獻</span><b class="${valueClass(row.totalContribution)}">${escapeHtml(analyticsMoney(row.totalContribution))}</b></div></article>`).join("")}</div>` : '<div class="portfolioAnalyticsEmpty">尚無可歸屬的標的損益。</div>';
    return `<div class="portfolioAnalyticsDetailHead"><h3>損益組成與按標的拆分</h3></div><div class="portfolioAnalyticsGrid">${cards}</div>${ranked}<p class="portfolioAnalyticsNote">期初部位可提供成本基礎與未實現損益，但不代表 Ledger 啟用前的完整投資報酬。</p>`;
  }

  function monthBars(rows, key, className = "") {
    const max = Math.max(1, ...rows.map(row => Math.abs(Number(row[key]) || 0)));
    return `<div class="portfolioMonthBars">${rows.map((row,index)=>`<div class="portfolioMonthBar ${className}"><i style="height:${Math.max(2, Math.abs(Number(row[key])||0)/max*78).toFixed(1)}px"></i><small>${String(index+1).padStart(2,"0")}</small></div>`).join("")}</div>`;
  }

  function renderDividendAnalytics(dividend) {
    if (!ledger) return '<div class="portfolioAnalyticsEmpty">建立交易帳本後才會提供股息中心。</div>';
    const yearOptions = (dividend.years.length ? dividend.years : [dividend.year]).map(year=>`<option value="${year}" ${year===dividend.year?"selected":""}>${year}</option>`).join("");
    if (dividend.status === "EMPTY") return `<div class="portfolioAnalyticsDetailHead"><h3>股息收入</h3><label>年度<select data-dividend-year>${yearOptions}</select></label></div><div class="portfolioAnalyticsEmpty">尚無股息紀錄。</div>`;
    const cards = [["今年股息",analyticsMoney(dividend.yearTotal),dividend.year],["累計股息",analyticsMoney(dividend.cumulative),"Ledger 啟用後"],["最近一次股息",dividend.latest?analyticsMoney(dividend.latest.grossAmount):"—",dividend.latest?`${displayDate(dividend.latest.tradeDate)}｜${dividend.latest.symbol}`:"尚無紀錄"],["股息來源數",`${dividend.sourceCount} 檔`,"本年度"],["累計股息／投入成本",Number.isFinite(dividend.cumulativeDividendToCost)?plainPercent(dividend.cumulativeDividendToCost):"—","不代表目前市場殖利率"]].map(row=>analyticsCard(...row)).join("");
    const bySymbol = dividend.bySymbol.length ? `<div class="portfolioAnalyticsRanked">${dividend.bySymbol.map(row=>`<article><b>${escapeHtml(row.symbol)}</b><div><span>${escapeHtml(dividend.year)} 股息</span><b>${escapeHtml(analyticsMoney(row.amount))}</b></div></article>`).join("")}</div>` : "";
    return `<div class="portfolioAnalyticsDetailHead"><h3>股息收入</h3><label>年度<select data-dividend-year>${yearOptions}</select></label></div><div class="portfolioAnalyticsGrid">${cards}</div>${monthBars(dividend.monthly,"amount")}${bySymbol}<p class="portfolioAnalyticsNote">所有數值只來自 DIVIDEND events；不預測未來股息。</p>`;
  }

  function renderTradingAnalytics(trading) {
    if (!ledger) return '<div class="portfolioAnalyticsEmpty">建立交易帳本後才會提供交易統計。</div>';
    if (trading.status === "EMPTY") return '<div class="portfolioAnalyticsEmpty">尚無交易統計。</div>';
    const cards = [["買入次數",`${trading.buyCount} 筆`,"BUY events"],["賣出次數",`${trading.sellCount} 筆`,"SELL events"],["累計買入金額",analyticsMoney(-trading.cumulativeBuy),"含 BUY fee",-trading.cumulativeBuy],["累計賣出金額",analyticsMoney(trading.cumulativeSell),"已扣 SELL fee／tax",trading.cumulativeSell],["平均單筆買入",trading.averageBuy===null?"—":analyticsMoney(trading.averageBuy),"不含入金"],["已實現交易損益",analyticsMoney(trading.realizedPnL),"加權平均成本",trading.realizedPnL],["累計入金",analyticsMoney(trading.deposits),"不含期初現金"],["累計出金",analyticsMoney(-trading.withdrawals),"External flow",-trading.withdrawals],["淨外部投入",analyticsMoney(trading.netExternalContributions),"入金減出金",trading.netExternalContributions],["獲利／虧損賣出",`${trading.profitableSellCount}／${trading.lossSellCount} 筆`,trading.profitableSellRatio===null?"賣出樣本未滿 5 筆，不強調比例":`獲利賣出占比 ${plainPercent(trading.profitableSellRatio)}`]].map(row=>analyticsCard(...row)).join("");
    const monthly = trading.monthly.length ? `${monthBars(trading.monthly,"buyAmount")}${monthBars(trading.monthly,"sellAmount","sell")}` : "";
    return `<div class="portfolioAnalyticsDetailHead"><h3>交易統計</h3></div><div class="portfolioAnalyticsGrid">${cards}</div>${monthly}<p class="portfolioAnalyticsNote">金色為每月買入、綠色為每月賣出；DEPOSIT／WITHDRAWAL 不會混入交易金額。</p>`;
  }

  function renderMonthlyAnalytics(report, months, annual) {
    const options=months.map(month=>`<option value="${month}" ${month===analyticsMonth?"selected":""}>${month.replace("-"," 年 ")} 月</option>`).join("");
    if(!report.available)return `<div class="portfolioAnalyticsDetailHead"><h3>月度報告</h3>${options?`<label>月份<select data-report-month>${options}</select></label>`:""}</div><div class="portfolioAnalyticsEmpty">尚無足夠 snapshot 建立月度報告。</div>`;
    const metrics=[["月初總資產",analyticsMoney(report.startAssets),displayDate(report.startDate)],["月底／最新總資產",analyticsMoney(report.endAssets),displayDate(report.endDate)],["月內 TWR",report.twr===null?"資料不完整":percent(report.twr),`${report.observations} 個 snapshots`,report.twr],["0050 同期",report.benchmarkReturn===null?"資料不足":percent(report.benchmarkReturn),"相同起訖日期",report.benchmarkReturn],["相對差異",report.relativeDifference===null?"—":point(report.relativeDifference),"Portfolio TWR 減 0050",report.relativeDifference],["月內淨入金",analyticsMoney(report.netDeposits),"入金減出金",report.netDeposits],["月內股息",analyticsMoney(report.dividends),"DIVIDEND events",report.dividends],["月內已實現損益",analyticsMoney(report.realizedPnL),"SELL realized P/L",report.realizedPnL],["月末未實現損益",analyticsMoney(report.unrealizedPnL),"月末市值減成本",report.unrealizedPnL],["月內買入金額",analyticsMoney(-report.buyAmount),"含 BUY fee",-report.buyAmount],["月內賣出金額",analyticsMoney(report.sellAmount),"淨賣出收入",report.sellAmount],["最大單一部位",report.largestPosition===null?"—":plainPercent(report.largestPosition),"月末持股市值"],["月內最大回撤",report.maxDrawdown===null?"資料不完整":percent(report.maxDrawdown),report.missingDates.length?`缺少 ${report.missingDates.length} 個必要交易日`:"依正式 snapshots",report.maxDrawdown]].map(row=>analyticsCard(...row)).join("");
    const annualCards=annual?.available?`<div class="portfolioAnalyticsDetailHead"><h3>${annual.year} 年度摘要</h3></div><div class="portfolioAnalyticsGrid">${[["YTD TWR",annual.twr===null?"資料不足":percent(annual.twr),annual.partialYear?`統計自 ${displayDate(annual.startDate)} 起`:"年度至今",annual.twr],["YTD XIRR",annual.xirr===null?"資料不足":percent(annual.xirr),"資金加權年化",annual.xirr],["YTD 股息",analyticsMoney(annual.dividends),"DIVIDEND events",annual.dividends],["YTD 已實現損益",analyticsMoney(annual.realizedPnL),"SELL realized P/L",annual.realizedPnL],["YTD 淨入金",analyticsMoney(annual.netDeposits),"不含期初現金",annual.netDeposits],["YTD 最大回撤",annual.maxDrawdown===null?"資料不足":percent(annual.maxDrawdown),"正式 snapshots",annual.maxDrawdown]].map(row=>analyticsCard(...row)).join("")}</div>`:"";
    return `<div class="portfolioAnalyticsDetailHead"><h3>月度報告</h3><label>月份<select data-report-month>${options}</select></label></div><div class="portfolioAnalyticsGrid">${metrics}</div><p class="portfolioAnalyticsSummaryText">${report.summary.map(escapeHtml).join("<br>")}</p>${annualCards}`;
  }

  function renderAnalytics() {
    const quality=$v6("#portfolioAnalyticsQuality"),summary=$v6("#portfolioAnalyticsSummary"),detail=$v6("#portfolioAnalyticsDetail");$v6("#portfolioAnalyticsCoverage").textContent=`與投資績效共用期間：${portfolioAnalysisPeriod}`;
    $v6("#portfolioAnalyticsTabs").querySelectorAll("[data-analytics-tab]").forEach(button=>button.classList.toggle("active",button.dataset.analyticsTab===analyticsTab));
    if(!ledger){quality.dataset.quality="PENDING";quality.textContent="等待交易帳本";summary.innerHTML=["已實現損益","未實現損益","股息收入","總投資損益"].map(label=>analyticsMetric(label,"—","建立 Ledger 後開始")).join("");renderContribution({available:false});renderMonthlyPreview({available:false});detail.innerHTML='<div class="portfolioAnalyticsEmpty">建立交易帳本後，投資分析將從正式績效起始日開始累積。</div>';return}
    const marketRows=analyticsMarketRows(),profit=analyticsCore.calculateProfitBreakdown({ledger,marketRows}),holdingsBreakdown=analyticsCore.calculateHoldingProfitBreakdown({ledger,marketRows}),contribution=analyticsCore.calculatePortfolioContribution({ledger,snapshots:portfolioHistory,period:portfolioAnalysisPeriod}),months=[...new Set(portfolioHistory.filter(row=>row.date>=ledger.performanceStartDate).map(row=>row.date.slice(0,7)))].sort().reverse();if(!analyticsMonth||!months.includes(analyticsMonth))analyticsMonth=months[0]||"";const report=analyticsCore.buildMonthlyPortfolioReport({ledger,snapshots:portfolioHistory,benchmarkRows,month:analyticsMonth});
    quality.dataset.quality=profit.available?"COMPLETE":"PARTIAL";quality.textContent=profit.available?"帳本與行情完整":"部分資料待補";
    summary.innerHTML=[["已實現損益",analyticsMoney(profit.realizedPnL),"已扣 SELL fee／tax",profit.realizedPnL],["未實現損益",analyticsMoney(profit.unrealizedPnL),profit.available?"目前市值減剩餘成本":"等待完整行情",profit.unrealizedPnL],["股息收入",analyticsMoney(profit.dividendIncome),"僅計 DIVIDEND",profit.dividendIncome],["總投資損益",analyticsMoney(profit.totalInvestmentPnL),"不含入金、出金與期初現金",profit.totalInvestmentPnL]].map(row=>analyticsMetric(...row)).join("");renderContribution(contribution);renderMonthlyPreview(report);
    if(analyticsTab==="PROFIT")detail.innerHTML=renderProfitAnalytics(profit,holdingsBreakdown);else if(analyticsTab==="DIVIDEND"){const dividend=analyticsCore.calculateDividendAnalytics({ledger,year:analyticsDividendYear});analyticsDividendYear=dividend.year;detail.innerHTML=renderDividendAnalytics(dividend)}else if(analyticsTab==="TRADING")detail.innerHTML=renderTradingAnalytics(analyticsCore.calculateTradingAnalytics({ledger,period:portfolioAnalysisPeriod,asOf:portfolioHistory.at(-1)?.date||taipeiToday()}));else if(analyticsTab==="MONTHLY"){const annual=analyticsCore.buildAnnualPortfolioSummary({ledger,snapshots:portfolioHistory,year:(analyticsMonth||taipeiToday()).slice(0,4)});detail.innerHTML=renderMonthlyAnalytics(report,months,annual)}else detail.innerHTML='<p class="portfolioAnalyticsNote">投資分析只讀取交易帳本與正式 snapshots；入出金不會被計入投資損益或 ETF contribution。</p>';
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
    const rows = performanceCore.selectPeriod(portfolioHistory, portfolioAnalysisPeriod);
    const continuity = performanceCore.analyzePortfolioContinuity(rows, {tradingDates: benchmarkRows.map(row => row.date), invalidCount: portfolioHistoryInvalidCount});
    const concentration = performanceCore.calculateConcentration(computed.rows.filter(row => row.quoteStatus === "current").map(row => ({code: row.code, marketValue: row.marketValue, weight: row.weight})));
    const allocation = performanceCore.calculateAllocationDeviation(computed.rows.map(row => ({code: row.code, weight: row.weight, targetAllocation: row.targetAllocation})));
    const drawdown = performanceCore.calculateMaxDrawdown(rows, {continuity});
    const volatility = performanceCore.calculateAnnualizedVolatility(rows, {continuity});
    const quality = portfolioHistoryInvalidCount ? "INVALID_DATA" : continuity.hasCapitalEvent ? "CAPITAL_EVENT" : rows.length < 10 || continuity.hasDataGap ? "INSUFFICIENT_HISTORY" : "COMPLETE";
    const qualityNode = $v6("#portfolioRiskQuality");
    qualityNode.dataset.quality = quality; qualityNode.textContent = riskStatusText(quality);
    $v6("#portfolioRiskPeriod").textContent = `目前區間：${portfolioAnalysisPeriod}`;
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
    const actual=new Map(computed.rows.map(row=>[row.code,row]));
    const cash=ledgerState?.valid?ledgerState.cash:rebalanceSettings.cash;
    const plan = performanceCore.buildCashOnlyRebalancePlan({
      rows:targetAllocationItems().map(item=>{
        const row=actual.get(item.code),quote=row?.quote||publicQuoteMap.get(item.code)||quoteMap.get(item.code);
        const current=quote&&core.quoteFreshness(quote).isCurrent;
        return{code:item.code,targetAllocation:item.targetAllocation,marketValue:row?row.quoteStatus==="current"?row.marketValue:null:0,price:current?quote.price:null};
      }),availableCash:cash
    });
    const summary = $v6("#capitalPlanSummary"), output = $v6("#capitalPlanRows");
    summary.innerHTML = [["可用現金",money(cash)],["建議投入",cash<=0?money(0):plan.status==="READY"?money(plan.allocated):"—"],["預計保留",plan.status==="READY"||plan.status==="NO_CASH"?money(plan.remaining):"—"]].map(([label,value])=>`<article><span>${label}</span><b>${escapeHtml(value)}</b></article>`).join("");
    if(plan.status==="TARGET_MISSING"||plan.status==="TARGET_INCOMPLETE"){output.innerHTML='<div class="capitalPlanEmpty">請先設定 ETF 目標配置，合計 100% 後顯示現金分配建議。</div>';return}
    if(plan.status==="PRICE_UNAVAILABLE"){output.innerHTML=`<div class="capitalPlanEmpty">${cash<=0?"目前沒有可配置現金。":""}${escapeHtml(plan.rows.filter(row=>row.status==="PRICE_UNAVAILABLE").map(row=>row.symbol).join("、"))} 行情暫缺，暫時無法完整計算配置；不產生買入建議。</div>`;return}
    output.innerHTML=plan.rows.map(row=>`<article class="capitalPlanRow"><div class="capitalPlanIdentity"><b>${escapeHtml(row.symbol)}</b><small>目前 ${plainPercent(row.currentAllocation)} → 目標 ${plainPercent(row.target)}</small></div><div class="capitalPlanAmount"><b>${row.status==="OVERWEIGHT"?"目前已高於目標":plan.status==="NO_CASH"?"目前沒有可配置現金":row.allocationAmount>0?`本次建議投入 ${money(row.allocationAmount)}`:"本次暫不投入"}</b><small>${row.allocationAmount>0?`約可買 ${number(row.estimatedUnits,0)} 股｜僅供試算`:row.status==="OVERWEIGHT"?"本次不投入新資金":"等待下一筆可用現金"}</small></div></article>`).join("");
  }

  const LEDGER_LABELS={OPENING_POSITION:"期初部位",OPENING_CASH:"期初現金",BUY:"買入",SELL:"賣出",DEPOSIT:"入金",WITHDRAWAL:"出金",DIVIDEND:"股息",FEE:"其他費用",TAX:"額外稅額",SPLIT:"股票分割",REVERSE_SPLIT:"反向分割",STOCK_DIVIDEND:"股票股利"};
  function ledgerEventDetail(event){if(["OPENING_POSITION","BUY","SELL"].includes(event.type))return`${event.symbol}｜${number(event.quantity,4)} 股 × ${money(event.unitPrice)}`;if(event.type==="DIVIDEND")return`${event.symbol}｜現金股息`;if(ledgerCore.CORPORATE_ACTIONS.has(event.type))return`${event.symbol}｜${event.type==="STOCK_DIVIDEND"?`每股配 ${number(event.sharesPerShare,6)} 股`:`調整比率 ${number(event.ratio,6)}`}`;return event.note||LEDGER_LABELS[event.type]||event.type}
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
  function transactionVisibility(){const type=$v6("#portfolioTransactionType").value,trade=["OPENING_POSITION","BUY","SELL"].includes(type),corporate=ledgerCore.CORPORATE_ACTIONS.has(type),symbol=trade||type==="DIVIDEND"||corporate;$v6("[data-transaction-symbol]").hidden=!symbol;$v6("[data-transaction-trade]").hidden=!trade;$v6("[data-transaction-amount]").hidden=trade||corporate;$v6("[data-transaction-corporate]").hidden=!corporate;$v6("#portfolioTransactionRatioLabel").textContent=type==="STOCK_DIVIDEND"?"每股配發股數":"調整比率";$v6("[data-transaction-costs]").hidden=!trade||type==="OPENING_POSITION";$v6("[data-transaction-tax]").hidden=type!=="SELL"}
  function updateCashImpactNote(){
    const note=$v6("#portfolioCashImpactNote");
    const amount=Number($v6("#portfolioTransactionQuantity").value)*Number($v6("#portfolioTransactionPrice").value)+Number($v6("#portfolioTransactionFee").value||0);
    const after=(ledgerState?.valid?ledgerState.cash:rebalanceSettings.cash)-amount;
    note.hidden=$v6("#portfolioTransactionType").value!=="BUY"||!Number.isFinite(amount)||amount<=0||after>=0;
    if(!note.hidden)note.textContent=`此交易後現金將為 ${money(after)}；仍可儲存交易。`;
  }
  function openCashModal(){const modal=$v6("#portfolioCashModal");$v6("#portfolioCashType").value="DEPOSIT";$v6("#portfolioCashAmount").value="";$v6("#portfolioCashDate").value=taipeiToday();$v6("#portfolioCashNote").value="";$v6("#portfolioCashError").textContent="";modal.classList.add("show");modal.setAttribute("aria-hidden","false")}
  function closeCashModal(){const modal=$v6("#portfolioCashModal");modal.classList.remove("show");modal.setAttribute("aria-hidden","true")}
  function submitCash(event){
    event.preventDefault();const amount=Number($v6("#portfolioCashAmount").value),error=$v6("#portfolioCashError");
    if(!Number.isFinite(amount)||amount<=0){error.textContent="請輸入有效的正數金額。";return}
    const entry=ledgerCore.normalizeEvent({type:$v6("#portfolioCashType").value,tradeDate:$v6("#portfolioCashDate").value,timestamp:new Date().toISOString(),grossAmount:amount,note:$v6("#portfolioCashNote").value,source:"MANUAL"});
    if(!entry){error.textContent="請確認類型、日期與金額。";return}
    try{if(!ledger)migrateLedger();const result=ledgerCore.mutateLedger(ledger,{type:"ADD",event:entry});if(!result.ok){error.textContent=result.error||"現金紀錄驗證失敗。";return}persistLedger(result.ledger);closeCashModal();refreshPortfolio()}catch(reason){error.textContent=reason?.message||"儲存失敗，資料未變更。"}
  }
  function openTransaction(eventId=null){if(!ledger){openMigration();return}editingLedgerEventId=eventId;const event=eventId?ledger.events.find(row=>row.id===eventId):null,select=$v6("#portfolioTransactionType");select.querySelectorAll("[data-opening-option]").forEach(node=>node.remove());if(event?.type.startsWith("OPENING_")){const option=document.createElement("option");option.value=event.type;option.textContent=LEDGER_LABELS[event.type];option.dataset.openingOption="true";select.prepend(option)}$v6("#portfolioTransactionTitle").textContent=event?`${LEDGER_LABELS[event.type]}紀錄`:"新增交易";select.value=event?.type||"BUY";select.disabled=Boolean(event?.type.startsWith("OPENING_"));$v6("#portfolioTransactionDate").value=event?.tradeDate||taipeiToday();$v6("#portfolioTransactionSymbol").value=event?.symbol||"";$v6("#portfolioTransactionQuantity").value=event?.quantity||"";$v6("#portfolioTransactionPrice").value=event?.unitPrice||"";$v6("#portfolioTransactionAmount").value=event?.grossAmount||"";$v6("#portfolioTransactionRatio").value=event?.type==="STOCK_DIVIDEND"?event.sharesPerShare||"":event?.ratio||"";$v6("#portfolioTransactionFee").value=event?.fee||0;$v6("#portfolioTransactionTax").value=event?.tax||0;$v6("#portfolioTransactionNote").value=event?.note||"";$v6("#portfolioTransactionError").textContent="";$v6("#portfolioTransactionWarning").hidden=true;transactionVisibility();updateCashImpactNote();const modal=$v6("#portfolioTransactionModal");modal.classList.add("show");modal.setAttribute("aria-hidden","false")}
  function transactionFormEvent(){const type=$v6("#portfolioTransactionType").value,trade=["OPENING_POSITION","BUY","SELL"].includes(type),corporate=ledgerCore.CORPORATE_ACTIONS.has(type),ratio=$v6("#portfolioTransactionRatio").value;return{type,tradeDate:$v6("#portfolioTransactionDate").value,timestamp:editingLedgerEventId?ledger.events.find(row=>row.id===editingLedgerEventId)?.timestamp:new Date().toISOString(),symbol:$v6("#portfolioTransactionSymbol").value,quantity:trade?$v6("#portfolioTransactionQuantity").value:null,unitPrice:trade?$v6("#portfolioTransactionPrice").value:null,grossAmount:trade||corporate?null:$v6("#portfolioTransactionAmount").value,ratio:corporate&&type!=="STOCK_DIVIDEND"?ratio:null,sharesPerShare:type==="STOCK_DIVIDEND"?ratio:null,fee:type==="OPENING_POSITION"||corporate?0:$v6("#portfolioTransactionFee").value,tax:type==="OPENING_POSITION"||corporate?0:$v6("#portfolioTransactionTax").value,note:$v6("#portfolioTransactionNote").value,source:editingLedgerEventId?ledger.events.find(row=>row.id===editingLedgerEventId)?.source||"MANUAL":"MANUAL",updatedAt:new Date().toISOString()}}
  function submitTransaction(event){event.preventDefault();const input=transactionFormEvent(),normalized=ledgerCore.normalizeEvent(input),warning=$v6("#portfolioTransactionWarning");if(!normalized){$v6("#portfolioTransactionError").textContent="請確認日期、代號、股數、價格、比率或金額皆為有效正數。";return}if(!editingLedgerEventId&&ledgerCore.detectLikelyDuplicate(ledger.events,normalized)&&warning.hidden){warning.textContent="可能為重複交易；若確實為另一筆交易，請再次按儲存。";warning.hidden=false;return}if(normalized.type==="OPENING_POSITION"&&!confirm("修改期初部位會改變正式績效基準，確定繼續？"))return;const result=ledgerCore.mutateLedger(ledger,{type:editingLedgerEventId?"EDIT":"ADD",id:editingLedgerEventId,event:normalized});if(!result.ok){$v6("#portfolioTransactionError").textContent=result.error||"交易後帳本狀態無效，未儲存任何變更。";return}if(ledgerCore.CORPORATE_ACTIONS.has(normalized.type))createRecovery(editingLedgerEventId?"BEFORE_CORPORATE_ACTION_EDIT":"BEFORE_CORPORATE_ACTION");persistLedger(result.ledger);closeLedgerModals();refreshPortfolio();updateQuotes({force:true})}
  function deleteLedgerEvent(id){const event=ledger?.events.find(row=>row.id===id);if(!event||!confirm(`刪除這筆「${LEDGER_LABELS[event.type]}」紀錄？`))return;if(event.type==="OPENING_POSITION"&&!confirm("刪除期初部位會改變正式績效基準，確定繼續？"))return;const result=ledgerCore.mutateLedger(ledger,{type:"DELETE",id});if(!result.ok){alert(result.error||"刪除後會造成後續交易無效，未刪除任何資料。");return}if(ledgerCore.CORPORATE_ACTIONS.has(event.type))createRecovery("BEFORE_CORPORATE_ACTION_DELETE");persistLedger(result.ledger);renderAllLedger();refreshPortfolio()}
  function filterLedgerEvent(event){return ledgerFilter==="ALL"||event.type===ledgerFilter||ledgerFilter==="CASH"&&["DEPOSIT","WITHDRAWAL"].includes(event.type)||ledgerFilter==="CORPORATE"&&ledgerCore.CORPORATE_ACTIONS.has(event.type)||ledgerFilter==="COST"&&["FEE","TAX"].includes(event.type)}
  function renderAllLedger(){if(!ledger)return;const rows=[...ledger.events].filter(filterLedgerEvent).sort((a,b)=>b.tradeDate.localeCompare(a.tradeDate)||b.timestamp.localeCompare(a.timestamp)||b.id.localeCompare(a.id));$v6("#portfolioLedgerAllList").innerHTML=rows.length?rows.map(row=>ledgerRow(row)).join(""):'<div class="portfolioLedgerEmpty">這個分類尚無交易紀錄。</div>'}
  function openLedger(){if(!ledger){openMigration();return}renderAllLedger();const modal=$v6("#portfolioLedgerModal");modal.classList.add("show");modal.setAttribute("aria-hidden","false")}

  function refreshPortfolio(animate = false, {focusTarget = ""} = {}) {
    computed = core.calculatePortfolio(effectiveHoldings(), quoteMap, {now: Date.now()});
    const simulation = $v6("#rebalanceSimulation");
    if (simulation) simulation.hidden = true;
    renderSummary();
    renderPortfolioDecisionSupport();
    renderList();
    drawAllocation();
    renderRebalance(focusTarget);
    recordPortfolioSnapshot();
    renderPerformance();
    renderAnalytics();
    renderRiskCenter();
    renderCapitalPlan();
    renderLedger();
    renderWorkflow();
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
      .filter(row => row.quoteStatus === "current" && Number.isFinite(row.marketValue) && row.marketValue > 0)
      .map(row => ({...row, allocationValue: row.marketValue, valueSource: "market"}));
    const allocation = dashboardCore.allocation(marketRows.map(row=>({...row,name:holdingName(row)})),6);
    const marketTotal = allocation.reduce((sum, item) => sum + item.value, 0);
    $v6("#portfolioAllocationMode").textContent = "依目前市值";
    chartSegments = [];
    if (!allocation.length) {
      ctx.strokeStyle = "#244332";
      ctx.lineWidth = Math.max(22, size * .12);
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size * .32, 0, Math.PI * 2);
      ctx.stroke();
      $v6("#portfolioChartCenter").innerHTML = `<b>${effectiveHoldings().length ? "資料暫缺" : "尚無持股"}</b><span>${effectiveHoldings().length} 檔持股</span>`;
      $v6("#portfolioChartDetail").innerHTML = `<p class="allocationLegendEmpty">${effectiveHoldings().length ? "行情資料暫缺，無法以市值計算配置。" : "新增持股後會在此顯示目前市值配置。"}</p>`;
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
    $v6("#portfolioChartCenter").innerHTML = `<b>${money(marketTotal)}</b><span>${effectiveHoldings().length} 檔持股<em>｜${marketRows.length} 檔可估值</em></span>`;
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
      const previous = catalog;
      const [universe, marketQuotes] = await Promise.allSettled([
        fetchJson(ETF_UNIVERSE_URL),
        fetchJson(MARKET_CACHE_URL)
      ]);
      const sources = {
        core,
        universe: universe.status === "fulfilled" ? universe.value : null,
        marketQuotes: marketQuotes.status === "fulfilled" ? marketQuotes.value : null,
        watchlist: typeof watchlist === "undefined" ? [] : watchlist,
        holdings,
        previous
      };
      catalog = etfCatalog.build(sources);
      // FinMind supplements stocks; its latency or outage must not delay ETF search.
      apiGet({dataset: "TaiwanStockInfo"}, {soft: true}).then(stocks => {
        catalog = etfCatalog.build({...sources, holdings, stocks, previous: catalog});
        if ($v6("#portfolioModal").classList.contains("show")) searchCatalog($v6("#portfolioCode").value);
      }).catch(() => {});
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
    const rows = etfCatalog.search(catalog, normalized);
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
    $v6("#portfolioCustomName").placeholder = "例如 長期核心部位";
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
      name: catalogItem?.name || quoteMap.get(code)?.name || publicQuoteMap.get(code)?.name || holdings.find(item => item.code === code)?.name || code
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
    const sharedQuotes = window.HSLiveMarket?.latestQuotes?.();
    if (sharedQuotes instanceof Map && sharedQuotes.size) applySharedQuotes({detail: {quotes: sharedQuotes, sourceUpdatedAt: "", source: "shared_cache"}});
    else refreshPortfolio();
    updateQuotes({force: true});
  }

  async function submitPortfolio(event) {
    event.preventDefault();
    try {
      await loadCatalog();
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

  function downloadText(text, fileName, type="text/plain;charset=utf-8") { const blob=new Blob([text],{type}),url=URL.createObjectURL(blob),link=document.createElement("a");link.href=url;link.download=fileName;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000); }
  function currentPortfolioAssets(){const latest=portfolioHistory.at(-1)?.totalAssets;if(Number.isFinite(Number(latest)))return Number(latest);const market=computed.rows.filter(row=>Number.isFinite(row.marketValue)).reduce((sum,row)=>sum+row.marketValue,0);return market+(ledgerState?.valid?ledgerState.cash:rebalanceSettings.cash||0)}
  function workflowMetric(label,value,note=""){return`<article class="portfolioWorkflowMetric"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b><small>${escapeHtml(note)}</small></article>`}
  function renderGoalAndActivity(){
    const goal=workflowCore.goalProgress(portfolioGoal,currentPortfolioAssets(),taipeiToday()),goalNode=$v6("#portfolioGoalCompact");
    goalNode.innerHTML=goal.available?`<div class="portfolioGoalBody"><div class="portfolioGoalValues"><div><span>目前資產</span><b>${money(goal.currentAssets)}</b></div><div><span>目標</span><b>${money(goal.goal.targetValue)}</b></div><div><span>完成度</span><b>${number(goal.progress,1)}%</b></div></div><div class="portfolioGoalProgress"><i style="width:${Math.min(100,Math.max(0,goal.progress))}%"></i></div><small>${goal.reached?"已達設定目標":`距離目標 ${money(goal.remaining)}`}｜目標日 ${displayDate(goal.goal.targetDate)}${goal.pastDue?"（日期已到）":""}</small></div>`:'<div class="portfolioGoalBody"><small>尚未設定主要投資目標；此功能只追蹤使用者自訂資產目標。</small></div>';
    const recurring=ledger?workflowCore.recurringAnalytics(ledger,{asOf:taipeiToday(),monthlyPlan:portfolioMonthlyPlan}):null,activity=$v6("#portfolioActivityCompact");
    activity.innerHTML=recurring?.available?`<div class="portfolioActivityBody"><div class="portfolioActivityValues"><div><span>本月入金</span><b>${money(recurring.months.at(-1)?.deposits||0)}</b></div><div><span>本月買入</span><b>${money(recurring.months.at(-1)?.buys||0)}</b></div><div><span>YTD 入金</span><b>${money(recurring.ytdDeposits)}</b></div></div><small>${recurring.planProgress?`本月計畫 ${money(recurring.planProgress.planned)}｜距離計畫 ${money(recurring.planProgress.remaining)}`:"尚未設定每月計畫投入"}</small></div>`:'<div class="portfolioActivityBody"><small>建立交易帳本後顯示本月入金與買入活動。</small></div>';
  }
  function renderRecurring(){const summary=$v6("#portfolioRecurringSummary"),symbols=$v6("#portfolioRecurringSymbols");if(!ledger){summary.innerHTML=workflowMetric("狀態","等待帳本","不建立推估");symbols.innerHTML="";return}const result=workflowCore.recurringAnalytics(ledger,{asOf:taipeiToday(),monthlyPlan:portfolioMonthlyPlan});summary.innerHTML=[workflowMetric("近 3 月平均入金",money(result.averageDeposit3M),"外部投入"),workflowMetric("近 6 月平均入金",money(result.averageDeposit6M),"外部投入"),workflowMetric("近 3 月平均買入",money(result.averageBuy3M),"實際 BUY"),workflowMetric("YTD 累計入金",money(result.ytdDeposits),result.maxDepositMonth.month?`最大月 ${result.maxDepositMonth.month}`:"尚無入金")].join("");symbols.innerHTML=result.bySymbol.length?result.bySymbol.map(row=>`<span class="portfolioRecurringSymbol"><b>${escapeHtml(row.symbol)}</b>｜近 6 月買入 ${row.months} 個月｜${money(row.totalBuy)}</span>`).join(""):'<span class="portfolioRecurringSymbol">近 6 月尚無 BUY 紀錄</span>'}
  function annualRow(label,value){return`<div class="portfolioAnnualRow"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`}
  function renderAnnualReport(){const select=$v6("#portfolioAnnualYear"),years=[...new Set(portfolioHistory.map(row=>row.date.slice(0,4)))].sort().reverse(),selected=select.value||years[0]||taipeiToday().slice(0,4);select.innerHTML=years.length?years.map(year=>`<option value="${year}"${year===selected?" selected":""}>${year}</option>`).join(""):`<option value="${selected}">${selected}</option>`;annualReport=ledger?workflowCore.buildAnnualReport({ledger,snapshots:portfolioHistory,benchmarkRows,marketRows:analyticsMarketRows(),year:selected}):null;const body=$v6("#portfolioAnnualReportBody");if(!annualReport?.available){$v6("#portfolioAnnualPeriod").textContent="等待正式績效資料";body.innerHTML='<div class="portfolioAnalyticsEmpty">需要交易帳本與正式 portfolio snapshots 才能建立年度報告。</div>';return}$v6("#portfolioAnnualPeriod").textContent=`資料期間 ${displayDate(annualReport.startDate)}–${displayDate(annualReport.endDate)}${annualReport.partialYear?"｜非完整年度":""}`;const percentOr=value=>value===null||value===undefined?"資料不足":percent(value),allocation=label=>annualReport[label].length?annualReport[label].map(row=>annualRow(row.symbol,`${number(row.weight,1)}%`)).join(""):annualRow("配置","資料不足"),contribution=annualReport.contribution.length?annualReport.contribution.slice(0,8).map(row=>annualRow(row.code||row.symbol,money(row.contribution??row.amount??0))).join(""):annualRow("Contribution","資料不足");body.innerHTML=`<div class="portfolioAnnualSummary">${[["起始資產",money(annualReport.startAssets)],["期末／目前資產",money(annualReport.endAssets)],["TWR",percentOr(annualReport.twr)],["XIRR",percentOr(annualReport.xirr)],["0050 同期",percentOr(annualReport.benchmarkReturn)],["相對差異",percentOr(annualReport.relativeReturn)],["淨外部投入",money(annualReport.netExternal)],["股息",money(annualReport.dividends)],["已實現損益",money(annualReport.realizedPnL)],["未實現損益",annualReport.unrealizedPnL===null?"資料不足":money(annualReport.unrealizedPnL)],["最大回撤",percentOr(annualReport.maxDrawdown)],["年化波動率",percentOr(annualReport.annualizedVolatility)]].map(row=>workflowMetric(...row)).join("")}</div><div class="portfolioAnnualRows"><article class="portfolioAnnualBlock"><h3>起始配置</h3>${allocation("startAllocation")}</article><article class="portfolioAnnualBlock"><h3>期末配置</h3>${allocation("endAllocation")}</article><article class="portfolioAnnualBlock"><h3>年度 Contribution</h3>${contribution}</article><article class="portfolioAnnualBlock"><h3>交易與風險</h3>${annualRow("買入筆數",annualReport.trading.buyCount)}${annualRow("賣出筆數",annualReport.trading.sellCount)}${annualRow("買入總額",money(annualReport.trading.cumulativeBuy))}${annualRow("賣出總額",money(annualReport.trading.cumulativeSell))}</article></div><p class="portfolioAnnualNarrative">${escapeHtml(annualReport.summary)}</p>`}
  function renderCalendar(){const input=$v6("#portfolioCalendarMonth");if(!input.value)input.value=taipeiToday().slice(0,7);const result=ledger?workflowCore.calendarMonth(ledger,input.value):{available:false,days:[]},grid=$v6("#portfolioCalendarGrid"),timeline=$v6("#portfolioCalendarTimeline");if(!result.available){grid.innerHTML="";timeline.innerHTML='<div class="portfolioAnalyticsEmpty">建立交易帳本後顯示投資日曆。</div>';return}const map=new Map(result.days.map(day=>[Number(day.date.slice(8)),day])),first=new Date(`${input.value}-01T00:00:00Z`).getUTCDay(),count=new Date(Number(input.value.slice(0,4)),Number(input.value.slice(5,7)),0).getDate(),cells=[];for(let i=0;i<first;i+=1)cells.push('<span aria-hidden="true"></span>');for(let day=1;day<=count;day+=1){const item=map.get(day);cells.push(`<article class="portfolioCalendarDay"><time>${day}</time>${item?item.events.slice(0,3).map(event=>`<span class="portfolioCalendarEventDot">${escapeHtml(LEDGER_LABELS[event.type]||event.type)} ${event.symbol||money(event.grossAmount)}</span>`).join(""):""}</article>`)}grid.innerHTML=cells.join("");timeline.innerHTML=result.days.length?result.days.flatMap(day=>day.events.map(event=>`<article><time>${escapeHtml(day.date.slice(5).replace("-","/"))}</time><b>${escapeHtml(event.symbol?`${event.symbol} ${LEDGER_LABELS[event.type]||event.type}`:LEDGER_LABELS[event.type]||event.type)}</b><span>${money(Math.abs(event.cashImpact))}</span></article>`)).join(""):'<div class="portfolioAnalyticsEmpty">本月尚無交易活動。</div>'}
  function runIntegrityAudit(){portfolioAudit=ledger?resilienceCore.auditPortfolioData({ledger,snapshots:portfolioHistory,targets:rebalanceSettings.targets||{},knownSymbols:[...new Set([...catalog.map(row=>row.code),...holdings.map(row=>row.code)])]}):null;return portfolioAudit}
  function renderResilience(){const audit=runIntegrityAudit(),status=$v6("#portfolioIntegrityStatus"),issues=$v6("#portfolioIntegrityIssues"),repair=$v6("#portfolioIntegrityRepairBtn");status.innerHTML=audit?`<b class="portfolioIntegrityBadge" data-status="${audit.status}">${audit.status}</b><small>${audit.summary.events} 筆 Ledger｜${audit.summary.snapshots} 筆 snapshots｜Ledger ${escapeHtml(ledger.version)}</small>`:'<b class="portfolioIntegrityBadge" data-status="WARNING">NOT_INITIALIZED</b><small>建立交易帳本後才會執行完整性稽核。</small>';issues.innerHTML=audit?.issues.length?audit.issues.slice(0,8).map(row=>`<article><b>${escapeHtml(row.code)}</b><span>${escapeHtml(row.message)}</span></article>`).join(""):'<small>未發現需要人工處理的資料問題。</small>';const preview=ledger?resilienceCore.previewRepair({ledger,snapshots:portfolioHistory,targets:rebalanceSettings.targets||{},metadata:{}}):null;repair.hidden=preview?.status!=="REPAIR_AVAILABLE";repair.dataset.repair=preview?.status||"";$v6("#portfolioRecoveryPoints").innerHTML=portfolioRecoveryPoints.length?[...portfolioRecoveryPoints].reverse().map(row=>`<article><b>${escapeHtml(row.reason)}</b><span>${new Date(row.createdAt).toLocaleString("zh-TW")}</span><button type="button" data-recovery-restore="${escapeHtml(row.id)}">預覽還原</button></article>`).join(""):'<small>尚無復原點。</small>';$v6("#portfolioImportHistory").innerHTML=portfolioImportHistory.length?[...portfolioImportHistory].reverse().map(row=>`<article><b>${escapeHtml(row.fileName||row.adapterId)}</b><span>${escapeHtml(row.imported)} 筆｜${new Date(row.importedAt).toLocaleString("zh-TW")}</span><button type="button" data-import-batch-rollback="${escapeHtml(row.importBatchId)}" ${row.rolledBackAt?"disabled":""}>${row.rolledBackAt?"已回滾":"回滾此批次"}</button></article>`).join(""):'<small>尚無具 provenance 的券商匯入批次。</small>'}
  function renderDataStatus(){const node=$v6("#portfolioDataStatus"),rollback=Boolean(portfolioImportState?.preImportLedger);node.className="portfolioDataStatusRows";node.innerHTML=[["Ledger events",ledger?.events.length??0],["Snapshots",portfolioHistory.length],["Performance start",ledger?.performanceStartDate?displayDate(ledger.performanceStartDate):"—"],["Last backup",portfolioImportState?.lastBackupAt?new Date(portfolioImportState.lastBackupAt).toLocaleString("zh-TW"):"—"],["Backup schema","Full V1"],["Migration",resilienceCore.MIGRATION_VERSION],["Goal",portfolioGoal?"已設定":"未設定"],["Import status",portfolioImportState?.lastImportAt?`${portfolioImportState.importedCount} 筆｜${portfolioImportState.fileName}`:"尚未匯入"]].map(([label,value])=>`<span>${escapeHtml(label)}<b>${escapeHtml(value)}</b></span>`).join("");$v6("#portfolioImportRollbackBtn").disabled=!rollback;renderResilience()}
  function renderWorkflow(){renderGoalAndActivity();renderRecurring();renderAnnualReport();renderCalendar();renderDataStatus()}
  function normalizePortfolioTool(name){return({overview:"performance",performance:"performance",analytics:"analytics",recurring:"analytics",risk:"risk",transactions:"transactions",report:"report",calendar:"calendar",settings:"settings"})[name]||"performance"}
  function showPortfolioTool(name,{scroll=true}={}){activePortfolioTool=normalizePortfolioTool(name);document.querySelectorAll("[data-portfolio-tool]").forEach(node=>{node.hidden=node.dataset.portfolioTool!==activePortfolioTool});$v6("#portfolioWorkflowNav").querySelectorAll("[data-portfolio-section]").forEach(button=>{const active=normalizePortfolioTool(button.dataset.portfolioSection)===activePortfolioTool;button.classList.toggle("active",active);button.setAttribute("aria-selected",String(active))});if(scroll)$v6("#portfolioWorkflowNav").scrollIntoView({behavior:"smooth",block:"start"})}
  function workflowSectionTarget(name){$v6("#portfolioMoreTools").open=true;showPortfolioTool(name,{scroll:false});return document.querySelector(`[data-portfolio-tool="${normalizePortfolioTool(name)}"]`)}
  function holdingsView(name){const viewport=$v6("#portfolioHoldingsTableViewport"),table=$v6(".portfolioHoldingsTable"),target=$v6(`[data-column-group="${name}"]`),sticky=$v6(".portfolioHoldingsTableHead .holdingColSymbol");if(!viewport||!target||!table)return;table.dataset.view=name;viewport.scrollTo({left:name==="position"?0:Math.max(0,target.offsetLeft-(sticky?.offsetWidth||0)),behavior:"smooth"});document.querySelectorAll("[data-holdings-view]").forEach(button=>button.classList.toggle("active",button.dataset.holdingsView===name))}
  function openCsvPreview(preview,fileName){csvImportPreview=preview;csvImportFileName=fileName;$v6("#portfolioCsvPreviewSummary").innerHTML=[["總筆數",preview.total],["有效",preview.valid],["警告",preview.warning],["錯誤",preview.errors],["疑似重複",preview.duplicates]].map(row=>`<article><span>${row[0]}</span><b>${row[1]}</b></article>`).join("");const labels={VALID:"可匯入",WARNING:"需確認",ERROR:"無法匯入",DUPLICATE_CANDIDATE:"疑似重複"};$v6("#portfolioCsvPreviewRows").innerHTML=preview.rows.map((row,index)=>`<label class="portfolioCsvRow" data-status="${row.status}"><input type="checkbox" data-csv-select="${index}" ${row.selected?"checked":""} ${row.status==="ERROR"?"disabled":""}><span>#${row.rowNumber}</span><b class="portfolioCsvStatus">${labels[row.status]}</b><span data-csv-symbol>${escapeHtml(row.event?.symbol||row.event?.type||row.raw?.type||"—")}</span><small data-csv-detail>${escapeHtml(row.event?`${row.event.tradeDate}｜${row.event.type}｜${row.event.quantity??row.event.grossAmount}`:"欄位驗證失敗")}</small><small data-csv-message>${escapeHtml(row.messages.join("；")||"格式與欄位有效")}</small></label>`).join("");$v6("#portfolioCsvPreviewError").textContent="";const modal=$v6("#portfolioCsvPreviewModal");modal.classList.add("show");modal.setAttribute("aria-hidden","false")}
  function closeCsvPreview(){const modal=$v6("#portfolioCsvPreviewModal");modal.classList.remove("show");modal.setAttribute("aria-hidden","true");$v6("#portfolioCsvImportFile").value=""}
  async function selectCsv(file){if(!file)return;try{if(!ledger)throw new Error("請先建立交易帳本");if(file.size>1024*1024)throw new Error("CSV 不可超過 1 MB");openCsvPreview(workflowCore.buildImportPreview(await file.text(),ledger),file.name)}catch(error){alert(`CSV 讀取失敗：${error.message}`);$v6("#portfolioCsvImportFile").value=""}}
  function confirmCsvImport(){if(!ledger||!csvImportPreview)return;const selected=[...$v6("#portfolioCsvPreviewRows").querySelectorAll("[data-csv-select]:checked")].map(node=>Number(node.dataset.csvSelect));createRecovery(csvImportPreview.adapterId?"BEFORE_BROKER_IMPORT":"BEFORE_CSV_IMPORT");const result=csvImportPreview.adapterId?resilienceCore.atomicBrokerImport(ledger,csvImportPreview,selected):workflowCore.atomicImport(ledger,csvImportPreview,selected);if(!result.ok){$v6("#portfolioCsvPreviewError").textContent=result.error||`整批驗證失敗：${result.status}`;return}const now=new Date().toISOString();portfolioImportState={lastImportAt:now,fileName:csvImportFileName,importedCount:result.imported,preImportLedger:ledger,lastBackupAt:now};if(result.importBatchId){portfolioImportHistory.push({importedAt:now,fileName:csvImportFileName,imported:result.imported,importBatchId:result.importBatchId,adapterId:result.adapterId});saveWorkflowValue(resilienceCore.IMPORT_HISTORY_STORAGE_KEY,portfolioImportHistory)}saveWorkflowValue(workflowCore.IMPORT_STORAGE_KEY,portfolioImportState);persistLedger(result.ledger);closeCsvPreview();refreshPortfolio();alert(`已原子匯入 ${result.imported} 筆交易；若發現問題，可在設定恢復匯入前狀態。`)}
  function rollbackCsvImport(){if(!portfolioImportState?.preImportLedger)return;if(!confirm("確定要恢復最近一次 CSV 匯入前的交易帳本？"))return;if(!confirm("再次確認：目前匯入後的交易變更將由匯入前狀態取代。"))return;const restored=ledgerCore.validateLedger(portfolioImportState.preImportLedger);if(!restored){alert("匯入前備份驗證失敗，未變更任何資料。");return}persistLedger(restored);portfolioImportState={...portfolioImportState,preImportLedger:null,rollbackAt:new Date().toISOString()};saveWorkflowValue(workflowCore.IMPORT_STORAGE_KEY,portfolioImportState);refreshPortfolio()}
  async function selectBrokerCsv(file){if(!file)return;try{if(!ledger)throw new Error("請先建立交易帳本");if(file.size>1024*1024)throw new Error("CSV 不可超過 1 MB");const preview=resilienceCore.buildBrokerPreview(await file.text(),ledger,{fileName:file.name});if(!preview.ok)throw new Error("目前只支援 Phase 7 通用券商 CSV fixture");openCsvPreview(preview,file.name)}catch(error){alert(`券商 CSV 讀取失敗：${error.message}`)}finally{$v6("#portfolioBrokerImportFile").value=""}}
  function rollbackImportBatch(batchId){const record=portfolioImportHistory.find(row=>row.importBatchId===batchId);if(!record||record.rolledBackAt||!confirm("只移除此券商匯入批次，保留後續手動交易？"))return;createRecovery("BEFORE_IMPORT_BATCH_ROLLBACK");const result=resilienceCore.rollbackImportBatch(ledger,batchId);if(!result.ok){alert(result.error||`批次回滾失敗：${result.status}`);return}persistLedger(result.ledger);record.rolledBackAt=new Date().toISOString();saveWorkflowValue(resilienceCore.IMPORT_HISTORY_STORAGE_KEY,portfolioImportHistory);refreshPortfolio()}
  function restoreRecoveryPoint(id){const point=portfolioRecoveryPoints.find(row=>row.id===id),preview=point?resilienceCore.previewBackup(point.backup):null;if(!preview?.ok){alert("復原點無法通過完整性驗證。");return}if(!confirm(`復原預覽：${preview.counts.events} 筆 Ledger、${preview.counts.snapshots} 筆 snapshots。確定原子還原？`))return;const restored=resilienceCore.restoreBackup(point.backup);if(!restored.ok){alert("還原失敗，目前資料未變更。");return}createRecovery("BEFORE_RECOVERY_RESTORE");holdings=core.validateImportPayload(restored.holdings);ledger=restored.ledger;portfolioHistory=restored.snapshots.map(performanceCore.validateSnapshot).filter(Boolean);rebalanceSettings={...rebalanceSettings,...restored.rebalanceSettings};portfolioGoal=restored.goal;portfolioMonthlyPlan=restored.monthlyPlan;portfolioImportState=restored.importState;portfolioImportHistory=restored.importHistory||[];persistLedger(ledger);savePortfolioHistory();saveRebalanceSettings();saveWorkflowValue(workflowCore.GOAL_STORAGE_KEY,portfolioGoal);saveWorkflowValue(workflowCore.PLAN_STORAGE_KEY,portfolioMonthlyPlan);saveWorkflowValue(workflowCore.IMPORT_STORAGE_KEY,portfolioImportState);saveWorkflowValue(resilienceCore.IMPORT_HISTORY_STORAGE_KEY,portfolioImportHistory);refreshPortfolio()}
  function openGoal(){const modal=$v6("#portfolioGoalModal");$v6("#portfolioGoalValue").value=portfolioGoal?.targetValue||"";$v6("#portfolioGoalDate").value=portfolioGoal?.targetDate||"";$v6("#portfolioGoalError").textContent="";modal.classList.add("show");modal.setAttribute("aria-hidden","false")}
  function closeGoal(){const modal=$v6("#portfolioGoalModal");modal.classList.remove("show");modal.setAttribute("aria-hidden","true")}

  function exportHoldings() {
    let payload;
    try { payload=fullBackupCore.createBackup(localStorage); }
    catch { alert("完整備份驗證失敗；未匯出不完整檔案。"); return; }
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
      if (file.size > 5 * 1024 * 1024) throw new Error("備份檔不可超過 5 MB。");
      const parsed = JSON.parse(await file.text());
      if (parsed?.schema===fullBackupCore.SCHEMA || parsed?.schemaVersion!==undefined) {
        const preview=fullBackupCore.validateBackup(parsed);
        if(!preview.ok)throw new Error(`完整備份驗證失敗：${preview.status}`);
        if(!confirm(`完整備份包含 ${preview.state.holdings.length} 檔實際持股、${preview.state.universe.length} 檔目標標的、現金與再平衡設定。還原將取代目前 Portfolio 使用者資料，確定繼續？`))return;
        const result=fullBackupCore.restoreAtomic(localStorage,parsed);
        if(!result.ok)throw new Error(`還原未完成：${result.status}`);
        location.reload();return;
      }
      if(!confirm("這是舊版備份；可能只包含持股，不包含目標配置與現金。若繼續，將沿用舊版匯入方式。確定繼續？"))return;
      const preview=[4,5,6].includes(Number(parsed?.version))?resilienceCore.previewBackup(parsed):null;if(preview&&!preview.ok)throw new Error("完整備份格式無效。");if(preview&&!confirm(`備份預覽：${preview.counts.events} 筆 Ledger、${preview.counts.snapshots} 筆 snapshots、${preview.counts.holdings} 檔持股。確定原子還原？`))return;const restored=preview?resilienceCore.restoreBackup(parsed):null;if(restored&&!restored.ok)throw new Error("備份完整性驗證失敗。");if(restored)createRecovery("BEFORE_BACKUP_RESTORE");
      const imported = core.validateImportPayload(restored?restored.holdings:parsed);
      const importedLedger = restored?.ledger||(parsed?.ledger ? ledgerCore.validateLedger(parsed.ledger) : null);
      if (parsed?.ledger && !importedLedger) throw new Error("交易帳本格式無效。");
      holdings = imported;
      if (importedLedger) { ledger=importedLedger; persistLedger(importedLedger); }
      else { ledger=null; ledgerState=null; localStorage.removeItem(ledgerCore.STORAGE_KEY); }
      if(Array.isArray(parsed?.snapshots)){const restored=parsed.snapshots.map(performanceCore.validateSnapshot).filter(Boolean);portfolioHistory=restored.sort((a,b)=>a.date.localeCompare(b.date));savePortfolioHistory()}
      if(parsed?.rebalanceSettings&&typeof parsed.rebalanceSettings==="object"){rebalanceSettings={...rebalanceSettings,...parsed.rebalanceSettings};if(ledgerState?.valid)rebalanceSettings.cash=ledgerState.cash;saveRebalanceSettings()}
      if(restored){portfolioGoal=restored.goal;portfolioMonthlyPlan=restored.monthlyPlan;portfolioImportState=restored.importState;portfolioImportHistory=restored.importHistory||[];saveWorkflowValue(workflowCore.GOAL_STORAGE_KEY,portfolioGoal);saveWorkflowValue(workflowCore.PLAN_STORAGE_KEY,portfolioMonthlyPlan);saveWorkflowValue(workflowCore.IMPORT_STORAGE_KEY,portfolioImportState);saveWorkflowValue(resilienceCore.IMPORT_HISTORY_STORAGE_KEY,portfolioImportHistory)}
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
    const officialTime = Date.parse([...incoming.values()].find(quote => quote.officialCheckedAt)?.officialCheckedAt || "");
    if (Number.isFinite(officialTime)) officialCheckedAt = officialTime;
    const sourceTime=Date.parse(event.detail.sourceUpdatedAt||"");
    if(Number.isFinite(sourceTime))lastSuccessAt=sourceTime;
    const applyPortfolio=$v6("#portfolioAutoRefresh").checked||pendingManualPortfolioApply;
    pendingManualPortfolioApply=false;
    reconcilePortfolioQuotes(publicQuoteMap, {applyPortfolio, sourceUpdatedAt: event.detail.sourceUpdatedAt||""});
    renderQuoteStatus(`${quoteTimeLabel()}｜${event.detail.source==="authorized_proxy"?"授權延遲行情":"公開快取"}`);
  }

  function useCurrentAllocationAsTargets() {
    const targets = core.targetsFromAllocation(computed.rows);
    if (!targets.length) return;
    const targetMap = new Map(targets.map(item => [item.code, item.targetAllocation]));
    holdings = holdings.map(item => core.validateHolding({...item, targetAllocation: targetMap.get(item.code) ?? item.targetAllocation}));
    for(const code of Object.keys(rebalanceSettings.targets))if(!holdings.some(item=>item.code===code))rebalanceSettings.targets[code]=0;
    saveHoldings();
    saveRebalanceSettings();
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
    $v6("#portfolioAddBtn").addEventListener("click", () => openTransaction());
    $v6("#portfolioAddCashBtn").addEventListener("click",openCashModal);
    $v6("#portfolioCashClose").addEventListener("click",closeCashModal);
    $v6("#portfolioCashModal").addEventListener("click",event=>{if(event.target===$v6("#portfolioCashModal"))closeCashModal()});
    $v6("#portfolioCashForm").addEventListener("submit",submitCash);
    $v6("#portfolioModalClose").addEventListener("click", closePortfolioModal);
    $v6("#portfolioModal").addEventListener("click", event => { if (event.target === $v6("#portfolioModal")) closePortfolioModal(); });
    $v6("#portfolioForm").addEventListener("submit", submitPortfolio);
    $v6("#portfolioTargetEditorOpen").addEventListener("click",openTargetModal);
    $v6("#portfolioTargetModalClose").addEventListener("click",closeTargetModal);
    $v6("#portfolioTargetModal").addEventListener("click",event=>{if(event.target===$v6("#portfolioTargetModal"))closeTargetModal()});
    $v6("#portfolioTargetForm").addEventListener("submit",saveTargetBatch);
    $v6("#portfolioTargetSymbolAdd").addEventListener("click",addTargetSymbol);
    $v6("#portfolioSmartTargetOpen").addEventListener("click",openTargetModal);
    $v6("#portfolioTargetCancel").addEventListener("click",closeTargetModal);
    $v6("#portfolioCode").addEventListener("input", event => {
      searchCatalog(event.target.value);
    });
    $v6("#portfolioDuplicateActions").querySelectorAll("[data-duplicate-action]").forEach(button => button.addEventListener("click", () => duplicateAction(button.dataset.duplicateAction)));
    $v6("#portfolioSort").addEventListener("change",()=>{holdingsSortDirection="desc";renderList()});
    $v6(".portfolioHoldingsTableHead").addEventListener("click",event=>{const button=event.target.closest("[data-holdings-sort]");if(!button)return;const select=$v6("#portfolioSort"),same=select.value===button.dataset.holdingsSort;holdingsSortDirection=same&&holdingsSortDirection==="desc"?"asc":"desc";select.value=button.dataset.holdingsSort;renderList()});
    $v6(".portfolioHoldingsViews").addEventListener("click",event=>{const button=event.target.closest("[data-holdings-view]");if(button)holdingsView(button.dataset.holdingsView)});
    $v6("#portfolioExportBtn").addEventListener("click", exportHoldings);
    $v6("#portfolioImportBtn").addEventListener("click", () => $v6("#portfolioImportFile").click());
    $v6("#portfolioImportFile").addEventListener("change", event => importHoldings(event.target.files?.[0]));
    $v6("#portfolioCsvTemplateBtn").addEventListener("click",()=>downloadText(workflowCore.csvTemplate(),"hs-portfolio-transactions-template.csv","text/csv;charset=utf-8"));
    $v6("#portfolioCsvImportBtn").addEventListener("click",()=>{if(!ledger){openMigration();return}$v6("#portfolioCsvImportFile").click()});
    $v6("#portfolioCsvImportFile").addEventListener("change",event=>selectCsv(event.target.files?.[0]));
    $v6("#portfolioBrokerImportBtn").addEventListener("click",()=>{if(!ledger){openMigration();return}$v6("#portfolioBrokerImportFile").click()});
    $v6("#portfolioBrokerImportFile").addEventListener("change",event=>selectBrokerCsv(event.target.files?.[0]));
    $v6("#portfolioCsvExportBtn").addEventListener("click",()=>{if(!ledger){openMigration();return}downloadText(`\uFEFF${workflowCore.exportLedgerCsv(ledger)}`,`hs-portfolio-ledger-${taipeiToday()}.csv`,"text/csv;charset=utf-8")});
    $v6("#portfolioCsvConfirmBtn").addEventListener("click",confirmCsvImport);
    $v6("#portfolioCsvPreviewRows").addEventListener("change",event=>{const index=Number(event.target.dataset.csvSelect);if(Number.isInteger(index)&&csvImportPreview?.rows[index])csvImportPreview.rows[index].selected=event.target.checked});
    document.querySelectorAll("[data-csv-preview-close]").forEach(button=>button.addEventListener("click",closeCsvPreview));
    $v6("#portfolioImportRollbackBtn").addEventListener("click",rollbackCsvImport);
    $v6("#portfolioIntegrityAuditBtn").addEventListener("click",renderResilience);
    $v6("#portfolioIntegrityRepairBtn").addEventListener("click",()=>{if(!ledger)return;const input={ledger,snapshots:portfolioHistory,targets:rebalanceSettings.targets||{},metadata:{}},preview=resilienceCore.previewRepair(input);if(preview.status!=="REPAIR_AVAILABLE"){alert("沒有可自動安全修復的項目。");return}if(!confirm(`將執行 ${preview.operations.length} 項可逆的安全修復，並先建立復原點？`))return;createRecovery("BEFORE_INTEGRITY_REPAIR");const result=resilienceCore.applyRepair(input,preview);if(!result.ok){alert("修復後稽核未通過，未寫入。");return}persistLedger(result.data.ledger);refreshPortfolio()});
    $v6("#portfolioImportHistory").addEventListener("click",event=>{const button=event.target.closest("[data-import-batch-rollback]");if(button)rollbackImportBatch(button.dataset.importBatchRollback)});
    $v6("#portfolioRecoveryPoints").addEventListener("click",event=>{const button=event.target.closest("[data-recovery-restore]");if(button)restoreRecoveryPoint(button.dataset.recoveryRestore)});
    document.querySelectorAll("[data-goal-edit]").forEach(button=>button.addEventListener("click",openGoal));document.querySelectorAll("[data-goal-close]").forEach(button=>button.addEventListener("click",closeGoal));
    $v6("#portfolioGoalForm").addEventListener("submit",event=>{event.preventDefault();const goal=workflowCore.normalizeGoal({targetValue:$v6("#portfolioGoalValue").value,targetDate:$v6("#portfolioGoalDate").value});if(!goal){$v6("#portfolioGoalError").textContent="請輸入大於 0 的目標資產與有效目標日期。";return}portfolioGoal=goal;saveWorkflowValue(workflowCore.GOAL_STORAGE_KEY,portfolioGoal);closeGoal();renderWorkflow()});
    $v6("#portfolioMonthlyPlan").value=portfolioMonthlyPlan?.amount||"";$v6("#portfolioMonthlyPlan").addEventListener("change",event=>{portfolioMonthlyPlan=workflowCore.normalizeMonthlyPlan(event.target.value);saveWorkflowValue(workflowCore.PLAN_STORAGE_KEY,portfolioMonthlyPlan);renderWorkflow()});
    $v6("#portfolioAnnualYear").addEventListener("change",renderAnnualReport);$v6("#portfolioAnnualCsvBtn").addEventListener("click",()=>{if(!annualReport?.available)return;downloadText(`\uFEFF${workflowCore.exportAnnualCsv(annualReport)}`,`hs-portfolio-annual-${annualReport.year}.csv`,"text/csv;charset=utf-8")});$v6("#portfolioAnnualPrintBtn").addEventListener("click",()=>window.print());
    $v6("#portfolioCalendarMonth").addEventListener("change",renderCalendar);
    $v6("#portfolioWorkflowNav").addEventListener("click",event=>{const button=event.target.closest("[data-portfolio-section]");if(button)showPortfolioTool(button.dataset.portfolioSection)});
    $v6("#portfolioMoreTools").addEventListener("toggle",event=>$v6("#portfolio").classList.toggle("portfolioMoreOpen",event.target.open));
    document.querySelectorAll("[data-portfolio-section]").forEach(button=>{
      if(button.closest("#portfolioWorkflowNav"))return;
      button.addEventListener("click",()=>{
        const target=workflowSectionTarget(button.dataset.portfolioSection);
        if(target){$v6("#portfolioWorkflowNav").scrollIntoView({behavior:"smooth",block:"start"})}
      });
    });
    $v6("#portfolioClearBtn").addEventListener("click", clearHoldings);
    $v6("#portfolioTransactionAddBtn").addEventListener("click", () => openTransaction());
    $v6("#portfolioLedgerViewBtn").addEventListener("click", openLedger);
    $v6("#portfolioLedgerMigrateBtn").addEventListener("click",()=>{migrateLedger();if(ledger)openTransaction()});
    document.querySelectorAll("[data-ledger-close]").forEach(button=>button.addEventListener("click",closeLedgerModals));
    $v6("#portfolioTransactionType").addEventListener("change",()=>{transactionVisibility();updateCashImpactNote()});
    ["#portfolioTransactionQuantity","#portfolioTransactionPrice","#portfolioTransactionFee"].forEach(selector=>$v6(selector).addEventListener("input",updateCashImpactNote));
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
    $v6("#rebalanceCash").disabled = Boolean(ledger);
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
        ...rebalanceSettings,
        cash: ledgerState?.valid ? ledgerState.cash : Math.max(0, Number($v6("#rebalanceCash").value) || 0), profile: $v6("#rebalanceProfile").value,
        customTolerance: Number($v6("#rebalanceCustomTolerance").value), reminder: $v6("#rebalanceReminder").value,
        customDays: Number($v6("#rebalanceCustomDays").value), cashFirst: $v6("#rebalanceCashFirst").checked,
        trendProtection: $v6("#rebalanceTrendProtection").checked
      };
      saveRebalanceSettings(); syncRebalanceControls(); refreshPortfolio();
    };
    $v6("#rebalanceCash").addEventListener("input", updateRebalanceSettings);
    rebalanceIds.filter(id => id !== "rebalanceCash").forEach(id => $v6(`#${id}`).addEventListener("change", updateRebalanceSettings));
    $v6("#rebalanceUseCurrentBtn").addEventListener("click", useCurrentAllocationAsTargets);
    $v6("#rebalanceApplyBtn").addEventListener("click", showRebalanceSimulation);
    syncRebalanceControls();
    $v6("#portfolioPerformancePeriods").addEventListener("click", event => {
      const button = event.target.closest("[data-performance-period]");
      if (!button) return;
      portfolioAnalysisPeriod = button.dataset.performancePeriod;
      renderPerformance();
      renderRiskCenter();
      renderAnalytics();
    });
    $v6("#portfolioBenchmarkToggle").addEventListener("change", renderPerformance);
    $v6("#portfolioAnalyticsTabs").addEventListener("click", event => {
      const button=event.target.closest("[data-analytics-tab]");if(!button)return;analyticsTab=button.dataset.analyticsTab;renderAnalytics();
    });
    $v6("#portfolioAnalyticsCenter").addEventListener("click",event=>{const button=event.target.closest("[data-analytics-open]");if(!button)return;analyticsTab=button.dataset.analyticsOpen;renderAnalytics()});
    $v6("#portfolioAnalyticsDetail").addEventListener("change",event=>{if(event.target.matches("[data-dividend-year]")){analyticsDividendYear=event.target.value;renderAnalytics()}else if(event.target.matches("[data-report-month]")){analyticsMonth=event.target.value;renderAnalytics()}});
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
    window.addEventListener("hs:quote-cache-checked",event=>{
      const checked = Date.parse(event.detail?.officialCheckedAt || "");
      if (Number.isFinite(checked)) officialCheckedAt = checked;
      renderQuoteStatus();
    });
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
      if (event.key === "Escape" && $v6("#portfolioTargetModal").classList.contains("show")) closeTargetModal();
      if (event.key === "Escape") closeLedgerModals();
    });
    const sentimentObserver = new MutationObserver(renderHomeSentiment);
    sentimentObserver.observe($v6("#fomoContent"), {childList: true});
    sentimentObserver.observe($v6("#cnnFearGreedContent"), {childList: true});
  }

  bindEvents();
  window.addEventListener("hs:formal-core-score-updated",()=>{renderPortfolioDecisionSupport();renderList();renderRebalance();renderCapitalPlan()});
  showPortfolioTool("performance",{scroll:false});
  refreshPortfolio();
  fetch(BENCHMARK_URL, {cache: "no-store", headers: {"Accept": "application/json"}}).then(response => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }).then(payload => {
    benchmarkRows = Array.isArray(payload?.items?.["0050"]?.rows) ? payload.items["0050"].rows : [];
    historicalRowsBySymbol=new Map(Object.entries(payload?.items||{}).map(([symbol,item])=>[symbol,Array.isArray(item?.rows)?item.rows:[]]));
    renderList();renderPerformance(); renderRiskCenter(); renderAnalytics();
  }).catch(() => { benchmarkRows = [];historicalRowsBySymbol=new Map();renderList(); renderPerformance(); renderRiskCenter(); renderAnalytics(); });
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
