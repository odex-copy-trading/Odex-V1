//! Hard Safety Circuit Breakers enforced in the Rust engine hot path.
//!
//! These limits are enforced directly inside the Rust engine before any transaction is
//! signed or broadcast, and CANNOT be bypassed by the browser UI or control plane.

use std::collections::VecDeque;
use std::sync::{
    atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
    Mutex,
};
use serde::Serialize;

#[derive(Debug, Clone)]
pub struct HardSafetyLimits {
    /// Rolling 1-hour max gas + tip spend cap in lamports (auto-pause if breached).
    pub max_hourly_burn_lamports: u64,
    /// Max consecutive failed buys / slippage reverts before auto-pause.
    pub max_consecutive_failures: u32,
    /// Hard ceiling on a single buy transaction in lamports.
    pub max_single_tx_buy_lamports: u64,
    /// Hard ceiling on total simultaneous open SOL exposure in lamports.
    pub max_open_exposure_lamports: u64,
}

impl Default for HardSafetyLimits {
    fn default() -> Self {
        Self {
            max_hourly_burn_lamports: 2_000_000_000,   // 2.0 SOL / hour
            max_consecutive_failures: 8,
            max_single_tx_buy_lamports: 10_000_000_000, // 10.0 SOL / tx
            max_open_exposure_lamports: 50_000_000_000, // 50.0 SOL open
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "breaker", rename_all = "snake_case")]
pub enum CircuitBreakerTrip {
    HourlyBurnCap {
        rolling_burn_lamports: u64,
        cap_lamports: u64,
    },
    ConsecutiveFailures {
        count: u32,
        limit: u32,
    },
    SingleTxBuyCap {
        requested_lamports: u64,
        cap_lamports: u64,
    },
    OpenExposureCap {
        projected_lamports: u64,
        cap_lamports: u64,
    },
}

pub struct SafetyCircuitBreakers {
    limits: HardSafetyLimits,
    tripped: AtomicBool,
    consecutive_failures: AtomicU32,
    open_exposure_lamports: AtomicU64,
    burn_window: Mutex<VecDeque<(u64, u64)>>, // (unix_ts_secs, lamports)
}

impl SafetyCircuitBreakers {
    pub fn new(limits: HardSafetyLimits) -> Self {
        Self {
            limits,
            tripped: AtomicBool::new(false),
            consecutive_failures: AtomicU32::new(0),
            open_exposure_lamports: AtomicU64::new(0),
            burn_window: Mutex::new(VecDeque::with_capacity(512)),
        }
    }

    pub fn is_tripped(&self) -> bool {
        self.tripped.load(Ordering::Acquire)
    }

    /// Operator re-arm after inspecting the incident.
    pub fn reset(&self) {
        self.consecutive_failures.store(0, Ordering::Release);
        self.tripped.store(false, Ordering::Release);
    }

    /// Pre-trade hard check enforced before any buy transaction is dispatched.
    pub fn check_pre_buy(&self, buy_lamports: u64) -> Result<(), CircuitBreakerTrip> {
        if buy_lamports > self.limits.max_single_tx_buy_lamports {
            return Err(CircuitBreakerTrip::SingleTxBuyCap {
                requested_lamports: buy_lamports,
                cap_lamports: self.limits.max_single_tx_buy_lamports,
            });
        }
        let current = self.open_exposure_lamports.load(Ordering::Acquire);
        let projected = current.saturating_add(buy_lamports);
        if projected > self.limits.max_open_exposure_lamports {
            return Err(CircuitBreakerTrip::OpenExposureCap {
                projected_lamports: projected,
                cap_lamports: self.limits.max_open_exposure_lamports,
            });
        }
        Ok(())
    }

    /// Records a gas + tip spend event; trips and auto-pauses if the rolling 1-hour cap is breached.
    pub fn record_burn(&self, now_secs: u64, lamports: u64) -> Result<u64, CircuitBreakerTrip> {
        let mut q = self.burn_window.lock().expect("burn window lock");
        let cutoff = now_secs.saturating_sub(3_600);
        while let Some(&(ts, _)) = q.front() {
            if ts < cutoff {
                q.pop_front();
            } else {
                break;
            }
        }
        q.push_back((now_secs, lamports));
        let total: u64 = q.iter().map(|&(_, l)| l).sum();
        if total > self.limits.max_hourly_burn_lamports {
            self.tripped.store(true, Ordering::Release);
            return Err(CircuitBreakerTrip::HourlyBurnCap {
                rolling_burn_lamports: total,
                cap_lamports: self.limits.max_hourly_burn_lamports,
            });
        }
        Ok(total)
    }

    /// Records a buy outcome. Consecutive failures/slippage errors trip the breaker at the limit.
    pub fn record_buy_outcome(&self, succeeded: bool, filled_lamports: u64) -> Result<(), CircuitBreakerTrip> {
        if succeeded {
            self.consecutive_failures.store(0, Ordering::Release);
            self.open_exposure_lamports
                .fetch_add(filled_lamports, Ordering::AcqRel);
            return Ok(());
        }
        let count = self.consecutive_failures.fetch_add(1, Ordering::AcqRel) + 1;
        if count >= self.limits.max_consecutive_failures {
            self.tripped.store(true, Ordering::Release);
            return Err(CircuitBreakerTrip::ConsecutiveFailures {
                count,
                limit: self.limits.max_consecutive_failures,
            });
        }
        Ok(())
    }

    pub fn release_exposure(&self, lamports: u64) {
        let _ = self.open_exposure_lamports.fetch_update(
            Ordering::AcqRel,
            Ordering::Acquire,
            |cur| Some(cur.saturating_sub(lamports)),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enforces_all_hard_circuit_breakers() {
        let cb = SafetyCircuitBreakers::new(HardSafetyLimits {
            max_hourly_burn_lamports: 1_000_000,
            max_consecutive_failures: 3,
            max_single_tx_buy_lamports: 5_000_000_000,
            max_open_exposure_lamports: 8_000_000_000,
        });

        // Single-tx cap
        assert!(matches!(
            cb.check_pre_buy(6_000_000_000),
            Err(CircuitBreakerTrip::SingleTxBuyCap { .. })
        ));

        // Open exposure cap
        cb.record_buy_outcome(true, 5_000_000_000).unwrap();
        assert!(matches!(
            cb.check_pre_buy(4_000_000_000),
            Err(CircuitBreakerTrip::OpenExposureCap { .. })
        ));
        cb.release_exposure(5_000_000_000);
        assert!(cb.check_pre_buy(4_000_000_000).is_ok());

        // Consecutive failures trip
        assert!(cb.record_buy_outcome(false, 0).is_ok());
        assert!(cb.record_buy_outcome(false, 0).is_ok());
        assert!(matches!(
            cb.record_buy_outcome(false, 0),
            Err(CircuitBreakerTrip::ConsecutiveFailures { count: 3, limit: 3 })
        ));
        assert!(cb.is_tripped());
        cb.reset();

        // Hourly burn cap trips
        assert_eq!(cb.record_burn(1000, 600_000).unwrap(), 600_000);
        assert!(matches!(
            cb.record_burn(1010, 500_000),
            Err(CircuitBreakerTrip::HourlyBurnCap { rolling_burn_lamports: 1_100_000, .. })
        ));
        assert!(cb.is_tripped());
    }
}
