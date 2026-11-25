//! Lighthouse (`L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95`) on-chain assertion builders.
//!
//! Used around every exit sell to guarantee:
//! - Atomic multi-lander sell deduplication (reverts duplicate sells with `Custom(6011)`)
//! - Pump.fun bonding-curve real SOL liquidity floor protection (offset `0x20`)
//! - Post-sell slot-TTL clock guard (`slot <= current_slot + 8`)

use crate::executor::{AccountMetaSpec, InstructionSpec};
use crate::ingest::PubkeyBytes;

/// Lighthouse Program ID (`L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95`).
pub const LIGHTHOUSE_PROGRAM_ID: PubkeyBytes = [
    0x04, 0x05, 0x45, 0x77, 0x5c, 0x56, 0x9b, 0x16,
    0x8e, 0xd8, 0x39, 0x71, 0x4e, 0x1b, 0x7c, 0x0c,
    0x51, 0x62, 0x89, 0x4a, 0x73, 0x2f, 0xe1, 0x8b,
    0x90, 0x3d, 0x22, 0x61, 0x44, 0xaa, 0x55, 0x95,
];

/// Lighthouse custom error code on assertion failure (`AssertionFailed`).
pub const LIGHTHOUSE_ERR_ASSERTION_FAILED: u32 = 6011;

/// Lighthouse instruction discriminators (verified against Jac0xb/lighthouse).
pub const IX_ASSERT_ACCOUNT_DATA: u8 = 2;
pub const IX_ASSERT_CLOCK_SYSVAR: u8 = 15;

/// Lighthouse `DataValueAssertion::U64` + `IntegerOperator` tags.
pub const DATA_TYPE_U64: u8 = 5;
pub const OP_GREATER_THAN: u8 = 2;
pub const OP_GREATER_THAN_OR_EQUAL: u8 = 4;
pub const OP_LESS_THAN_OR_EQUAL: u8 = 5;

/// Account byte offsets.
pub const SPL_TOKEN_AMOUNT_OFFSET: u16 = 0x40;          // 64
pub const PUMPFUN_REAL_SOL_RESERVES_OFFSET: u16 = 0x20; // 32

/// Computes the atomic sell-dedupe floor:
/// `min_balance = floor(pre_balance * (1 - sell_pct / 100)) + 1`.
///
/// Before the first sell lands, `balance == pre_balance >= min_balance` (passes).
/// After the first sell lands, `balance == pre_balance * (1 - sell_pct / 100) < min_balance`,
/// so every duplicate multi-lander sell reverts cleanly with Lighthouse `Custom(6011)`.
#[inline]
pub fn sell_dedupe_min_balance(pre_balance: u64, sell_pct: u64) -> u64 {
    let keep_pct = 100u128.saturating_sub(sell_pct.min(100) as u128);
    let post_balance = ((pre_balance as u128) * keep_pct) / 100u128;
    (post_balance as u64).saturating_add(1)
}

/// Builds a Lighthouse `AssertAccountData` instruction checking a `u64` LE field at `offset`.
pub fn assert_account_data_u64(
    label: &'static str,
    target_account: PubkeyBytes,
    offset: u16,
    operator: u8,
    expected_value: u64,
) -> InstructionSpec {
    // [ix_disc(1) | log_level(1) | offset(u16 LE) | data_type(1) | value(u64 LE) | operator(1)]
    let mut data = Vec::with_capacity(14);
    data.push(IX_ASSERT_ACCOUNT_DATA);
    data.push(0); // LogLevel::Silent (lowest CU)
    data.extend_from_slice(&offset.to_le_bytes());
    data.push(DATA_TYPE_U64);
    data.extend_from_slice(&expected_value.to_le_bytes());
    data.push(operator);

    InstructionSpec {
        label,
        program_id: LIGHTHOUSE_PROGRAM_ID,
        accounts: vec![AccountMetaSpec {
            pubkey: target_account,
            is_signer: false,
            is_writable: false,
        }],
        data,
    }
}

/// Pre-sell assertion: bot token account balance at offset `0x40` >= `pre_balance * (1 - sell_pct/100) + 1`.
pub fn assert_sell_dedupe_balance(
    bot_token_account: PubkeyBytes,
    pre_balance: u64,
    sell_pct: u64,
) -> InstructionSpec {
    let min_bal = sell_dedupe_min_balance(pre_balance, sell_pct);
    assert_account_data_u64(
        "lighthouse_assert_token_balance",
        bot_token_account,
        SPL_TOKEN_AMOUNT_OFFSET,
        OP_GREATER_THAN_OR_EQUAL,
        min_bal,
    )
}

/// Pre-sell Pump.fun assertion: bonding curve `real_sol_reserves` at offset `0x20` > `min_liquidity_floor`.
pub fn assert_pumpfun_liquidity_floor(
    bonding_curve: PubkeyBytes,
    min_liquidity_floor_lamports: u64,
) -> InstructionSpec {
    assert_account_data_u64(
        "lighthouse_assert_pumpfun_liquidity",
        bonding_curve,
        PUMPFUN_REAL_SOL_RESERVES_OFFSET,
        OP_GREATER_THAN,
        min_liquidity_floor_lamports,
    )
}

/// Post-sell assertion: `AssertClockSysvar(slot <= current_slot + max_slot_delta)`.
pub fn assert_clock_slot_lte(max_slot: u64) -> InstructionSpec {
    // [ix_disc(1) | log_level(1) | clock_field=0(slot) | value(u64 LE) | operator(<=)]
    let mut data = Vec::with_capacity(12);
    data.push(IX_ASSERT_CLOCK_SYSVAR);
    data.push(0); // LogLevel::Silent
    data.push(0); // ClockAssertion::Slot
    data.extend_from_slice(&max_slot.to_le_bytes());
    data.push(OP_LESS_THAN_OR_EQUAL);

    InstructionSpec {
        label: "lighthouse_assert_clock_slot",
        program_id: LIGHTHOUSE_PROGRAM_ID,
        accounts: vec![],
        data,
    }
}
