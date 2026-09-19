"use strict";

const HS_PUSH_SW_VERSION = "HS_PUSH_SW_V2";
const HS_PUSH_PAYLOAD_VERSION = "HS_WEB_PUSH_PAYLOAD_V1";
const HS_ALERT_PAYLOAD_VERSION = "HS_ETF_ALERT_PUSH_V1";
const TEST_TITLE = "HS ETF 雷達";
const TEST_BODY = "背景通知測試成功";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

self.addEventListener("message", event => {
  if (event.data?.type === "HS_PUSH_SW_VERSION") {
    event.ports?.[0]?.postMessage({type: "HS_PUSH_SW_VERSION", version: HS_PUSH_SW_VERSION});
  }
});

self.addEventListener("push", event => {
  let payload;
  try {
    payload = event.data?.json();
  } catch {
    return;
  }
  const validTest = payload
    && payload.version === HS_PUSH_PAYLOAD_VERSION
    && payload.type === "TEST_PUSH"
    && payload.title === TEST_TITLE
    && payload.body === TEST_BODY
    && payload.route === "./"
    && typeof payload.sent_at === "string"
    && typeof payload.notification_id === "string";
  const alertType = payload?.type === "ETF_ALERT_BUNDLE" || payload?.type === "TEST_ETF_ALERT_BUNDLE";
  const validAlert = alertType && payload.version === HS_ALERT_PAYLOAD_VERSION && /^\d{4,6}$/.test(payload.etf) && /^\?radarEtf=\d{4,6}$/.test(payload.route) && typeof payload.bundle_id === "string" && Array.isArray(payload.alert_ids) && typeof payload.title === "string" && typeof payload.body === "string" && typeof payload.sent_at === "string";
  if (!validTest && !validAlert) return;
  const title = validTest ? TEST_TITLE : payload.title, body = validTest ? TEST_BODY : payload.body, route = validTest ? "./" : payload.route, tag = validTest ? "hs-radar-test-push" : `hs-radar-${payload.bundle_id}`;
  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag,
    renotify: false,
    requireInteraction: false,
    silent: false,
    data: {route, notification_id: payload.notification_id || payload.bundle_id, sw_version: HS_PUSH_SW_VERSION}
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const route = /^\?radarEtf=\d{4,6}$/.test(event.notification.data?.route) ? event.notification.data.route : "./";
  const appUrl = new URL(route, self.registration.scope).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({type: "window", includeUncontrolled: true});
    const existing = windows.find(client => client.url.startsWith(self.registration.scope));
    if (existing) {
      if ("navigate" in existing && !existing.url.startsWith(appUrl)) await existing.navigate(appUrl);
      return existing.focus();
    }
    return self.clients.openWindow(appUrl);
  })());
});

self.addEventListener("pushsubscriptionchange", event => {
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({type: "window", includeUncontrolled: true});
    for (const client of windows) client.postMessage({type: "HS_PUSH_SUBSCRIPTION_CHANGED", status: "RE_ENABLE_REQUIRED", version: HS_PUSH_SW_VERSION});
  })());
});
