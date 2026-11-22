//! Raydium CPMM `SwapBaseInput` (`venue_op = 11`) CPI encoder.

/// Raydium CPMM `swap_base_input` 8-byte Anchor discriminator.
pub const DISC_RAYDIUM_CPMM_SWAP_BASE_IN: [u8; 8] = [0x8f, 0xbe, 0x5a, 0xda, 0xc4, 0x1e, 0x33, 0xde];

/// Encodes `SwapBaseInput(amount_in, minimum_amount_out)` into 24 bytes.
#[inline(always)]
pub fn encode_swap_base_in(amount_in: u64, min_quote_out: u64, out: &mut [u8; 32]) -> usize {
    out[0..8].copy_from_slice(&DISC_RAYDIUM_CPMM_SWAP_BASE_IN);
    out[8..16].copy_from_slice(&amount_in.to_le_bytes());
    out[16..24].copy_from_slice(&min_quote_out.to_le_bytes());
    24
}
