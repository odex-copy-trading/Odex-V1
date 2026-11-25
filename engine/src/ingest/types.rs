//! Core domain types for ShredStream/Geyser ingestion and the Opportunity Bus.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Raw 32-byte Solana public key (zero-allocation Copy key for DashMap lookups).
pub type PubkeyBytes = [u8; 32];

/// Native SOL / WSOL mint (`So11111111111111111111111111111111111111112`).
pub const WSOL_MINT: PubkeyBytes = [
    0x06, 0x9b, 0x88, 0x57, 0xfe, 0xab, 0x81, 0x84,
    0xfb, 0x68, 0x7f, 0x63, 0x46, 0x18, 0xc0, 0x35,
    0xda, 0xc4, 0x39, 0xdc, 0x1a, 0xeb, 0x3b, 0x55,
    0x98, 0xa0, 0xf0, 0x00, 0x00, 0x00, 0x00, 0x01,
];

/// Supported DEX venues matching the Step 3 control-plane wire contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Venue {
    #[serde(rename = "Pump.fun")]
    PumpFun,
    #[serde(rename = "PumpSwap")]
    PumpSwap,
    #[serde(rename = "Raydium LaunchLab")]
    RaydiumLaunchLab,
    #[serde(rename = "Raydium CPMM")]
    RaydiumCpmm,
}

/// Strategy identifier mixed into `opportunity_key = sha256(mint || trigger_slot || strategy_id)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[repr(u8)]
pub enum StrategyId {
    KolBackrun = 1,
    PumpFunCreateV2Snipe = 2,
    LaunchLabInitSnipe = 3,
    GenericQuoteSnipe = 4,
}

/// Deterministic 32-byte deduplication key shared with On-Chain Program #1 (`whal-dedupe`).
///
/// `opportunity_key = sha256(mint || trigger_slot_le || strategy_id_u8)`
#[inline]
pub fn compute_opportunity_key(
    mint: &PubkeyBytes,
    trigger_slot: u64,
    strategy_id: StrategyId,
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(mint);
    hasher.update(trigger_slot.to_le_bytes());
    hasher.update([strategy_id as u8]);
    let digest = hasher.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

/// Active KOL watchlist entry synced from the Step 3 `/api/kols` control plane.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KolRule {
    pub id: String,
    pub label: String,
    pub pubkey: PubkeyBytes,
    /// Optional SPL/Token-2022 quote token account tracked in `BalanceCache` when quote != SOL.
    pub quote_token_account: Option<PubkeyBytes>,
    pub is_spl_quote: bool,
    /// Pre-configured drop margin in lamports (or raw quote token base units).
    pub margin_lamports: u64,
    pub buy_size_lamports: u64,
    pub max_curve_reserve_lamports: u64,
    pub enabled: bool,
}

/// Configurable filters for 0-block launch detection (Pump.fun CreateV2 / LaunchLab Initialize).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchFilterConfig {
    pub enabled: bool,
    pub min_dev_buy_lamports: u64,
    pub max_dev_buy_lamports: u64,
    /// Empty means any quote mint is allowed; otherwise the launch quote mint must be listed.
    pub allowed_quote_mints: Vec<PubkeyBytes>,
    /// Optional case-insensitive symbol/name substring denylist (e.g. spam filters).
    pub blocked_keywords: Vec<String>,
    /// Require non-empty metadata URI.
    pub require_metadata_uri: bool,
    /// Bot own buy size in lamports when sniping a 0-block launch (hot-reloaded from strategy.default_buy_sol).
    pub default_buy_lamports: u64,
}

impl Default for LaunchFilterConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            min_dev_buy_lamports: 500_000_000,      // 0.5 SOL (1:1 with Paper Mode)
            max_dev_buy_lamports: 5_000_000_000,    // 5.0 SOL (1:1 with Paper Mode)
            allowed_quote_mints: Vec::new(),
            blocked_keywords: Vec::new(),
            require_metadata_uri: true,
            default_buy_lamports: 50_000_000,       // 0.05 SOL safe default until config.apply syncs
        }
    }
}

/// Lightweight decoded instruction view extracted from a ShredStream transaction.
#[derive(Debug, Clone)]
pub struct DecodedInstruction {
    pub program_id: PubkeyBytes,
    pub accounts: Vec<PubkeyBytes>,
    pub data: Vec<u8>,
}

/// Lightweight decoded transaction reconstructed from raw Jito shreds.
#[derive(Debug, Clone)]
pub struct DecodedTx {
    pub slot: u64,
    pub received_at_us: u64,
    pub signature: [u8; 64],
    pub signers: Vec<PubkeyBytes>,
    pub instructions: Vec<DecodedInstruction>,
}

/// Details specific to either a KOL copy-trade buy or a 0-block token launch.
#[derive(Debug, Clone)]
pub enum TriggerKind {
    KolBuy {
        kol_id: String,
        kol_wallet: PubkeyBytes,
        watched_balance_account: PubkeyBytes,
        is_spl_quote: bool,
        pre_balance: u64,
        /// `pre_balance.saturating_sub(kol.margin_lamports)` passed directly to `whal-router`.
        balance_threshold: u64,
        estimated_kol_spend: u64,
        buy_size_lamports: u64,
        max_curve_reserve_lamports: u64,
    },
    ZeroBlockLaunch {
        creator: PubkeyBytes,
        dev_buy_lamports: u64,
        initial_dev_buy_lamports: u64,
        name: String,
        symbol: String,
        uri: String,
    },
}

/// Strongly-typed opportunity published over the bounded `tokio::sync::broadcast` bus.
#[derive(Debug, Clone)]
pub struct TriggerEvent {
    pub opportunity_key: [u8; 32],
    pub strategy_id: StrategyId,
    pub trigger_slot: u64,
    pub detected_at_us: u64,
    pub venue: Venue,
    pub mint: PubkeyBytes,
    pub quote_mint: PubkeyBytes,
    pub pool_pda: PubkeyBytes,
    /// Full DEX instruction account metas captured directly from the triggering KOL/Dev transaction.
    pub dex_accounts: Vec<PubkeyBytes>,
    pub kind: TriggerKind,
}

/// Helper to encode a 32-byte pubkey as base58 for telemetry and logging.
#[inline]
pub fn pubkey_to_bs58(pk: &PubkeyBytes) -> String {
    bs58::encode(pk).into_string()
}

/// Helper to decode a base58 pubkey string into 32 bytes.
pub fn pubkey_from_bs58(s: &str) -> Result<PubkeyBytes, bs58::decode::Error> {
    let mut out = [0u8; 32];
    let n = bs58::decode(s).onto(&mut out)?;
    if n != 32 {
        return Err(bs58::decode::Error::BufferTooSmall);
    }
    Ok(out)
}
