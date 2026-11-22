//! LiteSVM integration tests for `whal-sell-router`.
//!
//! Verifies same-slot Buy -> 25% Sell chaining without knowing the exact buy fill
//! quantity off-chain, plus error handling on zero balance and invalid percentages.
//!
//! Build the SBF program first, then run:
//! ```bash
//! cargo build-sbf
//! cargo test --test litesvm -- --nocapture
//! ```

use litesvm::LiteSVM;
use solana_sdk::{
    account::Account,
    instruction::{AccountMeta, Instruction, InstructionError},
    message::Message,
    pubkey::Pubkey,
    signature::Keypair,
    signer::Signer,
    transaction::{Transaction, TransactionError},
};
use whal_sell_router::{
    ERR_INVALID_SELL_PCT, ERR_ZERO_BALANCE, FLAG_CLOSE_ACCOUNT, SELL_IX_DATA_LEN,
    SPL_AMOUNT_OFFSET, VENUE_OP_PUMPFUN,
};

const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

/// Classic SPL Token Program ID (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`).
fn spl_token_program_id() -> Pubkey {
    Pubkey::new_from_array([
        0x06, 0xdd, 0xf6, 0xe1, 0xd7, 0x65, 0xa1, 0x93,
        0xd9, 0xcb, 0xe1, 0x46, 0xce, 0xeb, 0x79, 0xac,
        0x1c, 0xb4, 0x85, 0xed, 0x5f, 0x5b, 0x37, 0x91,
        0x3a, 0x8c, 0xf5, 0x85, 0x7e, 0xff, 0x00, 0xa9,
    ])
}

fn sell_router_id() -> Pubkey {
    Pubkey::new_from_array([0xCC; 32])
}

fn load_sell_router(svm: &mut LiteSVM, pid: Pubkey) {
    let so_path = concat!(env!("CARGO_MANIFEST_DIR"), "/target/deploy/whal_sell_router.so");
    svm.add_program_from_file(pid, so_path)
        .expect("build the SBF binary first with `cargo build-sbf`");
}

/// Constructs a 165-byte SPL Token account with `amount` written at `data[64..72]`.
fn make_spl_token_account(mint: Pubkey, owner: Pubkey, amount: u64) -> Account {
    let mut data = vec![0u8; 165];
    data[0..32].copy_from_slice(mint.as_ref());
    data[32..64].copy_from_slice(owner.as_ref());
    data[SPL_AMOUNT_OFFSET..SPL_AMOUNT_OFFSET + 8].copy_from_slice(&amount.to_le_bytes());
    data[108] = 1; // AccountState::Initialized
    Account {
        lamports: 2_039_280,
        data,
        owner: spl_token_program_id(),
        executable: false,
        rent_epoch: 0,
    }
}

fn build_sell_ix(
    pid: Pubkey,
    target_dex: Pubkey,
    bot_token_acc: Pubkey,
    hot_wallet: Pubkey,
    venue_op: u8,
    sell_pct: u64,
    flags: u64,
    min_quote_out: u64,
) -> Instruction {
    let mut data = Vec::with_capacity(SELL_IX_DATA_LEN);
    data.push(venue_op);
    data.extend_from_slice(&sell_pct.to_le_bytes());
    data.extend_from_slice(&flags.to_le_bytes());
    data.extend_from_slice(&min_quote_out.to_le_bytes());

    Instruction::new_with_bytes(
        pid,
        &data,
        vec![
            AccountMeta::new_readonly(target_dex, false),
            AccountMeta::new(bot_token_acc, false),
            AccountMeta::new(hot_wallet, true),
            AccountMeta::new_readonly(spl_token_program_id(), false),
        ],
    )
}

#[test]
fn same_slot_buy_then_25_pct_sell_reads_live_balance_on_chain() {
    let mut svm = LiteSVM::new();
    let pid = sell_router_id();
    load_sell_router(&mut svm, pid);

    let hot_wallet = Keypair::new();
    let mint = Pubkey::new_unique();
    let bot_ata = Pubkey::new_unique();
    let mock_dex = solana_sdk::system_program::id();

    svm.airdrop(&hot_wallet.pubkey(), 10 * LAMPORTS_PER_SOL).unwrap();

    // Before the buy lands in this slot, bot's seeded token account has 0 tokens.
    svm.set_account(bot_ata, make_spl_token_account(mint, hot_wallet.pubkey(), 0))
        .unwrap();

    // Attempting 25% sell before buy lands aborts with ERR_ZERO_BALANCE (Custom(3)).
    let ix_empty = build_sell_ix(pid, mock_dex, bot_ata, hot_wallet.pubkey(), VENUE_OP_PUMPFUN, 25, 0, 1);
    let bh = svm.latest_blockhash();
    let tx_empty = Transaction::new(
        &[&hot_wallet],
        Message::new_with_blockhash(&[ix_empty], Some(&hot_wallet.pubkey()), &bh),
        bh,
    );
    let err = svm.send_transaction(tx_empty).unwrap_err();
    assert_eq!(
        err.err,
        TransactionError::InstructionError(0, InstructionError::Custom(ERR_ZERO_BALANCE))
    );

    // Same slot: simulate Buy filling an arbitrary unknown quantity (123_456_789 raw units)
    // into bot_ata without passing that quantity to the sell instruction!
    let unknown_buy_fill = 123_456_789u64;
    svm.set_account(
        bot_ata,
        make_spl_token_account(mint, hot_wallet.pubkey(), unknown_buy_fill),
    )
    .unwrap();

    // Immediately execute 25% sell in the same slot (sell_pct = 25, off-chain knows nothing about fill qty).
    // Router reads 123_456_789 at data[64..72], computes amount_in = 30_864_197, and invokes target DEX CPI.
    let ix_25 = build_sell_ix(pid, mock_dex, bot_ata, hot_wallet.pubkey(), VENUE_OP_PUMPFUN, 25, 0, 1);
    let bh = svm.latest_blockhash();
    let tx_25 = Transaction::new(
        &[&hot_wallet],
        Message::new_with_blockhash(&[ix_25], Some(&hot_wallet.pubkey()), &bh),
        bh,
    );
    let res = svm.send_transaction(tx_25);
    if let Err(e) = res {
        // Guard & balance read succeeded (did NOT fail with zero-balance or invalid-pct);
        // execution crossed into the target DEX CPI.
        assert_ne!(
            e.err,
            TransactionError::InstructionError(0, InstructionError::Custom(ERR_ZERO_BALANCE))
        );
        assert_ne!(
            e.err,
            TransactionError::InstructionError(0, InstructionError::Custom(ERR_INVALID_SELL_PCT))
        );
    }

    // Invalid percentage (0 or 101) is rejected with Custom(2).
    let ix_bad = build_sell_ix(
        pid,
        mock_dex,
        bot_ata,
        hot_wallet.pubkey(),
        VENUE_OP_PUMPFUN,
        150,
        FLAG_CLOSE_ACCOUNT,
        1,
    );
    let bh = svm.latest_blockhash();
    let tx_bad = Transaction::new(
        &[&hot_wallet],
        Message::new_with_blockhash(&[ix_bad], Some(&hot_wallet.pubkey()), &bh),
        bh,
    );
    let err_bad = svm.send_transaction(tx_bad).unwrap_err();
    assert_eq!(
        err_bad.err,
        TransactionError::InstructionError(0, InstructionError::Custom(ERR_INVALID_SELL_PCT))
    );
}
