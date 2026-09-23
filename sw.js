// 오늘 올라옴? — 알림 담당 서비스워커
// 페이지가 Cache Storage("ott-state")에 넣어둔 일정(schedule)을 읽고, 시간이 된 회차를 한 번씩만 알림

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

const readJson = async (c, key, fallback) => {
  const r = await c.match(key);
  if (!r) return fallback;
  try { return await r.json(); } catch (e) { return fallback; }
};

const check = async () => {
  if (Notification.permission !== "granted") return;
  const c = await caches.open("ott-state");
  const schedule = await readJson(c, "schedule", []);
  const notified = await readJson(c, "notified", {});
  const now = Date.now();
  let changed = false;
  for (const it of schedule) {
    // 시간이 지났고, 12시간 안이고, 아직 안 보낸 것만
    if (it.at > now || now - it.at > 12 * 3600 * 1000 || notified[it.key]) continue;
    await self.registration.showNotification(it.title, { body: it.body, tag: it.key, icon: "icon-512.png" });
    notified[it.key] = now;
    changed = true;
  }
  if (changed) {
    // 2주 지난 기록은 정리
    for (const k in notified) if (now - notified[k] > 14 * 86400 * 1000) delete notified[k];
    await c.put("notified", new Response(JSON.stringify(notified)));
  }
};

// 서버(Cloudflare Worker)가 보낸 푸시 — 앱이 꺼져 있어도 도착
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data.json(); } catch (err) {}
  e.waitUntil(self.registration.showNotification(d.title || "오늘 올라옴?", { body: d.body || "", tag: d.tag, icon: "icon-512.png" }));
});

self.addEventListener("message", (e) => { if (e.data === "check") e.waitUntil(check()); });
self.addEventListener("periodicsync", (e) => { if (e.tag === "ott-check") e.waitUntil(check()); });

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (list.length) return list[0].focus();
    return self.clients.openWindow("./");
  })());
});
