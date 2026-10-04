// NiceShot API — Cloudflare Worker
// PIN -> álbum de evento (pasta pública do Google Drive) -> miniaturas / download.
//
// Bindings necessários:
//   KV   EVENTS            (armazena eventos, PINs e a pasta global do Drive)
//   Secrets: GOOGLE_API_KEY, ADMIN_KEY, TOKEN_SECRET
//   Var:     ALLOWED_ORIGIN (ex.: https://niceshot.meudominio.com — vários separados por vírgula)

const BUILD = "2026-10-04-c"; // versão do Worker; o admin avisa se o publicado estiver desatualizado
const DRIVE = "https://www.googleapis.com/drive/v3";
const TOKEN_TTL = 60 * 60 * 24 * 3; // sessão do visitante: 3 dias
const LIST_TTL = 60; // cache da listagem de fotos (segundos)
const PIN_ALPHABET = "0123456789"; // PIN de 4 dígitos
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const MAX_DRIVE_CALLS = 45; // proteção contra o limite de subrequisições do Worker
const enc = new TextEncoder();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export default {
  async fetch(req, env, ctx) {
    const cors = corsHeaders(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    let res;
    try {
      res = await route(req, env, ctx, new URL(req.url));
    } catch (e) {
      if (e instanceof HttpError) res = json({ error: e.message }, e.status);
      else {
        console.error(e);
        res = json({ error: "erro interno" }, 500);
      }
    }
    // reembrulha para tornar os headers mutáveis (respostas de fetch/cache são imutáveis)
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
};

async function route(req, env, ctx, url) {
  const p = url.pathname.replace(/\/+$/, "") || "/";
  const m = req.method;
  let r;
  if (p === "/api/health") return json({ ok: true, build: BUILD });
  if (p === "/api/events" && m === "GET") return publicEvents(env);
  if (p === "/api/access" && m === "POST") return access(req, env);
  if (p === "/api/photos" && m === "GET") return photos(env, url);
  if ((r = p.match(/^\/api\/cover\/([a-z0-9]+)$/)) && m === "GET") return cover(env, ctx, url, r[1]);
  if ((r = p.match(/^\/api\/thumb\/([\w-]+)$/)) && m === "GET") return thumb(env, ctx, url, r[1]);
  if ((r = p.match(/^\/api\/download\/([\w-]+)$/)) && m === "GET") return download(env, url, r[1]);
  if (p.startsWith("/api/admin/")) return admin(req, env, p, m);
  throw new HttpError(404, "não encontrado");
}

/* ------------------------------ público ------------------------------ */

// Lista pública: só eventos ativos marcados para aparecer na tela inicial (sem PIN, sem pasta).
async function publicEvents(env) {
  const keys = await env.EVENTS.list({ prefix: "event:" });
  const evs = (await Promise.all(keys.keys.map((k) => env.EVENTS.get(k.name, "json")))).filter((e) => e && e.active && e.listed !== false);
  evs.sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0));
  return json(evs.map((e) => ({ id: e.id, name: e.name, date: e.date, place: e.place || "", cover: !!e.cover })));
}

async function access(req, env) {
  await limit(req, "pin", 10, 60);
  const { pin, eventId: wanted } = await readJson(req);
  const eventId = await env.EVENTS.get(`pin:${String(pin || "").toUpperCase().trim()}`);
  if (!eventId || (wanted && wanted !== eventId)) throw new HttpError(401, "PIN inválido");
  const ev = await getEvent(env, eventId);
  if (!ev || !ev.active) throw new HttpError(403, "álbum indisponível");
  return json({ token: await makeToken(env, ev.id), event: publicEvent(ev) });
}

async function photos(env, url) {
  const ev = await eventFromToken(env, url.searchParams.get("token"));
  const list = await listPhotos(env, ev);
  const photos = await Promise.all(list.map(async (p) => ({ ...p, k: await photoKey(env, ev.id, p.id) })));
  return json({ event: publicEvent(ev), count: photos.length, photos });
}

async function thumb(env, ctx, url, fileId) {
  const ev = await eventFromToken(env, url.searchParams.get("token"));
  await checkPhoto(env, ev, fileId, url.searchParams.get("k"));
  return thumbResponse(env, ctx, fileId, thumbSize(url));
}

// Capa pública do evento (a foto escolhida no admin): não exige PIN.
async function cover(env, ctx, url, eventId) {
  const ev = await getEvent(env, eventId);
  if (!ev || !ev.active || ev.listed === false || !ev.cover) throw new HttpError(404, "sem capa");
  return thumbResponse(env, ctx, ev.cover, thumbSize(url));
}

function thumbSize(url) {
  const asked = Number(url.searchParams.get("s"));
  return [400, 800, 1600].includes(asked) ? asked : 400; // 400 = grade, 800 = busca por selfie, 1600 = visualização
}

async function thumbResponse(env, ctx, fileId, size) {
  const cache = caches.default;
  const key = new Request(`https://thumb.local/${fileId}/${size}`);
  let res = await cache.match(key);
  if (!res) {
    const meta = await fetch(`${DRIVE}/files/${fileId}?fields=thumbnailLink&key=${env.GOOGLE_API_KEY}`);
    if (!meta.ok) throw new HttpError(502, "miniatura indisponível");
    const { thumbnailLink } = await meta.json();
    if (!thumbnailLink) throw new HttpError(404, "sem miniatura");
    const img = await fetch(thumbnailLink.replace(/=s\d+$/, `=s${size}`));
    if (!img.ok) throw new HttpError(502, "miniatura indisponível");
    res = new Response(img.body, {
      headers: {
        "Content-Type": img.headers.get("Content-Type") || "image/jpeg",
        "Cache-Control": "public, max-age=86400",
      },
    });
    ctx.waitUntil(cache.put(key, res.clone()));
  }
  return res;
}

async function download(env, url, fileId) {
  const ev = await eventFromToken(env, url.searchParams.get("token"));
  if (ev.allowDownload === false) throw new HttpError(403, "download desativado neste álbum");
  await checkPhoto(env, ev, fileId, url.searchParams.get("k"));
  const meta = await fetch(`${DRIVE}/files/${fileId}?fields=name&key=${env.GOOGLE_API_KEY}`);
  const name = meta.ok ? (await meta.json()).name || `${fileId}.jpg` : `${fileId}.jpg`;
  const up = await fetch(`${DRIVE}/files/${fileId}?alt=media&key=${env.GOOGLE_API_KEY}`);
  if (!up.ok) {
    // 403 do Drive costuma ser cota por arquivo/minuto: peça para tentar de novo
    throw new HttpError(up.status === 403 ? 429 : 502, "arquivo indisponível agora, tente novamente em instantes");
  }
  const h = new Headers({
    "Content-Type": up.headers.get("Content-Type") || "image/jpeg",
    "Content-Disposition": `attachment; filename="${name.replace(/[\"\\\r\n]/g, "")}"`,
    "Cache-Control": "private, max-age=0",
  });
  const len = up.headers.get("Content-Length");
  if (len) h.set("Content-Length", len);
  return new Response(up.body, { headers: h });
}

/* ------------------------------- admin ------------------------------- */

async function admin(req, env, p, m) {
  await limit(req, "admin", 30, 60);
  const auth = req.headers.get("Authorization") || "";
  if (!env.ADMIN_KEY || !safeEqual(auth, `Bearer ${env.ADMIN_KEY}`)) throw new HttpError(401, "não autorizado");
  let r;

  if (p === "/api/admin/events" && m === "GET") {
    const keys = await env.EVENTS.list({ prefix: "event:" });
    const events = (await Promise.all(keys.keys.map((k) => env.EVENTS.get(k.name, "json")))).filter(Boolean);
    events.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return json(events);
  }

  if (p === "/api/admin/events" && m === "POST") {
    const b = await readJson(req);
    if (!b.name) throw new HttpError(400, "informe o nome do evento");
    const now = Date.now();
    const pin = b.pin ? await assertFreePin(env, b.pin) : await uniquePin(env);
    const ev = {
      id: randomString(8, ID_ALPHABET),
      name: String(b.name).trim().slice(0, 120),
      date: String(b.date || ""),
      place: String(b.place || "").trim().slice(0, 120),
      dateFrom: cleanDay(b.dateFrom),
      dateTo: cleanDay(b.dateTo),
      subfolders: b.subfolders !== false,
      folderId: b.folderId ? extractFolderId(b.folderId) : "", // vazio = usa a pasta global
      allowDownload: b.allowDownload !== false,
      active: b.active !== false,
      listed: b.listed !== false,
      hidden: [],
      pin,
      createdAt: now,
      updatedAt: now,
    };
    await saveEvent(env, ev);
    await env.EVENTS.put(`pin:${ev.pin}`, ev.id);
    return json(ev, 201);
  }

  if ((r = p.match(/^\/api\/admin\/events\/([a-z0-9]+)$/))) {
    const ev = await getEvent(env, r[1]);
    if (!ev) throw new HttpError(404, "evento não encontrado");

    if (m === "GET") return json(ev);

    if (m === "DELETE") {
      await env.EVENTS.delete(`event:${ev.id}`);
      await env.EVENTS.delete(`pin:${ev.pin}`);
      return json({ ok: true });
    }

    if (m === "PUT") {
      const b = await readJson(req);
      for (const k of ["name", "date", "place"]) if (k in b) ev[k] = String(b[k]).trim();
      if ("folderId" in b) ev.folderId = extractFolderId(b.folderId);
      for (const k of ["allowDownload", "active", "listed", "subfolders"]) if (k in b) ev[k] = !!b[k];
      if (Array.isArray(b.hidden)) ev.hidden = b.hidden.map(String);
      if (b.hideFile) ev.hidden = [...new Set([...(ev.hidden || []), String(b.hideFile)])];
      if (b.unhideFile) ev.hidden = (ev.hidden || []).filter((x) => x !== String(b.unhideFile));
      for (const k of ["dateFrom", "dateTo"]) if (k in b) ev[k] = cleanDay(b[k]);
      if ("cover" in b) ev.cover = String(b.cover || "").slice(0, 80);
      if (b.pin && String(b.pin).trim() !== ev.pin) {
        const pin = await assertFreePin(env, b.pin);
        await env.EVENTS.delete(`pin:${ev.pin}`);
        ev.pin = pin;
        await env.EVENTS.put(`pin:${pin}`, ev.id);
      }
      if (b.regeneratePin) {
        await env.EVENTS.delete(`pin:${ev.pin}`);
        ev.pin = await uniquePin(env);
        await env.EVENTS.put(`pin:${ev.pin}`, ev.id);
      }
      ev.updatedAt = Date.now();
      await saveEvent(env, ev);
      return json(ev);
    }
  }

  if (p === "/api/admin/settings" && m === "GET") return json(await getSettings(env));
  if (p === "/api/admin/settings" && m === "PUT") {
    const b = await readJson(req);
    const s = { ...(await getSettings(env)), folderId: extractFolderId(b.folderId) };
    await env.EVENTS.put("settings", JSON.stringify(s));
    return json(s);
  }

  throw new HttpError(404, "não encontrado");
}

/* ------------------------- eventos e fotos --------------------------- */

async function getSettings(env) {
  return (await env.EVENTS.get("settings", "json")) || {};
}

async function getEvent(env, id) {
  return env.EVENTS.get(`event:${id}`, "json");
}

async function saveEvent(env, ev) {
  await env.EVENTS.put(`event:${ev.id}`, JSON.stringify(ev));
}

function publicEvent(ev) {
  return { id: ev.id, name: ev.name, date: ev.date, allowDownload: ev.allowDownload !== false, maxBatch: 10, dateFrom: ev.dateFrom || "", dateTo: ev.dateTo || "" };
}

async function eventFromToken(env, token) {
  const id = await readToken(env, token);
  const ev = await getEvent(env, id);
  if (!ev || !ev.active) throw new HttpError(403, "álbum indisponível");
  return ev;
}

// Chave por foto: só quem recebeu a lista (com PIN) tem o k de cada foto; evita relistar a pasta a cada miniatura.
async function photoKey(env, eventId, fileId) {
  return (await hmac(env.TOKEN_SECRET, `k.${eventId}.${fileId}`)).slice(0, 16);
}

async function checkPhoto(env, ev, fileId, k) {
  if ((ev.hidden || []).includes(fileId)) throw new HttpError(404, "foto não encontrada neste álbum");
  if (!safeEqual(String(k || ""), await photoKey(env, ev.id, fileId))) throw new HttpError(403, "acesso negado a esta foto");
}

async function assertInEvent(env, ev, fileId) {
  const photo = (await listPhotos(env, ev)).find((x) => x.id === fileId);
  if (!photo) throw new HttpError(404, "foto não encontrada neste álbum");
  return photo;
}

// Ordena pela hora da foto (EXIF "2026:10:03 14:21:05"), com o envio ao Drive como reserva.
// Assim duas câmeras e a virada do 9999 ficam na ordem certa.
function sortKeyOf(f) {
  const t = f.imageMediaMetadata?.time || "";
  if (/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}/.test(t)) return t.slice(0, 10).replace(/:/g, "-") + "T" + t.slice(11, 19);
  return (f.createdTime || "").slice(0, 19);
}

// Lista as fotos do evento (pasta do Drive + filtros de prefixo/sequência), com cache de 60 s.
// A chave de cache inclui updatedAt: qualquer mudança no admin invalida na hora.
async function listPhotos(env, ev) {
  const folderId = ev.folderId || (await getSettings(env)).folderId; // pasta própria do evento ou a global
  if (!folderId) throw new HttpError(503, "pasta do Drive não configurada no admin");
  const cache = caches.default;
  const key = new Request(`https://list.local/${ev.id}/${ev.updatedAt || 0}/${folderId}`);
  const hit = await cache.match(key);
  if (hit) return hit.json();

  const files = await driveListImages(env, folderId, ev.subfolders !== false);
  const hidden = new Set(ev.hidden || []);
  const out = [];
  for (const f of files) {
    if (hidden.has(f.id)) continue;
    const day = sortKeyOf(f).slice(0, 10); // dia da captura (hora da câmera)
    if (ev.dateFrom && day < ev.dateFrom) continue;
    if (ev.dateTo && day > ev.dateTo) continue;
    out.push({
      id: f.id,
      name: f.name,
      size: Number(f.size || 0),
      takenAt: sortKeyOf(f),
      exif: !!f.imageMediaMetadata?.time, // false = foto sem data de captura gravada (vale a data de envio ao Drive)
      w: f.imageMediaMetadata?.width || 0,
      h: f.imageMediaMetadata?.height || 0,
    });
  }
  out.sort((a, b) => a.takenAt.localeCompare(b.takenAt) || a.name.localeCompare(b.name));
  await cache.put(
    key,
    new Response(JSON.stringify(out), {
      headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${LIST_TTL}` },
    }),
  );
  return out;
}

// Percorre a pasta e até 2 níveis de subpastas (o image.canon pode organizar por data).
async function driveListImages(env, rootId, deep = true) {
  const maxDepth = deep ? 3 : 1; // sem subpastas: só os arquivos da própria pasta
  const files = [];
  let level = [rootId];
  let calls = 0;
  for (let depth = 0; depth < maxDepth && level.length; depth++) {
    const next = [];
    for (const folderId of level) {
      let pageToken = "";
      do {
        if (++calls > MAX_DRIVE_CALLS) return files;
        const params = new URLSearchParams({
          q: `'${folderId}' in parents and trashed=false`,
          key: env.GOOGLE_API_KEY,
          pageSize: "1000",
          fields: "nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,imageMediaMetadata(time,width,height))",
        });
        if (pageToken) params.set("pageToken", pageToken);
        const res = await fetch(`${DRIVE}/files?${params}`);
        if (!res.ok) throw new HttpError(502, `Drive respondeu ${res.status} (a pasta está compartilhada por link?)`);
        const data = await res.json();
        for (const f of data.files || []) {
          if (f.mimeType === "application/vnd.google-apps.folder") next.push(f);
          else if ((f.mimeType || "").startsWith("image/")) files.push(f);
        }
        pageToken = data.nextPageToken || "";
      } while (pageToken);
    }
    level = next.sort((a, b) => (b.modifiedTime || "").localeCompare(a.modifiedTime || "")).map((f) => f.id);
  }
  return files;
}

/* ------------------------- token, PIN, limites ----------------------- */

async function hmac(secret, data) {
  if (!secret) throw new HttpError(500, "TOKEN_SECRET não configurado");
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))));
}

async function makeToken(env, eventId) {
  const body = `${eventId}.${Math.floor(Date.now() / 1000) + TOKEN_TTL}`;
  return `${body}.${await hmac(env.TOKEN_SECRET, body)}`;
}

async function readToken(env, token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new HttpError(401, "sessão inválida");
  const [eventId, exp, sig] = parts;
  if (!safeEqual(sig, await hmac(env.TOKEN_SECRET, `${eventId}.${exp}`))) throw new HttpError(401, "sessão inválida");
  if (Number(exp) < Date.now() / 1000) throw new HttpError(401, "sessão expirada, digite o PIN novamente");
  return eventId;
}

// Valida um PIN escolhido à mão: 4 dígitos e ainda não usado por outro evento.
async function assertFreePin(env, value) {
  const pin = String(value).trim();
  if (!/^\d{4}$/.test(pin)) throw new HttpError(400, "o PIN precisa ter 4 dígitos");
  if (await env.EVENTS.get(`pin:${pin}`)) throw new HttpError(409, "esse PIN já está em uso por outro evento");
  return pin;
}

async function uniquePin(env) {
  for (let i = 0; i < 30; i++) {
    const pin = randomString(4, PIN_ALPHABET);
    if (!(await env.EVENTS.get(`pin:${pin}`))) return pin;
  }
  throw new HttpError(500, "não foi possível gerar PIN único");
}

// Limite simples por IP usando o cache da Cloudflare (por datacenter; suficiente contra tentativa em massa).
async function limit(req, bucket, max, windowSec) {
  const ip = req.headers.get("CF-Connecting-IP") || "local";
  const cache = caches.default;
  const key = new Request(`https://rl.local/${bucket}/${encodeURIComponent(ip)}`);
  const hit = await cache.match(key);
  const n = hit ? Number(await hit.text()) : 0;
  if (n >= max) throw new HttpError(429, "muitas tentativas, aguarde um minuto");
  await cache.put(key, new Response(String(n + 1), { headers: { "Cache-Control": `max-age=${windowSec}` } }));
}

/* ------------------------------ utilitários -------------------------- */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

async function readJson(req) {
  try {
    return (await req.json()) || {};
  } catch {
    throw new HttpError(400, "JSON inválido");
  }
}

function corsHeaders(req, env) {
  const origin = req.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
  const h = {
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Expose-Headers": "Content-Disposition,Content-Length",
    "Access-Control-Max-Age": "86400",
  };
  if (allowed.includes("*")) h["Access-Control-Allow-Origin"] = origin || "*";
  else if (allowed.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function randomString(len, alphabet) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function safeEqual(a, b) {
  a = String(a);
  b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Aceita o ID puro ou a URL da pasta (https://drive.google.com/drive/folders/ID?usp=sharing)
function extractFolderId(v) {
  const s = String(v || "").trim();
  const m = s.match(/folders\/([\w-]+)/) || s.match(/[?&]id=([\w-]+)/);
  return m ? m[1] : s;
}

// Aceita só datas no formato AAAA-MM-DD (ou vazio).
function cleanDay(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : "";
}
