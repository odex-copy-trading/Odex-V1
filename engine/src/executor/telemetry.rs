//! Execution telemetry payloads matching Step 3's `/internal/engine` (`lib/telemetry.ts`) contract.

use serde::Serialize;

use crate::ingest::Venue;
use super::landers::LanderId;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertBreakdown {
    pub duplicate: u32,
    pub mutex: u32,
    pub kol_not_landed: u32,
    pub slippage: u32,
    pub expired: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BurstFeedPayload {
    pub id: String,
    pub ts: u64,
    pub slot: u64,
    pub kind: &'static str,
    pub kol_id: Option<String>,
    pub mint: String,
    pub symbol: String,
    pub venue: Venue,
    pub size_sol: f64,
    pub fanout: usize,
    pub winner: Option<LanderId>,
    pub signature: Option<String>,
    pub cu_used: u64,
    pub reverts: RevertBreakdown,
    pub outcome: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum ExecutorTelemetryEvent {
    #[serde(rename = "burst_dispatched")]
    BurstDispatched {
        ts: u64,
        burst: BurstFeedPayload,
    },
    #[serde(rename = "tx_landed")]
    TxLanded {
        ts: u64,
        #[serde(rename = "burstId")]
        burst_id: String,
        slot: u64,
        outcome: &'static str,
        lander: Option<LanderId>,
        signature: Option<String>,
    },
}
