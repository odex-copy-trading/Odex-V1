//! Automated USDC Treasury Sweeper (`/engine/src/treasury`).

pub mod jupiter;
pub mod sweeper;

pub use jupiter::{
    JupiterQuoteResponse, JupiterSwapResponse, JupiterV6Client, DEFAULT_JUPITER_V6_URL,
    USDC_MINT_STR, WSOL_MINT_STR,
};
pub use sweeper::{
    should_sweep, SweepRecord, SweeperConfig, TreasurySweeper, DEFAULT_POLL_INTERVAL_SECS,
    DEFAULT_SWEEP_CLIP_LAMPORTS,
};
