(function () {
  "use strict";

  const pages = Object.freeze([
    { kicker: "先從一件事開始", title: "HS 是幫你整理市場，不替你做決定", body: "市場每天有很多價格和指標。HS 把它們整理成較容易閱讀的訊號，讓你先看懂市場狀態，再自行判斷。", note: "這不是預測，也不是投資建議。" },
    { kicker: "認識正式分數", title: "分數越高，代表越值得留意", body: "分數反映目前正式模型中的市場回檔與條件。20 分可先了解狀態；50 分以上可多看一眼；70、80 分以上則代表訊號更值得注意。", note: "分數高不等於必須買進，只代表可以進一步查看。" },
    { kicker: "先看正式資料", title: "正式分數是每天整理的參考", body: "例如 00830 顯示 52 分，你可以先把它理解成：依正式資料整理出的目前分數。初次使用時，先看正式分數與級距就好。", note: "正式分數依既有正式資料呈現，不由這份導覽另行計算。" },
    { kicker: "盤中與盤後不同", title: "盤中分數是暫時觀察值", body: "交易時間內，價格會變動。盤中分數表示「如果現在收盤，分數可能會如何」；它不是當日正式收盤分數。", note: "閱讀時以正式分數為主，並留意 LIVE／正式標示。" },
    { kicker: "首頁先看三件事", title: "標的、正式分數、今日判讀", body: "在首頁先找到 ETF 名稱，確認正式分數，再讀今日判讀。其他圖表、均線與週 J 都是延伸資訊，可以之後再慢慢看。", note: "不用一次讀懂每個指標。" },
    { kicker: "想多了解時", title: "點開 ETF 看它的背景", body: "詳細頁會整理近期分數變化、距離下一級的分數，以及價格相對長期均線的位置，幫你了解訊號從哪裡來。", note: "HS 整理資訊，不要求你自行計算，也不替你下單。" },
    { kicker: "記住這一點", title: "HS 不預測市場，也不催你交易", body: "一般的小幅波動不必急著反應；當分數或市場狀態值得注意時，你可以再查看資料，依自己的計畫決定下一步。", note: "投資有風險。請依自身狀況判斷；分數不保證未來表現。" }
  ]);
  const STORAGE_KEY = "hs.onboarding.hs3.v1.seen";
  const root = document.getElementById("hsBeginnerGuide");
  if (!root) return;

  const panel = root.querySelector(".hsBeginnerGuidePanel");
  const title = document.getElementById("hsBeginnerGuideTitle");
  const body = document.getElementById("hsBeginnerGuideBody");
  const note = document.getElementById("hsBeginnerGuideNote");
  const kicker = document.getElementById("hsBeginnerGuideKicker");
  const progressLabel = document.getElementById("hsBeginnerGuideProgress");
  const progress = root.querySelector('[role="progressbar"]');
  const progressFill = progress?.querySelector("span");
  const previous = document.getElementById("hsBeginnerGuidePrevious");
  const next = document.getElementById("hsBeginnerGuideNext");
  const finish = document.getElementById("hsBeginnerGuideFinish");
  const closeButton = document.getElementById("hsBeginnerGuideClose");
  let pageIndex = 0;
  let returnFocus = null;
  let priorOverflow = "";

  function render() {
    const page = pages[pageIndex];
    title.textContent = page.title;
    body.textContent = page.body;
    note.textContent = page.note;
    kicker.textContent = page.kicker;
    progressLabel.textContent = `第 ${pageIndex + 1} 頁／共 ${pages.length} 頁`;
    progress?.setAttribute("aria-valuenow", String(pageIndex + 1));
    if (progressFill) progressFill.style.width = `${((pageIndex + 1) / pages.length) * 100}%`;
    previous.disabled = pageIndex === 0;
    next.hidden = pageIndex === pages.length - 1;
    finish.hidden = pageIndex !== pages.length - 1;
  }

  function open(trigger) {
    pageIndex = 0;
    returnFocus = trigger || document.activeElement;
    priorOverflow = document.body.style.overflow;
    render();
    root.inert = false;
    root.setAttribute("aria-hidden", "false");
    root.classList.add("is-open");
    document.body.style.overflow = "hidden";
    closeButton.focus();
  }

  function markSeen() {
    try { localStorage.setItem(STORAGE_KEY, new Date().toISOString()); } catch (_) { /* optional preference */ }
  }

  function close() {
    root.classList.remove("is-open");
    root.setAttribute("aria-hidden", "true");
    root.inert = true;
    document.body.style.overflow = priorOverflow;
    markSeen();
    if (returnFocus?.isConnected) returnFocus.focus();
  }

  function onKeydown(event) {
    if (!root.classList.contains("is-open")) return;
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if (event.key !== "Tab") return;
    const items = [...root.querySelectorAll('button:not([disabled]):not([hidden])')];
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  document.getElementById("hsOnboardingOpenHeader")?.addEventListener("click", event => open(event.currentTarget));
  document.getElementById("hsOnboardingOpenHome")?.addEventListener("click", event => open(event.currentTarget));
  closeButton.addEventListener("click", close);
  root.addEventListener("click", event => { if (event.target === root) close(); });
  previous.addEventListener("click", () => { if (pageIndex > 0) { pageIndex -= 1; render(); } });
  next.addEventListener("click", () => { if (pageIndex < pages.length - 1) { pageIndex += 1; render(); } });
  finish.addEventListener("click", close);
  document.addEventListener("keydown", onKeydown);

  window.HSBeginnerGuide = Object.freeze({ open: () => open(document.activeElement), close, pageCount: pages.length });
})();
