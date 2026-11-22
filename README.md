# Whal Bot · Operator terminal

Frontend for the Whal Bot engine: Next.js (App Router) + TypeScript + Tailwind CSS v4.
The UI talks to the control plane (`server/`) over REST + WebSocket. Until the Rust engine connects over the bridge, the control plane runs a **simulated engine**: nothing signs, sends or reads on-chain data, and the UI labels it SIMULATED ENGINE.

## Run

```
npm install
npm run server:keys > server/.env.local   # shows the operator token once; save it
npm run server                            # control plane on http://127.0.0.1:8787 (simulated engine)
npm run dev                               # UI on http://localhost:3000, sign in with the operator token
```

Requires Node 22.13+. UI-only preview without a backend: `NEXT_PUBLIC_WHAL_MOCK=1 npm run dev`.
Control plane details: [server/README.md](server/README.md).

## Pages

| Route | Panel |
|---|---|
| `/` | Live feed (shred events, bursts, revert breakdown) + active positions with 25/50/100% panic sell |
| `/watchlist` | KOL wallets: label, pubkey, quote asset, trigger margin, buy size, max curve reserve, enable, win rate, PnL |
| `/execution` | Lander matrix (win share, land rate, slot Δ, tips, revert cost) + revert causes |
| `/treasury` | Balances, WSOL→USDC sweeps, SPL / Token-2022 inventory, rent reclaim |
| `/settings` | Engine config: 6 tabs, live validation, diff preview, save with hot reload, write-only secrets, JSON import/export |

The top status bar is on every page: engine pill (RUNNING / PAUSED / SHADOW MODE, KILLED), emergency kill switch
(also **Shift+K**) with confirmation, slot, ShredStream latency, nonce pool, ring buffer, SOL / WSOL / USDC / portfolio.

## Structure

```
app/                     routes, layout, loading/error/not-found
components/shell/        AppShell (rail, mobile nav, toasts, connection banner), StatusBar (engine, kill switch, metrics)
components/ui.tsx        Card, Badge, Button, Toggle, Segmented, Field, Input, Modal, Skeleton, EmptyState, Th/Td
components/icons.ts      Lucide icons (single import point)
features/*               one folder per page
lib/types.ts             domain + wire protocol (ServerMessage / ClientCommand)
lib/store.tsx            socket connection, reducer, reconnect with backoff, commands with acks, toasts
lib/mock/server.ts       MOCK backend + WebSocket-shaped MockSocket (fictional names, random addresses)
```

## Configuration (Step 2)

| Piece | Where |
|---|---|
| Zod schema, defaults, secret ids, restart-required paths, diff, import/export | `lib/config/schema.ts` |
| JSON Schema (generated) | `config/bot-config.schema.json` (`npm run config:schema`) |
| Rust serde structs, validation, encrypted secret store, hot reload | `engine/whal-config` |
| Settings UI | `features/settings/*` |
| Tests | `npm test` (`lib/config/schema.test.ts`), `cargo test` in `engine/whal-config` |

- **Hot reload:** every field applies on the next detection except those tagged *Restart*
  (RPC/Geyser/ShredStream endpoints, commitment, hot wallet, signer, WSOL vault, lander endpoints, tx version).
  Those are saved immediately and listed in a "Restart needed" banner until the engine restarts.
- **Saving:** edits are validated as you type; **Review & save** shows a per-field diff marked Live / Restart.
  Saves carry the config version they were based on; if the engine's config changed meanwhile the save is refused.
- **Secrets:** API tokens are write-only in the UI (Set / Replace / Clear; the page shows only "Set · 3d ago").
  The control plane and engine encrypt them with ChaCha20-Poly1305 under `WHAL_MASTER_KEY` (32 bytes, base64) in `secrets.enc`.
  The **hot wallet signer key is never accepted from the browser**: import it on the engine host
  (`whal-engine secrets import-keypair <path>`) or use a remote signer.
- **URLs never carry credentials:** URLs with `api-key`, `token`, user:pass etc. are rejected; use the matching secret.
- **Import/export:** Export writes the saved config without any secret. Import validates the file, drops any
  secret-looking keys (with a warning) and loads it as unsaved changes for review.

## Engine bridge

The real engine connects to the control plane at `/internal/engine`; see server/README.md. Keys and signing stay on the engine host; the browser never sees private keys.
