"use strict";

const HS_PUSH_SW_VERSION = "HS_PUSH_SW_V1";
const HS_PUSH_PAYLOAD_VERSION = "HS_WEB_PUSH_PAYLOAD_V1";
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
  const valid = payload
    && payload.version === HS_PUSH_PAYLOAD_VERSION
    && payload.type === "TEST_PUSH"
    && payload.title === TEST_TITLE
    && payload.body === TEST_BODY
    && payload.route === "./"
    && typeof payload.sent_at === "string"
    && typeof payload.notification_id === "string";
  if (!valid) return;
  event.waitUntil(self.registration.showNotification(TEST_TITLE, {
    body: TEST_BODY,
    tag: "hs-radar-test-push",
    renotify: false,
    requireInteraction: false,
    silent: false,
    data: {route: "./", notification_id: payload.notification_id, sw_version: HS_PUSH_SW_VERSION}
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const appUrl = new URL("./", self.registration.scope).href;
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
