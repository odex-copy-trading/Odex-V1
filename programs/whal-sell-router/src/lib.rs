//! Whal Bot — On-Chain Program #4: Percentage-Based On-Chain Sell Router.
//!
//! Minimal, `no_std`, zero-allocation Pinocchio program supporting atomic same-slot
//! Buy -> Percentage Sell chaining without knowing the exact buy fill quantity off-chain.
//!
//! ## Instruction Data (exact 25 bytes)
//! - `byte[0]`      : `venue_op` (`7` = LaunchLab `SellExactIn`, `9` = Pump.fun `SellV3`, `11` = Raydium CPMM)
//! - `bytes[1..9]`  : `sell_pct` (`u64` LE: `1..=100`)
//! - `bytes[9..17]` : `flags` (`u64` LE; `bit0` = `FLAG_CLOSE_ACCOUNT` to close seeded ATA on 100% sell)
//! - `bytes[17..25]`: `min_quote_out` (`u64` LE slippage floor)
//!
//! ## Accounts
//! - `[0]` `target_program`    (executable — LaunchLab / Pump.fun / Raydium CPMM)
//! - `[1]` `bot_token_account` (writable — bot's live SPL / Token-2022 account; balance read at `data[64..72]`)
//! - `[2]` `hot_wallet`        (signer, writable — authority & rent-reclaim destination)
//! - `[3]` `token_program`     (executable — SPL Token or Token-2022, used for `CloseAccount` CPI)
//! - `[4..]` `cpi_accounts`    forwarded verbatim to the target DEX CPI

#![no_std]
#![allow(unexpected_cfgs)]

#[cfg(test)]
extern crate std;

pub mod cpmm;
pub mod launchlab;
pub mod pumpfun;

use core::mem::MaybeUninit;
use pinocchio::{
    account_info::AccountInfo,
    cpi::slice_invoke,
    instruction::{AccountMeta, Instruction},
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

/// Exact instruction payload length: 1 + 8 + 8 + 8 = 25 bytes.
pub const SELL_IX_DATA_LEN: usize = 25;

/// Venue operation codes.
pub const VENUE_OP_LAUNCHLAB: u8 = 7;
pub const VENUE_OP_PUMPFUN: u8 = 9;
pub const VENUE_OP_RAYDIUM_CPMM: u8 = 11;

/// Flag bits.
pub const FLAG_CLOSE_ACCOUNT: u64 = 1 << 0;

/// SPL Token / Token-2022 layout & `CloseAccount` opcode (9).
pub const SPL_AMOUNT_OFFSET: usize = 64;
pub const SPL_ACCOUNT_MIN_LEN: usize = 72;
pub const TOKEN_IX_CLOSE_ACCOUNT: u8 = 9;
pub const MAX_CPI_ACCOUNTS: usize = 24;

/// Custom error codes.
pub const ERR_INVALID_VENUE: u32 = 1;
pub const ERR_INVALID_SELL_PCT: u32 = 2;
pub const ERR_ZERO_BALANCE: u32 = 3;

#[inline(always)]
fn read_u64_le(buf: &[u8], off: usize) -> Result<u64, ProgramError> {
    if off.saturating_add(8) > buf.len() {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(u64::from_le_bytes([
        buf[off],
        buf[off + 1],
        buf[off + 2],
        buf[off + 3],
        buf[off + 4],
        buf[off + 5],
        buf[off + 6],
        buf[off + 7],
    ]))
}

/// Computes `amount_in = (live_balance * sell_pct) / 100` using `u128` to avoid overflow
/// on high-supply tokens. Returns `ERR_INVALID_SELL_PCT` if `sell_pct` is outside `1..=100`,
/// and `ERR_ZERO_BALANCE` if `live_balance == 0` or computed `amount_in == 0`.
#[inline(always)]
pub fn compute_sell_amount(live_balance: u64, sell_pct: u64) -> Result<u64, ProgramError> {
    if sell_pct == 0 || sell_pct > 100 {
        return Err(ProgramError::Custom(ERR_INVALID_SELL_PCT));
    }
    if live_balance == 0 {
        return Err(ProgramError::Custom(ERR_ZERO_BALANCE));
    }
    let amount_in = if sell_pct == 100 {
        live_balance
    } else {
        ((live_balance as u128 * sell_pct as u128) / 100) as u64
    };
    if amount_in == 0 {
        return Err(ProgramError::Custom(ERR_ZERO_BALANCE));
    }
    Ok(amount_in)
}

/// Encodes the venue-specific sell CPI payload into a 32-byte stack buffer.
#[inline(always)]
pub fn encode_venue_sell(
    venue_op: u8,
    amount_in: u64,
    min_quote_out: u64,
    out: &mut [u8; 32],
) -> Result<usize, ProgramError> {
    match venue_op {
        VENUE_OP_LAUNCHLAB => Ok(launchlab::encode_sell_exact_in(amount_in, min_quote_out, out)),
        VENUE_OP_PUMPFUN => Ok(pumpfun::encode_sell_v3(amount_in, min_quote_out, out)),
        VENUE_OP_RAYDIUM_CPMM => Ok(cpmm::encode_swap_base_in(amount_in, min_quote_out, out)),
        _ => Err(ProgramError::Custom(ERR_INVALID_VENUE)),
    }
}

/// Program entrypoint.
#[inline(always)]
pub fn process_instruction(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if instruction_data.len() != SELL_IX_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    if accounts.len() < 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let venue_op = instruction_data[0];
    let sell_pct = read_u64_le(instruction_data, 1)?;
    let flags = read_u64_le(instruction_data, 9)?;
    let min_quote_out = read_u64_le(instruction_data, 17)?;

    let target_program = &accounts[0];
    let bot_token_account = &accounts[1];
    let hot_wallet = &accounts[2];
    let token_program = &accounts[3];

    if !hot_wallet.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // 1. Read live token balance at data[64..72] on-chain.
    let live_balance = {
        let data = bot_token_account.try_borrow_data()?;
        if data.len() < SPL_ACCOUNT_MIN_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        read_u64_le(&data, SPL_AMOUNT_OFFSET)?
    };

    // 2. Compute amount_in = (live_balance * sell_pct) / 100.
    let amount_in = compute_sell_amount(live_balance, sell_pct)?;

    // 3. Encode venue CPI data and invoke target DEX on stack.
    let mut ix_buf = [0u8; 32];
    let ix_len = encode_venue_sell(venue_op, amount_in, min_quote_out, &mut ix_buf)?;

    let cpi_slice = &accounts[4..];
    let cpi_len = cpi_slice.len();
    if cpi_len > MAX_CPI_ACCOUNTS {
        return Err(ProgramError::InvalidInstructionData);
    }

    let mut metas: [MaybeUninit<AccountMeta>; MAX_CPI_ACCOUNTS] =
        [const { MaybeUninit::uninit() }; MAX_CPI_ACCOUNTS];
    let mut infos: [MaybeUninit<&AccountInfo>; MAX_CPI_ACCOUNTS] =
        [const { MaybeUninit::uninit() }; MAX_CPI_ACCOUNTS];

    let mut i = 0;
    while i < cpi_len {
        let acc = &cpi_slice[i];
        metas[i].write(AccountMeta::from(acc));
        infos[i].write(acc);
        i += 1;
    }

    // SAFETY: First `cpi_len` entries of `metas` and `infos` were initialized above.
    let metas_slice = unsafe { core::slice::from_raw_parts(metas.as_ptr() as *const AccountMeta, cpi_len) };
    let infos_slice = unsafe { core::slice::from_raw_parts(infos.as_ptr() as *const &AccountInfo, cpi_len) };

    let sell_ix = Instruction {
        program_id: target_program.key(),
        accounts: metas_slice,
        data: &ix_buf[..ix_len],
    };
    slice_invoke(&sell_ix, infos_slice)?;

    // 4. If sell_pct == 100 and close_flag is set, close the ephemeral seeded token account
    //    to reclaim rent directly to the hot wallet.
    if sell_pct == 100 && (flags & FLAG_CLOSE_ACCOUNT) != 0 {
        let close_data = [TOKEN_IX_CLOSE_ACCOUNT];
        let close_metas = [
            AccountMeta::writable(bot_token_account.key()),
            AccountMeta::writable(hot_wallet.key()),
            AccountMeta::readonly_signer(hot_wallet.key()),
        ];
        let close_ix = Instruction {
            program_id: token_program.key(),
            accounts: &close_metas,
            data: &close_data,
        };
        slice_invoke(&close_ix, &[bot_token_account, hot_wallet, hot_wallet])?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_percentage_without_overflow() {
        assert_eq!(compute_sell_amount(123_456_789, 25).unwrap(), 30_864_197);
        assert_eq!(compute_sell_amount(123_456_789, 100).unwrap(), 123_456_789);
        assert_eq!(compute_sell_amount(u64::MAX, 50).unwrap(), u64::MAX / 2);

        assert_eq!(
            compute_sell_amount(1_000, 0).unwrap_err(),
            ProgramError::Custom(ERR_INVALID_SELL_PCT)
        );
        assert_eq!(
            compute_sell_amount(1_000, 101).unwrap_err(),
            ProgramError::Custom(ERR_INVALID_SELL_PCT)
        );
        assert_eq!(
            compute_sell_amount(0, 25).unwrap_err(),
            ProgramError::Custom(ERR_ZERO_BALANCE)
        );
    }

    #[test]
    fn encodes_all_three_sell_venues() {
        let mut buf = [0u8; 32];
        assert_eq!(encode_venue_sell(VENUE_OP_LAUNCHLAB, 500, 10, &mut buf).unwrap(), 32);
        assert_eq!(&buf[0..8], &launchlab::DISC_LAUNCHLAB_SELL_EXACT_IN);

        assert_eq!(encode_venue_sell(VENUE_OP_PUMPFUN, 500, 10, &mut buf).unwrap(), 24);
        assert_eq!(&buf[0..8], &pumpfun::DISC_PUMPFUN_SELL_V3);

        assert_eq!(encode_venue_sell(VENUE_OP_RAYDIUM_CPMM, 500, 10, &mut buf).unwrap(), 24);
        assert_eq!(&buf[0..8], &cpmm::DISC_RAYDIUM_CPMM_SWAP_BASE_IN);

        assert_eq!(
            encode_venue_sell(42, 500, 10, &mut buf).unwrap_err(),
            ProgramError::Custom(ERR_INVALID_VENUE)
        );
    }
}
