//! Validation rules. Keep in step with lib/config/schema.ts; error paths use the same dotted form
//! (`landers.providers.jito.max_tip_sol`, `wallets.nonce_accounts[3]`) so the UI can map them to fields.

use crate::model::*;
use serde::Serialize;
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FieldError { pub path: String, pub message: String }

struct V(Vec<FieldError>);
impl V {
    fn err(&mut self, path: impl Into<String>, message: impl Into<String>) { self.0.push(FieldError { path: path.into(), message: message.into() }); }
    fn range_f(&mut self, path: &str, v: f64, min: f64, max: f64, unit: &str) {
        if !v.is_finite() || v < min || v > max { self.err(path, format!("Must be between {min} and {max}{unit}")); }
    }
    fn range_u(&mut self, path: &str, v: u64, min: u64, max: u64, unit: &str) {
        if v < min || v > max { self.err(path, format!("Must be between {min} and {max}{unit}")); }
    }
    fn pubkey(&mut self, path: &str, v: &str) {
        match bs58::decode(v.trim()).into_vec() {
            Ok(b) if b.len() == 32 => {}
            _ => self.err(path, "Not a valid Solana public key (base58, 32 bytes)"),
        }
    }
    fn endpoint(&mut self, path: &str, v: &str, schemes: &[&str]) {
        let Ok(u) = url::Url::parse(v.trim()) else { return self.err(path, "Not a valid URL") };
        if !schemes.contains(&u.scheme()) { self.err(path, format!("Scheme must be one of {}", schemes.join(", "))); }
        if !u.username().is_empty() || u.password().is_some() { self.err(path, "Remove credentials from the URL; set them as a secret instead"); }
        for (k, _) in u.query_pairs() {
            let k = k.to_ascii_lowercase();
            if matches!(k.as_str(), "api-key" | "api_key" | "apikey" | "token" | "key" | "secret" | "auth" | "access_token" | "access-token") {
                self.err(path, format!("Remove \"{k}\" from the URL; set it as a secret instead"));
            }
        }
    }
    fn slot_range(&mut self, path: &str, r: SlotRange, max: u32) {
        self.range_u(&format!("{path}.min"), r.min.into(), 0, max.into(), " slots");
        self.range_u(&format!("{path}.max"), r.max.into(), 0, max.into(), " slots");
        if r.min > r.max { self.err(format!("{path}.max"), "Min must be ≤ max"); }
    }
}

const HTTP: &[&str] = &["https", "http"];
const GRPC: &[&str] = &["https", "http", "grpc", "grpcs"];

pub fn validate(c: &BotConfig) -> Result<(), Vec<FieldError>> {
    let mut v = V(Vec::new());
    if c.version != CONFIG_VERSION { v.err("version", format!("Unsupported config version {}", c.version)); }

    // network
    let n = &c.network;
    v.endpoint("network.rpc_primary_url", &n.rpc_primary_url, HTTP);
    if n.rpc_backup_urls.len() > 4 { v.err("network.rpc_backup_urls", "At most 4 backups"); }
    for (i, u) in n.rpc_backup_urls.iter().enumerate() { v.endpoint(&format!("network.rpc_backup_urls[{i}]"), u, HTTP); }
    v.endpoint("network.geyser_grpc_url", &n.geyser_grpc_url, GRPC);
    v.endpoint("network.shredstream_url", &n.shredstream_url, GRPC);
    if !(-2000..=2000).contains(&n.slot_clock_offset_ms) { v.err("network.slot_clock_offset_ms", "Must be between -2000 and 2000 ms"); }

    // wallets
    let w = &c.wallets;
    v.pubkey("wallets.hot_wallet_pubkey", &w.hot_wallet_pubkey);
    v.pubkey("wallets.wsol_vault_ata", &w.wsol_vault_ata);
    if !w.hot_wallet_pubkey.is_empty() && w.hot_wallet_pubkey == w.wsol_vault_ata { v.err("wallets.wsol_vault_ata", "The WSOL vault is a token account, not the wallet itself"); }
    if w.nonce_accounts.is_empty() || w.nonce_accounts.len() > 32 { v.err("wallets.nonce_accounts", "Between 1 and 32 nonce accounts"); }
    let mut seen = HashSet::new();
    for (i, k) in w.nonce_accounts.iter().enumerate() {
        v.pubkey(&format!("wallets.nonce_accounts[{i}]"), k);
        if !seen.insert(k) { v.err("wallets.nonce_accounts", "Duplicate nonce account"); }
        if *k == w.hot_wallet_pubkey { v.err("wallets.nonce_accounts", "The hot wallet cannot be a nonce account"); }
    }
    v.range_u("wallets.nonce_target_pool_size", w.nonce_target_pool_size.into(), 1, 32, "");
    v.range_u("wallets.nonce_health_check_secs", w.nonce_health_check_secs.into(), 5, 3600, " s");
    v.range_f("wallets.nonce_min_balance_sol", w.nonce_min_balance_sol, 0.0015, 1.0, " SOL");
    v.range_f("wallets.max_hot_wallet_sol", w.max_hot_wallet_sol, 0.1, 10_000.0, " SOL");

    // strategy
    let s = &c.strategy;
    v.range_f("strategy.default_buy_sol", s.default_buy_sol, 0.01, 100.0, " SOL");
    v.range_f("strategy.min_buy_sol", s.min_buy_sol, 0.01, 100.0, " SOL");
    v.range_f("strategy.max_buy_sol", s.max_buy_sol, 0.01, 100.0, " SOL");
    if s.min_buy_sol > s.max_buy_sol { v.err("strategy.max_buy_sol", "Max must be ≥ min"); }
    if s.default_buy_sol < s.min_buy_sol || s.default_buy_sol > s.max_buy_sol { v.err("strategy.default_buy_sol", "Default must sit between min and max"); }
    v.range_f("strategy.max_curve_reserve_sol", s.max_curve_reserve_sol, 1.0, 100_000.0, " SOL");
    v.range_u("strategy.slippage_bps", s.slippage_bps.into(), 0, 5000, " bps");
    v.range_f("strategy.default_kol_margin_sol", s.default_kol_margin_sol, 0.000_001, 10.0, " SOL");
    v.slot_range("strategy.buy_slot_ttl", s.buy_slot_ttl, 16);
    for (i, m) in s.generic_quote_mints.iter().enumerate() { v.pubkey(&format!("strategy.generic_quote_mints[{i}]"), m); }
    if s.modes.generic_quote_snipe && s.generic_quote_mints.is_empty() { v.err("strategy.generic_quote_mints", "Add at least one quote mint for Generic-Quote mode"); }

    // landers
    let l = &c.landers;
    let mut on = 0u32;
    for id in LanderId::ALL {
        let base = format!("landers.providers.{}", id.key());
        let Some(p) = l.providers.get(&id) else { v.err(&base, "Missing provider"); continue };
        v.endpoint(&format!("{base}.endpoint_url"), &p.endpoint_url, HTTP);
        if p.tip_accounts.len() > 16 { v.err(format!("{base}.tip_accounts"), "At most 16 tip accounts"); }
        for (i, t) in p.tip_accounts.iter().enumerate() { v.pubkey(&format!("{base}.tip_accounts[{i}]"), t); }
        v.range_f(&format!("{base}.min_tip_sol"), p.min_tip_sol, 0.0, 1.0, " SOL");
        v.range_f(&format!("{base}.max_tip_sol"), p.max_tip_sol, 0.0, 1.0, " SOL");
        if p.min_tip_sol > p.max_tip_sol { v.err(format!("{base}.max_tip_sol"), "Max tip must be ≥ min tip"); }
        v.range_u(&format!("{base}.fanout"), p.fanout.into(), 0, 32, " txs");
        if p.enabled {
            if p.fanout == 0 { v.err(format!("{base}.fanout"), "Enabled providers need a fan-out of at least 1"); }
            if id != LanderId::Tpu && p.tip_accounts.is_empty() { v.err(format!("{base}.tip_accounts"), "Add the provider’s tip accounts"); }
            on += p.fanout;
        }
    }
    if !l.providers.values().any(|p| p.enabled) { v.err("landers.providers", "Enable at least one landing provider"); }
    if on > 128 { v.err("landers.providers", format!("Total fan-out {on} exceeds 128 txs per opportunity")); }
    v.range_u("landers.tx.compute_unit_limit", l.tx.compute_unit_limit.into(), 1_000, 1_400_000, " CU");
    v.range_u("landers.tx.loaded_accounts_data_size_limit", l.tx.loaded_accounts_data_size_limit.into(), 0, 64 * 1024 * 1024, " bytes");
    v.range_u("landers.tx.priority_fee_lamports", l.tx.priority_fee_lamports, 0, 1_000_000_000, " lamports");
    v.range_f("landers.max_hourly_burn_sol", l.max_hourly_burn_sol, 0.001, 1_000.0, " SOL");

    // exits
    let x = &c.exits;
    v.range_f("exits.instant_tp_pct", x.instant_tp_pct, 0.0, 100.0, "%");
    if x.ladder.len() > 8 { v.err("exits.ladder", "At most 8 steps"); }
    let mut last_mult = 0.0;
    for (i, st) in x.ladder.iter().enumerate() {
        if !(st.sell_pct > 0.0 && st.sell_pct <= 100.0) { v.err(format!("exits.ladder[{i}].sell_pct"), "Between 0 and 100%"); }
        match st.trigger {
            LadderTrigger::PnlMultiple(m) => {
                if !(m > 0.0 && m <= 1000.0) { v.err(format!("exits.ladder[{i}].trigger.value"), "Between 0 and 1000×"); }
                if m <= last_mult { v.err("exits.ladder", "PnL-multiple triggers must increase step by step"); }
                last_mult = m;
            }
            LadderTrigger::TimeSecs(t) => if !(1..=86_400).contains(&t) { v.err(format!("exits.ladder[{i}].trigger.value"), "Between 1 and 86400 s"); },
        }
    }
    if let Some(p) = x.stop_loss_pct { v.range_f("exits.stop_loss_pct", p, 0.0, 99.0, "%"); }
    if let Some(p) = x.trailing_stop_pct { v.range_f("exits.trailing_stop_pct", p, 0.0, 99.0, "%"); }
    v.range_f("exits.curve_floor.min_real_sol_reserves_sol", x.curve_floor.min_real_sol_reserves_sol, 0.0, 100_000.0, " SOL");
    v.slot_range("exits.sell_slot_ttl", x.sell_slot_ttl, 64);

    // treasury
    let t = &c.treasury;
    v.range_f("treasury.trigger_wsol_threshold", t.trigger_wsol_threshold, 1.0, 1_000_000.0, " SOL");
    v.range_f("treasury.clip_wsol", t.clip_wsol, 0.1, 10_000.0, " SOL");
    if t.clip_wsol > t.trigger_wsol_threshold { v.err("treasury.clip_wsol", "Clip must not exceed the trigger threshold"); }
    v.pubkey("treasury.target_mint", &t.target_mint);
    v.range_u("treasury.slippage_bps", t.slippage_bps.into(), 0, 5000, " bps");
    v.range_u("treasury.max_priority_fee_lamports", t.max_priority_fee_lamports, 0, 100_000_000, " lamports");

    if v.0.is_empty() { Ok(()) } else { Err(v.0) }
}
