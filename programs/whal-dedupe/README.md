# `whal-dedupe` — Ring-Buffer Dedupe & Slot-TTL Guard

Minimal, `no_std`, zero-allocation Solana program built with **Pinocchio** (no Anchor, no heap allocator, target `< 3,000 CU`).

## State Account Layout (fixed `2,564` bytes)

| Offset | Size | Field |
|---|---|---|
| `0..4` | 4 B | `u32` LE circular write cursor (`0..63`) |
| `4..2564` | 2,560 B | 64 fixed entries × 40 B (`[32 B opportunity_key \| 8 B u64 LE recorded_slot]`) |

## Accounts

| Index | Writable | Signer | Description |
|---|---|---|---|
| `0` | yes | no | `state_account` (owned by this program, exact size 2,564 bytes) |
| `1` | no | yes | `authority` (must match `AUTHORIZED_BOT_PUBKEY`) |

## Instructions

- **`0x00` (`Initialize`, 1 byte)**: Zero-initializes the 2,564-byte state account.
- **`0x01` (`CheckAndLock`, 41 bytes)**:
  - `byte[0]`: `0x01`
  - `bytes[1..33]`: 32-byte `opportunity_key`
  - `bytes[33..41]`: `u64` LE `max_slot`

### Error Codes

| Code | Meaning |
|---|---|
| `Custom(1)` | `Duplicate` — `opportunity_key` already present in the 64-entry ring |
| `Custom(2)` | `TimedOut` — `Clock::get()?.slot > max_slot` |
| `Custom(3)` | `Unauthorized` — signer does not match `AUTHORIZED_BOT_PUBKEY` |

## Build & Test

```bash
cd programs/whal-dedupe

# Native unit tests (core ring-buffer & TTL logic)
cargo test --lib

# SBF build + Mollusk SVM integration & CU tests (< 3,000 CU)
cargo build-sbf
SBF_OUT_DIR=target/deploy cargo test --test mollusk -- --nocapture
```
