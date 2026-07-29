(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.HSPortfolioCore = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const CODE_PATTERN = /^[0-9A-Z]{4,10}$/;
  const MAX_HOLDINGS = 30;
  const MAX_SHARES = 1e12;
  const MAX_COST = 1e9;

  function finitePositive(value, max) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 && number <= max ? number : null;
  }

  function sanitizeName(value) {
    return String(value ?? "")
      .replace(/[\u0000-\u001f\u007f<>]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40);
  }

  function normalizeCode(value) {
    return String(value ?? "").trim().toUpperCase();
  }

  function validateHolding(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("持股資料格式不正確。");
    }
    const code = normalizeCode(input.code);
    const shares = finitePositive(input.shares, MAX_SHARES);
    const averageCost = finitePositive(input.averageCost, MAX_COST);
    if (!CODE_PATTERN.test(code)) throw new Error("股票代號需為 4～10 碼英數字。");
    if (shares === null) throw new Error("股數必須大於 0，且不可超過 1 兆股。");
    if (averageCost === null) throw new Error("平均成本必須大於 0，且不可超過 10 億元。");
    return {
      code,
      shares,
      averageCost,
      customName: sanitizeName(input.customName),
      name: sanitizeName(input.name),
      updatedAt: new Date().toISOString()
    };
  }

  function validateImportPayload(payload) {
    const rows = Array.isArray(payload) ? payload : payload?.holdings;
    if (!Array.isArray(rows)) throw new Error("JSON 必須包含 holdings 陣列。");
    if (rows.length > MAX_HOLDINGS) throw new Error(`持股最多 ${MAX_HOLDINGS} 檔。`);
    const seen = new Set();
    const holdings = rows.map(validateHolding);
    for (const item of holdings) {
      if (seen.has(item.code)) throw new Error(`代號 ${item.code} 重複，請先整理備份檔。`);
      seen.add(item.code);
    }
    return holdings;
  }

  function mergeHolding(existing, incoming) {
    const oldItem = validateHolding(existing);
    const newItem = validateHolding(incoming);
    if (oldItem.code !== newItem.code) throw new Error("只能合併相同代號。");
    const shares = oldItem.shares + newItem.shares;
    if (!Number.isFinite(shares) || shares > MAX_SHARES) throw new Error("合併後股數超過上限。");
    const totalCost = oldItem.shares * oldItem.averageCost + newItem.shares * newItem.averageCost;
    return {
      ...oldItem,
      shares,
      averageCost: totalCost / shares,
      customName: newItem.customName || oldItem.customName,
      name: newItem.name || oldItem.name,
      updatedAt: new Date().toISOString()
    };
  }

  function validQuote(quote) {
    const price = Number(quote?.price);
    const previousClose = Number(quote?.previousClose);
    if (!Number.isFinite(price) || price <= 0) return null;
    return {
      price,
      previousClose: Number.isFinite(previousClose) && previousClose > 0 ? previousClose : null,
      name: sanitizeName(quote?.name),
      date: String(quote?.date ?? ""),
      fetchedAt: String(quote?.fetchedAt ?? ""),
      quoteMode: quote?.quoteMode === "delayed" ? "delayed" : "close",
      quoteTime: String(quote?.quoteTime ?? "")
    };
  }

  function calculatePortfolio(holdings, quotes) {
    const quoteLookup = quotes instanceof Map ? quotes : new Map(Object.entries(quotes || {}));
    const rows = holdings.map(raw => {
      const item = validateHolding(raw);
      const quote = validQuote(quoteLookup.get(item.code));
      const totalCost = item.shares * item.averageCost;
      if (!quote) return {...item, quote: null, totalCost, marketValue: null, totalPnl: null, returnRate: null, todayPnl: null, changeRate: null, weight: null};
      const marketValue = item.shares * quote.price;
      const totalPnl = marketValue - totalCost;
      const returnRate = totalCost > 0 ? totalPnl / totalCost * 100 : null;
      const todayPnl = quote.previousClose ? item.shares * (quote.price - quote.previousClose) : null;
      const changeRate = quote.previousClose ? (quote.price / quote.previousClose - 1) * 100 : null;
      return {...item, quote, totalCost, marketValue, totalPnl, returnRate, todayPnl, changeRate, weight: null};
    });
    const complete = rows.length > 0 && rows.every(row => row.quote && Number.isFinite(row.todayPnl));
    const quotedRows = rows.filter(row => Number.isFinite(row.marketValue));
    const totalMarketValue = quotedRows.reduce((sum, row) => sum + row.marketValue, 0);
    for (const row of rows) {
      row.weight = Number.isFinite(row.marketValue) && totalMarketValue > 0 ? row.marketValue / totalMarketValue * 100 : null;
    }
    if (!complete) {
      return {rows, complete: false, totalMarketValue: null, totalCost: null, totalPnl: null, returnRate: null, todayPnl: null, todayRate: null};
    }
    const totalCost = rows.reduce((sum, row) => sum + row.totalCost, 0);
    const totalPnl = totalMarketValue - totalCost;
    const todayPnl = rows.reduce((sum, row) => sum + row.todayPnl, 0);
    const previousMarketValue = rows.reduce((sum, row) => sum + row.shares * row.quote.previousClose, 0);
    return {
      rows,
      complete: true,
      totalMarketValue,
      totalCost,
      totalPnl,
      returnRate: totalCost > 0 ? totalPnl / totalCost * 100 : null,
      todayPnl,
      todayRate: previousMarketValue > 0 ? todayPnl / previousMarketValue * 100 : null
    };
  }

  function buildAllocation(rows) {
    const validRows = rows.filter(row => Number.isFinite(row.marketValue) && row.marketValue > 0)
      .sort((a, b) => b.marketValue - a.marketValue);
    const total = validRows.reduce((sum, row) => sum + row.marketValue, 0);
    if (!total) return [];
    const direct = validRows.length > 8 ? validRows.slice(0, 7) : validRows;
    const result = direct.map(row => ({
      code: row.code,
      name: row.customName || row.quote?.name || row.name || row.code,
      value: row.marketValue,
      weight: row.marketValue / total * 100,
      pnl: row.totalPnl,
      members: [row.code]
    }));
    if (validRows.length > 8) {
      const others = validRows.slice(7);
      const value = others.reduce((sum, row) => sum + row.marketValue, 0);
      result.push({
        code: "其他",
        name: `${others.length} 檔較小部位`,
        value,
        weight: value / total * 100,
        pnl: others.reduce((sum, row) => sum + row.totalPnl, 0),
        members: others.map(row => row.code)
      });
    }
    return result;
  }

  function parseNumber(value) {
    const number = Number(String(value ?? "").replace(/,/g, "").trim());
    return Number.isFinite(number) ? number : null;
  }

  function rocDateToIso(value) {
    const digits = String(value ?? "").replace(/\D/g, "");
    if (digits.length !== 7) return "";
    const year = Number(digits.slice(0, 3)) + 1911;
    const month = digits.slice(3, 5);
    const day = digits.slice(5, 7);
    const iso = `${year}-${month}-${day}`;
    return Number.isFinite(Date.parse(`${iso}T00:00:00+08:00`)) ? iso : "";
  }

  function parseTwseRows(rows, fetchedAt) {
    const result = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const code = normalizeCode(row.Code);
      const price = parseNumber(row.ClosingPrice);
      const change = parseNumber(row.Change);
      if (!CODE_PATTERN.test(code) || price === null || price <= 0) continue;
      const previousClose = change === null ? null : price - change;
      result.set(code, {
        price,
        previousClose: previousClose > 0 ? previousClose : null,
        name: sanitizeName(row.Name),
        date: rocDateToIso(row.Date),
        fetchedAt,
        market: "TWSE"
      });
    }
    return result;
  }

  function parseTpexRows(rows, fetchedAt) {
    const result = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const code = normalizeCode(row.SecuritiesCompanyCode);
      const price = parseNumber(row.Close);
      const change = parseNumber(row.Change);
      if (!CODE_PATTERN.test(code) || price === null || price <= 0) continue;
      const previousClose = change === null ? null : price - change;
      result.set(code, {
        price,
        previousClose: previousClose > 0 ? previousClose : null,
        name: sanitizeName(row.CompanyName),
        date: rocDateToIso(row.Date),
        fetchedAt,
        market: "TPEx"
      });
    }
    return result;
  }

  function parseCachedQuotes(payload) {
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.items)) throw new Error("行情快取格式不正確。");
    const updatedAt = String(payload.updated_at || "");
    const updatedTime = Date.parse(updatedAt);
    if (!Number.isFinite(updatedTime) || updatedTime > Date.now() + 6 * 3600000 || Date.now() - updatedTime > 14 * 86400000) {
      throw new Error("行情快取更新時間不合理。");
    }
    const result = new Map();
    for (const row of payload.items) {
      const code = normalizeCode(row.code);
      const price = parseNumber(row.price);
      const previousClose = parseNumber(row.previous_close);
      const date = String(row.date || "");
      if (!CODE_PATTERN.test(code) || price === null || price <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      result.set(code, {
        price,
        previousClose: previousClose !== null && previousClose > 0 ? previousClose : null,
        name: sanitizeName(row.name),
        date,
        fetchedAt: updatedAt,
        market: row.market === "TPEx" ? "TPEx" : "TWSE",
        quoteMode: row.quote_mode === "delayed" ? "delayed" : "close",
        quoteTime: String(row.quote_time || "")
      });
    }
    if (!result.size) throw new Error("行情快取沒有有效資料。");
    return result;
  }

  function taipeiParts(now) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Taipei",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(now);
    return Object.fromEntries(parts.map(part => [part.type, part.value]));
  }

  function isTaipeiMarketOpen(now = new Date()) {
    const parts = taipeiParts(now);
    if (!["Mon", "Tue", "Wed", "Thu", "Fri"].includes(parts.weekday)) return false;
    const minutes = Number(parts.hour) * 60 + Number(parts.minute);
    return minutes >= 9 * 60 && minutes <= 13 * 60 + 30;
  }

  function safeNumber(value) {
    return Number.isFinite(value) ? value : null;
  }

  return {
    CODE_PATTERN,
    MAX_HOLDINGS,
    validateHolding,
    validateImportPayload,
    mergeHolding,
    calculatePortfolio,
    buildAllocation,
    parseTwseRows,
    parseTpexRows,
    parseCachedQuotes,
    rocDateToIso,
    isTaipeiMarketOpen,
    sanitizeName,
    normalizeCode,
    safeNumber
  };
});
