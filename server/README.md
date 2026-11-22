# Whal Bot control plane

TypeScript on Node's built-in `http` + [`ws`](https://github.com/websockets/ws), SQLite via `node:sqlite`.
Requires **Node 22.13+** (Node 24 recommended). No native addons.

## Quick start

```
npm install
npm run server:keys > server/.env.local   # prints the operator token ONCE on screen; keep it
npm run server                            # http://127.0.0.1:8787, simulated engine
npm run dev                               # terminal UI on http://localhost:3000, sign in with the operator token
```

The UI talks to `NEXT_PUBLIC_WHAL_API_URL` (default `http://127.0.0.1:8787`).
Set `NEXT_PUBLIC_WHAL_MOCK=1` to run the UI on its in-browser simulator with no backend.

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `WHAL_JWT_SECRET` | yes | ≥32 bytes, base64. Signs session JWTs (HS256). |
| `WHAL_MASTER_KEY` | yes | 32 bytes, base64. Encrypts `secrets.enc` (ChaCha20-Poly1305). Keep it off the data disk in production. |
| `WHAL_OPERATOR_TOKEN_HASH` | yes | scrypt hash of the operator token, from `npm run server:keys`. The token itself is never stored. |
| `WHAL_ENGINE_MODE` | no | `simulated` (default) or `bridge` (real engine connects to `/internal/engine`). |
| `WHAL_ENGINE_BRIDGE_TOKEN` | bridge | ≥32 chars. The engine sends it as `Authorization: Bearer …`. |
| `WHAL_HOST` / `WHAL_PORT` | no | Default `127.0.0.1:8787`. Binding elsewhere without an allowlist logs a warning. |
| `WHAL_IP_ALLOWLIST` | no | Comma-separated IPs/CIDRs, e.g. `127.0.0.1/32,10.8.0.0/24`. Empty = any. Applies to REST, WS and the engine bridge. |
| `WHAL_CORS_ORIGINS` | no | Allowed browser origins. Default `http://localhost:3000`. Other origins can't call mutating routes or open the WS. |
| `WHAL_TRUST_PROXY` | no | `1` to take the client IP from `X-Forwarded-For` (only behind your own reverse proxy). |
| `WHAL_DATA_DIR` | no | Default `.data/` (SQLite DB + `secrets.enc`). |
| `WHAL_JWT_TTL_SEC` | no | Session length, default 12 h. |

## REST API

All routes except `/api/auth/login` and `/api/health` need `Authorization: Bearer <jwt>`.
Errors are `{ "error": "...", "fields"?: { "<path>": "<message>" } }`.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/login` | `{ token }` → `{ token: jwt, expiresAt }`. 5 attempts per IP, refills 1 per 12 s. |
| POST | `/api/auth/logout` | Revokes the current JWT. |
| GET | `/api/health` | No auth. `{ ok, engineSource, uptimeSec }`. |
| GET | `/api/state` | Snapshot for the UI (engine, chain, balances, feed, positions, KOLs, landers, treasury, config). |
| GET | `/api/config` | `{ version, config, secrets: {id: {set, updatedAt}}, pendingRestart, nonces }`. Never secret values. |
| GET | `/api/config/schema` | JSON Schema of the config. |
| PUT | `/api/config` | `{ baseVersion, config }`. 400 with `fields` on invalid, 409 if `baseVersion` is stale. Applies hot fields live through the engine; restart-only paths go to `pendingRestart`. |
| PUT / DELETE | `/api/secrets/:id` | `{ value }`. Write-only. `wallets.hot_wallet_keypair` is refused (403): host-only. |
| GET / POST | `/api/kols` | POST `{ label, pubkey, quote, triggerMargin, buySizeSol, maxCurveReserveSol, enabled }`. 409 on duplicate pubkey. |
| PATCH / DELETE | `/api/kols/:id` | Partial update / remove. |
| POST | `/api/engine/control` | `{ action: start | pause | shadow_mode | emergency_kill_switch, reason? }`. After a kill only `pause` (re-arm) is accepted. |
| GET | `/api/positions` | `{ open, closed }`. |
| POST | `/api/positions/:mint/sell` | `{ pct: 15 | 25 | 33 | 50 | 100 }`. |
| GET | `/api/bursts` | `?limit=50&cursor=…&outcome=filled|missed|expired|shadow|sold&kol=<id>&kind=buys|sells|all` → `{ items, nextCursor }`. Each item has slot, fan-out, winning lander, winning tx signature, CU, revert breakdown. |
| GET | `/api/treasury` | Balances, SPL / Token-2022 inventory, rent stats, USDC sweep log. |
| GET / POST | `/api/nonces` | POST `{ action: create | topup | advance | check, count?, pubkey? }`. `create` records new accounts as a new config version. |
| GET | `/api/audit` | `?limit=100&before=<id>`. Logins (incl. failures), config changes with diffs, secret set/clear (id only), KOL changes, engine control, manual sells, nonce actions, breaker trips. |

## WebSocket `/ws/telemetry`

Open the socket, then send `{"type":"auth","token":"<jwt>"}` within 5 s (the token never goes in a URL).
The server answers `{"type":"ready","engineSource":"simulated"|"bridge"}` and streams events (see `lib/telemetry.ts`):

`slot_tick`, `kol_shred_detected`, `burst_dispatched`, `tx_landed`, `position_updated`, `sweep_executed`,
`circuit_breaker_tripped`, plus state-sync events `engine_status`, `kols_updated`, `landers_updated`,
`session_updated`, `treasury_updated`, `config_updated`.

Optional: `{"type":"subscribe","events":["slot_tick","tx_landed"]}`, `{"type":"ping"}`.
Slow clients drop high-rate events (`slot_tick`, `landers_updated`, `session_updated`) instead of buffering.
Close codes: `4401` auth, `4429` too many messages.

## Circuit breakers

The control plane pauses the engine and emits `circuit_breaker_tripped` when:

* gas + tip burn in the rolling hour exceeds `landers.max_hourly_burn_sol`;
* the hot wallet holds more than `wallets.max_hot_wallet_sol`;
* the engine bridge disconnects.

A tripped breaker stays latched until an operator presses Run again (audited as `breaker.reset`).

## Engine bridge (for the Rust engine)

The engine connects to `ws://<host>/internal/engine` with `Authorization: Bearer $WHAL_ENGINE_BRIDGE_TOKEN`:

```
engine -> cp   {"type":"snapshot","runtime":{...EngineRuntime}}            once, after connecting
engine -> cp   {"type":"event","event":{...TelemetryEvent | {type:"nonces"}}}
engine -> cp   {"type":"ack","id":"b1","ok":true,"result":{...}}
cp -> engine   {"type":"command","id":"b1","command":{...EngineCommand}}
```

Types: `server/engine/types.ts`, `lib/telemetry.ts`. On (re)connect the control plane pushes the current config
version and the KOL rules. Secrets are read by the engine from the same `secrets.enc`
(`engine/whal-config/src/secrets.rs`), never sent over the bridge.

## Tests

```
npm run test:server
```

13 integration tests against a real HTTP/WS server with the simulated engine: auth and JWT revocation,
config validation/conflict/hot-vs-restart, secrets never returned or stored in plaintext, KOL CRUD,
engine control and kill/re-arm rules, manual sells, burst pagination, treasury/nonces, WS auth and origin
checks, the burn circuit breaker, login rate limiting and the IP allowlist.

## Notes

* Built on Node's `http` rather than Fastify so it runs with two runtime dependencies (`ws`, `zod`).
  Routes are plain `{ method, path, auth, limit, handler }` objects; porting to Fastify is mechanical.
* SQLite (WAL) is enough for one operator and one engine. For Postgres, replace `server/db.ts`; nothing
  else touches SQL.
