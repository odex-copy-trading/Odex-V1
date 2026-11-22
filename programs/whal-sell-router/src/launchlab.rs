//! Raydium LaunchLab `SellExactIn` (`venue_op = 7`) CPI encoder.

/// Raydium LaunchLab `sell_exact_in` 8-byte Anchor discriminator.
pub const DISC_LAUNCHLAB_SELL_EXACT_IN: [u8; 8] = [0x95, 0x27, 0xde, 0x9b, 0xd3, 0x7c, 0x98, 0x1a];

/// Encodes `SellExactIn(amount_in, minimum_amount_out, share_fee_rate = 0)` into 32 bytes.
#[inline(always)]
pub fn encode_sell_exact_in(amount_in: u64, min_quote_out: u64, out: &mut [u8; 32]) -> usize {
    out[0..8].copy_from_slice(&DISC_LAUNCHLAB_SELL_EXACT_IN);
    out[8..16].copy_from_slice(&amount_in.to_le_bytes());
    out[16..24].copy_from_slice(&min_quote_out.to_le_bytes());
    out[24..32].copy_from_slice(&0u64.to_le_bytes());
    32
}
