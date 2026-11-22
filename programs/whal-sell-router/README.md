# `whal-sell-router` — Percentage-Based On-Chain Sell Router

Minimal, `no_std`, zero-allocation Pinocchio program enabling atomic same-slot **Buy → Percentage Sell** chaining without knowing the exact buy fill quantity off-chain.

## Instruction Data (exact `25` bytes)

| Offset | Size | Field |
|---|---|---|
| `0` | 1 B | `venue_op`: `7` = LaunchLab `SellExactIn`, `9` = Pump.fun `SellV3`, `11` = Raydium CPMM |
| `1..9` | 8 B | `sell_pct` (`u64` LE: `1..=100`) |
| `9..17` | 8 B | `flags` (`u64` LE; `bit0 = 1` closes ephemeral seeded ATA on `sell_pct == 100` to reclaim rent) |
| `17..25` | 8 B | `min_quote_out` (`u64` LE slippage floor) |

## Build & Test

```bash
cd programs/whal-sell-router

# Native unit tests
cargo test --lib

# SBF build + LiteSVM same-slot Buy -> 25% Sell test
cargo build-sbf
cargo test --test litesvm -- --nocapture
```
