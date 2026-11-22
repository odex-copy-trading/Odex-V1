# `whal-router` — KOL Balance-Delta Guard & Buy Router

Minimal, `no_std`, zero-allocation Solana program built with **Pinocchio** (`no_allocator!`, stack-only CPI).

## Modes

### Mode A — Standalone Guard (`op = 0x01`, target `< 200 CU`)
- **Accounts**: `[0]` `watched_account` (read-only: KOL wallet or SPL/Token-2022 token account).
- **Data (15 bytes)**: `[op=0x01 (1B) | mode_flags (1B: bit0 = SPL offset 64 vs lamports) | reserved (5B) | threshold (u64 LE, 8B)]`.
- Aborts with `Custom(1)` if `current_balance >= threshold`, otherwise returns `Ok(())`.

### Mode B — Multi-KOL Guard + CPI Buy Router (`op = 0x02`, target `< 700 CU` on abort)
- **Accounts**:
  - `[0]` `target_program` (Pump.fun, PumpSwap, or Raydium LaunchLab)
  - `[1]` `pool_reserve_account`
  - `[2 .. total - N]` forwarded CPI accounts (up to 24, stack-allocated)
  - `[total - N .. total]` `N` trailing read-only KOL accounts (`1..=8`)
- **Data (`47 + 8*N` bytes)**:
  - `venue` (`0` = Pump.fun `BuyExactQuoteInV3`, `1` = PumpSwap `Buy`, `2` = Raydium LaunchLab `BuyExactIn`)
  - `kol_count` (`1..=8`), `kol_flags` (bitmask for SPL vs SOL), `reserve_flags`, `reserve_offset`, `min_reserve`, `max_reserve`, `base_buy`, `max_buy`, `min_tokens_out`, and `N` × `u64` LE thresholds.
- **Checks & Execution**:
  1. Verifies at least one watched KOL has `current_balance < threshold[i]` (else `Custom(1)`).
  2. Verifies pool quote reserve is within `[min_reserve, max_reserve]` (else `Custom(2)`).
  3. Dynamically sizes buy within `[base_buy, max_buy]` and executes stack-allocated CPI (`slice_invoke`).

## Build & Test

```bash
cd programs/whal-router

# Native unit tests
cargo test --lib

# SBF build + LiteSVM integration & CU tests
cargo build-sbf
cargo test --test litesvm -- --nocapture
```
