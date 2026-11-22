//! Automated Exit Ladder, Lighthouse Assertions, and Position Manager (`/engine/src/exits`).

pub mod builder;
pub mod lighthouse;
pub mod manager;

pub use builder::{build_protected_sell_instructions, SellTxParams};
pub use lighthouse::{
    assert_clock_slot_lte, assert_pumpfun_liquidity_floor, assert_sell_dedupe_balance,
    sell_dedupe_min_balance, LIGHTHOUSE_ERR_ASSERTION_FAILED, LIGHTHOUSE_PROGRAM_ID,
};
pub use manager::{ExitEngine, ExitOrder, ExitPolicy, LadderStep, LadderTrigger, ManagedPosition};
