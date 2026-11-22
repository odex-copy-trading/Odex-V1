//! Whal Bot — On-Chain Program #2: KOL Balance-Delta Guard & Buy Router.
//!
//! Minimal, `no_std`, zero-allocation Pinocchio program with two execution modes:
//!
//! ## Mode A — Standalone Guard (`op = 0x01`, target < 200 CU)
//! - Accounts: `[0]` `watched_account` (read-only: KOL system wallet or SPL/Token-2022 token account).
//! - Data (15 bytes): `[op=0x01 (1B) | mode_flags (1B: bit0 = SPL balance @ offset 64 vs lamports) | reserved (5B) | threshold (u64 LE, 8B)]`.
//! - If `current_balance >= threshold` -> `Custom(1)` (`KolNotLanded`). Else `Ok(())`.
//!
//! ## Mode B — Multi-KOL Guard + CPI Buy Router (`op = 0x02`, target < 700 CU on abort)
//! - Accounts:
//!   - `[0]` `target_program` (Pump.fun / PumpSwap / Raydium LaunchLab)
//!   - `[1]` `pool_reserve_account` (bonding curve or quote vault)
//!   - `[2 .. total - N]` `cpi_accounts` forwarded to the venue CPI
//!   - `[total - N .. total]` `N` trailing read-only KOL accounts (`1 <= N <= 8`)
//! - Data (`47 + 8 * N` bytes):
//!   - `[0]`      `op = 0x02`
//!   - `[1]`      `venue` (`0` = Pump.fun BuyExactQuoteInV3, `1` = PumpSwap Buy, `2` = Raydium LaunchLab BuyExactIn)
//!   - `[2]`      `kol_count` (`N`, `1..=8`)
//!   - `[3]`      `kol_flags` (bit `i`: `1` = SPL token balance @ offset 64, `0` = native lamports)
//!   - `[4]`      `reserve_flags` (`bit0`: `1` = u64 LE at `reserve_offset`, `0` = lamports)
//!   - `[5..7]`   `reserve_offset` (`u16` LE)
//!   - `[7..15]`  `min_reserve` (`u64` LE)
//!   - `[15..23]` `max_reserve` (`u64` LE)
//!   - `[23..31]` `base_buy` (`u64` LE)
//!   - `[31..39]` `max_buy` (`u64` LE)
//!   - `[39..47]` `min_tokens_out` (`u64` LE)
//!   - `[47 .. 47 + 8*N]` `N` × `u64` LE balance thresholds (`kol_pre_balance - margin`)

#![no_std]
#![allow(unexpected_cfgs)]

#[cfg(test)]
extern crate std;

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

/// Instruction opcodes.
pub const OP_STANDALONE_GUARD: u8 = 0x01;
pub const OP_MULTI_KOL_ROUTER: u8 = 0x02;

/// Exact Mode A payload length: 1 + 1 + 5 + 8 = 15 bytes.
pub const MODE_A_DATA_LEN: usize = 15;
/// Fixed Mode B header length before the `N * 8`-byte threshold table.
pub const MODE_B_HEADER_LEN: usize = 47;

/// SPL Token & Token-2022 account `amount` field offset (bytes 64..72).
pub const SPL_AMOUNT_OFFSET: usize = 64;
pub const SPL_ACCOUNT_MIN_LEN: usize = 72;

/// Multi-KOL limits and stack CPI account capacity.
pub const MAX_KOLS: usize = 8;
pub const MAX_CPI_ACCOUNTS: usize = 24;

/// Target DEX venue identifiers.
pub const VENUE_PUMPFUN: u8 = 0;
pub const VENUE_PUMPSWAP: u8 = 1;
pub const VENUE_RAYDIUM_LAUNCHLAB: u8 = 2;

/// Custom program error codes.
pub const ERR_KOL_NOT_LANDED: u32 = 1;
pub const ERR_RESERVE_OUT_OF_BOUNDS: u32 = 2;
pub const ERR_INVALID_VENUE: u32 = 3;
pub const ERR_INVALID_KOL_COUNT: u32 = 4;

/// 8-byte Anchor discriminators for supported venue buy instructions.
/// - Pump.fun `buy_exact_quote_in_v3`
pub const DISC_PUMPFUN_BUY_EXACT_QUOTE_V3: [u8; 8] = [0xc6, 0x2e, 0x15, 0x52, 0xb4, 0xd9, 0xe8, 0x70];
/// - PumpSwap `buy`
pub const DISC_PUMPSWAP_BUY: [u8; 8] = [0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea];
/// - Raydium LaunchLab `buy_exact_in`
pub const DISC_LAUNCHLAB_BUY_EXACT_IN: [u8; 8] = [0xfa, 0xea, 0x0d, 0x7b, 0xd5, 0x9c, 0x13, 0xec];

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

#[inline(always)]
fn read_account_balance(acc: &AccountInfo, is_spl: bool) -> Result<u64, ProgramError> {
    if is_spl {
        // SAFETY: Read-only borrow; no aliasing mutable borrow exists during guard phase.
        let data = acc.try_borrow_data()?;
        if data.len() < SPL_ACCOUNT_MIN_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        read_u64_le(&data, SPL_AMOUNT_OFFSET)
    } else {
        Ok(acc.lamports())
    }
}

/// Pure guard check shared by Mode A and native tests.
#[inline(always)]
pub fn check_balance_below_threshold(current_balance: u64, threshold: u64) -> ProgramResult {
    if current_balance >= threshold {
        return Err(ProgramError::Custom(ERR_KOL_NOT_LANDED));
    }
    Ok(())
}

/// Pure reserve bounds check shared by Mode B and native tests.
#[inline(always)]
pub fn check_reserve_bounds(reserve: u64, min_reserve: u64, max_reserve: u64) -> ProgramResult {
    if min_reserve > max_reserve || reserve < min_reserve || reserve > max_reserve {
        return Err(ProgramError::Custom(ERR_RESERVE_OUT_OF_BOUNDS));
    }
    Ok(())
}

/// Dynamically computes the buy size clamped within `[base_buy, max_buy]`.
/// Scales linearly from `base_buy` toward `max_buy` as the winning KOL's
/// balance drop (`delta = threshold - current_balance`) increases.
#[inline(always)]
pub fn compute_dynamic_buy(base_buy: u64, max_buy: u64, best_delta: u64) -> Result<u64, ProgramError> {
    if base_buy == 0 || base_buy > max_buy {
        return Err(ProgramError::InvalidInstructionData);
    }
    let span = max_buy - base_buy;
    if span == 0 || best_delta == 0 {
        return Ok(base_buy);
    }
    // Add 25% of the KOL's excess drop beyond threshold, capped at max_buy.
    let bonus = (best_delta >> 2).min(span);
    Ok(base_buy.saturating_add(bonus).min(max_buy))
}

/// Encodes the venue-specific CPI buy instruction into a fixed 32-byte stack buffer.
/// Returns the active byte slice length (`24` or `32`).
#[inline(always)]
pub fn encode_venue_buy(
    venue: u8,
    buy_amount: u64,
    min_tokens_out: u64,
    out: &mut [u8; 32],
) -> Result<usize, ProgramError> {
    match venue {
        VENUE_PUMPFUN => {
            // BuyExactQuoteInV3(quote_amount_in, min_tokens_out)
            out[0..8].copy_from_slice(&DISC_PUMPFUN_BUY_EXACT_QUOTE_V3);
            out[8..16].copy_from_slice(&buy_amount.to_le_bytes());
            out[16..24].copy_from_slice(&min_tokens_out.to_le_bytes());
            Ok(24)
        }
        VENUE_PUMPSWAP => {
            // Buy(base_amount_out, max_quote_amount_in)
            out[0..8].copy_from_slice(&DISC_PUMPSWAP_BUY);
            out[8..16].copy_from_slice(&min_tokens_out.to_le_bytes());
            out[16..24].copy_from_slice(&buy_amount.to_le_bytes());
            Ok(24)
        }
        VENUE_RAYDIUM_LAUNCHLAB => {
            // BuyExactIn(amount_in, minimum_amount_out, share_fee_rate = 0)
            out[0..8].copy_from_slice(&DISC_LAUNCHLAB_BUY_EXACT_IN);
            out[8..16].copy_from_slice(&buy_amount.to_le_bytes());
            out[16..24].copy_from_slice(&min_tokens_out.to_le_bytes());
            out[24..32].copy_from_slice(&0u64.to_le_bytes());
            Ok(32)
        }
        _ => Err(ProgramError::Custom(ERR_INVALID_VENUE)),
    }
}

/// Mode A — Standalone Guard (target < 200 CU).
#[inline(always)]
fn process_mode_a(accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() != MODE_A_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    if accounts.is_empty() {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let is_spl = (data[1] & 1) != 0;
    let threshold = u64::from_le_bytes([
        data[7], data[8], data[9], data[10], data[11], data[12], data[13], data[14],
    ]);
    let current = read_account_balance(&accounts[0], is_spl)?;
    check_balance_below_threshold(current, threshold)
}

/// Mode B — Multi-KOL Guard + CPI Buy Router (target < 700 CU on abort).
#[inline(always)]
fn process_mode_b(accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < MODE_B_HEADER_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let venue = data[1];
    let kol_count = data[2] as usize;
    if kol_count == 0 || kol_count > MAX_KOLS {
        return Err(ProgramError::Custom(ERR_INVALID_KOL_COUNT));
    }
    let expected_len = MODE_B_HEADER_LEN + kol_count * 8;
    if data.len() != expected_len {
        return Err(ProgramError::InvalidInstructionData);
    }
    // Need at least [target_program, pool_reserve_account, ...kol_accounts].
    if accounts.len() < 2 + kol_count {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let kol_flags = data[3];
    let kol_start = accounts.len() - kol_count;

    // 1. Multi-KOL balance-delta guard (runs FIRST for ultra-low CU abort < 700 CU).
    let mut triggered = false;
    let mut best_delta = 0u64;
    let mut i = 0;
    while i < kol_count {
        let is_spl = ((kol_flags >> i) & 1) != 0;
        let threshold = read_u64_le(data, MODE_B_HEADER_LEN + i * 8)?;
        let bal = read_account_balance(&accounts[kol_start + i], is_spl)?;
        if bal < threshold {
            triggered = true;
            let delta = threshold - bal;
            if delta > best_delta {
                best_delta = delta;
            }
        }
        i += 1;
    }
    if !triggered {
        return Err(ProgramError::Custom(ERR_KOL_NOT_LANDED));
    }

    // 2. Pool / bonding-curve quote-reserve bounds check.
    let reserve_is_data = (data[4] & 1) != 0;
    let reserve_offset = u16::from_le_bytes([data[5], data[6]]) as usize;
    let min_reserve = read_u64_le(data, 7)?;
    let max_reserve = read_u64_le(data, 15)?;
    let pool_acc = &accounts[1];
    let reserve = if reserve_is_data {
        let pool_data = pool_acc.try_borrow_data()?;
        read_u64_le(&pool_data, reserve_offset)?
    } else {
        pool_acc.lamports()
    };
    check_reserve_bounds(reserve, min_reserve, max_reserve)?;

    // 3. Dynamic buy sizing within [base_buy, max_buy].
    let base_buy = read_u64_le(data, 23)?;
    let max_buy = read_u64_le(data, 31)?;
    let min_tokens_out = read_u64_le(data, 39)?;
    let buy_amount = compute_dynamic_buy(base_buy, max_buy, best_delta)?;

    // 4. Encode venue CPI payload on stack and invoke target venue program.
    let mut ix_buf = [0u8; 32];
    let ix_len = encode_venue_buy(venue, buy_amount, min_tokens_out, &mut ix_buf)?;

    let target_program = &accounts[0];
    let cpi_slice = &accounts[2..kol_start];
    let cpi_len = cpi_slice.len();
    if cpi_len > MAX_CPI_ACCOUNTS {
        return Err(ProgramError::InvalidInstructionData);
    }

    // Build AccountMeta and &AccountInfo slices on the stack (zero heap allocation).
    let mut metas: [MaybeUninit<AccountMeta>; MAX_CPI_ACCOUNTS] =
        [const { MaybeUninit::uninit() }; MAX_CPI_ACCOUNTS];
    let mut infos: [MaybeUninit<&AccountInfo>; MAX_CPI_ACCOUNTS] =
        [const { MaybeUninit::uninit() }; MAX_CPI_ACCOUNTS];

    let mut j = 0;
    while j < cpi_len {
        let acc = &cpi_slice[j];
        metas[j].write(AccountMeta::from(acc));
        infos[j].write(acc);
        j += 1;
    }

    // SAFETY: First `cpi_len` elements of `metas` and `infos` were initialized above.
    let metas_slice = unsafe { core::slice::from_raw_parts(metas.as_ptr() as *const AccountMeta, cpi_len) };
    let infos_slice = unsafe { core::slice::from_raw_parts(infos.as_ptr() as *const &AccountInfo, cpi_len) };

    let ix = Instruction {
        program_id: target_program.key(),
        accounts: metas_slice,
        data: &ix_buf[..ix_len],
    };

    slice_invoke(&ix, infos_slice)
}

/// Program entrypoint.
#[inline(always)]
pub fn process_instruction(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let op = *instruction_data
        .first()
        .ok_or(ProgramError::InvalidInstructionData)?;
    match op {
        OP_STANDALONE_GUARD => process_mode_a(accounts, instruction_data),
        OP_MULTI_KOL_ROUTER => process_mode_b(accounts, instruction_data),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_a_guard_logic() {
        // KOL still has 10 SOL, threshold is 9.98 SOL -> abort Custom(1)
        let err = check_balance_below_threshold(10_000_000_000, 9_980_000_000).unwrap_err();
        assert_eq!(err, ProgramError::Custom(ERR_KOL_NOT_LANDED));

        // KOL spent 3 SOL (now 7 SOL < 9.98 SOL) -> pass
        check_balance_below_threshold(7_000_000_000, 9_980_000_000).unwrap();
    }

    #[test]
    fn reserve_bounds_and_dynamic_sizing() {
        assert_eq!(
            check_reserve_bounds(5_000_000_000, 10_000_000_000, 80_000_000_000).unwrap_err(),
            ProgramError::Custom(ERR_RESERVE_OUT_OF_BOUNDS)
        );
        assert_eq!(
            check_reserve_bounds(90_000_000_000, 10_000_000_000, 80_000_000_000).unwrap_err(),
            ProgramError::Custom(ERR_RESERVE_OUT_OF_BOUNDS)
        );
        check_reserve_bounds(35_000_000_000, 10_000_000_000, 80_000_000_000).unwrap();

        // Dynamic buy stays within [1 SOL, 4 SOL]
        let base = 1_000_000_000;
        let max = 4_000_000_000;
        assert_eq!(compute_dynamic_buy(base, max, 0).unwrap(), base);
        assert_eq!(compute_dynamic_buy(base, max, 2_000_000_000).unwrap(), 1_500_000_000);
        assert_eq!(compute_dynamic_buy(base, max, 50_000_000_000).unwrap(), max);
    }

    #[test]
    fn venue_encoding_lengths_and_discriminators() {
        let mut buf = [0u8; 32];
        assert_eq!(encode_venue_buy(VENUE_PUMPFUN, 2_000_000_000, 1000, &mut buf).unwrap(), 24);
        assert_eq!(&buf[0..8], &DISC_PUMPFUN_BUY_EXACT_QUOTE_V3);

        assert_eq!(encode_venue_buy(VENUE_PUMPSWAP, 2_000_000_000, 1000, &mut buf).unwrap(), 24);
        assert_eq!(&buf[0..8], &DISC_PUMPSWAP_BUY);

        assert_eq!(encode_venue_buy(VENUE_RAYDIUM_LAUNCHLAB, 2_000_000_000, 1000, &mut buf).unwrap(), 32);
        assert_eq!(&buf[0..8], &DISC_LAUNCHLAB_BUY_EXACT_IN);

        assert_eq!(
            encode_venue_buy(99, 1, 1, &mut buf).unwrap_err(),
            ProgramError::Custom(ERR_INVALID_VENUE)
        );
    }
}
