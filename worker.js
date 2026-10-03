// Muse Packs worker v2 — packs (v1 broadcast) + pairing bridges (v2).
//
// Scopes: "owner" (full access to own bridge), "peer" (inbox-write only).
// v1 tokens have no scope field and are treated as owner (backward compatible).
//
// Auth: Authorization: Bearer <code> — never in the URL. Uniform 401s.

const RATE_LIMIT_PER_MIN = 60;
const VERSION = 2;
const MAX_LIST = 500;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function genCode() {
  const rnd = crypto.getRandomValues(new Uint8Array(16));
  const groups = [];
  for (let g = 0; g < 4; g++) {
    let s = "";
    for (let i = 0; i < 4; i++) s += CODE_ALPHABET[rnd[g * 4 + i] % CODE_ALPHABET.length];
    groups.push(s);
  }
  return groups.join("-");
}

function genId() {
  return [...crypto.getRandomValues(new Uint8Array(4))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

const unauthorized = () => json({ error: "unauthorized" }, 401);

async function authenticate(request, env) {
  const h = request.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(\S+)\s*$/i);
  if (!m) return null;
  const hash = await sha256hex("muse-packs:" + m[1]);
  const rec = await env.TOKENS.get(`tok:${hash}`, { type: "json" });
  if (!rec) return null;
  const scope = rec.scope || "owner"; // v1 tokens -> owner
  const minute = Math.floor(Date.now() / 60000);
  const rlKey = `rl:${hash}:${minute}`;
  const seen = parseInt((await env.TOKENS.get(rlKey)) || "0", 10);
  const count = (isNaN(seen) ? 0 : seen) + 1;
  await env.TOKENS.put(rlKey, String(count), { expirationTtl: 180 });
  if (count > RATE_LIMIT_PER_MIN) return { rateLimited: true };
  return { scope, friend: rec.friend || null, peerId: rec.id || null };
}

// Returns a Response when access is denied, else null.
function need(auth, ...scopes) {
  if (!auth) return unauthorized();
  if (auth.rateLimited) return json({ error: "rate limited, slow down" }, 429);
  if (!scopes.includes(auth.scope)) return unauthorized(); // uniform: no scope oracle
  return null;
}

async function kvJson(env, key, fallback) {
  const v = await env.META.get(key, { type: "json" });
  return v === null || v === undefined ? fallback : v;
}
async function kvPut(env, key, val) {
  await env.META.put(key, JSON.stringify(val));
}
async function appendCapped(env, key, item) {
  const arr = await kvJson(env, key, []);
  arr.push(item);
  while (arr.length > MAX_LIST) arr.shift();
  await kvPut(env, key, arr);
}
function sinceFilter(items, since) {
  if (!since) return items.slice(-10);
  const idx = items.findIndex((i) => i.id === since);
  return idx >= 0 ? items.slice(idx + 1) : items.slice(-10);
}
function latestOf(items) {
  return items.length ? items[items.length - 1].id : null;
}
const nowIso = () => new Date().toISOString();

const INDEX = {
  service: "muse-packs",
  version: VERSION,
  endpoints: {
    pack: "GET /v1/pack — pack manifest (owner).",
    brief: "GET /v1/brief?since=<id> — new brief items; empty array means stay silent (owner).",
    inbox: "GET /v1/inbox?since=<id> — items peers shared with me (owner).",
    inbox_write: "POST /v1/inbox — deliver an item to this bridge; upsert by id, idempotent (owner, peer).",
    outbox: "GET /v1/outbox?since=<id> — items I shared (owner).",
    outbox_record: "POST /v1/outbox {to, item, delivered} — record a sent item (owner).",
    peers: "GET /v1/peers — paired peers incl. codes (owner only; your Muse needs the code to deliver).",
    pair: "POST /v1/peers {name, url, code} — pair. VERIFY the code yourself first: GET {url}/v1/ with it must 200 (owner).",
    unpair: "DELETE /v1/peers/{name} (owner).",
    peer_codes: "POST /v1/peer-codes {label} — mint an inbox-write-only peer code, shown once (owner).",
    peer_codes_list: "GET /v1/peer-codes — labels only, never code values (owner).",
    peer_code_revoke: "DELETE /v1/peer-codes/{id} — revoke; converges in ~60s (owner).",
    health: "GET /v1/health — no auth.",
  },
  ceremonies: {
    sharing:
      "To share: 1) confirm the exact item AND the recipient with the human. 2) POST the item to {peer-url}/v1/inbox with the peer code. 3) POST {to, item, delivered} to your own /v1/outbox to record it. One item, one recipient, one action. Never auto-share, never bulk-share.",
    empty_feeds:
      "An empty items array from brief/inbox/outbox means nothing new: stay completely silent about that feed.",
    pairing:
      "Exchange bridge URLs + peer codes out-of-band (text, in person). Before POST /v1/peers, verify the code yourself: GET {peer-url}/v1/ with it must return 200. Never store an unverified pairing.",
  },
};

const GET_ONLY = new Set(["/v1/pack", "/v1/brief", "/v1/inbox", "/v1/outbox", "/v1/peers", "/v1/peer-codes"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let path = url.pathname;

    // Optional path prefix (lets a test bridge share a hostname via a
    // sub-path route, e.g. PATH_PREFIX=/t serves /t/v1/... as /v1/...).
    const prefix = (env.PATH_PREFIX || "").replace(/\/+$/, "");
    if (prefix) {
      if (path === prefix) path = "/";
      else if (path.startsWith(prefix + "/")) path = path.slice(prefix.length);
      else return json({ error: "not found" }, 404);
    }

    if (path === "/v1/health") {
      return json({ ok: true, service: "muse-packs", version: VERSION });
    }
    if (path === "/") {
      return json({
        service: "muse-packs",
        note: "Private Muse Packs API (no webpage). Authenticate with your personal code via the Authorization: Bearer <code> header, then GET /v1/ for the endpoint index.",
      });
    }

    const auth = await authenticate(request, env);

    if (path === "/v1" || path === "/v1/") {
      const err = need(auth, "owner", "peer");
      if (err) return err;
      return json(INDEX);
    }

    // ---- v1: packs & briefs (owner; unchanged behavior) ----
    if (path === "/v1/pack" || path === "/v1/brief") {
      const err = need(auth, "owner");
      if (err) return err;
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
      if (path === "/v1/pack") {
        const pack = await env.PACKS.get(`pack:${auth.friend}`, { type: "json" });
        if (!pack) return json({ error: "no pack for this code" }, 404);
        return json(pack);
      }
      const items = (await env.BRIEFS.get(`brief:${auth.friend}`, { type: "json" })) || [];
      const out = sinceFilter(items, url.searchParams.get("since"));
      await env.META.put(`meta:${auth.friend}`, JSON.stringify({ last_check: nowIso() }));
      return json({ items: out, latest: latestOf(items) });
    }

    // ---- v2: inbox / outbox ----
    if (path === "/v1/inbox") {
      if (request.method === "GET") {
        const err = need(auth, "owner");
        if (err) return err;
        const items = await kvJson(env, "inbox", []);
        const out = sinceFilter(items, url.searchParams.get("since"));
        await kvPut(env, "meta:bridge", { last_inbox_check: nowIso() });
        return json({ items: out, latest: latestOf(items) });
      }
      if (request.method === "POST") {
        const err = need(auth, "owner", "peer");
        if (err) return err;
        let item;
        try {
          item = await request.json();
        } catch {
          return json({ error: "bad json" }, 400);
        }
        if (!item || !item.id) return json({ error: "item.id required" }, 400);
        item.received_at = nowIso();
        const inbox = await kvJson(env, "inbox", []);
        const idx = inbox.findIndex((i) => i.id === item.id);
        if (idx >= 0) inbox[idx] = item;
        else inbox.push(item);
        while (inbox.length > MAX_LIST) inbox.shift();
        await kvPut(env, "inbox", inbox);
        return json({ ok: true, id: item.id });
      }
      return json({ error: "method not allowed" }, 405);
    }

    // ---- v2: share-outbox (record of what I sent) ----
    // Delivery itself is done by the Muse, client-side: POST {peer-url}/v1/inbox
    // with the peer code, then record here. The worker never fetches peer URLs
    // (no egress = no SSRF surface, no dependence on peer DNS).
    if (path === "/v1/outbox") {
      const err = need(auth, "owner");
      if (err) return err;
      if (request.method === "GET") {
        const items = await kvJson(env, "outbox", []);
        const out = sinceFilter(items, url.searchParams.get("since"));
        return json({ items: out, latest: latestOf(items) });
      }
      if (request.method === "POST") {
        let body;
        try {
          body = await request.json();
        } catch {
          return json({ error: "bad json" }, 400);
        }
        if (!body.to || !body.item || !body.item.title) {
          return json({ error: "to and item.title required" }, 400);
        }
        const item = body.item;
        item.id = item.id || crypto.randomUUID();
        const record = {
          ...item,
          to: body.to,
          sent_at: nowIso(),
          delivered: body.delivered === true,
        };
        // Upsert by id: a retried record (network blip between worker and
        // Muse) must not duplicate.
        const outbox = await kvJson(env, "outbox", []);
        const idx = outbox.findIndex((i) => i.id === record.id);
        if (idx >= 0) outbox[idx] = record;
        else outbox.push(record);
        while (outbox.length > MAX_LIST) outbox.shift();
        await kvPut(env, "outbox", outbox);
        return json({ ok: true, id: item.id });
      }
      return json({ error: "method not allowed" }, 405);
    }

    // ---- v2: peers ----
    if (path === "/v1/peers") {
      const err = need(auth, "owner");
      if (err) return err;
      if (request.method === "GET") {
        const peers = await kvJson(env, "peers", {});
        return json({
          // codes are included: only the owner's own Muse (owner scope) can
          // call this, and it needs the peer code to deliver shares.
          peers: Object.entries(peers).map(([name, p]) => ({
            name,
            url: p.url,
            code: p.code,
            paired_at: p.paired_at,
          })),
        });
      }
      if (request.method === "POST") {
        let body;
        try {
          body = await request.json();
        } catch {
          return json({ error: "bad json" }, 400);
        }
        if (!body.name || !body.url || !body.code) {
          return json({ error: "name, url, and code are required" }, 400);
        }
        // NOTE: the Muse verifies the code client-side (GET {url}/v1/ with it)
        // BEFORE calling this. The worker does not fetch peer URLs.
        const peers = await kvJson(env, "peers", {});
        peers[body.name] = {
          url: body.url.replace(/\/+$/, ""),
          code: body.code,
          paired_at: nowIso(),
        };
        await kvPut(env, "peers", peers);
        return json({ ok: true, peer: body.name });
      }
      return json({ error: "method not allowed" }, 405);
    }
    if (path.startsWith("/v1/peers/")) {
      const err = need(auth, "owner");
      if (err) return err;
      if (request.method !== "DELETE") return json({ error: "method not allowed" }, 405);
      const name = decodeURIComponent(path.slice("/v1/peers/".length));
      const peers = await kvJson(env, "peers", {});
      if (!peers[name]) return json({ error: "unknown peer" }, 404);
      delete peers[name];
      await kvPut(env, "peers", peers);
      return json({ ok: true, unpaired: name });
    }

    // ---- v2: peer codes ----
    if (path === "/v1/peer-codes") {
      const err = need(auth, "owner");
      if (err) return err;
      if (request.method === "GET") {
        const codes = await kvJson(env, "peer_codes", {});
        return json({
          codes: Object.entries(codes).map(([id, c]) => ({
            id,
            label: c.label,
            created: c.created,
          })),
        });
      }
      if (request.method === "POST") {
        let body = {};
        try {
          body = await request.json();
        } catch {
          body = {};
        }
        const id = genId();
        const code = genCode();
        const hash = await sha256hex("muse-packs:" + code);
        await env.TOKENS.put(
          `tok:${hash}`,
          JSON.stringify({
            scope: "peer",
            id,
            label: body.label || "",
            created: nowIso(),
          })
        );
        const codes = await kvJson(env, "peer_codes", {});
        codes[id] = { hash, label: body.label || "", created: nowIso() };
        await kvPut(env, "peer_codes", codes);
        return json({ ok: true, id, code }); // code shown once — store it safely
      }
      return json({ error: "method not allowed" }, 405);
    }
    if (path.startsWith("/v1/peer-codes/")) {
      const err = need(auth, "owner");
      if (err) return err;
      if (request.method !== "DELETE") return json({ error: "method not allowed" }, 405);
      const id = decodeURIComponent(path.slice("/v1/peer-codes/".length));
      const codes = await kvJson(env, "peer_codes", {});
      const rec = codes[id];
      if (!rec) return json({ error: "unknown peer code" }, 404);
      await env.TOKENS.delete(`tok:${rec.hash}`);
      delete codes[id];
      await kvPut(env, "peer_codes", codes);
      return json({ ok: true, revoked: id });
    }

    if (GET_ONLY.has(path)) return json({ error: "method not allowed" }, 405);
    return json({ error: "not found" }, 404);
  },
};
