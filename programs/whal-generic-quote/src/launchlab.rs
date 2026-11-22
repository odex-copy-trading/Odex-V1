//! Raydium LaunchLab `BuyExactIn` CPI encoder and stack-allocated invoker.

use core::mem::MaybeUninit;
use pinocchio::{
    account_info::AccountInfo,
    cpi::slice_invoke,
    instruction::{AccountMeta, Instruction},
    program_error::ProgramError,
    ProgramResult,
};

/// Maximum accounts forwarded to Raydium LaunchLab `BuyExactIn`.
pub const MAX_CPI_ACCOUNTS: usize = 24;

/// Raydium LaunchLab `buy_exact_in` 8-byte Anchor discriminator.
pub const DISC_LAUNCHLAB_BUY_EXACT_IN: [u8; 8] = [0xfa, 0xea, 0x0d, 0x7b, 0xd5, 0x9c, 0x13, 0xec];

/// Encodes Raydium LaunchLab `BuyExactIn` instruction data (32 bytes):
/// `[8B disc | amount_in (u64 LE) | minimum_amount_out (u64 LE) | share_fee_rate (u64 LE)]`.
#[inline(always)]
pub fn encode_buy_exact_in(
    amount_in: u64,
    minimum_amount_out: u64,
    share_fee_rate: u64,
) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[0..8].copy_from_slice(&DISC_LAUNCHLAB_BUY_EXACT_IN);
    out[8..16].copy_from_slice(&amount_in.to_le_bytes());
    out[16..24].copy_from_slice(&minimum_amount_out.to_le_bytes());
    out[24..32].copy_from_slice(&share_fee_rate.to_le_bytes());
    out
}

/// Executes a zero-allocation stack CPI into Raydium LaunchLab `BuyExactIn`.
#[inline(always)]
pub fn invoke_buy_exact_in(
    launchlab_program: &AccountInfo,
    cpi_accounts: &[AccountInfo],
    amount_in: u64,
    minimum_amount_out: u64,
    share_fee_rate: u64,
) -> ProgramResult {
    let n = cpi_accounts.len();
    if n == 0 || n > MAX_CPI_ACCOUNTS {
        return Err(ProgramError::InvalidInstructionData);
    }

    let data = encode_buy_exact_in(amount_in, minimum_amount_out, share_fee_rate);

    let mut metas: [MaybeUninit<AccountMeta>; MAX_CPI_ACCOUNTS] =
        [const { MaybeUninit::uninit() }; MAX_CPI_ACCOUNTS];
    let mut infos: [MaybeUninit<&AccountInfo>; MAX_CPI_ACCOUNTS] =
        [const { MaybeUninit::uninit() }; MAX_CPI_ACCOUNTS];

    let mut i = 0;
    while i < n {
        let acc = &cpi_accounts[i];
        metas[i].write(AccountMeta::from(acc));
        infos[i].write(acc);
        i += 1;
    }

    // SAFETY: First `n` entries of `metas` and `infos` were initialized above.
    let metas_slice = unsafe { core::slice::from_raw_parts(metas.as_ptr() as *const AccountMeta, n) };
    let infos_slice = unsafe { core::slice::from_raw_parts(infos.as_ptr() as *const &AccountInfo, n) };

    let ix = Instruction {
        program_id: launchlab_program.key(),
        accounts: metas_slice,
        data: &data,
    };
    slice_invoke(&ix, infos_slice)
}
