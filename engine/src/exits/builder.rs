//! Protected Sell Transaction Builder combining Lighthouse assertions, Program #4
//! (`whal-sell-router`), and `Token::CloseAccount` rent reclaim on 100% exits.

use crate::executor::{
    AccountMetaSpec, InstructionSpec, SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
};
use crate::ingest::{PubkeyBytes, Venue};
use super::lighthouse::{
    assert_clock_slot_lte, assert_pumpfun_liquidity_floor, assert_sell_dedupe_balance,
};

pub const VENUE_OP_LAUNCHLAB: u8 = 7;
pub const VENUE_OP_PUMPFUN: u8 = 9;
pub const VENUE_OP_RAYDIUM_CPMM: u8 = 11;

pub const FLAG_CLOSE_ACCOUNT: u64 = 1 << 0;
pub const TOKEN_IX_CLOSE_ACCOUNT: u8 = 9;
pub const DEFAULT_POST_SELL_SLOT_TTL: u64 = 8;

#[derive(Debug, Clone)]
pub struct SellTxParams {
    pub sell_router_program: PubkeyBytes,
    pub target_dex_program: PubkeyBytes,
    pub venue: Venue,
    pub hot_wallet: PubkeyBytes,
    pub bot_token_account: PubkeyBytes,
    pub pool_or_curve: PubkeyBytes,
    pub is_token_2022: bool,
    pub pre_balance: u64,
    pub sell_pct: u64,
    pub min_quote_out: u64,
    pub min_liquidity_floor_lamports: u64,
    pub current_slot: u64,
    pub close_on_full_exit: bool,
    pub cpi_accounts: Vec<AccountMetaSpec>,
}

/// Builds the complete Lighthouse-protected exit instruction sequence:
/// 1. Pre-sell Lighthouse `AssertAccountData` on `bot_token_account` (`offset 0x40 >= dedupe_floor`)
/// 2. *(Pump.fun)* Pre-sell Lighthouse `AssertAccountData` on `bonding_curve` (`offset 0x20 > min_liquidity_floor`)
/// 3. Program #4 (`whal-sell-router`) 25-byte percentage sell instruction
/// 4. *(100% exit)* `Token::CloseAccount` to reclaim `0.00203928 SOL` rent to `hot_wallet`
/// 5. Post-sell Lighthouse `AssertClockSysvar(slot <= current_slot + 8)`
pub fn build_protected_sell_instructions(p: &SellTxParams) -> Vec<InstructionSpec> {
    let mut ixs = Vec::with_capacity(5);
    let token_program = if p.is_token_2022 {
        TOKEN_2022_PROGRAM_ID
    } else {
        SPL_TOKEN_PROGRAM_ID
    };

    let direct_native = p.sell_router_program == [0u8; 32]
        || std::env::var("WHAL_DIRECT_NATIVE_DEX")
            .ok()
            .map(|v| matches!(v.trim(), "1" | "true" | "TRUE"))
            .unwrap_or(false);

    if direct_native {
        // Direct native Pump.fun sell(amount, min_sol_output) — skips undeployed whal-sell-router & Lighthouse.
        let sell_amount = if p.pre_balance > 0 {
            ((p.pre_balance as u128 * p.sell_pct.min(100) as u128) / 100).max(1) as u64
        } else {
            1
        };
        // Pump.fun `sell` Anchor discriminator: sha256("global:sell")[..8]
        const DISC_PUMPFUN_SELL: [u8; 8] = [0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad];
        let mut native_data = Vec::with_capacity(24);
        native_data.extend_from_slice(&DISC_PUMPFUN_SELL);
        native_data.extend_from_slice(&sell_amount.to_le_bytes());
        native_data.extend_from_slice(&p.min_quote_out.to_le_bytes());
        // Pump.fun sell account order puts creator_vault(8) before token_program(9) compared to buy(8=token_prog, 9=creator_vault)
        let mut native_accs = p.cpi_accounts.clone();
        if p.venue == Venue::PumpFun && native_accs.len() >= 10 {
            native_accs.swap(8, 9);
        }
        ixs.push(InstructionSpec {
            label: "direct_native_dex_sell",
            program_id: p.target_dex_program,
            accounts: native_accs,
            data: native_data,
        });
        if p.sell_pct >= 100 && p.close_on_full_exit {
            ixs.push(InstructionSpec {
                label: "token_close_account_rent_reclaim",
                program_id: token_program,
                accounts: vec![
                    AccountMetaSpec { pubkey: p.bot_token_account, is_signer: false, is_writable: true },
                    AccountMetaSpec { pubkey: p.hot_wallet, is_signer: false, is_writable: true },
                    AccountMetaSpec { pubkey: p.hot_wallet, is_signer: true, is_writable: false },
                ],
                data: vec![TOKEN_IX_CLOSE_ACCOUNT],
            });
        }
        return ixs;
    }

    // 1. Pre-sell atomic sell deduplication via Lighthouse (reverts duplicates with Custom(6011)).
    if p.pre_balance > 0 {
        ixs.push(assert_sell_dedupe_balance(
            p.bot_token_account,
            p.pre_balance,
            p.sell_pct,
        ));
    }

    // 2. Pre-sell Pump.fun bonding-curve liquidity floor assertion (offset 0x20).
    if p.venue == Venue::PumpFun && p.min_liquidity_floor_lamports > 0 {
        ixs.push(assert_pumpfun_liquidity_floor(
            p.pool_or_curve,
            p.min_liquidity_floor_lamports,
        ));
    }

    // 3. Program #4 (Percentage Sell Router — exact 25 bytes).
    let venue_op = match p.venue {
        Venue::RaydiumLaunchLab => VENUE_OP_LAUNCHLAB,
        Venue::PumpFun | Venue::PumpSwap => VENUE_OP_PUMPFUN,
        Venue::RaydiumCpmm => VENUE_OP_RAYDIUM_CPMM,
    };
    let flags = if p.sell_pct >= 100 && p.close_on_full_exit {
        FLAG_CLOSE_ACCOUNT
    } else {
        0
    };
    let mut sell_data = Vec::with_capacity(25);
    sell_data.push(venue_op);
    sell_data.extend_from_slice(&p.sell_pct.min(100).to_le_bytes());
    sell_data.extend_from_slice(&flags.to_le_bytes());
    sell_data.extend_from_slice(&p.min_quote_out.to_le_bytes());

    let mut sell_accounts = Vec::with_capacity(4 + p.cpi_accounts.len());
    sell_accounts.push(AccountMetaSpec { pubkey: p.target_dex_program, is_signer: false, is_writable: false });
    sell_accounts.push(AccountMetaSpec { pubkey: p.bot_token_account, is_signer: false, is_writable: true });
    sell_accounts.push(AccountMetaSpec { pubkey: p.hot_wallet, is_signer: true, is_writable: true });
    sell_accounts.push(AccountMetaSpec { pubkey: token_program, is_signer: false, is_writable: false });
    sell_accounts.extend(p.cpi_accounts.iter().cloned());

    ixs.push(InstructionSpec {
        label: "program4_percentage_sell",
        program_id: p.sell_router_program,
        accounts: sell_accounts,
        data: sell_data,
    });

    // 4. On 100% exit, append Token::CloseAccount to reclaim 0.00203928 SOL rent.
    if p.sell_pct >= 100 && p.close_on_full_exit {
        ixs.push(InstructionSpec {
            label: "token_close_account_rent_reclaim",
            program_id: token_program,
            accounts: vec![
                AccountMetaSpec { pubkey: p.bot_token_account, is_signer: false, is_writable: true },
                AccountMetaSpec { pubkey: p.hot_wallet, is_signer: false, is_writable: true },
                AccountMetaSpec { pubkey: p.hot_wallet, is_signer: true, is_writable: false },
            ],
            data: vec![TOKEN_IX_CLOSE_ACCOUNT],
        });
    }

    // 5. Post-sell Lighthouse Clock Sysvar assertion (slot <= current_slot + 8).
    ixs.push(assert_clock_slot_lte(
        p.current_slot.saturating_add(DEFAULT_POST_SELL_SLOT_TTL),
    ));

    ixs
}
