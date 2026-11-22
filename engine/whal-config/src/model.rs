//! Config model. Field names and nesting match the JSON produced by the frontend exactly.
//! `deny_unknown_fields` everywhere: an unknown key is a typo or a smuggled secret.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const CONFIG_VERSION: u32 = 1;
pub type Pubkey = String; // base58, checked in validate.rs

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BotConfig {
    pub version: u32,
    pub network: Network,
    pub wallets: Wallets,
    pub strategy: Strategy,
    pub landers: Landers,
    pub exits: Exits,
    pub treasury: Treasury,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Commitment { Processed, Confirmed, Finalized }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Network {
    pub rpc_primary_url: String,
    pub rpc_backup_urls: Vec<String>,
    pub geyser_grpc_url: String,
    pub shredstream_url: String,
    pub commitment: Commitment,
    pub slot_clock_offset_ms: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignerSource { EncryptedKeystore, RemoteSigner }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Wallets {
    pub hot_wallet_pubkey: Pubkey,
    pub signer_source: SignerSource,
    pub wsol_vault_ata: Pubkey,
    pub nonce_accounts: Vec<Pubkey>,
    pub nonce_auto_create: bool,
    pub nonce_target_pool_size: u32,
    pub nonce_health_check_secs: u32,
    pub nonce_min_balance_sol: f64,
    pub max_hot_wallet_sol: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Modes {
    pub kol_backrun: bool,
    pub pumpfun_create_snipe: bool,
    pub generic_quote_snipe: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SlotRange { pub min: u32, pub max: u32 }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Strategy {
    pub modes: Modes,
    pub default_buy_sol: f64,
    pub min_buy_sol: f64,
    pub max_buy_sol: f64,
    pub max_curve_reserve_sol: f64,
    pub slippage_bps: u32,
    pub default_kol_margin_sol: f64,
    pub buy_slot_ttl: SlotRange,
    pub generic_quote_mints: Vec<Pubkey>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LanderId { Jito, Nozomi, Stellium, Landx, Bloom, Astralane, Glaive, Fastlanes, Tpu }

impl LanderId {
    pub const ALL: [LanderId; 9] = [
        Self::Jito, Self::Nozomi, Self::Stellium, Self::Landx, Self::Bloom,
        Self::Astralane, Self::Glaive, Self::Fastlanes, Self::Tpu,
    ];
    pub fn key(self) -> &'static str {
        match self {
            Self::Jito => "jito", Self::Nozomi => "nozomi", Self::Stellium => "stellium", Self::Landx => "landx",
            Self::Bloom => "bloom", Self::Astralane => "astralane", Self::Glaive => "glaive",
            Self::Fastlanes => "fastlanes", Self::Tpu => "tpu",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Provider {
    pub enabled: bool,
    pub endpoint_url: String,
    pub tip_accounts: Vec<Pubkey>,
    pub min_tip_sol: f64,
    pub max_tip_sol: f64,
    pub fanout: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TxVersion { V1, V0, Legacy }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TxConfig {
    pub version: TxVersion,
    pub compute_unit_limit: u32,
    pub loaded_accounts_data_size_limit: u32,
    pub priority_fee_lamports: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Landers {
    /// Keyed by LanderId; all seven must be present.
    pub providers: BTreeMap<LanderId, Provider>,
    pub tx: TxConfig,
    pub max_hourly_burn_sol: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum LadderTrigger {
    PnlMultiple(f64),
    TimeSecs(u32),
}

// The frontend writes `{ "kind": "pnl_multiple", "value": 2 }`, which is serde's adjacently tagged form.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LadderStep { pub sell_pct: f64, pub trigger: LadderTrigger }

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CurveFloor { pub enabled: bool, pub min_real_sol_reserves_sol: f64 }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Exits {
    pub instant_tp_pct: f64,
    pub ladder: Vec<LadderStep>,
    pub stop_loss_pct: Option<f64>,
    pub trailing_stop_pct: Option<f64>,
    pub curve_floor: CurveFloor,
    pub sell_slot_ttl: SlotRange,
    pub auto_close_account: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SweepRoute { JupiterV6 }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Treasury {
    pub sweep_enabled: bool,
    pub trigger_wsol_threshold: f64,
    pub clip_wsol: f64,
    pub target_mint: Pubkey,
    pub route: SweepRoute,
    pub slippage_bps: u32,
    pub max_priority_fee_lamports: u64,
}

/// Secret ids known to the engine. Values live only in the encrypted [`crate::SecretStore`].
pub fn secret_ids() -> Vec<String> {
    let mut v = vec![
        "network.rpc_api_key".to_string(),
        "network.geyser_token".to_string(),
        "network.shredstream_token".to_string(),
        "wallets.hot_wallet_keypair".to_string(),
    ];
    for id in LanderId::ALL { if id != LanderId::Tpu { v.push(format!("landers.{}.auth_token", id.key())); } }
    v
}

/// Secrets the API may accept from the UI. The signer key is CLI-only.
pub fn ui_settable_secret(id: &str) -> bool {
    id != "wallets.hot_wallet_keypair" && secret_ids().iter().any(|s| s == id)
}
