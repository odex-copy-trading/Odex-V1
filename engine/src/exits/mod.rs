//! Automated Exit Ladder, Lighthouse Assertions, and Position Manager (`/engine/src/exits`).

pub mod builder;
pub mod lighthouse;
pub mod manager;

pub use builder::{build_protected_sell_instructions, SellTxParams};
pub use lighthouse::{
    assert_account_data_u64, assert_account_lamports_lte, assert_clock_slot_lte,
    assert_pumpfun_liquidity_floor, assert_sell_dedupe_balance, sell_dedupe_min_balance,
    LIGHTHOUSE_ERR_ASSERTION_FAILED, LIGHTHOUSE_PROGRAM_ID, OP_LESS_THAN_OR_EQUAL,
    SPL_TOKEN_AMOUNT_OFFSET,
};
pub use manager::{ExitEngine, ExitOrder, ExitPolicy, LadderStep, LadderTrigger, ManagedPosition};
