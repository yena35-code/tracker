// 오늘 올라옴? 서버 (Cloudflare Worker, 파일 하나로 끝 — 대시보드에 그대로 붙여넣기)
// 1) TMDB 프록시: API 키는 서버 시크릿에만 두고 앱에는 노출 안 함
// 2) 웹 푸시: 앱이 꺼져 있어도 정해진 시각에 알림 (크론이 1분마다 확인)
//
// 대시보드 설정
//   - KV 바인딩 이름: KV
//   - 시크릿: TMDB_KEY
//   - 크론 트리거: * * * * *

const SUBJECT = "https://yena35-code.github.io/tracker/"; // 푸시 서비스에 알리는 연락처(앱 주소)

// 앱이 쓰는 TMDB 경로만 허용 (아무 요청이나 대신 보내주는 공개 프록시가 되지 않도록)
const ALLOWED = [/^\/search\/tv$/, /^\/discover\/tv$/, /^\/tv\/\d+$/, /^\/tv\/\d+\/season\/\d+$/, /^\/tv\/\d+\/watch\/providers$/];
// 브라우저 푸시 서비스 주소만 허용
const PUSH_HOSTS = ["fcm.googleapis.com", "android.googleapis.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com"];

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...cors, "Content-Type": "application/json" } });

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p.startsWith("/tmdb/")) return await tmdb(url, env);
      if (p === "/vapid") return json({ publicKey: (await vapid(env)).pub });
      if (p === "/sync" && req.method === "POST") return await sync(req, env);
      if (p === "/unsubscribe" && req.method === "POST") return await unsubscribe(req, env);
      return json({ ok: true, name: "ott-server" });
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendDue(env));
  },
};

// ── TMDB 프록시 ──
async function tmdb(url, env) {
  const path = url.pathname.slice("/tmdb".length);
  if (!ALLOWED.some((r) => r.test(path))) return json({ error: "not allowed" }, 403);
  const q = new URLSearchParams(url.search);
  q.set("api_key", env.TMDB_KEY);
  const res = await fetch(`https://api.themoviedb.org/3${path}?${q}`, { cf: { cacheTtl: 600, cacheEverything: true } });
  return new Response(res.body, { status: res.status, headers: { ...cors, "Content-Type": "application/json" } });
}

// ── 구독 & 알림 일정 저장 ──
const validSub = (s) => {
  try {
    const u = new URL(s.endpoint);
    return u.protocol === "https:" && PUSH_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith("." + h))
      && typeof s.keys?.p256dh === "string" && typeof s.keys?.auth === "string";
  } catch (e) { return false; }
};

async function sync(req, env) {
  const d = await req.json().catch(() => null);
  if (!d || !validSub(d.sub || {})) return json({ error: "bad subscription" }, 400);
  const schedule = (Array.isArray(d.schedule) ? d.schedule : []).slice(0, 100).map((it) => ({
    key: String(it.key).slice(0, 80), at: Number(it.at) || 0,
    title: String(it.title).slice(0, 100), body: String(it.body).slice(0, 200),
  }));
  const sub = { endpoint: d.sub.endpoint, keys: { p256dh: d.sub.keys.p256dh, auth: d.sub.keys.auth } };
  const id = await hashId(sub.endpoint);
  const old = await env.KV.get("sub:" + id, "json");
  await env.KV.put("sub:" + id, JSON.stringify({ sub, schedule, notified: old?.notified || {} }));
  const idx = (await env.KV.get("subs", "json")) || [];
  if (!idx.includes(id)) { idx.push(id); await env.KV.put("subs", JSON.stringify(idx)); }
  return json({ ok: true });
}

async function unsubscribe(req, env) {
  const d = await req.json().catch(() => null);
  if (!d?.endpoint) return json({ error: "bad request" }, 400);
  const id = await hashId(d.endpoint);
  await env.KV.delete("sub:" + id);
  const idx = ((await env.KV.get("subs", "json")) || []).filter((x) => x !== id);
  await env.KV.put("subs", JSON.stringify(idx));
  return json({ ok: true });
}

// ── 크론: 시간이 된 회차 푸시 ──
async function sendDue(env) {
  const ids = (await env.KV.get("subs", "json")) || [];
  if (!ids.length) return;
  const v = await vapid(env);
  const now = Date.now();
  const alive = [];
  for (const id of ids) {
    const rec = await env.KV.get("sub:" + id, "json");
    if (!rec) continue;
    let changed = false, gone = false;
    for (const it of rec.schedule) {
      // 시간이 지났고, 12시간 안이고, 아직 안 보낸 것만
      if (it.at > now || now - it.at > 12 * 3600 * 1000 || rec.notified[it.key]) continue;
      const status = await push(rec.sub, JSON.stringify({ title: it.title, body: it.body, tag: it.key }), v);
      if (status === 404 || status === 410) { gone = true; break; } // 구독 해지된 기기
      if (status >= 200 && status < 300) { rec.notified[it.key] = now; changed = true; }
    }
    if (gone) { await env.KV.delete("sub:" + id); continue; }
    alive.push(id);
    if (changed) {
      for (const k in rec.notified) if (now - rec.notified[k] > 14 * 86400 * 1000) delete rec.notified[k];
      await env.KV.put("sub:" + id, JSON.stringify(rec));
    }
  }
  if (alive.length !== ids.length) await env.KV.put("subs", JSON.stringify(alive));
}

async function push(sub, payload, v) {
  const jwt = await vapidJwt(new URL(sub.endpoint).origin, v);
  const body = await encrypt(payload, sub.keys.p256dh, sub.keys.auth);
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "43200",
      Urgency: "high",
      Authorization: `vapid t=${jwt}, k=${v.pub}`,
    },
    body,
  });
  return res.status;
}

// ── VAPID (서버 신원 키) — 처음 한 번 자동 생성해서 KV에 보관 ──
let vapidCache = null;
async function vapid(env) {
  if (vapidCache) return vapidCache;
  let v = await env.KV.get("vapid", "json");
  if (!v) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    v = { jwk: await crypto.subtle.exportKey("jwk", kp.privateKey), pub: b64u(await crypto.subtle.exportKey("raw", kp.publicKey)) };
    await env.KV.put("vapid", JSON.stringify(v));
  }
  return (vapidCache = v);
}

async function vapidJwt(aud, v) {
  const key = await crypto.subtle.importKey("jwk", v.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const h = b64u(enc(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const p = b64u(enc(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc(`${h}.${p}`));
  return `${h}.${p}.${b64u(sig)}`;
}

// ── 푸시 메시지 암호화 (RFC 8291, aes128gcm) ──
// test 인자는 RFC 예제값 검증용 (salt, 보내는 쪽 키 고정)
async function encrypt(text, p256dh, auth, test = {}) {
  const uaPub = unb64u(p256dh);
  const authSecret = unb64u(auth);
  const salt = test.salt || crypto.getRandomValues(new Uint8Array(16));
  const as = test.asKeys || await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));

  const prkKey = await hmac(authSecret, shared);
  const ikm = (await hmac(prkKey, cat(enc("WebPush: info\0"), uaPub, asPub, [1]))).slice(0, 32);
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(enc("Content-Encoding: aes128gcm\0"), [1]))).slice(0, 16);
  const nonce = (await hmac(prk, cat(enc("Content-Encoding: nonce\0"), [1]))).slice(0, 12);

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, cat(enc(text), [2])));
  const header = new Uint8Array(21);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = 65;
  return cat(header, asPub, ct);
}

// ── 유틸 ──
const enc = (s) => new TextEncoder().encode(s);
const cat = (...parts) => {
  const arrs = parts.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};
async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
function b64u(buf) {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64u(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
async function hashId(s) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", enc(s)));
  return [...h.slice(0, 16)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
