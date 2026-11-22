//! Shadow Mode (Dry-Run) RPC `simulateTransaction` harness.
//!
//! Runs the live ShredStream -> KOL Detector -> Tx Builder pipeline on mainnet,
//! simulating every built transaction via RPC `simulateTransaction` instead of
//! broadcasting, and tracking virtual PnL and guard hit rates for the UI.

use std::sync::atomic::{AtomicU64, Ordering};
use serde::Serialize;

use crate::executor::BuiltTransaction;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowMetricsSnapshot {
    pub simulated_total: u64,
    pub simulated_fills: u64,
    pub guard_kol_not_landed: u64,
    pub guard_duplicate: u64,
    pub guard_timed_out: u64,
    pub other_errors: u64,
    pub total_cu_simulated: u64,
}

#[derive(Debug, Clone)]
pub struct SimulationOutcome {
    pub ok: bool,
    pub units_consumed: u64,
    pub custom_error: Option<u32>,
    pub logs: Vec<String>,
}

pub struct ShadowSimulator {
    rpc_url: String,
    http: reqwest::Client,
    simulated_total: AtomicU64,
    simulated_fills: AtomicU64,
    guard_kol_not_landed: AtomicU64,
    guard_duplicate: AtomicU64,
    guard_timed_out: AtomicU64,
    other_errors: AtomicU64,
    total_cu_simulated: AtomicU64,
}

impl ShadowSimulator {
    pub fn new(rpc_url: impl Into<String>) -> Self {
        Self {
            rpc_url: rpc_url.into(),
            http: reqwest::Client::new(),
            simulated_total: AtomicU64::new(0),
            simulated_fills: AtomicU64::new(0),
            guard_kol_not_landed: AtomicU64::new(0),
            guard_duplicate: AtomicU64::new(0),
            guard_timed_out: AtomicU64::new(0),
            other_errors: AtomicU64::new(0),
            total_cu_simulated: AtomicU64::new(0),
        }
    }

    /// Simulates a serialized base64 transaction against Solana RPC `simulateTransaction`.
    pub async fn simulate_tx(
        &self,
        _built: &BuiltTransaction,
        tx_base64: &str,
    ) -> Result<SimulationOutcome, reqwest::Error> {
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "simulateTransaction",
            "params": [
                tx_base64,
                {
                    "encoding": "base64",
                    "sigVerify": false,
                    "replaceRecentBlockhash": false,
                    "commitment": "processed"
                }
            ]
        });
        let resp: serde_json::Value = self
            .http
            .post(&self.rpc_url)
            .json(&body)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;

        let val = &resp["result"]["value"];
        let units = val["unitsConsumed"].as_u64().unwrap_or(0);
        let err = &val["err"];
        let logs = val["logs"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(ToOwned::to_owned)).collect())
            .unwrap_or_default();

        let custom_error = err
            .get("InstructionError")
            .and_then(|arr| arr.get(1))
            .and_then(|obj| obj.get("Custom"))
            .and_then(|c| c.as_u64())
            .map(|c| c as u32);

        let outcome = SimulationOutcome {
            ok: err.is_null(),
            units_consumed: units,
            custom_error,
            logs,
        };
        self.record_outcome(&outcome);
        Ok(outcome)
    }

    pub fn record_outcome(&self, outcome: &SimulationOutcome) {
        self.simulated_total.fetch_add(1, Ordering::Relaxed);
        self.total_cu_simulated
            .fetch_add(outcome.units_consumed, Ordering::Relaxed);
        if outcome.ok {
            self.simulated_fills.fetch_add(1, Ordering::Relaxed);
        } else {
            match outcome.custom_error {
                Some(1) => { self.guard_kol_not_landed.fetch_add(1, Ordering::Relaxed); }
                Some(2) => { self.guard_timed_out.fetch_add(1, Ordering::Relaxed); }
                Some(0) => { self.guard_duplicate.fetch_add(1, Ordering::Relaxed); }
                _ => { self.other_errors.fetch_add(1, Ordering::Relaxed); }
            }
        }
    }

    pub fn snapshot(&self) -> ShadowMetricsSnapshot {
        ShadowMetricsSnapshot {
            simulated_total: self.simulated_total.load(Ordering::Relaxed),
            simulated_fills: self.simulated_fills.load(Ordering::Relaxed),
            guard_kol_not_landed: self.guard_kol_not_landed.load(Ordering::Relaxed),
            guard_duplicate: self.guard_duplicate.load(Ordering::Relaxed),
            guard_timed_out: self.guard_timed_out.load(Ordering::Relaxed),
            other_errors: self.other_errors.load(Ordering::Relaxed),
            total_cu_simulated: self.total_cu_simulated.load(Ordering::Relaxed),
        }
    }
}
