//! Whal Bot — On-Chain Program #3: Generic-Quote LaunchLab Buyer.
//!
//! Designed to be chained in the same transaction immediately AFTER a Meteora DLMM
//! `SwapExactOut2` instruction (which atomically swaps SOL -> exact quote token such as
//! BONK or xStocks).
//!
//! ## Accounts
//! - `[0]` `launchlab_program` (executable — Raydium LaunchLab)
//! - `[1]` `bot_quote_ata`     (writable — bot's SPL or Token-2022 quote token account)
//! - `[2]` `quote_mint`        (read-only — quote token mint, e.g. BONK / xStock)
//! - `[3]` `quote_token_prog`  (executable — SPL Token or Token-2022 program)
//! - `[4 .. total - N]` `launchlab_cpi_accounts` forwarded to LaunchLab `BuyExactIn`
//! - `[total - N .. total]` `N` trailing read-only KOL quote token accounts (`1 <= N <= 8`)
//!
//! ## Instruction Data (`28 + 8 * N` bytes)
//! - `[0]`      `op = 0x01` (`GenericQuoteBuyExactIn`)
//! - `[1]`      `kol_count` (`N`, `1..=8`)
//! - `[2]`      `quote_decimals` (`u8`, for Token-2022 / SPL `TransferChecked`)
//! - `[3]`      `flags` (`bit0`: `1` = cap spend at `max_quote_in`, `0` = spend entire acquired balance)
//! - `[4..12]`  `max_quote_in` (`u64` LE)
//! - `[12..20]` `min_tokens_out` (`u64` LE)
//! - `[20..28]` `share_fee_rate` (`u64` LE)
//! - `[28 .. 28 + 8*N]` `N` × `u64` LE KOL token balance thresholds

#![no_std]
#![allow(unexpected_cfgs)]

#[cfg(test)]
extern crate std;

pub mod generic_quote;
pub mod launchlab;

use pinocchio::{
    account_info::AccountInfo,
    no_allocator,
    nostd_panic_handler,
    program_entrypoint,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

#[cfg(all(not(feature = "no-entrypoint"), not(test)))]
program_entrypoint!(process_instruction);

#[cfg(all(not(feature = "no-entrypoint"), not(test)))]
no_allocator!();

#[cfg(all(not(feature = "no-entrypoint"), not(test)))]
nostd_panic_handler!();

pub const OP_GENERIC_QUOTE_BUY: u8 = 0x01;
pub const HEADER_LEN: usize = 28;
pub const FLAG_CAP_QUOTE_IN: u8 = 1 << 0;

/// Resolves the quote amount to spend from the live post-Meteora balance.
#[inline(always)]
pub fn resolve_quote_amount(
    live_quote_balance: u64,
    max_quote_in: u64,
    cap_enabled: bool,
) -> Result<u64, ProgramError> {
    if live_quote_balance == 0 {
        return Err(ProgramError::Custom(generic_quote::ERR_ZERO_QUOTE_BALANCE));
    }
    let amount = if cap_enabled && max_quote_in > 0 {
        live_quote_balance.min(max_quote_in)
    } else {
        live_quote_balance
    };
    if amount == 0 {
        return Err(ProgramError::Custom(generic_quote::ERR_ZERO_QUOTE_BALANCE));
    }
    Ok(amount)
}

#[inline(always)]
pub fn process_instruction(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if instruction_data.len() < HEADER_LEN || instruction_data[0] != OP_GENERIC_QUOTE_BUY {
        return Err(ProgramError::InvalidInstructionData);
    }

    let kol_count = instruction_data[1] as usize;
    if kol_count == 0 || kol_count > generic_quote::MAX_KOLS {
        return Err(ProgramError::Custom(generic_quote::ERR_INVALID_KOL_COUNT));
    }
    if instruction_data.len() != HEADER_LEN + kol_count * 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    // Need at least [launchlab_program, bot_quote_ata, quote_mint, quote_token_prog, ...kols].
    if accounts.len() < 4 + kol_count {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let kol_start = accounts.len() - kol_count;

    // 1. Multi-account KOL token-balance threshold guard (fails fast with Custom(1)).
    generic_quote::verify_kol_token_thresholds(
        &accounts[kol_start..],
        &instruction_data[HEADER_LEN..],
    )?;

    // 2. Verify quote token program is SPL Token or Token-2022.
    let quote_token_prog = &accounts[3];
    if !generic_quote::is_supported_token_program(quote_token_prog.key()) {
        return Err(ProgramError::Custom(generic_quote::ERR_INVALID_TOKEN_PROGRAM));
    }

    // 3. Read newly acquired quote token balance (immediately after Meteora DLMM SwapExactOut2).
    let bot_quote_ata = &accounts[1];
    let live_quote_balance = generic_quote::read_token_amount(bot_quote_ata)?;

    let flags = instruction_data[3];
    let max_quote_in = generic_quote::read_u64_le(instruction_data, 4)?;
    let min_tokens_out = generic_quote::read_u64_le(instruction_data, 12)?;
    let share_fee_rate = generic_quote::read_u64_le(instruction_data, 20)?;

    let amount_in = resolve_quote_amount(
        live_quote_balance,
        max_quote_in,
        (flags & FLAG_CAP_QUOTE_IN) != 0,
    )?;

    // 4. Execute Raydium LaunchLab BuyExactIn CPI using the acquired quote tokens.
    let launchlab_program = &accounts[0];
    let cpi_accounts = &accounts[4..kol_start];
    launchlab::invoke_buy_exact_in(
        launchlab_program,
        cpi_accounts,
        amount_in,
        min_tokens_out,
        share_fee_rate,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_post_meteora_quote_amount() {
        assert_eq!(
            resolve_quote_amount(0, 1_000, true).unwrap_err(),
            ProgramError::Custom(generic_quote::ERR_ZERO_QUOTE_BALANCE)
        );
        assert_eq!(resolve_quote_amount(500_000, 1_000_000, true).unwrap(), 500_000);
        assert_eq!(resolve_quote_amount(2_000_000, 1_000_000, true).unwrap(), 1_000_000);
        assert_eq!(resolve_quote_amount(2_000_000, 1_000_000, false).unwrap(), 2_000_000);
    }

    #[test]
    fn supports_spl_and_token_2022_and_encodes_transfer_checked() {
        assert!(generic_quote::is_supported_token_program(&generic_quote::SPL_TOKEN_PROGRAM_ID));
        assert!(generic_quote::is_supported_token_program(&generic_quote::TOKEN_2022_PROGRAM_ID));
        assert!(!generic_quote::is_supported_token_program(&[0u8; 32]));

        let tc = generic_quote::encode_transfer_checked(1_234_567, 5);
        assert_eq!(tc[0], generic_quote::TOKEN_IX_TRANSFER_CHECKED);
        assert_eq!(u64::from_le_bytes(tc[1..9].try_into().unwrap()), 1_234_567);
        assert_eq!(tc[9], 5);

        let buy = launchlab::encode_buy_exact_in(5_000_000, 10_000, 0);
        assert_eq!(&buy[0..8], &launchlab::DISC_LAUNCHLAB_BUY_EXACT_IN);
        assert_eq!(u64::from_le_bytes(buy[8..16].try_into().unwrap()), 5_000_000);
    }
}
