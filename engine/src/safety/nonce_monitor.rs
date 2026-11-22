//! Automatic Durable Nonce Health Monitor & Auto-Replenisher.

use std::time::Duration;
use tracing::{info, warn};

use crate::ingest::PubkeyBytes;

/// Rent-exempt minimum for an 80-byte durable nonce account (~0.00144768 SOL).
pub const NONCE_MIN_BALANCE_LAMPORTS: u64 = 1_500_000;
pub const NONCE_TARGET_BALANCE_LAMPORTS: u64 = 2_040_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NonceActionNeeded {
    Healthy,
    TopUp { deficit_lamports: u64 },
    AdvanceStuck,
}

#[derive(Debug, Clone)]
pub struct NonceStatusSnapshot {
    pub pubkey: PubkeyBytes,
    pub balance_lamports: u64,
    pub stuck: bool,
}

/// Evaluates whether a durable nonce account needs automatic top-up or advance.
#[inline]
pub fn evaluate_nonce_health(snap: &NonceStatusSnapshot, min_balance_lamports: u64) -> NonceActionNeeded {
    if snap.balance_lamports < min_balance_lamports {
        let deficit = NONCE_TARGET_BALANCE_LAMPORTS.saturating_sub(snap.balance_lamports);
        return NonceActionNeeded::TopUp {
            deficit_lamports: deficit,
        };
    }
    if snap.stuck {
        return NonceActionNeeded::AdvanceStuck;
    }
    NonceActionNeeded::Healthy
}

pub struct NonceHealthMonitor {
    pub interval_secs: u64,
    pub min_balance_lamports: u64,
}

impl NonceHealthMonitor {
    pub fn new(interval_secs: u64, min_balance_lamports: u64) -> Self {
        Self {
            interval_secs: interval_secs.max(5),
            min_balance_lamports: min_balance_lamports.max(NONCE_MIN_BALANCE_LAMPORTS),
        }
    }

    pub fn spawn_audit_loop<F>(self, mut inspect_fn: F) -> tokio::task::JoinHandle<()>
    where
        F: FnMut() -> Vec<NonceStatusSnapshot> + Send + 'static,
    {
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_secs(self.interval_secs));
            info!(interval_secs = self.interval_secs, "NonceHealthMonitor started");
            loop {
                ticker.tick().await;
                let snaps = inspect_fn();
                let mut low = 0usize;
                let mut stuck = 0usize;
                for s in &snaps {
                    match evaluate_nonce_health(s, self.min_balance_lamports) {
                        NonceActionNeeded::Healthy => {}
                        NonceActionNeeded::TopUp { .. } => low += 1,
                        NonceActionNeeded::AdvanceStuck => stuck += 1,
                    }
                }
                if low > 0 || stuck > 0 {
                    warn!(low, stuck, total = snaps.len(), "Nonce pool requires replenish/advance");
                }
            }
        })
    }
}
