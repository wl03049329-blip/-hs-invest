(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.HSMarketUiCore = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  function classifyJ(value) {
    const j = Number(value);
    if (!Number.isFinite(j)) return {label: "等待", className: "neutral"};
    if (j < -10) return {label: "極度超賣", className: "purple"};
    if (j < 0) return {label: "強力超賣", className: "red"};
    if (j < 10) return {label: "更佳買點", className: "orange"};
    if (j < 20) return {label: "加碼觀察", className: "yellow"};
    return {label: "等待", className: "neutral"};
  }

  function turnText(direction) {
    return direction === "回升" ? "超賣後回升" : "超賣但尚未止跌";
  }

  return {classifyJ, turnText};
});
