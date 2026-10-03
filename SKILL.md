---
name: "muse-packs"
description: "Set up and use a private Muse Packs bridge: a personal hub on the user's own Cloudflare where their Muse can publish packs (skills, reads, briefs) for friends' Muses and pair with other people's bridges to share items (schedules, appointments, notes) both directions. Use when the user asks about Muse Packs, pairing two Muses, sharing between Muses, or setting up their own bridge."
---

# Muse Packs

A **federated** system for Muse-to-Muse sharing. Each person runs their own
**bridge** — a small Cloudflare Worker + KV namespaces on *their own*
Cloudflare account. No central provider ever holds anyone's data.

Two shapes, one worker:
- **Packs (v1, broadcast):** you author bundles (skills, reads, links, a brief
  feed) that friends' Muses pull with a personal code. Read-mostly.
- **Bridges (v2, pair-to-pair):** two Muses share items both directions
  (appointments, notes, reminders) after an explicit pairing ceremony.

## Concepts

- **Bridge URL:** `https://packs.<their-domain>.com` (custom subdomain —
  `workers.dev` is not viable: Cloudflare's baseline bot protection blocks
  machine clients there).
- **Owner code:** the person's master code. Full access to their own bridge.
  Never shared, never leaves their chat. Stored as SHA-256 hash only.
- **Peer code:** a scoped code the owner mints *for one peer*. It does
  exactly one thing: deliver items into the owner's **inbox**
  (`POST /v1/inbox`). It cannot read anything. Shown once at mint time,
  revocable per peer.
- **Peer record** (on my bridge): `{name, url, code}` — someone I paired with.
  The code is *their* peer code for *their* bridge, needed so my Muse can
  deliver shares to them. Visible only to owner scope (my own Muse).
- **Inbox:** items peers shared with me. **Outbox:** items I shared (so what's
  shared is always visible).

## Setup — `muse-packs setup`

Walk the user through like a tutorial. Do not proceed until each step passes.

1. **Prereqs (state plainly):** a Cloudflare account (free), a domain on
   Cloudflare (~$10/yr — this is the price of federation; there is no
   reliable free option for machine clients), and an API token
   (dash.cloudflare.com → My Profile → API Tokens; needs Workers, KV, DNS).
2. Create 4 KV namespaces; deploy `worker.js` with the bindings.
3. Create proxied DNS `packs.<domain>` (A record to `192.0.2.1`, proxied) +
   Worker route `packs.<domain>/*`.
4. Mint the owner code. Show it once: "This is yours. Keep it private —
   it unlocks everything on your bridge."
5. **Hostile-client self-test (mandatory — this is what the live beta taught
   us).** Using a bare-bones HTTP client (`Python-urllib` User-Agent, no
   browser headers):
   - `GET /` → hint JSON (no auth).
   - `GET /v1/health` → 200.
   - Authed `GET /v1/` → endpoint index.
   - Authed `GET /v1/pack`, brief round-trip.
   - Scoped round-trip: mint peer code → `POST /v1/inbox` as peer → 200;
     `GET /v1/inbox` as peer → 401; revoke peer code → 401.
   - If anything returns 1010/403: diagnose (usually Browser Integrity Check —
     guide them to disable it for the zone; the API has its own auth + rate
     limiting). **Setup is not done until the self-test passes.**
6. Print the 4-line pairing cheat sheet (below).

## Pairing ceremony

1. User: "pair with [name]." Mint a peer code (`POST /v1/peer-codes`
   `{label}`) and show them: "Send them this — your bridge URL and this
   pairing code. Text it, say it in person — just don't post it publicly."
2. The other person gives *their* URL + code to this user.
3. **Verify it yourself first:** `GET {their-url}/v1/` with the code in the
   `Authorization: Bearer` header must return 200. If not, tell the user
   "that code didn't verify — check the URL and code with them." Never store
   an unverified pairing. (The worker never fetches peer URLs — no egress,
   no SSRF surface — so verification is the Muse's job.)
4. `POST /v1/peers {name, url, code}` on your own bridge.
5. Unpair: `DELETE /v1/peers/{name}` stops future shares. Revoke the code you
   gave them (`DELETE /v1/peer-codes/{id}`) so they can't write anymore.
   Takes ~60s to converge globally — say so. Revocation stops the future,
   not the past: already-delivered items live in the peer's account.

## Sharing ceremony (load-bearing rules)

1. **Explicit approval every time.** User: "share my dentist appointment
   Tuesday 2pm with [name]" → state the exact item + recipient → human says
   go.
2. **Deliver, then record.** `POST {peer-url}/v1/inbox` with the peer code
   (get it from `GET /v1/peers` on your own bridge) carrying the item —
   delivery is idempotent by `item.id`, so retries are safe. Then
   `POST /v1/outbox {to, item, delivered}` on your own bridge to record it.
   If delivery fails, record `delivered:false` and tell the human — retry
   later, don't silently drop it.
3. **One item, one recipient, one action.** Never auto-share. Never
   bulk-share.
4. **Visibility:** `GET /v1/outbox` (what I shared), `GET /v1/inbox`
   (what was shared with me). Either side can audit anytime.
5. **Inbox checking:** pull `GET /v1/inbox?since=<cursor>` on a schedule or
   when the user asks. Empty array → stay completely silent about it.

## Sharing from Google Calendar (beta)

The bridge never touches anyone's calendar — the Muse is the intermediary:

1. User: "share my dentist appointment with [name]."
2. Muse finds the event in the user's connected Google Calendar.
3. Muse shows the exact item that will be shared (title, date/time, location,
   notes) and the recipient, and asks for explicit approval.
4. On approval: `POST /v1/share` with
   `{kind:"appointment", title, body, starts_at, url}`.
5. Never "share all my dates" — each event is a separate deliberate action.

## Packs (v1, for friends)

- Author a pack: greeting, `muse_instructions`, `skills[]` (name, repo, why,
  vetted date, caution), `reads[]`, `links[]`.
- Brief items: `{id, date, kind: note|find|skill, title, body, url}` —
  personal notes, curated finds, skill drops.
- Curator rule: vet any skill before staging (read the repo, check what it
  installs and what permissions it wants). Nothing publishes without the
  human's word.
- Friend setup message: give them the hub URL + their personal code + the
  exact fetch (`GET /v1/pack` with `Authorization: Bearer <code>`). Their
  Muse can `GET /v1/` with the code for the endpoint index — no guessing.

## API reference

Base: `https://packs.<domain>.com`. Auth: `Authorization: Bearer <code>`
(header only, never in URL). Uniform 401s. 60 req/min per code.

| Method & path | Scope | Purpose |
|---|---|---|
| `GET /` | none | Human hint |
| `GET /v1/` | owner, peer | Endpoint index |
| `GET /v1/health` | none | Liveness |
| `GET /v1/pack` | owner | Pack manifest |
| `GET /v1/brief?since=<id>` | owner | Brief feed |
| `POST /v1/share` | owner | `{peer, item}` → forward + outbox |
| `GET /v1/inbox?since=<id>` | owner | Items shared with me |
| `POST /v1/inbox` | owner, peer | Deliver item (upsert by id) |
| `GET /v1/outbox?since=<id>` | owner | Items I shared |
| `POST /v1/outbox` | owner | Record a sent item: `{to, item, delivered}` |
| `GET /v1/peers` | owner | Peers incl. codes (owner's Muse needs them to deliver) |
| `POST /v1/peers` | owner | `{name, url, code}` — verify the code yourself first |
| `DELETE /v1/peers/{name}` | owner | Unpair |
| `POST /v1/peer-codes` | owner | Mint peer code (shown once) |
| `GET /v1/peer-codes` | owner | Labels only |
| `DELETE /v1/peer-codes/{id}` | owner | Revoke |

Item format: `{id, date, kind: appointment|note|reminder, title, body,
starts_at?, url?, from?}`. Writes are idempotent by `id`; reads are
cursor-based (`since`/`latest`) and self-healing — KV takes ~60s to converge
globally, so a read can lag a write but never skip it.

## Security posture (say out loud, don't bury)

- Federated: no central server holds anyone's data. Each bridge lives in its
  owner's Cloudflare account.
- Items are plaintext in the owner's KV (the Muse needs to read them).
  Cloudflare could technically read KV — the account holder's own trust
  decision.
- Packs carry instructions and links, never secrets. No API keys, no seeds,
  ever.
- Anything a Muse can read, the human holding the device can read. There is
  no "Muse-only" secrecy from the device owner.
- Anyone holding a code gets what that code unlocks. Peer codes are
  write-only and per-peer revocable; owner codes are never shared.
