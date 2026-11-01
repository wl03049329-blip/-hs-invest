(function () {
  "use strict";

  const VERSION_URL = new URL("version.json", document.baseURI);
  const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

  const builtVersion = document.querySelector?.('meta[name="hs-app-version"]')?.content;
  (typeof builtVersion === "string" && SEMVER.test(builtVersion)
    ? Promise.resolve({ ok: true, json: async () => ({ version: builtVersion }) })
    : fetch(VERSION_URL, { cache: "no-store", headers: { Accept: "application/json" } }))
    .then(response => {
      if (!response.ok) throw new Error("VERSION_SOURCE_UNAVAILABLE");
      return response.json();
    })
    .then(payload => {
      const match = typeof payload?.version === "string" && payload.version.match(SEMVER);
      if (!match) throw new Error("VERSION_SOURCE_INVALID");
      const [full, major, minor] = match;
      const display = `${major}.${minor}`;
      // An old cached document can fetch a new version.json; that does NOT mean
      // its old UI has upgraded. Use the existing shared script as a one-time
      // same-entry bridge, never clear data or force an edited page to reload.
      if (!builtVersion && typeof document.createElement === 'function') {
        document.title = 'HS ETF 股市雷達｜舊頁待更新';
        document.querySelectorAll('[data-hs-version]').forEach(n => { n.textContent = '待更新'; });
        const bar=document.createElement('aside');bar.setAttribute('role','status');bar.style.cssText='position:fixed;z-index:2147483000;top:12px;left:12px;right:12px;padding:14px;background:#17140e;color:#f3cf7a;border:1px solid #a28543;border-radius:12px;font:14px/1.6 sans-serif';
        bar.textContent='HS 原入口已有新版。請先完成編輯；更新不會清除持股，也不需重新加入主畫面。';const b=document.createElement('button');b.textContent='立即更新';b.style.cssText='margin-left:10px;padding:8px';b.onclick=async()=>{if(document.querySelector('dialog[open],.modal.show,[data-saving="true"]')){b.textContent='請先完成或關閉編輯';return;}try{const r=await fetch(new URL('app-release.json?legacy-check='+Date.now(),document.baseURI),{cache:'no-store'});if(!r.ok)throw Error();const m=await r.json();if(m.schema!=='HS_STABLE_APP_RELEASE_V1'||!/^[a-f0-9]{40}$/.test(m.commit))throw Error();const u=new URL('./',document.baseURI);u.searchParams.set('tab','portfolio');u.searchParams.set('hs-entry',m.commit);location.replace(u.href);}catch(_){b.textContent='尚未完成，連線後重試';}};bar.append(b);document.body.append(bar);return;
      }
      document.title = `HS ETF 股市雷達 ${display}`;
      document.querySelectorAll("[data-hs-version]").forEach(node => { node.textContent = display; });
      document.querySelectorAll("[data-hs-version-full]").forEach(node => { node.textContent = full; });
      window.HSProductVersion = Object.freeze({ full, display });
      document.documentElement.dataset.hsProductVersion = full;
    })
    .catch(() => {
      document.documentElement.dataset.hsVersionStatus = "unavailable";
    });
})();
