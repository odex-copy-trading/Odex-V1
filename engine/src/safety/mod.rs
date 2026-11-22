//! Shadow mode simulation, hard safety circuit breakers, and durable nonce health monitoring.

pub mod breakers;
pub mod nonce_monitor;
pub mod shadow;

pub use breakers::{CircuitBreakerTrip, HardSafetyLimits, SafetyCircuitBreakers};
pub use nonce_monitor::{
    evaluate_nonce_health, NonceActionNeeded, NonceHealthMonitor, NonceStatusSnapshot,
    NONCE_MIN_BALANCE_LAMPORTS, NONCE_TARGET_BALANCE_LAMPORTS,
};
pub use shadow::{ShadowMetricsSnapshot, ShadowSimulator, SimulationOutcome};
