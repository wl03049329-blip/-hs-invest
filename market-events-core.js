(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HSMarketEventsCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const OFFICIAL_HOSTS = [
    "federalreserve.gov", "bls.gov", "bea.gov", "whitehouse.gov",
    "ustr.gov", "commerce.gov", "federalregister.gov", "cbc.gov.tw"
  ];
  const CONFIRMED = new Set(["announced", "revised"]);
  const VALID_STATUS = new Set(["scheduled", "announced", "revised", "cancelled"]);
  const finite = value => {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  const parseDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? new Date(`${value}T00:00:00+08:00`) : null;

  function isOfficialUrl(value) {
    try {
      const host = new URL(String(value || "")).hostname.toLowerCase();
      return OFFICIAL_HOSTS.some(domain => host === domain || host.endsWith(`.${domain}`));
    } catch {
      return false;
    }
  }

  function validateEvent(raw = {}, {custom = false} = {}) {
    const event = {...raw};
    event.status = VALID_STATUS.has(event.status) ? event.status : "scheduled";
    event.date = /^\d{4}-\d{2}-\d{2}$/.test(String(event.date || "")) ? event.date : "";
    event.title = String(event.title || event.name || "").replace(/[<>]/g, "").trim().slice(0, 120);
    event.type = String(event.type || "其他").replace(/[<>]/g, "").trim().slice(0, 40);
    event.risk = ["低", "中", "高", "自訂"].includes(event.risk) ? event.risk : "中";
    for (const key of ["result_summary", "market_summary", "target_range", "tariff_rate", "affected_scope", "effective_date", "official_source_name"]) {
      event[key] = String(event[key] || "").replace(/[<>]/g, "").trim().slice(0, key === "market_summary" ? 300 : 180);
    }
    event.custom = Boolean(custom || event.custom);
    event.sourceConfirmed = event.custom || isOfficialUrl(event.official_source_url);
    event.resultConfirmed = CONFIRMED.has(event.status) && event.sourceConfirmed && Boolean(String(event.result_summary || "").trim());
    if (CONFIRMED.has(event.status) && !event.resultConfirmed) {
      event.status = "scheduled";
      event.result_summary = "";
      event.verified_at = "";
    }
    return event;
  }

  function groupEvents(rawEvents = [], now = new Date()) {
    const today = new Date(new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit"
    }).format(now) + "T00:00:00+08:00");
    const dayDiff = value => {
      const date = parseDate(value);
      return date ? Math.round((date - today) / 86400000) : null;
    };
    const events = rawEvents.map(event => validateEvent(event, {custom: event.custom})).filter(event => event.date && event.title);
    const upcoming = events.filter(event => {
      const days = dayDiff(event.date);
      return event.status === "scheduled" && days !== null && days >= 0;
    }).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 3);
    const announced = events.filter(event => {
      const days = dayDiff(event.date);
      return CONFIRMED.has(event.status) && event.resultConfirmed && days !== null && days <= 0 && days >= -7;
    }).sort((a, b) => b.date.localeCompare(a.date));
    const history = events.filter(event => {
      const days = dayDiff(event.date);
      return days !== null && days <= 0 && days >= -90;
    }).sort((a, b) => b.date.localeCompare(a.date));
    return {upcoming, announced, history};
  }

  function decisionLabel(changeBps) {
    const bps = finite(changeBps);
    if (bps === null) return "";
    if (bps === 0) return "維持利率不變（0碼）";
    const quarters = Math.abs(bps) / 25;
    const units = Number.isInteger(quarters) ? quarters : quarters.toFixed(1);
    return `${bps > 0 ? "升息" : "降息"}${units}碼（${bps > 0 ? "+" : ""}${bps}個基點）`;
  }

  function comparisonLabel(event) {
    const actual = finite(event.actual);
    const expected = finite(event.expected);
    if (actual === null || expected === null || event.expected === "") return "";
    const difference = actual - expected;
    if (Math.abs(difference) < 0.0001) return "符合市場預期";
    return `${difference > 0 ? "高於" : "低於"}預期 ${Math.abs(difference).toFixed(1)} 個百分點`;
  }

  return {OFFICIAL_HOSTS, isOfficialUrl, validateEvent, groupEvents, decisionLabel, comparisonLabel};
});
