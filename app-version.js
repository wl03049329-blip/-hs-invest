(function () {
  "use strict";

  const VERSION_URL = new URL("version.json", document.baseURI);
  const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

  fetch(VERSION_URL, { cache: "no-store", headers: { Accept: "application/json" } })
    .then(response => {
      if (!response.ok) throw new Error("VERSION_SOURCE_UNAVAILABLE");
      return response.json();
    })
    .then(payload => {
      const match = typeof payload?.version === "string" && payload.version.match(SEMVER);
      if (!match) throw new Error("VERSION_SOURCE_INVALID");
      const [full, major, minor] = match;
      const display = `${major}.${minor}`;
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
