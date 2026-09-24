(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.HSPortfolioEtfCatalog = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  function build({core, universe, marketQuotes, watchlist, holdings, stocks, previous} = {}) {
    const catalog = new Map();
    const add = (rows, source, convert) => {
      for (const raw of Array.isArray(rows) ? rows : []) {
        const item = convert(raw);
        const code = core.normalizeCode(item.code);
        if (!core.CODE_PATTERN.test(code) || catalog.has(code)) continue;
        catalog.set(code, {
          code,
          name: core.sanitizeName(item.name) || code,
          issuer: core.sanitizeName(item.issuer),
          type: String(item.type || ""),
          asset_class: String(item.asset_class || ""),
          strategy_category: String(item.strategy_category || ""),
          exchange: String(item.exchange || ""),
          source
        });
      }
    };
    add(universe?.items, "etf_universe", row => ({
      code: row?.code, name: row?.name, issuer: row?.issuer,
      type: row?.official_type, asset_class: row?.asset_class,
      strategy_category: row?.strategy_category, exchange: row?.exchange
    }));
    add(marketQuotes?.items, "market_quotes", row => ({code: row?.code, name: row?.name, exchange: row?.market}));
    add(watchlist, "watchlist", row => ({code: row?.id || row?.code, name: row?.name}));
    add(holdings, "holdings", row => ({code: row?.code, name: row?.customName || row?.name}));
    add(stocks, "taiwan_stock_info", row => ({code: row?.stock_id, name: row?.stock_name}));
    add(previous, "previous", row => row || {});
    return [...catalog.values()];
  }

  function search(catalog, query, limit = 8) {
    const term = String(query || "").trim().toLocaleLowerCase();
    if (!term) return [];
    return (Array.isArray(catalog) ? catalog : []).filter(item =>
      [item.code, item.name, item.issuer, item.type, item.strategy_category]
        .some(value => String(value || "").toLocaleLowerCase().includes(term))
    ).slice(0, limit);
  }

  return {build, search};
});
