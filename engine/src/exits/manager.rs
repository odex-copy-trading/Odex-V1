//! Position Manager & Automated Staged Exit Ladder Engine.

use std::sync::Arc;
use dashmap::DashMap;

use crate::ingest::{PubkeyBytes, Venue};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LadderTrigger {
    PnlMultiple(f64),
    TimeSecs(u64),
}

#[derive(Debug, Clone, Copy)]
pub struct LadderStep {
    pub sell_pct: u64,
    pub trigger: LadderTrigger,
}

#[derive(Debug, Clone)]
pub struct ExitPolicy {
    pub same_slot_take_profit_enabled: bool,
    pub same_slot_take_profit_pct: u64, // default 25%
    pub min_liquidity_floor_lamports: u64,
    pub max_hold_secs: u64,
    pub ladder: Vec<LadderStep>,
}

impl Default for ExitPolicy {
    fn default() -> Self {
        Self {
            same_slot_take_profit_enabled: true,
            same_slot_take_profit_pct: 25,
            min_liquidity_floor_lamports: 10_000_000_000, // 10 SOL
            max_hold_secs: 900,
            ladder: vec![
                LadderStep { sell_pct: 15, trigger: LadderTrigger::PnlMultiple(1.5) },
                LadderStep { sell_pct: 33, trigger: LadderTrigger::PnlMultiple(2.5) },
                LadderStep { sell_pct: 100, trigger: LadderTrigger::PnlMultiple(5.0) },
            ],
        }
    }
}

#[derive(Debug, Clone)]
pub struct ManagedPosition {
    pub mint: PubkeyBytes,
    pub pool_or_curve: PubkeyBytes,
    pub bot_token_account: PubkeyBytes,
    pub venue: Venue,
    pub is_token_2022: bool,
    pub opened_at_secs: u64,
    pub opened_slot: u64,
    pub entry_price_sol: f64,
    pub token_balance: u64,
    pub dex_accounts: Vec<PubkeyBytes>,
    pub same_slot_tp_fired: bool,
    pub fired_steps: Vec<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExitOrder {
    pub mint: PubkeyBytes,
    pub sell_pct: u64,
    pub close_account: bool,
    pub reason: &'static str,
}

pub struct ExitEngine {
    positions: Arc<DashMap<PubkeyBytes, ManagedPosition>>,
    twap_state: Arc<DashMap<PubkeyBytes, (u64, u8)>>, // (last_drip_secs, drips_fired)
    policy: ExitPolicy,
}

impl ExitEngine {
    pub fn new(policy: ExitPolicy) -> Self {
        Self {
            positions: Arc::new(DashMap::new()),
            twap_state: Arc::new(DashMap::new()),
            policy,
        }
    }

    /// Registers a newly opened position and optionally returns an immediate same-slot 25%
    /// take-profit `ExitOrder` for high-conviction entries.
    pub fn register_position(
        &self,
        mut pos: ManagedPosition,
        high_conviction: bool,
    ) -> Option<ExitOrder> {
        pos.fired_steps = vec![false; self.policy.ladder.len()];
        let mint = pos.mint;
        let same_slot_order = if high_conviction && self.policy.same_slot_take_profit_enabled {
            pos.same_slot_tp_fired = true;
            Some(ExitOrder {
                mint,
                sell_pct: self.policy.same_slot_take_profit_pct,
                close_account: self.policy.same_slot_take_profit_pct >= 100,
                reason: "Same-slot take-profit",
            })
        } else {
            None
        };
        self.positions.insert(mint, pos);
        same_slot_order
    }

    /// Evaluates a live Geyser price + liquidity update against the staged Exit Ladder.
    pub fn on_price_update(
        &self,
        mint: &PubkeyBytes,
        current_price_sol: f64,
        curve_reserve_lamports: u64,
        now_secs: u64,
    ) -> Option<ExitOrder> {
        let mut entry = self.positions.get_mut(mint)?;
        let pos = entry.value_mut();

        // 1. Emergency liquidity floor protection -> 100% exit + rent reclaim
        if curve_reserve_lamports < self.policy.min_liquidity_floor_lamports {
            return Some(ExitOrder {
                mint: *mint,
                sell_pct: 100,
                close_account: true,
                reason: "Liquidity floor",
            });
        }

        // 2. Max hold time cap -> 100% exit + rent reclaim
        let held_secs = now_secs.saturating_sub(pos.opened_at_secs);
        let mult = if pos.entry_price_sol > 0.0 {
            current_price_sol / pos.entry_price_sol
        } else {
            0.0
        };

        // 2a. Fhbh1D Fail-Fast Stop-Loss: dump 100% within 2–3s if price drops <= -6%
        if held_secs >= 2 && held_secs <= 12 && mult > 0.0 && mult <= 0.94 {
            return Some(ExitOrder {
                mint: *mint,
                sell_pct: 100,
                close_account: true,
                reason: "Fail-fast SL (2-3s)",
            });
        }

        // 2b. Fhbh1D 45s hard time-stop for flat/dead positions (< +5%)
        if held_secs >= 45 && held_secs < 90 && mult > 0.0 && mult < 1.05 {
            return Some(ExitOrder {
                mint: *mint,
                sell_pct: 100,
                close_account: true,
                reason: "Time-stop (45s)",
            });
        }

        if self.policy.max_hold_secs > 0 && held_secs >= self.policy.max_hold_secs {
            return Some(ExitOrder {
                mint: *mint,
                sell_pct: 100,
                close_account: true,
                reason: "Time cap",
            });
        }

        // 3. Staged exit ladder steps (e.g. 15%, 33%, 100%)
        for (idx, step) in self.policy.ladder.iter().enumerate() {
            if pos.fired_steps.get(idx).copied().unwrap_or(true) {
                continue;
            }
            let hit = match step.trigger {
                LadderTrigger::PnlMultiple(target) => mult >= target,
                LadderTrigger::TimeSecs(secs) => held_secs >= secs,
            };
            if hit {
                pos.fired_steps[idx] = true;
                return Some(ExitOrder {
                    mint: *mint,
                    sell_pct: step.sell_pct,
                    close_account: step.sell_pct >= 100,
                    reason: "Auto exit ladder",
                });
            }
        }

        // 3b. Fhbh1D 15%-every-2s Exponential TWAP Drip while >= +18% (up to 6 drips, leaving ~30% moonbag)
        if mult >= 1.18 && held_secs >= 2 {
            let mut twap = self.twap_state.entry(*mint).or_insert((pos.opened_at_secs, 0));
            let (last_drip, drips) = *twap;
            if drips < 6 && now_secs.saturating_sub(last_drip) >= 2 {
                *twap = (now_secs, drips + 1);
                return Some(ExitOrder {
                    mint: *mint,
                    sell_pct: 15,
                    close_account: false,
                    reason: "TWAP drip (15%/2s)",
                });
            }
        }

        None
    }

    pub fn get_position(&self, mint: &PubkeyBytes) -> Option<ManagedPosition> {
        self.positions.get(mint).map(|p| p.clone())
    }

    pub fn list_positions(&self) -> Vec<ManagedPosition> {
        self.positions.iter().map(|e| e.value().clone()).collect()
    }

    pub fn remove_position(&self, mint: &PubkeyBytes) {
        self.positions.remove(mint);
        self.twap_state.remove(mint);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exits::builder::{build_protected_sell_instructions, SellTxParams};
    use crate::exits::lighthouse::sell_dedupe_min_balance;

    #[test]
    fn lighthouse_sell_dedupe_and_close_account_on_100_pct() {
        // 1,000,000 tokens, 25% sell -> post-sell balance = 750,000 -> min_balance = 750,001
        assert_eq!(sell_dedupe_min_balance(1_000_000, 25), 750_001);
        assert_eq!(sell_dedupe_min_balance(1_000_000, 100), 1);

        let ixs = build_protected_sell_instructions(&SellTxParams {
            sell_router_program: [0xCC; 32],
            target_dex_program: [0x40; 32],
            venue: Venue::PumpFun,
            hot_wallet: [0x01; 32],
            bot_token_account: [0x02; 32],
            pool_or_curve: [0x03; 32],
            is_token_2022: false,
            pre_balance: 1_000_000,
            sell_pct: 100,
            min_quote_out: 100,
            min_liquidity_floor_lamports: 10_000_000_000,
            current_slot: 500_000,
            close_on_full_exit: true,
            cpi_accounts: vec![],
        });
        let labels: Vec<&str> = ixs.iter().map(|i| i.label).collect();
        assert_eq!(
            labels,
            vec![
                "lighthouse_assert_token_balance",
                "lighthouse_assert_pumpfun_liquidity",
                "program4_percentage_sell",
                "token_close_account_rent_reclaim",
                "lighthouse_assert_clock_slot",
            ]
        );
    }

    #[test]
    fn staged_exit_ladder_and_same_slot_tp() {
        let engine = ExitEngine::new(ExitPolicy::default());
        let mint = [0xAA; 32];
        let tp = engine.register_position(
            ManagedPosition {
                mint,
                pool_or_curve: [0xBB; 32],
                bot_token_account: [0xCC; 32],
                venue: Venue::PumpFun,
                is_token_2022: false,
                opened_at_secs: 1_000,
                opened_slot: 500,
                entry_price_sol: 1e-6,
                token_balance: 1_000_000,
                dex_accounts: vec![],
                same_slot_tp_fired: false,
                fired_steps: vec![],
            },
            true,
        );
        assert_eq!(tp.unwrap().sell_pct, 25);

        // 1.6x hits rung 0 (15%)
        let r0 = engine.on_price_update(&mint, 1.6e-6, 30_000_000_000, 1_010).unwrap();
        assert_eq!(r0.sell_pct, 15);

        // 2.6x hits rung 1 (33%)
        let r1 = engine.on_price_update(&mint, 2.6e-6, 30_000_000_000, 1_020).unwrap();
        assert_eq!(r1.sell_pct, 33);

        // Curve liquidity drop below 10 SOL triggers immediate 100% exit + close
        let floor = engine.on_price_update(&mint, 2.0e-6, 5_000_000_000, 1_025).unwrap();
        assert_eq!(floor.sell_pct, 100);
        assert!(floor.close_account);
    }
}
