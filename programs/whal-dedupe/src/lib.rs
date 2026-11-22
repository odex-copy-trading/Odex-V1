//! Whal Bot — On-Chain Program #1: Ring-Buffer Dedupe & Slot-TTL Guard.
//!
//! Minimal, `no_std`, zero-allocation Pinocchio program (target < 3,000 CU).
//!
//! ## State Account Layout (fixed 2,564 bytes)
//! - `bytes[0..4]`    : `u32` LE circular write cursor (`0..63`)
//! - `bytes[4..2564]` : 64 fixed entries of 40 bytes each:
//!   - `entry[0..32]` : 32-byte `opportunity_key`
//!   - `entry[32..40]`: `u64` LE `recorded_slot`
//!
//! ## Accounts
//! - `[0]` (writable) `state_account` — owned by this program, exact length 2,564 bytes
//! - `[1]` (signer)   `authority`     — must match [`AUTHORIZED_BOT_PUBKEY`]
//!
//! ## Instructions
//! - `0x00` (`Initialize`, 1 byte): zero-initializes the 2,564-byte state account.
//! - `0x01` (`CheckAndLock`, 41 bytes):
//!   - `byte[0]`      : `0x01`
//!   - `bytes[1..33]` : 32-byte unique `opportunity_key`
//!   - `bytes[33..41]`: `u64` LE `max_slot`

#![no_std]
#![allow(unexpected_cfgs)]

#[cfg(test)]
extern crate std;

use pinocchio::{
    account_info::AccountInfo,
    no_allocator,
    nostd_panic_handler,
    program_entrypoint,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

#[cfg(all(not(feature = "no-entrypoint"), not(test)))]
program_entrypoint!(process_instruction);

#[cfg(all(not(feature = "no-entrypoint"), not(test)))]
no_allocator!();

#[cfg(all(not(feature = "no-entrypoint"), not(test)))]
nostd_panic_handler!();

/// Number of slots in the circular ring buffer.
pub const RING_CAP: usize = 64;
/// Byte size of a single ring entry: 32-byte opportunity_key + 8-byte u64 LE recorded_slot.
pub const ENTRY_LEN: usize = 40;
/// Byte offset where the 64-entry ring starts (immediately after the 4-byte u32 LE cursor).
pub const HEADER_LEN: usize = 4;
/// Exact required size of the state account in bytes: `4 + 64 * 40 = 2,564`.
pub const STATE_LEN: usize = HEADER_LEN + RING_CAP * ENTRY_LEN;

/// Instruction discriminators.
pub const IX_INITIALIZE: u8 = 0x00;
pub const IX_CHECK_AND_LOCK: u8 = 0x01;
/// Exact byte length of a `CheckAndLock` instruction payload.
pub const CHECK_AND_LOCK_DATA_LEN: usize = 1 + 32 + 8;

/// Custom program error codes.
pub const ERR_DUPLICATE: u32 = 1;
pub const ERR_TIMED_OUT: u32 = 2;
pub const ERR_UNAUTHORIZED: u32 = 3;

/// Authorized hot-wallet / bot signer public key.
/// Replace with the deployment hot wallet pubkey before building for mainnet.
pub const AUTHORIZED_BOT_PUBKEY: Pubkey = [
    0x57, 0x48, 0x41, 0x4c, 0x5f, 0x42, 0x4f, 0x54,
    0x5f, 0x41, 0x55, 0x54, 0x48, 0x5f, 0x4b, 0x45,
    0x59, 0x5f, 0x56, 0x31, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
];

/// Fast 32-byte equality using four `u64` comparisons with immediate short-circuit.
/// Compiles to minimal SBF loads/branches (~4–8 CU per non-matching entry).
#[inline(always)]
fn eq32(a: &[u8], b: &[u8; 32]) -> bool {
    // SAFETY: Caller guarantees `a.len() >= 32`. Using unaligned u64 reads avoids
    // alignment traps and lets LLVM emit 4 `ldxdw` + `jne` pairs on SBF.
    unsafe {
        let pa = a.as_ptr() as *const u64;
        let pb = b.as_ptr() as *const u64;
        pa.read_unaligned() == pb.read_unaligned()
            && pa.add(1).read_unaligned() == pb.add(1).read_unaligned()
            && pa.add(2).read_unaligned() == pb.add(2).read_unaligned()
            && pa.add(3).read_unaligned() == pb.add(3).read_unaligned()
    }
}

/// Zero-initializes the 2,564-byte ring-buffer state account.
#[inline(always)]
pub fn initialize_state(data: &mut [u8]) -> ProgramResult {
    if data.len() != STATE_LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    data.fill(0);
    Ok(())
}

/// Core `CheckAndLock` state transition:
/// 1. Rejects if `current_slot > max_slot` with `Custom(2)` (`TimedOut`).
/// 2. Scans all 64 entries; rejects if any 32-byte key matches with `Custom(1)` (`Duplicate`).
/// 3. Writes `(opportunity_key, current_slot)` at `entry[cursor % 64]` and advances `cursor = (cursor + 1) % 64`.
#[inline(always)]
pub fn check_and_lock_state(
    data: &mut [u8],
    opportunity_key: &[u8; 32],
    max_slot: u64,
    current_slot: u64,
) -> ProgramResult {
    if data.len() != STATE_LEN {
        return Err(ProgramError::InvalidAccountData);
    }

    // 1. Slot-TTL guard (cheapest check first — fails fast before scanning).
    if current_slot > max_slot {
        return Err(ProgramError::Custom(ERR_TIMED_OUT));
    }

    // Reject an all-zero key so uninitialized ring slots never collide with a real key.
    if eq32(opportunity_key, &[0u8; 32]) {
        return Err(ProgramError::InvalidInstructionData);
    }

    // 2. Linear scan of all 64 fixed 40-byte entries.
    let mut offset = HEADER_LEN;
    let mut i = 0;
    while i < RING_CAP {
        if eq32(&data[offset..offset + 32], opportunity_key) {
            return Err(ProgramError::Custom(ERR_DUPLICATE));
        }
        offset += ENTRY_LEN;
        i += 1;
    }

    // 3. Write (opportunity_key, current_slot) at cursor % 64 and advance cursor.
    let cursor = u32::from_le_bytes([data[0], data[1], data[2], data[3]]) as usize % RING_CAP;
    let write_off = HEADER_LEN + cursor * ENTRY_LEN;
    data[write_off..write_off + 32].copy_from_slice(opportunity_key);
    data[write_off + 32..write_off + 40].copy_from_slice(&current_slot.to_le_bytes());

    let next_cursor = ((cursor + 1) % RING_CAP) as u32;
    data[0..4].copy_from_slice(&next_cursor.to_le_bytes());

    Ok(())
}

/// Program entrypoint.
#[inline(always)]
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    // Expect at least [state_account, authority].
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let state_acc = &accounts[0];
    let authority = &accounts[1];

    // Verify authority is signer and matches authorized bot pubkey.
    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !eq32(authority.key().as_ref(), &AUTHORIZED_BOT_PUBKEY) {
        return Err(ProgramError::Custom(ERR_UNAUTHORIZED));
    }

    // Verify state account ownership, writability, and exact 2,564-byte size.
    if !state_acc.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }
    if !state_acc.is_owned_by(program_id) {
        return Err(ProgramError::IncorrectProgramId);
    }
    if state_acc.data_len() != STATE_LEN {
        return Err(ProgramError::InvalidAccountData);
    }

    let (&disc, rest) = instruction_data
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;

    // SAFETY: We verified ownership, writability, and single mutable borrow scope.
    let mut data = state_acc.try_borrow_mut_data()?;

    match disc {
        IX_INITIALIZE => {
            if !rest.is_empty() {
                return Err(ProgramError::InvalidInstructionData);
            }
            initialize_state(&mut data)
        }
        IX_CHECK_AND_LOCK => {
            if instruction_data.len() != CHECK_AND_LOCK_DATA_LEN {
                return Err(ProgramError::InvalidInstructionData);
            }
            let key: &[u8; 32] = rest[0..32]
                .try_into()
                .map_err(|_| ProgramError::InvalidInstructionData)?;
            let max_slot = u64::from_le_bytes(
                rest[32..40]
                    .try_into()
                    .map_err(|_| ProgramError::InvalidInstructionData)?,
            );

            // Read current slot via sol_get_clock_sysvar.
            let current_slot = Clock::get()?.slot;

            check_and_lock_state(&mut data, key, max_slot, current_slot)
        }
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key_for(n: u32) -> [u8; 32] {
        let mut k = [0u8; 32];
        k[0..4].copy_from_slice(&n.to_le_bytes());
        k[31] = 0xAA;
        k
    }

    #[test]
    fn first_tx_succeeds_and_writes_slot() {
        let mut buf = [0xFFu8; STATE_LEN];
        initialize_state(&mut buf).unwrap();
        assert_eq!(u32::from_le_bytes(buf[0..4].try_into().unwrap()), 0);

        let k = key_for(1);
        check_and_lock_state(&mut buf, &k, 105, 100).unwrap();

        assert_eq!(u32::from_le_bytes(buf[0..4].try_into().unwrap()), 1);
        assert_eq!(&buf[HEADER_LEN..HEADER_LEN + 32], &k);
        assert_eq!(
            u64::from_le_bytes(buf[HEADER_LEN + 32..HEADER_LEN + 40].try_into().unwrap()),
            100
        );
    }

    #[test]
    fn duplicate_key_fails_with_custom_1() {
        let mut buf = [0u8; STATE_LEN];
        let k = key_for(42);
        check_and_lock_state(&mut buf, &k, 200, 198).unwrap();
        let err = check_and_lock_state(&mut buf, &k, 200, 198).unwrap_err();
        assert_eq!(err, ProgramError::Custom(ERR_DUPLICATE));
    }

    #[test]
    fn expired_slot_fails_with_custom_2() {
        let mut buf = [0u8; STATE_LEN];
        let k = key_for(7);
        let err = check_and_lock_state(&mut buf, &k, 100, 101).unwrap_err();
        assert_eq!(err, ProgramError::Custom(ERR_TIMED_OUT));
    }

    #[test]
    fn ring_buffer_wraps_cleanly_after_64_entries() {
        let mut buf = [0u8; STATE_LEN];
        for i in 0..64u32 {
            check_and_lock_state(&mut buf, &key_for(i + 1), 1000, 500 + i as u64).unwrap();
        }
        // Cursor wrapped back to 0.
        assert_eq!(u32::from_le_bytes(buf[0..4].try_into().unwrap()), 0);

        // 65th entry overwrites slot 0 (key_for(1)) and sets cursor to 1.
        let k65 = key_for(65);
        check_and_lock_state(&mut buf, &k65, 1000, 600).unwrap();
        assert_eq!(u32::from_le_bytes(buf[0..4].try_into().unwrap()), 1);
        assert_eq!(&buf[HEADER_LEN..HEADER_LEN + 32], &k65);
        assert_eq!(
            u64::from_le_bytes(buf[HEADER_LEN + 32..HEADER_LEN + 40].try_into().unwrap()),
            600
        );

        // Evicted key_for(1) is no longer in the ring and can be inserted again.
        check_and_lock_state(&mut buf, &key_for(1), 1000, 601).unwrap();
        assert_eq!(u32::from_le_bytes(buf[0..4].try_into().unwrap()), 2);
    }
}
