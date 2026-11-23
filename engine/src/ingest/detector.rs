//! Sub-millisecond Trigger Detectors:
//! 1. KOL Buy Detector (Pump.fun, PumpSwap, Raydium LaunchLab)
//! 2. 0-Block Launch Detector (Pump.fun CreateV2 & Raydium LaunchLab Initialize)

use std::sync::RwLock;
use std::time::{SystemTime, UNIX_EPOCH};

use super::state::{BalanceCache, WatchlistCache};
use super::types::{
    compute_opportunity_key, DecodedInstruction, DecodedTx, LaunchFilterConfig, PubkeyBytes,
    StrategyId, TriggerEvent, TriggerKind, Venue, WSOL_MINT,
};

/// Program IDs (32-byte raw keys).
/// Pump.fun (`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`)
pub const PUMPFUN_PROGRAM_ID: PubkeyBytes = [
    0x01, 0x56, 0xe0, 0xf6, 0x93, 0x66, 0x5a, 0xcf,
    0x44, 0xdb, 0x15, 0x68, 0xbf, 0x17, 0x5b, 0xaa,
    0x51, 0x89, 0xcb, 0x97, 0xf5, 0xd2, 0xff, 0x3b,
    0x65, 0x5d, 0x2b, 0xb6, 0xfd, 0x6d, 0x18, 0xb0,
];

/// PumpSwap AMM (`pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`)
pub const PUMPSWAP_PROGRAM_ID: PubkeyBytes = [
    0x0c, 0x14, 0xde, 0xfc, 0x82, 0x5e, 0xc6, 0x76,
    0x94, 0x25, 0x08, 0x18, 0xbb, 0x65, 0x40, 0x65,
    0xf4, 0x29, 0x8d, 0x31, 0x56, 0xd5, 0x71, 0xb4,
    0xd4, 0xf8, 0x09, 0x0c, 0x18, 0xe9, 0xa8, 0x63,
];

/// Raydium LaunchLab (`LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj`)
pub const LAUNCHLAB_PROGRAM_ID: PubkeyBytes = [
    0x04, 0x67, 0x9c, 0x35, 0x2f, 0x14, 0x59, 0x72,
    0xa1, 0x92, 0x83, 0x74, 0x65, 0x56, 0x47, 0x38,
    0x29, 0x1a, 0x0b, 0xfc, 0xed, 0xde, 0xcf, 0xb0,
    0xa1, 0x92, 0x83, 0x74, 0x65, 0x56, 0x47, 0x01,
];

/// 8-byte Anchor discriminators for buy and launch instructions.
pub const DISC_PUMPFUN_BUY: [u8; 8] = [0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea];
pub const DISC_PUMPFUN_BUY_EXACT_QUOTE_V3: [u8; 8] = [0xc6, 0x2e, 0x15, 0x52, 0xb4, 0xd9, 0xe8, 0x70];
pub const DISC_PUMPFUN_CREATE_V2: [u8; 8] = [0x18, 0x1e, 0xc8, 0x28, 0x05, 0x1c, 0x07, 0x77];
pub const DISC_PUMPFUN_CREATE_V2_TOKEN2022: [u8; 8] = [0xd6, 0x90, 0x4c, 0xec, 0x5f, 0x8b, 0x31, 0xb4];
pub const DISC_PUMPSWAP_BUY: [u8; 8] = [0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea];
pub const DISC_LAUNCHLAB_BUY_EXACT_IN: [u8; 8] = [0xfa, 0xea, 0x0d, 0x7b, 0xd5, 0x9c, 0x13, 0xec];
pub const DISC_LAUNCHLAB_INITIALIZE: [u8; 8] = [0xaf, 0xaf, 0x6d, 0x1f, 0x0d, 0x98, 0x9b, 0xed];

#[inline]
fn now_us() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros() as u64)
        .unwrap_or(0)
}

#[inline]
fn read_u64(data: &[u8], off: usize) -> Option<u64> {
    Some(u64::from_le_bytes(data.get(off..off + 8)?.try_into().ok()?))
}

fn read_borsh_string(data: &[u8], off: &mut usize) -> Option<String> {
    let len = u32::from_le_bytes(data.get(*off..*off + 4)?.try_into().ok()?) as usize;
    *off += 4;
    if len > 256 || *off + len > data.len() {
        return None;
    }
    let s = core::str::from_utf8(&data[*off..*off + len]).ok()?.to_string();
    *off += len;
    Some(s)
}

struct ParsedBuy {
    venue: Venue,
    mint: PubkeyBytes,
    quote_mint: PubkeyBytes,
    pool_pda: PubkeyBytes,
    estimated_spend: u64,
    ix_accounts: Vec<PubkeyBytes>,
}

struct ParsedLaunch {
    venue: Venue,
    strategy_id: StrategyId,
    mint: PubkeyBytes,
    quote_mint: PubkeyBytes,
    pool_pda: PubkeyBytes,
    creator: PubkeyBytes,
    name: String,
    symbol: String,
    uri: String,
    ix_accounts: Vec<PubkeyBytes>,
}

fn parse_buy_ix(ix: &DecodedInstruction) -> Option<ParsedBuy> {
    let disc: [u8; 8] = ix.data.get(0..8)?.try_into().ok()?;
    if ix.program_id == PUMPFUN_PROGRAM_ID
        && (disc == DISC_PUMPFUN_BUY || disc == DISC_PUMPFUN_BUY_EXACT_QUOTE_V3)
    {
        // Pump.fun buy account layout: [global, fee_recipient, mint(2), bonding_curve(3), ...]
        let mint = *ix.accounts.get(2)?;
        let pool_pda = *ix.accounts.get(3)?;
        let estimated_spend = if disc == DISC_PUMPFUN_BUY_EXACT_QUOTE_V3 {
            read_u64(&ix.data, 8)?
        } else {
            // Legacy buy(amount, max_sol_cost)
            read_u64(&ix.data, 16)?
        };
        return Some(ParsedBuy {
            venue: Venue::PumpFun,
            mint,
            quote_mint: WSOL_MINT,
            pool_pda,
            estimated_spend,
            ix_accounts: ix.accounts.clone(),
        });
    }

    if ix.program_id == PUMPSWAP_PROGRAM_ID && disc == DISC_PUMPSWAP_BUY {
        // PumpSwap buy layout: [pool(0), user(1), global_config(2), base_mint(3), quote_mint(4), ...]
        let pool_pda = *ix.accounts.get(0)?;
        let mint = *ix.accounts.get(3)?;
        let quote_mint = *ix.accounts.get(4)?;
        let estimated_spend = read_u64(&ix.data, 16)?;
        return Some(ParsedBuy {
            venue: Venue::PumpSwap,
            mint,
            quote_mint,
            pool_pda,
            estimated_spend,
            ix_accounts: ix.accounts.clone(),
        });
    }

    if ix.program_id == LAUNCHLAB_PROGRAM_ID && disc == DISC_LAUNCHLAB_BUY_EXACT_IN {
        // Raydium LaunchLab BuyExactIn: [payer(0), auth(1), cfg(2), platform(3), pool_state(4), ..., base_mint(9), quote_mint(10)]
        let pool_pda = *ix.accounts.get(4)?;
        let mint = *ix.accounts.get(9)?;
        let quote_mint = *ix.accounts.get(10)?;
        let estimated_spend = read_u64(&ix.data, 8)?;
        return Some(ParsedBuy {
            venue: Venue::RaydiumLaunchLab,
            mint,
            quote_mint,
            pool_pda,
            estimated_spend,
            ix_accounts: ix.accounts.clone(),
        });
    }

    None
}

fn parse_launch_ix(ix: &DecodedInstruction) -> Option<ParsedLaunch> {
    let disc: [u8; 8] = ix.data.get(0..8)?.try_into().ok()?;
    if ix.program_id == PUMPFUN_PROGRAM_ID
        && (disc == DISC_PUMPFUN_CREATE_V2 || disc == DISC_PUMPFUN_CREATE_V2_TOKEN2022)
    {
        // Pump.fun CreateV2: [mint(0), mint_auth(1), bonding_curve(2), ..., user/creator(7)]
        let mint = *ix.accounts.get(0)?;
        let pool_pda = *ix.accounts.get(2)?;
        let creator = *ix.accounts.get(7).or_else(|| ix.accounts.last())?;
        let mut off = 8;
        let name = read_borsh_string(&ix.data, &mut off).unwrap_or_default();
        let symbol = read_borsh_string(&ix.data, &mut off).unwrap_or_default();
        let uri = read_borsh_string(&ix.data, &mut off).unwrap_or_default();
        return Some(ParsedLaunch {
            venue: Venue::PumpFun,
            strategy_id: StrategyId::PumpFunCreateV2Snipe,
            mint,
            quote_mint: WSOL_MINT,
            pool_pda,
            creator,
            name,
            symbol,
            uri,
            ix_accounts: ix.accounts.clone(),
        });
    }

    if ix.program_id == LAUNCHLAB_PROGRAM_ID && disc == DISC_LAUNCHLAB_INITIALIZE {
        // Raydium LaunchLab Initialize: [payer/creator(0), ..., pool_state(4), base_mint(6), quote_mint(7)]
        let creator = *ix.accounts.get(0)?;
        let pool_pda = *ix.accounts.get(4)?;
        let mint = *ix.accounts.get(6)?;
        let quote_mint = *ix.accounts.get(7)?;
        let mut off = 8;
        let name = read_borsh_string(&ix.data, &mut off).unwrap_or_default();
        let symbol = read_borsh_string(&ix.data, &mut off).unwrap_or_default();
        let uri = read_borsh_string(&ix.data, &mut off).unwrap_or_default();
        return Some(ParsedLaunch {
            venue: Venue::RaydiumLaunchLab,
            strategy_id: StrategyId::LaunchLabInitSnipe,
            mint,
            quote_mint,
            pool_pda,
            creator,
            name,
            symbol,
            uri,
            ix_accounts: ix.accounts.clone(),
        });
    }

    None
}

/// High-speed signal detector operating directly on decoded ShredStream transactions.
pub struct SignalDetector {
    watchlist: WatchlistCache,
    balances: BalanceCache,
    launch_filter: RwLock<LaunchFilterConfig>,
}

impl SignalDetector {
    pub fn new(
        watchlist: WatchlistCache,
        balances: BalanceCache,
        launch_filter: LaunchFilterConfig,
    ) -> Self {
        Self {
            watchlist,
            balances,
            launch_filter: RwLock::new(launch_filter),
        }
    }

    pub fn update_launch_filter(&self, next: LaunchFilterConfig) {
        if let Ok(mut guard) = self.launch_filter.write() {
            *guard = next;
        }
    }

    /// Inspects a decoded ShredStream transaction and returns all matching `TriggerEvent`s.
    pub fn inspect_tx(&self, tx: &DecodedTx) -> Vec<TriggerEvent> {
        let mut out = Vec::new();
        let detected_at_us = now_us();

        // 1. KOL Buy Detector: check if any tx signer is on the active KOL watchlist.
        let matched_kol = tx.signers.iter().find_map(|s| self.watchlist.match_signer(s));
        if let Some(kol) = matched_kol {
            for ix in &tx.instructions {
                if let Some(buy) = parse_buy_ix(ix) {
                    let watched_account = kol.quote_token_account.unwrap_or(kol.pubkey);
                    let pre_balance = self.balances.get(&watched_account).unwrap_or(0);
                    let balance_threshold = pre_balance.saturating_sub(kol.margin_lamports);
                    let strategy_id = if buy.quote_mint != WSOL_MINT {
                        StrategyId::GenericQuoteSnipe
                    } else {
                        StrategyId::KolBackrun
                    };
                    let opportunity_key = compute_opportunity_key(&buy.mint, tx.slot, strategy_id);
                    out.push(TriggerEvent {
                        opportunity_key,
                        strategy_id,
                        trigger_slot: tx.slot,
                        detected_at_us,
                        venue: buy.venue,
                        mint: buy.mint,
                        quote_mint: buy.quote_mint,
                        pool_pda: buy.pool_pda,
                        dex_accounts: buy.ix_accounts,
                        kind: TriggerKind::KolBuy {
                            kol_id: kol.id.clone(),
                            kol_wallet: kol.pubkey,
                            watched_balance_account: watched_account,
                            is_spl_quote: kol.is_spl_quote,
                            pre_balance,
                            balance_threshold,
                            estimated_kol_spend: buy.estimated_spend,
                            buy_size_lamports: kol.buy_size_lamports,
                            max_curve_reserve_lamports: kol.max_curve_reserve_lamports,
                        },
                    });
                }
            }
        }

        // 2. 0-Block Launch Detector (Pump.fun CreateV2 / Raydium LaunchLab Initialize).
        let filter = self
            .launch_filter
            .read()
            .map(|g| g.clone())
            .unwrap_or_default();
        if filter.enabled {
            // Check if a bundled dev buy accompanies the launch instruction in the same tx.
            let bundled_buys: Vec<ParsedBuy> = tx
                .instructions
                .iter()
                .filter_map(parse_buy_ix)
                .collect();
            let bundled_dev_buy: u64 = bundled_buys.iter().map(|b| b.estimated_spend).sum();
            let bundled_buy_accounts = bundled_buys
                .first()
                .map(|b| b.ix_accounts.clone())
                .unwrap_or_default();

            for ix in &tx.instructions {
                if let Some(launch) = parse_launch_ix(ix) {
                    if !self.matches_launch_filter(&launch, bundled_dev_buy, &filter) {
                        continue;
                    }
                    let opportunity_key =
                        compute_opportunity_key(&launch.mint, tx.slot, launch.strategy_id);
                    let dex_accounts = if !bundled_buy_accounts.is_empty() {
                        bundled_buy_accounts.clone()
                    } else {
                        launch.ix_accounts
                    };
                    out.push(TriggerEvent {
                        opportunity_key,
                        strategy_id: launch.strategy_id,
                        trigger_slot: tx.slot,
                        detected_at_us,
                        venue: launch.venue,
                        mint: launch.mint,
                        quote_mint: launch.quote_mint,
                        pool_pda: launch.pool_pda,
                        dex_accounts,
                        kind: TriggerKind::ZeroBlockLaunch {
                            creator: launch.creator,
                            dev_buy_lamports: bundled_dev_buy,
                            name: launch.name,
                            symbol: launch.symbol,
                            uri: launch.uri,
                        },
                    });
                }
            }
        }

        out
    }

    fn matches_launch_filter(
        &self,
        launch: &ParsedLaunch,
        dev_buy: u64,
        filter: &LaunchFilterConfig,
    ) -> bool {
        if dev_buy < filter.min_dev_buy_lamports || dev_buy > filter.max_dev_buy_lamports {
            return false;
        }
        if !filter.allowed_quote_mints.is_empty()
            && !filter.allowed_quote_mints.contains(&launch.quote_mint)
        {
            return false;
        }
        if filter.require_metadata_uri && launch.uri.trim().is_empty() {
            return false;
        }
        let hay = format!("{} {}", launch.name, launch.symbol).to_ascii_lowercase();
        for kw in &filter.blocked_keywords {
            if !kw.is_empty() && hay.contains(&kw.to_ascii_lowercase()) {
                return false;
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingest::bus::OpportunityBus;
    use crate::ingest::types::KolRule;
    use std::time::Instant;

    fn encode_borsh_str(out: &mut Vec<u8>, s: &str) {
        out.extend_from_slice(&(s.len() as u32).to_le_bytes());
        out.extend_from_slice(s.as_bytes());
    }

    #[test]
    fn detects_kol_pumpfun_buy_and_computes_threshold_and_key() {
        let watchlist = WatchlistCache::new();
        let balances = BalanceCache::new();
        let kol_pk = [0x11; 32];
        let mint = [0x22; 32];
        let curve = [0x33; 32];

        watchlist.upsert(KolRule {
            id: "kol_1".into(),
            label: "Harpoon".into(),
            pubkey: kol_pk,
            quote_token_account: None,
            is_spl_quote: false,
            margin_lamports: 20_000_000, // 0.02 SOL
            buy_size_lamports: 3_000_000_000,
            max_curve_reserve_lamports: 85_000_000_000,
            enabled: true,
        });
        balances.set(kol_pk, 10_000_000_000); // 10 SOL pre-slot balance

        let mut ix_data = Vec::new();
        ix_data.extend_from_slice(&DISC_PUMPFUN_BUY_EXACT_QUOTE_V3);
        ix_data.extend_from_slice(&3_000_000_000u64.to_le_bytes()); // 3 SOL spend
        ix_data.extend_from_slice(&1_000u64.to_le_bytes());

        let tx = DecodedTx {
            slot: 383_000_500,
            received_at_us: 0,
            signature: [0u8; 64],
            signers: vec![kol_pk],
            instructions: vec![DecodedInstruction {
                program_id: PUMPFUN_PROGRAM_ID,
                accounts: vec![[0; 32], [0; 32], mint, curve],
                data: ix_data,
            }],
        };

        let detector = SignalDetector::new(watchlist, balances, LaunchFilterConfig::default());
        let bus = OpportunityBus::new(64);
        let mut rx = bus.subscribe();

        let start = Instant::now();
        let events = detector.inspect_tx(&tx);
        assert_eq!(events.len(), 1);
        bus.publish(events[0].clone());
        let received = rx.try_recv().unwrap();
        let elapsed_us = start.elapsed().as_micros();

        assert!(elapsed_us < 2_000, "Detection + publish took {}us (>= 2ms)", elapsed_us);
        assert_eq!(
            received.opportunity_key,
            compute_opportunity_key(&mint, 383_000_500, StrategyId::KolBackrun)
        );
        match received.kind {
            TriggerKind::KolBuy {
                pre_balance,
                balance_threshold,
                estimated_kol_spend,
                ..
            } => {
                assert_eq!(pre_balance, 10_000_000_000);
                assert_eq!(balance_threshold, 9_980_000_000);
                assert_eq!(estimated_kol_spend, 3_000_000_000);
            }
            _ => panic!("expected KolBuy"),
        }
    }

    #[test]
    fn detects_zero_block_pumpfun_create_v2_with_dev_buy_filter() {
        let watchlist = WatchlistCache::new();
        let balances = BalanceCache::new();
        let mut filter = LaunchFilterConfig::default();
        filter.min_dev_buy_lamports = 500_000_000;
        filter.blocked_keywords = vec!["rug".into()];
        let detector = SignalDetector::new(watchlist, balances, filter);

        let mint = [0x44; 32];
        let curve = [0x55; 32];
        let creator = [0x66; 32];

        let mut create_data = Vec::new();
        create_data.extend_from_slice(&DISC_PUMPFUN_CREATE_V2);
        encode_borsh_str(&mut create_data, "Orca Fin");
        encode_borsh_str(&mut create_data, "ORCA");
        encode_borsh_str(&mut create_data, "https://meta.example/orca.json");

        let mut dev_buy_data = Vec::new();
        dev_buy_data.extend_from_slice(&DISC_PUMPFUN_BUY_EXACT_QUOTE_V3);
        dev_buy_data.extend_from_slice(&1_500_000_000u64.to_le_bytes());
        dev_buy_data.extend_from_slice(&1u64.to_le_bytes());

        let tx = DecodedTx {
            slot: 383_000_999,
            received_at_us: 0,
            signature: [0u8; 64],
            signers: vec![creator],
            instructions: vec![
                DecodedInstruction {
                    program_id: PUMPFUN_PROGRAM_ID,
                    accounts: vec![mint, [0; 32], curve, [0; 32], [0; 32], [0; 32], [0; 32], creator],
                    data: create_data,
                },
                DecodedInstruction {
                    program_id: PUMPFUN_PROGRAM_ID,
                    accounts: vec![[0; 32], [0; 32], mint, curve],
                    data: dev_buy_data,
                },
            ],
        };

        let events = detector.inspect_tx(&tx);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].strategy_id, StrategyId::PumpFunCreateV2Snipe);
        match &events[0].kind {
            TriggerKind::ZeroBlockLaunch { symbol, dev_buy_lamports, .. } => {
                assert_eq!(symbol, "ORCA");
                assert_eq!(*dev_buy_lamports, 1_500_000_000);
            }
            _ => panic!("expected ZeroBlockLaunch"),
        }
    }
}
