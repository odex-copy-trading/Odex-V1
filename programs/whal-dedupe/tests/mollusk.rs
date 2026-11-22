//! Mollusk SVM integration tests for `whal-dedupe`.
//!
//! Build the SBF program first, then run:
//! ```bash
//! cargo build-sbf
//! SBF_OUT_DIR=target/deploy cargo test --test mollusk -- --nocapture
//! ```

use mollusk_svm::Mollusk;
use solana_sdk::{
    account::Account,
    instruction::{AccountMeta, Instruction, InstructionError},
    pubkey::Pubkey,
};
use whal_dedupe::{
    AUTHORIZED_BOT_PUBKEY, ENTRY_LEN, ERR_DUPLICATE, ERR_TIMED_OUT, ERR_UNAUTHORIZED, HEADER_LEN,
    IX_CHECK_AND_LOCK, IX_INITIALIZE, RING_CAP, STATE_LEN,
};

const MAX_CU_BUDGET: u64 = 3_000;

fn program_id() -> Pubkey {
    Pubkey::new_from_array([0xDD; 32])
}

fn authority_pubkey() -> Pubkey {
    Pubkey::new_from_array(AUTHORIZED_BOT_PUBKEY)
}

fn make_key(n: u32) -> [u8; 32] {
    let mut k = [0u8; 32];
    k[0..4].copy_from_slice(&n.to_le_bytes());
    k[31] = 0x55;
    k
}

fn ix_initialize(pid: Pubkey, state: Pubkey, authority: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        pid,
        &[IX_INITIALIZE],
        vec![
            AccountMeta::new(state, false),
            AccountMeta::new_readonly(authority, true),
        ],
    )
}

fn ix_check_and_lock(
    pid: Pubkey,
    state: Pubkey,
    authority: Pubkey,
    key: &[u8; 32],
    max_slot: u64,
) -> Instruction {
    let mut data = Vec::with_capacity(41);
    data.push(IX_CHECK_AND_LOCK);
    data.extend_from_slice(key);
    data.extend_from_slice(&max_slot.to_le_bytes());
    Instruction::new_with_bytes(
        pid,
        &data,
        vec![
            AccountMeta::new(state, false),
            AccountMeta::new_readonly(authority, true),
        ],
    )
}

fn state_account(pid: Pubkey, data: Vec<u8>) -> Account {
    Account {
        lamports: 20_000_000,
        data,
        owner: pid,
        executable: false,
        rent_epoch: 0,
    }
}

fn signer_account() -> Account {
    Account {
        lamports: 1_000_000_000,
        data: vec![],
        owner: solana_sdk::system_program::id(),
        executable: false,
        rent_epoch: 0,
    }
}

#[test]
fn a_first_tx_succeeds_writes_slot_and_stays_under_3000_cu() {
    let pid = program_id();
    let state_pk = Pubkey::new_unique();
    let auth_pk = authority_pubkey();

    let mut mollusk = Mollusk::new(&pid, "whal_dedupe");
    mollusk.sysvars.clock.slot = 383_000_100;

    // Initialize dirty buffer
    let init_res = mollusk.process_instruction(
        &ix_initialize(pid, state_pk, auth_pk),
        &[
            (state_pk, state_account(pid, vec![0xFF; STATE_LEN])),
            (auth_pk, signer_account()),
        ],
    );
    assert!(init_res.raw_result.is_ok(), "initialize failed: {:?}", init_res.raw_result);
    assert!(
        init_res.compute_units_consumed < MAX_CU_BUDGET,
        "Initialize CU {} >= {}",
        init_res.compute_units_consumed,
        MAX_CU_BUDGET
    );
    let zeroed_state = init_res.resulting_accounts[0].1.clone();
    assert!(zeroed_state.data.iter().all(|&b| b == 0));

    // CheckAndLock first key
    let key = make_key(1);
    let res = mollusk.process_instruction(
        &ix_check_and_lock(pid, state_pk, auth_pk, &key, 383_000_104),
        &[(state_pk, zeroed_state), (auth_pk, signer_account())],
    );
    assert!(res.raw_result.is_ok(), "CheckAndLock failed: {:?}", res.raw_result);
    assert!(
        res.compute_units_consumed < MAX_CU_BUDGET,
        "CheckAndLock CU {} >= {}",
        res.compute_units_consumed,
        MAX_CU_BUDGET
    );

    let out = &res.resulting_accounts[0].1.data;
    assert_eq!(u32::from_le_bytes(out[0..4].try_into().unwrap()), 1);
    assert_eq!(&out[HEADER_LEN..HEADER_LEN + 32], &key);
    assert_eq!(
        u64::from_le_bytes(out[HEADER_LEN + 32..HEADER_LEN + 40].try_into().unwrap()),
        383_000_100
    );
}

#[test]
fn b_second_tx_same_key_in_same_slot_fails_with_custom_1() {
    let pid = program_id();
    let state_pk = Pubkey::new_unique();
    let auth_pk = authority_pubkey();

    let mut mollusk = Mollusk::new(&pid, "whal_dedupe");
    mollusk.sysvars.clock.slot = 500_000;

    let key = make_key(99);
    let first = mollusk.process_instruction(
        &ix_check_and_lock(pid, state_pk, auth_pk, &key, 500_004),
        &[
            (state_pk, state_account(pid, vec![0; STATE_LEN])),
            (auth_pk, signer_account()),
        ],
    );
    assert!(first.raw_result.is_ok());
    let updated_state = first.resulting_accounts[0].1.clone();

    let second = mollusk.process_instruction(
        &ix_check_and_lock(pid, state_pk, auth_pk, &key, 500_004),
        &[(state_pk, updated_state), (auth_pk, signer_account())],
    );
    assert_eq!(
        second.raw_result,
        Err(InstructionError::Custom(ERR_DUPLICATE))
    );
    assert!(
        second.compute_units_consumed < MAX_CU_BUDGET,
        "Duplicate reject CU {} >= {}",
        second.compute_units_consumed,
        MAX_CU_BUDGET
    );
}

#[test]
fn c_tx_after_max_slot_fails_with_custom_2() {
    let pid = program_id();
    let state_pk = Pubkey::new_unique();
    let auth_pk = authority_pubkey();

    let mut mollusk = Mollusk::new(&pid, "whal_dedupe");
    mollusk.sysvars.clock.slot = 500_005;

    let key = make_key(77);
    let res = mollusk.process_instruction(
        &ix_check_and_lock(pid, state_pk, auth_pk, &key, 500_004),
        &[
            (state_pk, state_account(pid, vec![0; STATE_LEN])),
            (auth_pk, signer_account()),
        ],
    );
    assert_eq!(
        res.raw_result,
        Err(InstructionError::Custom(ERR_TIMED_OUT))
    );
    assert!(
        res.compute_units_consumed < MAX_CU_BUDGET,
        "TimedOut reject CU {} >= {}",
        res.compute_units_consumed,
        MAX_CU_BUDGET
    );
}

#[test]
fn d_ring_buffer_wraps_cleanly_after_64_entries_and_e_cu_under_3000() {
    let pid = program_id();
    let state_pk = Pubkey::new_unique();
    let auth_pk = authority_pubkey();

    let mut mollusk = Mollusk::new(&pid, "whal_dedupe");
    let mut state = state_account(pid, vec![0; STATE_LEN]);
    let mut max_cu = 0u64;

    // Fill all 64 slots
    for i in 0..RING_CAP as u32 {
        let slot = 700_000 + i as u64;
        mollusk.sysvars.clock.slot = slot;
        let res = mollusk.process_instruction(
            &ix_check_and_lock(pid, state_pk, auth_pk, &make_key(i + 1), slot + 4),
            &[(state_pk, state), (auth_pk, signer_account())],
        );
        assert!(res.raw_result.is_ok(), "insert {} failed: {:?}", i, res.raw_result);
        max_cu = max_cu.max(res.compute_units_consumed);
        state = res.resulting_accounts[0].1.clone();
    }

    assert_eq!(u32::from_le_bytes(state.data[0..4].try_into().unwrap()), 0);

    // 65th insert wraps cleanly to entry 0, evicting key(1)
    mollusk.sysvars.clock.slot = 700_100;
    let key65 = make_key(65);
    let wrap = mollusk.process_instruction(
        &ix_check_and_lock(pid, state_pk, auth_pk, &key65, 700_104),
        &[(state_pk, state), (auth_pk, signer_account())],
    );
    assert!(wrap.raw_result.is_ok());
    max_cu = max_cu.max(wrap.compute_units_consumed);
    state = wrap.resulting_accounts[0].1.clone();

    assert_eq!(u32::from_le_bytes(state.data[0..4].try_into().unwrap()), 1);
    assert_eq!(&state.data[HEADER_LEN..HEADER_LEN + 32], &key65);
    assert_eq!(
        u64::from_le_bytes(state.data[HEADER_LEN + 32..HEADER_LEN + ENTRY_LEN].try_into().unwrap()),
        700_100
    );

    // Evicted key(1) can now be locked again
    mollusk.sysvars.clock.slot = 700_101;
    let reinsert = mollusk.process_instruction(
        &ix_check_and_lock(pid, state_pk, auth_pk, &make_key(1), 700_105),
        &[(state_pk, state), (auth_pk, signer_account())],
    );
    assert!(reinsert.raw_result.is_ok());
    max_cu = max_cu.max(reinsert.compute_units_consumed);

    assert!(
        max_cu < MAX_CU_BUDGET,
        "Worst-case CU {} exceeded budget {}",
        max_cu,
        MAX_CU_BUDGET
    );
}

#[test]
fn unauthorized_caller_is_rejected() {
    let pid = program_id();
    let state_pk = Pubkey::new_unique();
    let attacker_pk = Pubkey::new_unique();

    let mut mollusk = Mollusk::new(&pid, "whal_dedupe");
    mollusk.sysvars.clock.slot = 100;

    let res = mollusk.process_instruction(
        &ix_check_and_lock(pid, state_pk, attacker_pk, &make_key(1), 105),
        &[
            (state_pk, state_account(pid, vec![0; STATE_LEN])),
            (attacker_pk, signer_account()),
        ],
    );
    assert_eq!(
        res.raw_result,
        Err(InstructionError::Custom(ERR_UNAUTHORIZED))
    );
}
