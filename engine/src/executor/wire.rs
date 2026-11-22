//! Pure-Rust Ed25519 Signer & Solana Binary Wire Transaction Serializer.
//!
//! Zero C/OpenSSL dependencies — compiles cleanly on Linux, macOS, Windows, and Railway Docker containers.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use ed25519_dalek::{Signer, SigningKey};

use crate::ingest::PubkeyBytes;
use super::builder::{BuiltTransaction, TxVersion};

/// Hot wallet Ed25519 signer loaded from `WHAL_HOT_WALLET_KEYPAIR` (JSON byte array or base58)
/// or `WHAL_HOT_WALLET_KEYPAIR_PATH` (Solana CLI `id.json` file).
#[derive(Clone)]
pub struct HotWalletSigner {
    signing_key: SigningKey,
    pubkey: PubkeyBytes,
}

impl HotWalletSigner {
    pub fn from_secret_bytes(secret32: [u8; 32]) -> Self {
        let signing_key = SigningKey::from_bytes(&secret32);
        let pubkey = signing_key.verifying_key().to_bytes();
        Self { signing_key, pubkey }
    }

    /// Parses either a 64-byte Solana keypair JSON array (`[1,2,...,64]`), a 32-byte seed JSON array,
    /// or a base58-encoded 64-byte/32-byte secret key.
    pub fn parse_str(raw: &str) -> Result<Self, String> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err("empty keypair".into());
        }
        let bytes: Vec<u8> = if trimmed.starts_with('[') {
            serde_json::from_str(trimmed).map_err(|e| format!("invalid keypair JSON: {e}"))?
        } else {
            bs58::decode(trimmed)
                .into_vec()
                .map_err(|e| format!("invalid base58 keypair: {e}"))?
        };
        if bytes.len() < 32 {
            return Err(format!("keypair too short: {} bytes", bytes.len()));
        }
        let mut secret = [0u8; 32];
        secret.copy_from_slice(&bytes[..32]);
        Ok(Self::from_secret_bytes(secret))
    }

    pub fn from_file(path: impl AsRef<Path>) -> Result<Self, String> {
        let raw = fs::read_to_string(path.as_ref())
            .map_err(|e| format!("failed to read keypair file: {e}"))?;
        Self::parse_str(&raw)
    }

    /// Loads from `WHAL_HOT_WALLET_KEYPAIR` env var first, falling back to `WHAL_HOT_WALLET_KEYPAIR_PATH`.
    pub fn from_env() -> Result<Option<Self>, String> {
        if let Ok(raw) = std::env::var("WHAL_HOT_WALLET_KEYPAIR") {
            if !raw.trim().is_empty() {
                return Self::parse_str(&raw).map(Some);
            }
        }
        if let Ok(path) = std::env::var("WHAL_HOT_WALLET_KEYPAIR_PATH") {
            if !path.trim().is_empty() {
                return Self::from_file(path).map(Some);
            }
        }
        Ok(None)
    }

    #[inline]
    pub fn pubkey(&self) -> PubkeyBytes {
        self.pubkey
    }

    #[inline]
    pub fn pubkey_bs58(&self) -> String {
        bs58::encode(self.pubkey).into_string()
    }

    #[inline]
    pub fn sign(&self, message: &[u8]) -> [u8; 64] {
        self.signing_key.sign(message).to_bytes()
    }
}

/// Encodes a Solana compact-u16 (`short_vec` length prefix).
pub fn encode_short_u16(mut val: u16, out: &mut Vec<u8>) {
    loop {
        let mut elem = (val & 0x7f) as u8;
        val >>= 7;
        if val == 0 {
            out.push(elem);
            break;
        } else {
            elem |= 0x80;
            out.push(elem);
        }
    }
}

/// Decodes a Solana compact-u16, returning `(value, bytes_consumed)`.
pub fn decode_short_u16(input: &[u8]) -> Result<(u16, usize), String> {
    let mut val: u16 = 0;
    let mut shift = 0u32;
    for (i, &b) in input.iter().take(3).enumerate() {
        val |= ((b & 0x7f) as u16) << shift;
        if (b & 0x80) == 0 {
            return Ok((val, i + 1));
        }
        shift += 7;
    }
    Err("truncated short_u16".into())
}

/// Compiles a `BuiltTransaction` into canonical Solana binary wire format and signs it with `signer`.
/// Returns `(wire_bytes, base58_signature)`.
pub fn serialize_and_sign_tx(
    tx: &BuiltTransaction,
    signer: &HotWalletSigner,
) -> (Vec<u8>, String) {
    // 1. Collect unique account keys with merged (is_signer, is_writable) privileges.
    let mut meta: BTreeMap<PubkeyBytes, (bool, bool)> = BTreeMap::new();
    // Fee payer is always writable signer at index 0.
    meta.insert(tx.fee_payer, (true, true));
    for ix in &tx.instructions {
        meta.entry(ix.program_id).or_insert((false, false));
        for a in &ix.accounts {
            let entry = meta.entry(a.pubkey).or_insert((false, false));
            entry.0 |= a.is_signer;
            entry.1 |= a.is_writable;
        }
    }

    // 2. Partition into Solana's canonical 4 buckets:
    //    [writable signers (fee_payer first), readonly signers, writable non-signers, readonly non-signers]
    let mut writable_signers = Vec::new();
    let mut readonly_signers = Vec::new();
    let mut writable_non_signers = Vec::new();
    let mut readonly_non_signers = Vec::new();

    writable_signers.push(tx.fee_payer);
    for (pk, (is_signer, is_writable)) in meta {
        if pk == tx.fee_payer {
            continue;
        }
        match (is_signer, is_writable) {
            (true, true) => writable_signers.push(pk),
            (true, false) => readonly_signers.push(pk),
            (false, true) => writable_non_signers.push(pk),
            (false, false) => readonly_non_signers.push(pk),
        }
    }

    let num_required_signatures = (writable_signers.len() + readonly_signers.len()) as u8;
    let num_readonly_signed = readonly_signers.len() as u8;
    let num_readonly_unsigned = readonly_non_signers.len() as u8;

    let mut account_keys = Vec::with_capacity(
        writable_signers.len()
            + readonly_signers.len()
            + writable_non_signers.len()
            + readonly_non_signers.len(),
    );
    account_keys.extend_from_slice(&writable_signers);
    account_keys.extend_from_slice(&readonly_signers);
    account_keys.extend_from_slice(&writable_non_signers);
    account_keys.extend_from_slice(&readonly_non_signers);

    let index_of = |pk: &PubkeyBytes| -> u8 {
        account_keys
            .iter()
            .position(|k| k == pk)
            .expect("account key must exist") as u8
    };

    // 3. Serialize Solana Message (v0 if TxVersion::V0, legacy otherwise).
    let mut message = Vec::with_capacity(512);
    if tx.version == TxVersion::V0 {
        message.push(0x80); // VersionedMessage::V0 prefix
    }
    message.push(num_required_signatures);
    message.push(num_readonly_signed);
    message.push(num_readonly_unsigned);

    encode_short_u16(account_keys.len() as u16, &mut message);
    for pk in &account_keys {
        message.extend_from_slice(pk);
    }
    message.extend_from_slice(&tx.recent_blockhash);

    encode_short_u16(tx.instructions.len() as u16, &mut message);
    for ix in &tx.instructions {
        message.push(index_of(&ix.program_id));
        encode_short_u16(ix.accounts.len() as u16, &mut message);
        for a in &ix.accounts {
            message.push(index_of(&a.pubkey));
        }
        encode_short_u16(ix.data.len() as u16, &mut message);
        message.extend_from_slice(&ix.data);
    }

    if tx.version == TxVersion::V0 {
        // Static accounts already resolved; empty address_table_lookups vec.
        encode_short_u16(0, &mut message);
    }

    // 4. Sign message bytes and prepend compact-u16 signature array.
    let sig = signer.sign(&message);
    let sig_bs58 = bs58::encode(sig).into_string();

    let mut wire = Vec::with_capacity(1 + (num_required_signatures as usize) * 64 + message.len());
    encode_short_u16(num_required_signatures as u16, &mut wire);
    wire.extend_from_slice(&sig);
    for _ in 1..num_required_signatures {
        wire.extend_from_slice(&[0u8; 64]);
    }
    wire.extend_from_slice(&message);

    (wire, sig_bs58)
}

/// Signs an unsigned base64-encoded Solana transaction (e.g. from Jupiter V6 `/swap`)
/// by writing the Ed25519 signature of the message into signature slot 0.
/// Returns `(signed_base64, base58_signature)`.
pub fn sign_serialized_tx_base64(
    unsigned_b64: &str,
    signer: &HotWalletSigner,
) -> Result<(String, String), String> {
    let mut raw = BASE64
        .decode(unsigned_b64.trim())
        .map_err(|e| format!("invalid base64 tx: {e}"))?;
    let (sig_count, prefix_len) = decode_short_u16(&raw)?;
    if sig_count == 0 {
        return Err("transaction has 0 signature slots".into());
    }
    let msg_offset = prefix_len + (sig_count as usize) * 64;
    if raw.len() <= msg_offset {
        return Err("truncated serialized transaction".into());
    }
    let sig = signer.sign(&raw[msg_offset..]);
    raw[prefix_len..prefix_len + 64].copy_from_slice(&sig);
    let sig_bs58 = bs58::encode(sig).into_string();
    Ok((BASE64.encode(&raw), sig_bs58))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signature, Verifier};

    #[test]
    fn short_u16_roundtrip() {
        for v in [0u16, 1, 127, 128, 255, 16383, 16384] {
            let mut buf = Vec::new();
            encode_short_u16(v, &mut buf);
            let (decoded, len) = decode_short_u16(&buf).unwrap();
            assert_eq!(decoded, v);
            assert_eq!(len, buf.len());
        }
    }

    #[test]
    fn signs_jupiter_base64_transaction() {
        let signer = HotWalletSigner::from_secret_bytes([7u8; 32]);
        let mut unsigned = vec![1u8]; // 1 signature slot
        unsigned.extend_from_slice(&[0u8; 64]); // empty signature
        unsigned.extend_from_slice(b"mock-solana-v0-message-bytes");
        let b64 = BASE64.encode(&unsigned);

        let (signed_b64, sig_bs58) = sign_serialized_tx_base64(&b64, &signer).unwrap();
        let signed = BASE64.decode(signed_b64).unwrap();
        let sig_bytes: [u8; 64] = signed[1..65].try_into().unwrap();
        assert_eq!(bs58::encode(sig_bytes).into_string(), sig_bs58);
        let sig = Signature::from_bytes(&sig_bytes);
        signer
            .signing_key
            .verifying_key()
            .verify(b"mock-solana-v0-message-bytes", &sig)
            .expect("Ed25519 signature must verify");
    }
}
