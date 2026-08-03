(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.HSMarketV61Core = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const REQUIRED_MARKETS = ["taiex", "otc", "tsmc"];

  function taipeiParts(now = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Taipei",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).formatToParts(now);
    return Object.fromEntries(parts.map(part => [part.type, part.value]));
  }

  function minutesOf(parts) {
    return Number(parts.hour) * 60 + Number(parts.minute);
  }

  function taipeiDate(now = new Date()) {
    const parts = taipeiParts(now);
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function spotSession(now = new Date(), dataDate = "") {
    const parts = taipeiParts(now);
    const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(parts.weekday);
    const minutes = minutesOf(parts);
    if (weekday && minutes >= 540 && minutes <= 810 && dataDate === taipeiDate(now)) {
      return {key: "intraday", label: "盤中延遲"};
    }
    if (weekday && minutes > 810 && dataDate === taipeiDate(now)) {
      return {key: "closed", label: "現貨已收盤"};
    }
    return {key: "holiday", label: "休市／最新收盤"};
  }

  function futuresSession(now = new Date()) {
    const parts = taipeiParts(now);
    const minutes = minutesOf(parts);
    const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri"];
    if (weekdays.includes(parts.weekday) && minutes >= 525 && minutes <= 825) {
      return {key: "day", label: "日盤"};
    }
    if (weekdays.includes(parts.weekday) && minutes >= 900) {
      return {key: "night", label: "夜盤"};
    }
    if (["Tue", "Wed", "Thu", "Fri", "Sat"].includes(parts.weekday) && minutes <= 300) {
      return {key: "night", label: "夜盤"};
    }
    return {key: "closed", label: "休市／最新收盤"};
  }

  function parseTaipeiDataDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return NaN;
    return Date.parse(`${value}T12:00:00+08:00`);
  }

  function txQuoteState(item, now = new Date(), cacheUpdatedAt = "") {
    const session = futuresSession(now);
    const value = finite(item?.value);
    const change = finite(item?.change);
    const changePct = finite(item?.changePct);
    const dataDateTime = parseTaipeiDataDate(item?.dataDate);
    const cacheTime = Date.parse(cacheUpdatedAt);
    const quoteTime = Date.parse(item?.quoteTimestamp || "");
    const hasValidQuote = value !== null && value > 0 && change !== null && changePct !== null &&
      Number.isFinite(dataDateTime) && /^\d{6}$/.test(String(item?.contractMonth || ""));

    if (!hasValidQuote) {
      return {
        key: "unavailable",
        label: "資料暫時無法取得",
        stale: true,
        muted: true,
        notice: "台指期行情暫時無法取得",
        detail: "未以 0 代替"
      };
    }

    const isActive = session.key === "day" || session.key === "night";
    const quoteAge = now.getTime() - quoteTime;
    const cacheAge = now.getTime() - cacheTime;
    const expectedSourceSession = session.key === "day" ? "day" : "night";
    const delayedFresh = item.quoteMode === "delayed" &&
      Number.isFinite(quoteTime) &&
      quoteAge >= -5 * 60 * 1000 &&
      quoteAge <= 20 * 60 * 1000 &&
      Number.isFinite(cacheTime) &&
      cacheAge >= -5 * 60 * 1000 &&
      cacheAge <= 30 * 60 * 1000 &&
      item.sourceSession === expectedSourceSession &&
      futuresSession(new Date(quoteTime)).key === session.key;

    if (isActive && delayedFresh) {
      return {
        key: session.key === "day" ? "day_delayed" : "night_delayed",
        label: session.key === "day" ? "日盤延遲行情" : "夜盤延遲行情",
        stale: false,
        muted: false,
        notice: "延遲行情｜僅供參考",
        detail: ""
      };
    }

    if (isActive) {
      const isNight = session.key === "night";
      return {
        key: "stale",
        label: "資料已過期",
        stale: true,
        muted: true,
        notice: isNight ? "夜盤行情暫無可靠免費來源" : "日盤行情暫無可靠免費來源",
        detail: "目前顯示最近官方收盤資料"
      };
    }

    const officialCloseAge = now.getTime() - dataDateTime;
    if (item.quoteMode === "close" && officialCloseAge >= -12 * 3600000 && officialCloseAge <= 7 * 86400000) {
      return {
        key: "official_close",
        label: "最新官方收盤",
        stale: false,
        muted: false,
        notice: "目前顯示最近官方收盤資料",
        detail: ""
      };
    }

    return {
      key: "stale",
      label: "資料已過期",
      stale: true,
      muted: true,
      notice: "台指期行情資料已過期",
      detail: "目前顯示最近官方收盤資料"
    };
  }

  function finite(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function validateOverview(payload, now = new Date()) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("首頁行情格式不正確");
    }
    const updatedAt = Date.parse(payload.updated_at);
    if (!Number.isFinite(updatedAt) || updatedAt > now.getTime() + 6 * 3600000) {
      throw new Error("首頁行情更新時間不合理");
    }
    const instruments = payload.instruments;
    if (!instruments || typeof instruments !== "object") throw new Error("首頁行情內容缺失");
    const result = {};
    for (const key of REQUIRED_MARKETS) {
      const item = instruments[key];
      const value = finite(item?.value);
      const change = finite(item?.change);
      const changePct = finite(item?.change_pct);
      const dataDate = String(item?.data_date || "");
      const dataTime = String(item?.data_time || "");
      if (value === null || value <= 0 || change === null || changePct === null) {
        throw new Error(`${key} 行情數值無效`);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dataDate) || !dataTime || dataTime.length > 20) {
        throw new Error(`${key} 行情時間無效`);
      }
      result[key] = {
        key,
        name: String(item.name || key).slice(0, 30),
        value,
        change,
        changePct,
        dataDate,
        dataTime,
        quoteTime: Number.isFinite(Date.parse(item.quote_time)) ? new Date(item.quote_time).toISOString() : "",
        previousClose: finite(item.previous_close),
        open: finite(item.open),
        high: finite(item.high),
        low: finite(item.low),
        volume: finite(item.volume),
        quoteMode: item.quote_mode === "delayed" ? "delayed" : "close",
        contractMonth: /^\d{6}$/.test(String(item.contract_month || "")) ? String(item.contract_month) : "",
        sourceStatus: String(item.source_status || ""),
        sourceSession: ["day", "night"].includes(item.source_session) ? item.source_session : "",
        quoteTimestamp: Number.isFinite(Date.parse(item.quote_timestamp || item.quote_time)) ? new Date(item.quote_timestamp || item.quote_time).toISOString() : "",
        availability: String(item.availability || "")
      };
    }
    return {
      updatedAt: new Date(updatedAt).toISOString(),
      stale: now.getTime() - updatedAt > 30 * 60 * 1000,
      label: "盤中延遲行情｜約每 5 分鐘更新｜僅供參考",
      instruments: result,
      sourceStatus: payload.source_status && typeof payload.source_status === "object" ? payload.source_status : {}
    };
  }

  function tone(change) {
    const value = finite(change);
    return value === null || Math.abs(value) < 1e-9 ? "flat" : value > 0 ? "up" : "down";
  }

  function marketInterpretation(instruments) {
    const taiex = instruments?.taiex?.changePct;
    const otc = instruments?.otc?.changePct;
    const tsmc = instruments?.tsmc?.changePct;
    if (![taiex, otc, tsmc].every(Number.isFinite)) return "行情資料尚未完整，暫不做方向判斷。";
    if (taiex > 0 && otc < 0) return "加權指數上漲但櫃買指數下跌，資金目前偏向大型權值股。";
    if (otc - taiex >= 0.5) return "櫃買強於加權，中小型股表現相對活躍。";
    if (taiex - otc >= 0.5) return "加權強於櫃買，權值股表現相對突出。";
    if (taiex > 0 && tsmc > 0 && Math.abs(tsmc - taiex) <= 1.2) {
      return "台積電與加權指數同步上漲，權值股目前對市場形成支撐。";
    }
    return "加權、櫃買與台積電走勢接近，暫無單一市場明顯主導。";
  }

  function relativeStrength(instruments) {
    const taiex = finite(instruments?.taiex?.changePct);
    const otc = finite(instruments?.otc?.changePct);
    if (taiex === null || otc === null) return "資料更新中";
    const difference = taiex - otc;
    if (difference >= 0.35) return "權值股較強";
    if (difference <= -0.35) return "中小型股較強";
    return "表現接近";
  }

  function tsmcSync(instruments, breadth = {}) {
    const taiex = finite(instruments?.taiex?.changePct);
    const tsmc = finite(instruments?.tsmc?.changePct);
    if (taiex === null || tsmc === null) return "資料更新中";
    if (tsmc > 0 && Number(breadth.downs) > Number(breadth.ups)) return "台積電上漲但市場廣度不足";
    if (taiex > 0 && tsmc <= 0) return "大盤上漲但台積電偏弱";
    if (tsmc > taiex + 0.5 && taiex > 0) return "台積電帶動大盤";
    return "台積電與大盤同步";
  }

  function validateFuturesPosition(payload, now = new Date()) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("期貨籌碼格式不正確");
    }
    const updatedAt = Date.parse(payload.updated_at);
    const dataDate = String(payload.data_date || "");
    if (!Number.isFinite(updatedAt) || updatedAt > now.getTime() + 6 * 3600000 || !/^\d{4}-\d{2}-\d{2}$/.test(dataDate)) {
      throw new Error("期貨籌碼日期不合理");
    }
    const output = {updatedAt: new Date(updatedAt).toISOString(), dataDate, methodology: String(payload.methodology || "").slice(0, 1000), sourceStatus: payload.source_status || {}};
    for (const key of ["foreign_tx", "estimated_non_institutional_mtx", "estimated_non_institutional_tmf"]) {
      const raw = payload[key];
      if (!raw || typeof raw !== "object") throw new Error(`${key} 缺失`);
      const item = {};
      for (const field of ["long", "short", "net", "net_change"]) {
        const value = Number(raw[field]);
        if (!Number.isSafeInteger(value)) throw new Error(`${key}.${field} 不是整數`);
        item[field] = value;
      }
      if (item.long < 0 || item.short < 0 || item.long - item.short !== item.net) {
        throw new Error(`${key} 多空口數驗證失敗`);
      }
      output[key] = item;
    }
    return output;
  }

  return {
    taipeiParts,
    taipeiDate,
    spotSession,
    futuresSession,
    txQuoteState,
    validateOverview,
    validateFuturesPosition,
    tone,
    marketInterpretation,
    relativeStrength,
    tsmcSync
  };
});
