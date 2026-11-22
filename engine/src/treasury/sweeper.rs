//! Automated 30-second WSOL -> USDC Treasury Sweeper.
//!
//! Whenever the WSOL vault balance exceeds `threshold + clip_size` (default clip = `20.0 WSOL`),
//! fetches a Jupiter V6 quote (preferring low-CU AMMs like ZeroFi) and executes a low-fee
//! `20 WSOL -> USDC` swap to lock in trading profits automatically.

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use serde::Serialize;
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::executor::{sign_serialized_tx_base64, HotWalletSigner};
use crate::ingest::{BalanceCache, PubkeyBytes};
use super::jupiter::{JupiterV6Client, DEFAULT_JUPITER_V6_URL};

pub const LAMPORTS_PER_SOL: u64 = 1_000_000_000;
pub const DEFAULT_SWEEP_CLIP_LAMPORTS: u64 = 20 * LAMPORTS_PER_SOL;
pub const DEFAULT_POLL_INTERVAL_SECS: u64 = 30;

#[derive(Debug, Clone)]
pub struct SweeperConfig {
    pub enabled: bool,
    pub wsol_vault_ata: PubkeyBytes,
    pub hot_wallet_bs58: String,
    /// Minimum WSOL to retain in the trading vault before sweeping.
    pub threshold_lamports: u64,
    /// Fixed clip size swept per swap (default 20.0 WSOL).
    pub clip_lamports: u64,
    /// Poll interval in seconds (default 30s).
    pub poll_interval_secs: u64,
    pub slippage_bps: u16,
    pub max_priority_fee_lamports: u64,
    pub jupiter_url: String,
    pub rpc_url: String,
    pub preferred_dexes: Vec<String>,
}

impl Default for SweeperConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            wsol_vault_ata: [0u8; 32],
            hot_wallet_bs58: String::new(),
            threshold_lamports: 100 * LAMPORTS_PER_SOL,
            clip_lamports: DEFAULT_SWEEP_CLIP_LAMPORTS,
            poll_interval_secs: DEFAULT_POLL_INTERVAL_SECS,
            slippage_bps: 30,
            max_priority_fee_lamports: 15_000,
            jupiter_url: DEFAULT_JUPITER_V6_URL.to_string(),
            rpc_url: "https://api.mainnet-beta.solana.com".to_string(),
            preferred_dexes: vec!["ZeroFi".to_string()],
        }
    }
}

/// Telemetry record matching Step 3's `Sweep` / `sweep_executed` schema.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SweepRecord {
    pub id: String,
    pub ts: u64,
    pub slot: u64,
    pub wsol_in: f64,
    pub usdc_out: f64,
    pub route: String,
    pub status: &'static str,
}

/// Returns `true` when the WSOL vault balance exceeds `threshold + clip_size`.
#[inline]
pub fn should_sweep(wsol_balance_lamports: u64, threshold_lamports: u64, clip_lamports: u64) -> bool {
    clip_lamports > 0 && wsol_balance_lamports >= threshold_lamports.saturating_add(clip_lamports)
}

pub struct TreasurySweeper {
    cfg: SweeperConfig,
    balances: BalanceCache,
    jupiter: JupiterV6Client,
    http: reqwest::Client,
    signer: Option<Arc<HotWalletSigner>>,
    telemetry_tx: mpsc::Sender<SweepRecord>,
}

impl TreasurySweeper {
    pub fn new(
        cfg: SweeperConfig,
        balances: BalanceCache,
        telemetry_tx: mpsc::Sender<SweepRecord>,
    ) -> Self {
        Self::with_signer(cfg, balances, telemetry_tx, None)
    }

    pub fn with_signer(
        cfg: SweeperConfig,
        balances: BalanceCache,
        telemetry_tx: mpsc::Sender<SweepRecord>,
        signer: Option<Arc<HotWalletSigner>>,
    ) -> Self {
        let jupiter = JupiterV6Client::new(cfg.jupiter_url.clone(), cfg.preferred_dexes.clone());
        Self {
            cfg,
            balances,
            jupiter,
            http: reqwest::Client::new(),
            signer,
            telemetry_tx,
        }
    }

    /// Spawns the background 30-second treasury sweep loop.
    pub fn spawn(self: Arc<Self>) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let interval = Duration::from_secs(self.cfg.poll_interval_secs.max(5));
            let mut ticker = tokio::time::interval(interval);
            info!(
                poll_secs = interval.as_secs(),
                clip_wsol = self.cfg.clip_lamports as f64 / LAMPORTS_PER_SOL as f64,
                "TreasurySweeper background task started"
            );
            loop {
                ticker.tick().await;
                if !self.cfg.enabled {
                    continue;
                }
                if let Err(e) = self.check_and_sweep_once(0).await {
                    warn!(error = %e, "Treasury sweep attempt failed");
                }
            }
        })
    }

    /// Performs a single WSOL vault check and executes a `clip_lamports` WSOL -> USDC swap if eligible.
    pub async fn check_and_sweep_once(&self, current_slot: u64) -> Result<Option<SweepRecord>, reqwest::Error> {
        let wsol_balance = self.balances.get(&self.cfg.wsol_vault_ata).unwrap_or(0);
        if !should_sweep(wsol_balance, self.cfg.threshold_lamports, self.cfg.clip_lamports) {
            return Ok(None);
        }

        let (quote, route) = self
            .jupiter
            .quote_wsol_to_usdc(self.cfg.clip_lamports, self.cfg.slippage_bps)
            .await?;

        let swap = self
            .jupiter
            .build_swap_tx(
                &quote,
                &self.cfg.hot_wallet_bs58,
                self.cfg.max_priority_fee_lamports,
            )
            .await?;

        let mut status: &'static str = "confirmed";
        if let Some(signer) = &self.signer {
            match sign_serialized_tx_base64(&swap.swap_transaction, signer) {
                Ok((signed_b64, sig)) => {
                    let payload = serde_json::json!({
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "sendTransaction",
                        "params": [signed_b64, { "encoding": "base64", "skipPreflight": false, "maxRetries": 2 }]
                    });
                    match self.http.post(&self.cfg.rpc_url).json(&payload).send().await {
                        Ok(resp) if resp.status().is_success() => {
                            info!(signature = %sig, "Submitted signed Jupiter WSOL -> USDC sweep tx");
                        }
                        Ok(resp) => {
                            warn!(status = %resp.status(), "Sweep RPC submission returned non-200");
                            status = "failed";
                        }
                        Err(e) => {
                            warn!(error = %e, "Sweep RPC submission failed");
                            status = "failed";
                        }
                    }
                }
                Err(e) => {
                    warn!(error = %e, "Failed to sign Jupiter swap transaction");
                    status = "failed";
                }
            }
        } else {
            warn!("TreasurySweeper has no HotWalletSigner; skipping on-chain submission");
            status = "simulated";
        }

        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let usdc_out = quote.out_amount.parse::<u64>().unwrap_or(0) as f64 / 1_000_000.0;
        let record = SweepRecord {
            id: format!("sw_{:x}", ts),
            ts,
            slot: current_slot,
            wsol_in: self.cfg.clip_lamports as f64 / LAMPORTS_PER_SOL as f64,
            usdc_out,
            route,
            status,
        };
        let _ = self.telemetry_tx.try_send(record.clone());
        info!(wsol_in = record.wsol_in, usdc_out = record.usdc_out, route = %record.route, "Executed WSOL -> USDC treasury sweep");
        Ok(Some(record))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sweeps_only_when_balance_exceeds_threshold_plus_clip() {
        let threshold = 100 * LAMPORTS_PER_SOL;
        let clip = 20 * LAMPORTS_PER_SOL;
        assert!(!should_sweep(119 * LAMPORTS_PER_SOL, threshold, clip));
        assert!(should_sweep(120 * LAMPORTS_PER_SOL, threshold, clip));
        assert!(should_sweep(186 * LAMPORTS_PER_SOL, threshold, clip));
    }

    #[test]
    fn jupiter_quote_url_prefers_zerofi() {
        let jup = JupiterV6Client::new(DEFAULT_JUPITER_V6_URL, vec!["ZeroFi".into()]);
        let url = jup.build_quote_url(DEFAULT_SWEEP_CLIP_LAMPORTS, 30, true);
        assert!(url.contains("dexes=ZeroFi"));
        assert!(url.contains("amount=20000000000"));
        assert!(url.contains("onlyDirectRoutes=true"));
    }
}
