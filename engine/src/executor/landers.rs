//! Multi-Lander Concurrent SWQoS Fan-Out Engine.
//!
//! Spawns parallel async tasks submitting distinct-signature transaction variants
//! (varying durable nonce, tip account, and priority fee/tip) across all enabled
//! SWQoS providers: Jito, Temporal/Nozomi, Stellium, LandX, Bloom/BlockRazor, Astralane, Glaive, Speed/FastLanes, Direct TPU.

use std::sync::Arc;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use tokio::task::JoinSet;
use tracing::{debug, info};

use crate::ingest::{PubkeyBytes, TriggerEvent, TriggerKind, Venue};
use super::builder::{
    BuildVariantParams, BuiltTransaction, TxBuilder, TxVersion, V1TransactionConfig,
    TOKEN_2022_PROGRAM_ID,
};
use super::nonce::NoncePool;
use super::wire::{serialize_and_sign_tx, HotWalletSigner};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LanderId {
    Jito,
    Nozomi,
    Stellium,
    Landx,
    Bloom,
    Astralane,
    Glaive,
    Fastlanes,
    Tpu,
}

#[derive(Debug, Clone)]
pub struct LanderConfig {
    pub id: LanderId,
    pub enabled: bool,
    pub endpoint_url: String,
    pub auth_token: Option<String>,
    pub tip_accounts: Vec<PubkeyBytes>,
    pub min_tip_lamports: u64,
    pub max_tip_lamports: u64,
    pub fanout: usize,
}

#[derive(Debug, Clone)]
pub struct VariantDispatch {
    pub lander: LanderId,
    pub variant_idx: usize,
    pub endpoint_url: String,
    pub auth_token: Option<String>,
    pub tip_lamports: u64,
    pub tx: BuiltTransaction,
}

#[derive(Debug, Clone)]
pub struct VariantSubmitResult {
    pub lander: LanderId,
    pub variant_idx: usize,
    pub accepted: bool,
    pub signature: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct BurstDispatchSummary {
    pub slot: u64,
    pub total_sent: usize,
    pub accepted: usize,
    pub winner: Option<LanderId>,
    pub winning_signature: Option<String>,
    pub results: Vec<VariantSubmitResult>,
}

pub struct LanderFanOut {
    builder: Arc<TxBuilder>,
    nonces: NoncePool,
    http: reqwest::Client,
    signer: Option<Arc<HotWalletSigner>>,
    recent_blockhash: Arc<std::sync::RwLock<[u8; 32]>>,
}

impl LanderFanOut {
    pub fn new(builder: Arc<TxBuilder>, nonces: NoncePool) -> Self {
        Self::with_signer(builder, nonces, None)
    }

    pub fn with_signer(
        builder: Arc<TxBuilder>,
        nonces: NoncePool,
        signer: Option<Arc<HotWalletSigner>>,
    ) -> Self {
        let http = reqwest::Client::builder()
            .tcp_nodelay(true)
            .pool_max_idle_per_host(32)
            .build()
            .unwrap_or_default();
        Self {
            builder,
            nonces,
            http,
            signer,
            recent_blockhash: Arc::new(std::sync::RwLock::new([0u8; 32])),
        }
    }

    pub fn set_recent_blockhash(&self, hash: [u8; 32]) {
        if let Ok(mut g) = self.recent_blockhash.write() {
            *g = hash;
        }
    }

    fn resolve_nonce_or_blockhash(&self, idx: usize) -> Option<(PubkeyBytes, [u8; 32])> {
        if let Some(n) = self.nonces.next_ready() {
            return Some((n.pubkey, n.nonce_hash));
        }
        if idx > 0 {
            return None;
        }
        let bh = self.recent_blockhash.read().map(|g| *g).unwrap_or([0u8; 32]);
        if bh != [0u8; 32] {
            Some(([0u8; 32], bh))
        } else {
            None
        }
    }

    pub fn nonce_pool(&self) -> NoncePool {
        self.nonces.clone()
    }

    pub fn programs(&self) -> &super::builder::ProgramIds {
        self.builder.programs()
    }

    /// Generates distinct-signature Lighthouse-protected sell variants across all enabled SWQoS providers.
    #[allow(clippy::too_many_arguments)]
    pub fn build_sell_variants(
        &self,
        sell_ixs: &[super::builder::InstructionSpec],
        landers: &[LanderConfig],
        hot_wallet: PubkeyBytes,
        bot_token_account: PubkeyBytes,
        version: TxVersion,
        base_v1_cfg: V1TransactionConfig,
        lookup_tables: &[PubkeyBytes],
    ) -> Vec<VariantDispatch> {
        let mut variants = Vec::new();
        for lander in landers {
            if !lander.enabled || lander.fanout == 0 {
                continue;
            }
            for idx in 0..lander.fanout {
                let Some((nonce_pubkey, nonce_hash)) = self.resolve_nonce_or_blockhash(idx) else {
                    break;
                };
                let tip_account = if lander.tip_accounts.is_empty() {
                    hot_wallet
                } else {
                    lander.tip_accounts[idx % lander.tip_accounts.len()]
                };
                let tip_span = lander.max_tip_lamports.saturating_sub(lander.min_tip_lamports);
                let tip_step = if lander.fanout > 1 {
                    (tip_span * idx as u64) / (lander.fanout as u64 - 1)
                } else {
                    0
                };
                let tip_lamports = lander.min_tip_lamports.saturating_add(tip_step);

                let mut v1_cfg = base_v1_cfg;
                v1_cfg.priority_fee_lamports = v1_cfg
                    .priority_fee_lamports
                    .saturating_add((idx as u64) * 1_000);

                let tx = self.builder.build_sell_tx(
                    sell_ixs.to_vec(),
                    hot_wallet,
                    bot_token_account,
                    nonce_pubkey,
                    nonce_hash,
                    tip_account,
                    tip_lamports,
                    version,
                    v1_cfg,
                    lookup_tables,
                );
                variants.push(VariantDispatch {
                    lander: lander.id,
                    variant_idx: idx,
                    endpoint_url: lander.endpoint_url.clone(),
                    auth_token: lander.auth_token.clone(),
                    tip_lamports,
                    tx,
                });
            }
        }
        variants
    }

    /// Generates distinct-signature variants across all enabled SWQoS providers.
    pub fn build_variants(
        &self,
        trigger: &TriggerEvent,
        landers: &[LanderConfig],
        hot_wallet: PubkeyBytes,
        version: TxVersion,
        base_v1_cfg: V1TransactionConfig,
        lookup_tables: &[PubkeyBytes],
        buy_slot_ttl: u64,
    ) -> Vec<VariantDispatch> {
        let mut variants = Vec::new();
        for lander in landers {
            if !lander.enabled || lander.fanout == 0 {
                continue;
            }
            for idx in 0..lander.fanout {
                let Some((nonce_pubkey, nonce_hash)) = self.resolve_nonce_or_blockhash(idx) else {
                    break;
                };
                let tip_account = if lander.tip_accounts.is_empty() {
                    hot_wallet
                } else {
                    lander.tip_accounts[idx % lander.tip_accounts.len()]
                };
                let tip_span = lander.max_tip_lamports.saturating_sub(lander.min_tip_lamports);
                let tip_step = if lander.fanout > 1 {
                    (tip_span * idx as u64) / (lander.fanout as u64 - 1)
                } else {
                    0
                };
                let tip_lamports = lander.min_tip_lamports.saturating_add(tip_step);

                // Vary priority fee slightly per variant so signatures are guaranteed distinct.
                let mut v1_cfg = base_v1_cfg;
                v1_cfg.priority_fee_lamports = v1_cfg
                    .priority_fee_lamports
                    .saturating_add((idx as u64) * 1_000);

                let is_token_2022_mint = trigger.dex_accounts.contains(&TOKEN_2022_PROGRAM_ID);
                let use_standalone_guard_for_pumpswap = trigger.venue == Venue::PumpSwap;
                // Safe slippage floor: for Pump.fun 0-block launches (known initial 30 SOL / 1.073B curve),
                // compute AMM min_tokens_out with a 12% slippage tolerance; otherwise keep 1 so valid KOL fills never falsely revert.
                let min_tokens_out = match (&trigger.venue, &trigger.kind) {
                    (Venue::PumpFun, TriggerKind::ZeroBlockLaunch { dev_buy_lamports, .. }) => {
                        let base_v_sol: u128 = 30_000_000_000u128.saturating_add(*dev_buy_lamports as u128);
                        let base_v_tok: u128 = 1_073_000_000_000_000u128; // 1.073B tokens (6 decimals)
                        let buy_lamports: u128 = 500_000_000; // conservative 0.5 SOL floor reference
                        let est_out = (base_v_tok.saturating_mul(buy_lamports)) / base_v_sol.saturating_add(buy_lamports);
                        ((est_out * 88) / 100).max(1) as u64
                    }
                    _ => 1,
                };

                let params = BuildVariantParams {
                    version,
                    v1_config: v1_cfg,
                    lookup_tables: lookup_tables.to_vec(),
                    hot_wallet,
                    nonce_account: nonce_pubkey,
                    nonce_hash,
                    tip_account,
                    tip_lamports,
                    buy_slot_ttl,
                    is_token_2022_mint,
                    use_standalone_guard_for_pumpswap,
                    min_tokens_out,
                };
                let tx = self.builder.build_buy_tx(trigger, &params);
                variants.push(VariantDispatch {
                    lander: lander.id,
                    variant_idx: idx,
                    endpoint_url: lander.endpoint_url.clone(),
                    auth_token: lander.auth_token.clone(),
                    tip_lamports,
                    tx,
                });
            }
        }
        variants
    }

    /// Concurrently fans out all prepared transaction variants across every enabled SWQoS provider.
    pub async fn fan_out(&self, slot: u64, variants: Vec<VariantDispatch>, shadow_mode: bool) -> BurstDispatchSummary {
        let total_sent = variants.len();
        if shadow_mode {
            info!(slot, total_sent, "Shadow mode: burst simulated, nothing transmitted");
            return BurstDispatchSummary {
                slot,
                total_sent,
                accepted: 0,
                winner: None,
                winning_signature: None,
                results: Vec::new(),
            };
        }

        let mut set = JoinSet::new();
        for v in variants {
            let client = self.http.clone();
            let signer = self.signer.clone();
            set.spawn(async move { submit_variant(client, signer, v).await });
        }

        let mut results = Vec::with_capacity(total_sent);
        let mut winner = None;
        let mut winning_signature = None;
        let mut accepted = 0usize;

        while let Some(joined) = set.join_next().await {
            if let Ok(res) = joined {
                if res.accepted {
                    accepted += 1;
                    if winner.is_none() {
                        winner = Some(res.lander);
                        winning_signature = res.signature.clone();
                    }
                }
                results.push(res);
            }
        }

        BurstDispatchSummary {
            slot,
            total_sent,
            accepted,
            winner,
            winning_signature,
            results,
        }
    }
}

async fn submit_variant(
    client: reqwest::Client,
    signer: Option<Arc<HotWalletSigner>>,
    v: VariantDispatch,
) -> VariantSubmitResult {
    let Some(signer) = signer else {
        return VariantSubmitResult {
            lander: v.lander,
            variant_idx: v.variant_idx,
            accepted: false,
            signature: None,
            error: Some("HotWalletSigner not configured (set WHAL_HOT_WALLET_KEYPAIR)".into()),
        };
    };

    let (wire_bytes, computed_sig) = serialize_and_sign_tx(&v.tx, &signer);
    let encoded_tx = BASE64.encode(&wire_bytes);

    debug!(
        lander = ?v.lander,
        variant = v.variant_idx,
        tip = v.tip_lamports,
        sig = %computed_sig,
        bytes = wire_bytes.len(),
        endpoint = %v.endpoint_url,
        "Submitting signed SWQoS variant"
    );

    let payload = serde_json::json!({
        "jsonrpc": "2.0",
        "id": v.variant_idx + 1,
        "method": "sendTransaction",
        "params": [
            encoded_tx,
            { "encoding": "base64", "skipPreflight": true, "maxRetries": 0 }
        ]
    });

    let mut req = client.post(&v.endpoint_url).json(&payload);
    if let Some(tok) = &v.auth_token {
        if !tok.is_empty() {
            req = req
                .header("Authorization", format!("Bearer {tok}"))
                .header("x-api-key", tok.as_str());
        }
    }

    match req.send().await {
        Ok(resp) if resp.status().is_success() => {
            let body = resp.json::<serde_json::Value>().await.ok();
            let rpc_err = body
                .as_ref()
                .and_then(|j| j.get("error"))
                .map(|e| e.to_string());
            if let Some(err) = rpc_err {
                return VariantSubmitResult {
                    lander: v.lander,
                    variant_idx: v.variant_idx,
                    accepted: false,
                    signature: Some(computed_sig),
                    error: Some(err),
                };
            }
            let sig = body
                .as_ref()
                .and_then(|j| j.get("result").and_then(|r| r.as_str()).map(ToOwned::to_owned))
                .or(Some(computed_sig));
            VariantSubmitResult {
                lander: v.lander,
                variant_idx: v.variant_idx,
                accepted: true,
                signature: sig,
                error: None,
            }
        }
        Ok(resp) => VariantSubmitResult {
            lander: v.lander,
            variant_idx: v.variant_idx,
            accepted: false,
            signature: Some(computed_sig),
            error: Some(format!("HTTP {}", resp.status())),
        },
        Err(e) => VariantSubmitResult {
            lander: v.lander,
            variant_idx: v.variant_idx,
            accepted: false,
            signature: Some(computed_sig),
            error: Some(e.to_string()),
        },
    }
}
