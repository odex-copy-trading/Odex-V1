//! Generic-quote balance guard and SPL Token / Token-2022 `TransferChecked` support.

use pinocchio::{
    account_info::AccountInfo,
    cpi::slice_invoke,
    instruction::{AccountMeta, Instruction},
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

/// SPL Token & Token-2022 account `amount` field offset (`bytes[64..72]`).
pub const SPL_AMOUNT_OFFSET: usize = 64;
pub const SPL_ACCOUNT_MIN_LEN: usize = 72;

/// Maximum trailing KOL token accounts supported in a single instruction.
pub const MAX_KOLS: usize = 8;

/// Error codes.
pub const ERR_KOL_NOT_LANDED: u32 = 1;
pub const ERR_ZERO_QUOTE_BALANCE: u32 = 2;
pub const ERR_INVALID_KOL_COUNT: u32 = 3;
pub const ERR_INVALID_TOKEN_PROGRAM: u32 = 4;

/// Classic SPL Token Program ID (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`).
pub const SPL_TOKEN_PROGRAM_ID: Pubkey = [
    0x06, 0xdd, 0xf6, 0xe1, 0xd7, 0x65, 0xa1, 0x93,
    0xd9, 0xcb, 0xe1, 0x46, 0xce, 0xeb, 0x79, 0xac,
    0x1c, 0xb4, 0x85, 0xed, 0x5f, 0x5b, 0x37, 0x91,
    0x3a, 0x8c, 0xf5, 0x85, 0x7e, 0xff, 0x00, 0xa9,
];

/// Token-2022 Program ID (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`).
pub const TOKEN_2022_PROGRAM_ID: Pubkey = [
    0x06, 0xdd, 0xf6, 0xe1, 0xee, 0x75, 0x8f, 0xde,
    0x18, 0x42, 0x5d, 0xbc, 0xe4, 0x6c, 0xcd, 0xda,
    0xb6, 0x1a, 0xfc, 0x4d, 0x83, 0xb9, 0x0d, 0x27,
    0xfe, 0xbd, 0xf9, 0x28, 0xd8, 0xa1, 0x8b, 0xfc,
];

/// SPL Token / Token-2022 `TransferChecked` instruction discriminator (opcode 12).
pub const TOKEN_IX_TRANSFER_CHECKED: u8 = 12;

#[inline(always)]
pub fn read_u64_le(buf: &[u8], off: usize) -> Result<u64, ProgramError> {
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

/// Validates that `program_id` is either SPL Token or Token-2022.
#[inline(always)]
pub fn is_supported_token_program(program_id: &Pubkey) -> bool {
    program_id == &SPL_TOKEN_PROGRAM_ID || program_id == &TOKEN_2022_PROGRAM_ID
}

/// Reads the live SPL Token or Token-2022 balance at `data[64..72]`.
#[inline(always)]
pub fn read_token_amount(acc: &AccountInfo) -> Result<u64, ProgramError> {
    let data = acc.try_borrow_data()?;
    if data.len() < SPL_ACCOUNT_MIN_LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    read_u64_le(&data, SPL_AMOUNT_OFFSET)
}

/// Verifies at least one trailing KOL token account has dropped below its pre-computed
/// threshold (`kol_pre_balance - margin`). Aborts with `Custom(1)` if none triggered.
#[inline(always)]
pub fn verify_kol_token_thresholds(
    kol_accounts: &[AccountInfo],
    threshold_bytes: &[u8],
) -> ProgramResult {
    let n = kol_accounts.len();
    if n == 0 || n > MAX_KOLS {
        return Err(ProgramError::Custom(ERR_INVALID_KOL_COUNT));
    }
    if threshold_bytes.len() < n * 8 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let mut triggered = false;
    let mut i = 0;
    while i < n {
        let threshold = read_u64_le(threshold_bytes, i * 8)?;
        let current = read_token_amount(&kol_accounts[i])?;
        if current < threshold {
            triggered = true;
            break;
        }
        i += 1;
    }

    if !triggered {
        return Err(ProgramError::Custom(ERR_KOL_NOT_LANDED));
    }
    Ok(())
}

/// Encodes an SPL Token / Token-2022 `TransferChecked` instruction payload (10 bytes):
/// `[12u8 | amount (u64 LE) | decimals (u8)]`.
#[inline(always)]
pub fn encode_transfer_checked(amount: u64, decimals: u8) -> [u8; 10] {
    let mut buf = [0u8; 10];
    buf[0] = TOKEN_IX_TRANSFER_CHECKED;
    buf[1..9].copy_from_slice(&amount.to_le_bytes());
    buf[9] = decimals;
    buf
}

/// Invokes SPL Token or Token-2022 `TransferChecked` via zero-allocation stack CPI.
#[inline(always)]
pub fn invoke_transfer_checked(
    token_program: &AccountInfo,
    source: &AccountInfo,
    mint: &AccountInfo,
    destination: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
    decimals: u8,
) -> ProgramResult {
    if !is_supported_token_program(token_program.key()) {
        return Err(ProgramError::Custom(ERR_INVALID_TOKEN_PROGRAM));
    }
    let data = encode_transfer_checked(amount, decimals);
    let metas = [
        AccountMeta::writable(source.key()),
        AccountMeta::readonly(mint.key()),
        AccountMeta::writable(destination.key()),
        AccountMeta::readonly_signer(authority.key()),
    ];
    let ix = Instruction {
        program_id: token_program.key(),
        accounts: &metas,
        data: &data,
    };
    slice_invoke(&ix, &[source, mint, destination, authority])
}
