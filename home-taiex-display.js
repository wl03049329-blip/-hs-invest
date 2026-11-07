"use strict";
function mountHomeOfficialDisplay({core,id,file,source,fields}) {
  const card = document.getElementById(id);
  if (!card || !core) return;
  const prefix = core.key + ".";
  let snapshot = null, pending = false;
  function local() {
    try {
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith(prefix)) continue;
        try {
          const candidate = JSON.parse(localStorage.getItem(key));
          if (key === prefix + candidate?.trade_date) snapshot = core.select(snapshot, candidate);
        } catch { /* ignore only this malformed display record */ }
      }
    } catch { /* private mode or unavailable storage; in-page/network remain usable */ }
  }
  function persist() {
    try {
      localStorage.setItem(prefix + snapshot.trade_date, JSON.stringify(snapshot));
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith(prefix) && key < prefix + snapshot.trade_date) localStorage.removeItem(key);
      }
    } catch { /* never touch app or financial storage */ }
  }
  function render(verified) {
    const view = core.view(snapshot);
    const state = card.querySelector("[data-taiex-state],[data-tmf-state]");
    if (!view) return;
    const delta = card.querySelector("strong"), time = card.querySelector("time");
    card.querySelector("b").textContent = view.value;
    delta.dataset.homeTone = view.tone;
    delta.textContent = view.change;
    time.dateTime = view.date;
    time.textContent = "資料日 " + view.date.replaceAll("-", "/");
    time.title = source + "；取得時間 " + new Intl.DateTimeFormat("zh-TW", {
      timeZone: "Asia/Taipei", dateStyle: "short", timeStyle: "short"
    }).format(new Date(snapshot.retrieved_at));
    state.textContent = verified ? "" : "沿用已驗證資料";
    state.hidden = verified;
    delta.hidden = time.hidden = false;
  }
  async function refresh() {
    if (pending) return;
    pending = true;
    card.setAttribute("aria-busy", "true");
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), 8000);
    try {
      local();
      const response = await fetch(file + "?ts=" + Date.now(), {cache: "no-store", signal: abort.signal});
      if (!response.ok) throw Error("HTTP");
      const incoming = await response.json();
      if (!core.valid(incoming)) throw Error("INVALID");
      local();
      snapshot = core.select(snapshot, incoming);
      persist();
      render(["trade_date","previous_trade_date",...fields]
        .every(key => snapshot[key] === incoming[key]));
    } catch {
      local();
      render(false);
    } finally {
      clearTimeout(deadline);
      pending = false;
      card.setAttribute("aria-busy", "false");
    }
  }
  local();
  render(false);
  addEventListener("pageshow", refresh);
  addEventListener("online", refresh);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden && navigator.onLine) refresh(); }, 300000);
  refresh();
}
mountHomeOfficialDisplay({core:window.HSHomeTaiex,id:"homeTaiexCard",file:"home-taiex.json",
  source:"證交所 FMTQIK",fields:["close_cents","previous_close_cents","change_cents"]});
mountHomeOfficialDisplay({core:window.HSHomeTmf,id:"homeTmfRatioCard",file:"home-tmf-net.json",
  source:"期交所 TMF 一般交易時段",fields:["net","net_change"]});
