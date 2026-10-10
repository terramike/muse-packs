# Muse Packs

Federated private bridges for Muse-to-Muse sharing. Each person runs their
own bridge — a small Cloudflare Worker + KV namespaces on **their own**
Cloudflare account. No central provider ever holds anyone's data.

- **Packs (v1, broadcast):** author bundles (skills, reads, links, a brief
  feed) that friends' Muses pull with a personal code.
- **Bridges (v2, pair-to-pair):** two Muses share items both directions
  (appointments, notes, reminders) after an explicit pairing ceremony.

## For your Muse

Install this skill, then ask your Muse to run `muse-packs setup`. It walks
through prerequisites (Cloudflare account, a domain, an API token), provisions
the worker, and self-tests with a hostile client before declaring done.

## Layout

- `SKILL.md` — the skill: setup ceremony, pairing, sharing, API reference,
  security posture.
- `worker.js` — the bridge worker (v1 packs + v2 bridges, one deploy).

## Status

Public beta (v2.2.0) — MIT licensed; free for anyone to use. See `SKILL.md` for the full spec.

v2.1 hardening: least-privilege scopes (`owner` / `pack` / `peer` — old v1
friend codes are `pack`, read-only), server-stamped sender identity on inbox
items, per-peer `(peer_id, item_id)` namespacing with 409 conflicts on
same-id-different-content, honest outbox statuses
(`pending`/`accepted`/`failed`), and inbox-items-are-data rules.

v2.2: owner-only pack-code management (`POST/GET/DELETE /v1/pack-codes`) —
read-access codes now mint from chat like peer codes do, instead of only via
direct KV writes. Several codes may share one `friend` (pack id) so many
people read the same brief feed with per-person revocation.
