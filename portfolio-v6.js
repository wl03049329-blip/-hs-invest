(function () {
  "use strict";

  const core = window.HSPortfolioCore;
  if (!core) return;

  const storageKeys = window.HSPersistenceCore?.keys || {};
  const HOLDINGS_KEY = storageKeys.holdings || "hsRadar.portfolio.holdings";
  const QUOTES_KEY = storageKeys.quotes || "hsRadar.portfolio.quotes";
  const AUTO_KEY = storageKeys.portfolioAuto || "hsRadar.portfolio.autoRefresh";
  const MARKET_VERSION_KEY = storageKeys.portfolioMarketVersion || "hsRadar.portfolio.marketVersion";
  const TWSE_URL = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL";
  const TPEX_URL = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes";
  const MARKET_CACHE_URL = "market-quotes.json";
  const MARKET_META_URL = "market-quotes-meta.json";
  const COLORS = ["#52e38c", "#72b8ff", "#ff9d42", "#bd72ff", "#ff6674", "#ffd84d", "#42d7d1", "#d9a7ff"];
  const $v6 = selector => document.querySelector(selector);
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[char]));

  let holdings = loadHoldings();
  let quoteMap = loadQuoteCache();
  let publicQuoteMap = new Map();
  let computed = core.calculatePortfolio(holdings, quoteMap);
  let pendingDuplicate = null;
  let editingCode = null;
  let catalog = [];
  let catalogLoading = null;
  let refreshTimer = null;
  let refreshInFlight = null;
  let lastAttemptAt = 0;
  let lastSuccessAt = latestCachedFetchTime();
  let failureCount = 0;
  let marketCacheVersion = localStorage.getItem(MARKET_VERSION_KEY) || "";
  let chartSegments = [];
  let chartSelection = -1;
  let resizeFrame = 0;

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
          market: quote.market === "TPEx" ? "TPEx" : "TWSE"
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

  function taipeiToday() {
    return new Intl.DateTimeFormat("en-CA", {timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit"}).format(new Date());
  }

  function marketModeText() {
    return core.isTaipeiMarketOpen() ? "盤中動態延遲｜來源時間為準" : "收盤資料模式";
  }

  function renderQuoteStatus(message) {
    $v6("#portfolioMarketMode").textContent = marketModeText();
    $v6("#portfolioQuoteStatus").textContent = message || quoteTimeLabel();
  }

  function renderSummary() {
    const element = $v6("#portfolioSummary");
    if (!holdings.length) {
      element.innerHTML = [
        ["今日損益", "資料更新中", "今日報酬率 —"],
        ["累積損益", "資料更新中", "總報酬率 —"],
        ["股票市值", "資料更新中", "總投入成本 —"]
      ].map(([label, value, note]) => `<article class="summaryCard"><span>${label}</span><b class="dataPending">${value}</b><small>${note}</small></article>`).join("");
      return;
    }
    if (!computed.complete) {
      element.innerHTML = [
        ["今日損益", "資料更新中", "等待全部持股行情"],
        ["累積損益", "資料更新中", "缺少價格不會誤算為 0"],
        ["股票市值", "資料更新中", "已保留最後成功價格"]
      ].map(([label, value, note]) => `<article class="summaryCard"><span>${label}</span><b class="dataPending">${value}</b><small>${note}</small></article>`).join("");
      return;
    }
    element.innerHTML = `
      <article class="summaryCard"><span>今日損益</span><b class="${valueClass(computed.todayPnl)}">${money(computed.todayPnl)}</b><small class="${valueClass(computed.todayRate)}">今日報酬率 ${percent(computed.todayRate)}</small></article>
      <article class="summaryCard"><span>累積損益</span><b class="${valueClass(computed.totalPnl)}">${money(computed.totalPnl)}</b><small class="${valueClass(computed.returnRate)}">總報酬率 ${percent(computed.returnRate)}</small></article>
      <article class="summaryCard"><span>股票市值</span><b>${money(computed.totalMarketValue)}</b><small>總投入成本 ${money(computed.totalCost)}</small></article>`;
  }

  function holdingName(row) {
    return row.customName || row.quote?.name || row.name || row.code;
  }

  function radarFor(code) {
    try {
      const item = Array.isArray(all) ? all.find(entry => entry.id === code) : null;
      if (!item) return null;
      return {score: Number.isFinite(item.score) ? item.score : null, trend: item.trend?.label || "趨勢資料暫缺", action: item.action || "買點資料暫缺", strategyType: item.activeStrategyMode || "", swing: item.swingDecision || null};
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
    const rows = [...computed.rows];
    if (mode === "code") return rows.sort((a, b) => a.code.localeCompare(b.code));
    return rows.sort((a, b) => {
      const left = Number.isFinite(a[mode]) ? a[mode] : -Infinity;
      const right = Number.isFinite(b[mode]) ? b[mode] : -Infinity;
      return right - left || a.code.localeCompare(b.code);
    });
  }

  function renderList() {
    const list = $v6("#portfolioList");
    if (!holdings.length) {
      list.innerHTML = '<div class="portfolioEmpty">尚未新增持股。資料只會儲存在你的裝置。</div>';
      return;
    }
    list.innerHTML = sortedRows().map(row => {
      const radar = radarFor(row.code);
      const quoteMissing = !row.quote;
      const name = holdingName(row);
      const radarHtml = radar
        ? `<span class="radarPill">買點 ${radar.score === null ? "—" : radar.score} 分</span><b>${escapeHtml(radar.trend)}</b><span>${escapeHtml(radar.action)}</span>`
        : '<span class="radarPill">買點 —</span><span>尚未加入「ETF雷達」，無買點資料</span>';
      const tradeLabel = radar?.strategyType === "swing00733" ? "00733 強勢趨勢拉回" : radar?.strategyType === "swing006201" ? "006201 上櫃低檔轉折" : "";
      const trendProtected = radar?.swing?.strategyType === "swing00733" && radar.swing.stage?.number >= 3;
      const rebalance = core.rebalanceDecision({actualWeight: row.weight, targetAllocation: row.targetAllocation, trendProtected});
      return `<article class="holdingCard" data-holding-code="${escapeHtml(row.code)}">
        <div class="holdingMain">
          <div class="holdingIdentity"><b>${escapeHtml(row.code)}</b><span>${escapeHtml(name)}</span></div>
          <div class="holdingMetric"><span>今日損益</span><b class="${valueClass(row.todayPnl)}">${quoteMissing ? "行情暫缺" : money(row.todayPnl)}</b></div>
          <div class="holdingMetric"><span>漲跌幅</span><b class="${valueClass(row.changeRate)}">${quoteMissing ? "—" : percent(row.changeRate)}</b></div>
          <div class="holdingMetric"><span>累積損益</span><b class="${valueClass(row.totalPnl)}">${quoteMissing ? "—" : money(row.totalPnl)}</b></div>
          <div class="holdingActions"><button type="button" data-edit-holding="${escapeHtml(row.code)}" aria-label="修改 ${escapeHtml(row.code)} 持股">修改</button><button type="button" data-delete-holding="${escapeHtml(row.code)}" aria-label="刪除 ${escapeHtml(row.code)} 持股">刪除</button></div>
        </div>
        <div class="holdingRadar">${radarHtml}</div>
        <details class="holdingDetails">
          <summary>展開股數、成本、市值與占比</summary>
          <div class="holdingDetailsGrid">
            <div><span>股數</span><b>${number(row.shares, 4)}</b></div>
            <div><span>平均成本</span><b>${money(row.averageCost)}</b></div>
            <div><span>總成本</span><b>${money(row.totalCost)}</b></div>
            <div><span>目前股價</span><b>${quoteMissing ? "行情暫缺" : money(row.quote.price)}</b></div>
            <div><span>目前市值</span><b>${money(row.marketValue)}</b></div>
            <div><span>市值占比</span><b>${percent(row.weight)}</b></div>
            <div><span>累積報酬率</span><b class="${valueClass(row.returnRate)}">${percent(row.returnRate)}</b></div>
            <div><span>行情日期</span><b>${escapeHtml(row.quote?.date || "行情暫缺")}</b></div>
            <div><span>策略類型</span><b>${escapeHtml(tradeLabel || row.strategyType || "使用預設模型")}</b></div>
            <div><span>目標配置</span><b>${Number.isFinite(row.targetAllocation) ? percent(row.targetAllocation) : "未設定"}</b></div>
          </div>
          <p class="holdingNote">${escapeHtml(rebalance.label)}</p>
          ${lossNote(row) ? `<p class="holdingNote">${escapeHtml(lossNote(row))}</p>` : ""}
        </details>
      </article>`;
    }).join("");
    list.querySelectorAll("[data-edit-holding]").forEach(button => button.addEventListener("click", () => openPortfolioModal(button.dataset.editHolding)));
    list.querySelectorAll("[data-delete-holding]").forEach(button => button.addEventListener("click", () => deleteHolding(button.dataset.deleteHolding)));
  }

  function renderPortfolio(animate = false) {
    computed = core.calculatePortfolio(holdings, quoteMap);
    renderSummary();
    renderList();
    drawAllocation();
    renderQuoteStatus();
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
    const size = Math.max(220, Math.min(560, wrap.clientWidth || 320));
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(size * ratio) || canvas.height !== Math.round(size * ratio)) {
      canvas.width = Math.round(size * ratio);
      canvas.height = Math.round(size * ratio);
    }
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const allocation = core.buildAllocation(computed.rows);
    chartSegments = [];
    if (!allocation.length) {
      ctx.strokeStyle = "#244332";
      ctx.lineWidth = Math.max(22, size * .12);
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size * .32, 0, Math.PI * 2);
      ctx.stroke();
      $v6("#portfolioChartCenter").innerHTML = `<b>${holdings.length ? "資料更新中" : "尚無持股"}</b><span>${holdings.length} 檔持股</span>`;
      $v6("#portfolioChartDetail").textContent = holdings.length ? "行情載入後會顯示市值配置。" : "新增持股後會在此顯示資產配置。";
      return;
    }
    const center = size / 2;
    const radius = size * .36;
    const lineWidth = size * .19;
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
    $v6("#portfolioChartCenter").innerHTML = `<b>${computed.complete ? money(computed.totalMarketValue) : "部分行情"}</b><span>${holdings.length} 檔持股</span>`;
  }

  function showChartDetail(index) {
    if (!chartSegments.length) return;
    chartSelection = (index + chartSegments.length) % chartSegments.length;
    const item = chartSegments[chartSelection];
    $v6("#portfolioChartDetail").innerHTML = `<b><i style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${item.color};margin-right:6px"></i>${escapeHtml(item.code)} · ${escapeHtml(item.name)}</b>市值 ${money(item.value)}｜占比 ${percent(item.weight)}<br>累積損益 <span class="${valueClass(item.pnl)}">${money(item.pnl)}</span>${item.code === "其他" ? `<br><small>包含 ${escapeHtml(item.members.join("、"))}</small>` : ""}`;
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
    if (distance < rect.width * .25 || distance > rect.width * .48) return;
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
    renderPortfolio();
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
    renderPortfolio();
    scheduleNext();
  }

  function clearHoldings() {
    if (!holdings.length || !confirm("確定清除這台裝置上的全部持股？此動作無法復原，建議先匯出備份。")) return;
    holdings = [];
    quoteMap.clear();
    localStorage.removeItem(HOLDINGS_KEY);
    localStorage.removeItem(QUOTES_KEY);
    renderPortfolio();
    scheduleNext();
  }

  function exportHoldings() {
    const payload = {version: 1, exportedAt: new Date().toISOString(), holdings: holdings.map(({code, shares, averageCost, customName, name}) => ({code, shares, averageCost, customName, name}))};
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
      holdings = imported;
      marketCacheVersion = "";
      quoteMap = new Map([...quoteMap].filter(([code]) => holdings.some(item => item.code === code)));
      saveHoldings();
      saveQuoteCache();
      renderPortfolio();
      updateQuotes({force: true});
      alert(`已匯入 ${holdings.length} 檔持股，資料只儲存在此裝置。`);
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

  async function updateQuotes({force = false, applyPortfolio = $v6("#portfolioAutoRefresh").checked} = {}) {
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
        const needsPortfolioUpdate = result.changed || holdings.some(item => !quoteMap.has(item.code));
        if (needsPortfolioUpdate && applyPortfolio && holdings.length) {
          const heldCodes = new Set(holdings.map(item => item.code));
          for (const [code, quote] of publicQuoteMap) {
            if (heldCodes.has(code)) quoteMap.set(code, quote);
          }
          saveQuoteCache();
          renderPortfolio(true);
        }
        const missing = holdings.filter(item => !quoteMap.has(item.code)).length;
        const suffix = result.partial ? "；部分市場來源暫時無法取得" : "";
        if (!holdings.length) renderQuoteStatus("首頁行情快取已檢查；尚未新增持股");
        else if (!applyPortfolio) renderQuoteStatus(`${quoteTimeLabel()}；持股自動更新已關閉`);
        else renderQuoteStatus(`${quoteTimeLabel()}${missing ? `；${missing} 檔行情暫缺` : ""}${suffix}`);
        scheduleNext(60000);
      } catch {
        failureCount += 1;
        if (applyPortfolio && holdings.length) renderPortfolio();
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
      const card=(selector,title,value,status,date)=>{
        const node=$v6(selector);if(!node)return;
        node.innerHTML=`<span>${escapeHtml(title)}</span><b>${escapeHtml(value)}</b><em>${escapeHtml(status)}</em><small>資料日期 ${escapeHtml(date||"—")}</small>`;
      };
      const marginDate=values?.dataDate||risk?.data_date||"—",futuresDate=futures?.dataDate||"—";
      card("#homeMarginBalanceCard","台股融資餘額",Number.isFinite(values?.financingPrincipal)?`${number(values.financingPrincipal/1e8,2)}億`:"—",risk?.interpretation?.label||risk?.risk_state||"資料暫缺",marginDate);
      card("#homeMaintenanceCard","市場推估融資維持率",Number.isFinite(values?.maintenanceRatio)?`${number(values.maintenanceRatio,2)}%`:"—",Number.isFinite(values?.maintenanceRatio)?HSMarginRiskCore.ratioBand(values.maintenanceRatio).label:"資料暫缺",marginDate);
      card("#homeCnnCard","CNN Fear & Greed",Number.isFinite(cnn?.score)?number(cnn.score,0):"—",cnn?.label||"資料暫缺",cnn?.sourceUpdatedAt?String(cnn.sourceUpdatedAt).slice(0,10):"—");
      card("#homeForeignFuturesCard","外資台指期",Number.isFinite(foreign?.net)?`${foreign.net<0?"淨空":"淨多"} ${number(Math.abs(foreign.net),0)}口`:"—",Number.isFinite(foreign?.net)?(foreign.net<0?"偏空":"偏多"):"資料暫缺",futuresDate);
      const tmfRatio=Number.isFinite(tmf?.long)&&Number.isFinite(tmf?.short)&&tmf.short>0?tmf.long/tmf.short:null;
      const tmfState=Number.isFinite(tmfRatio)?(tmfRatio>1.1?"偏多":tmfRatio<.9?"偏空":"中性"):"資料暫缺";
      card("#homeTmfRatioCard","微台散戶多空比",Number.isFinite(tmfRatio)?number(tmfRatio,2):"—",tmfState,futuresDate);
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
    lastSuccessAt=Date.parse(event.detail.sourceUpdatedAt||event.detail.checkedAt||new Date().toISOString());
    if($v6("#portfolioAutoRefresh").checked&&holdings.length){
      const heldCodes=new Set(holdings.map(item=>item.code));
      for(const [code,quote] of publicQuoteMap)if(heldCodes.has(code))quoteMap.set(code,quote);
      saveQuoteCache();renderPortfolio(true);
    }
    renderQuoteStatus(`${quoteTimeLabel()}｜${event.detail.source==="authorized_proxy"?"授權延遲行情":"公開快取"}`);
  }

  function bindEvents() {
    $v6("#portfolioAddBtn").addEventListener("click", () => openPortfolioModal());
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
    $v6("#portfolioRefreshBtn").addEventListener("click", () => updateQuotes({force: true, applyPortfolio: true}));
    $v6("#portfolioAutoRefresh").checked = localStorage.getItem(AUTO_KEY) !== "0";
    $v6("#portfolioAutoRefresh").addEventListener("change", event => {
      localStorage.setItem(AUTO_KEY, event.target.checked ? "1" : "0");
      if (event.target.checked) updateQuotes({force: true, applyPortfolio: true});
      else renderQuoteStatus(`${quoteTimeLabel()}；持股自動更新已關閉`);
    });
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
      renderPortfolio();
      if ($v6("#portfolioAutoRefresh").checked) updateQuotes();
    });
    window.addEventListener("hs:delayed-quotes",applySharedQuotes);
    window.addEventListener("hs:delayed-quotes-error",()=>renderQuoteStatus("行情更新失敗，已保留最後資料"));
    window.addEventListener("resize", () => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(drawAllocation);
    }, {passive: true});
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && $v6("#portfolioModal").classList.contains("show")) closePortfolioModal();
    });
    const sentimentObserver = new MutationObserver(renderHomeSentiment);
    sentimentObserver.observe($v6("#fomoContent"), {childList: true});
    sentimentObserver.observe($v6("#cnnFearGreedContent"), {childList: true});
  }

  bindEvents();
  renderPortfolio();
  renderHomeSentiment();
  const initialShared=window.HSLiveMarket?.latestQuotes?.();
  if(initialShared instanceof Map&&initialShared.size)applySharedQuotes({detail:{quotes:initialShared,sourceUpdatedAt:new Date().toISOString(),source:"shared_cache"}});

  window.HSPortfolioV6 = Object.freeze({
    storageKey: HOLDINGS_KEY,
    quoteStorageKey: QUOTES_KEY,
    quoteSources: Object.freeze([TWSE_URL, TPEX_URL]),
    refresh: () => updateQuotes({force: true, applyPortfolio: true})
  });
})();
