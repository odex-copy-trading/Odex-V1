//! Pump.fun `SellV3` (`venue_op = 9`) CPI encoder.

/// Pump.fun `sell` (v3) 8-byte Anchor discriminator.
pub const DISC_PUMPFUN_SELL_V3: [u8; 8] = [0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad];

/// Encodes `SellV3(amount, min_sol_output)` into 24 bytes.
#[inline(always)]
pub fn encode_sell_v3(amount_in: u64, min_quote_out: u64, out: &mut [u8; 32]) -> usize {
    out[0..8].copy_from_slice(&DISC_PUMPFUN_SELL_V3);
    out[8..16].copy_from_slice(&amount_in.to_le_bytes());
    out[16..24].copy_from_slice(&min_quote_out.to_le_bytes());
    24
}
