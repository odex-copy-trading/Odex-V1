//! Encrypted-at-rest secret store.
//!
//! * File: JSON map `id -> { nonce, ciphertext, updated_at }`, written atomically with 0600 perms.
//! * Cipher: ChaCha20-Poly1305 (IETF), fresh 12-byte random nonce per write, secret id bound as AAD
//!   (a ciphertext cannot be moved to another id). Same format as server/secrets.ts (Node), so the
//!   control plane and the engine share one `secrets.enc`.
//! * Master key: 32 bytes, base64, from `WHAL_MASTER_KEY` (or a file path in `WHAL_MASTER_KEY_FILE`).
//!   Never stored next to `secrets.enc`.
//! * API surface: [`SecretStore::status`] for the UI (set / updated_at only) and
//!   [`SecretStore::reveal`] for engine internals. `reveal` returns `Zeroizing` memory and is not
//!   reachable from any HTTP/WebSocket handler.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chacha20poly1305::{aead::{Aead, KeyInit, Payload}, ChaCha20Poly1305, Nonce};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, io::Write, path::{Path, PathBuf}, sync::RwLock, time::{SystemTime, UNIX_EPOCH}};
use zeroize::Zeroizing;

#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    #[error("master key missing: set WHAL_MASTER_KEY or WHAL_MASTER_KEY_FILE")] NoMasterKey,
    #[error("master key must be 32 bytes, base64-encoded")] BadMasterKey,
    #[error("unknown secret id {0}")] UnknownId(String),
    #[error("secret {0} cannot be set from the API")] NotApiSettable(String),
    #[error("secret value is empty or too long")] BadValue,
    #[error("decryption failed for {0}: wrong master key or tampered file")] Decrypt(String),
    #[error("secret store I/O: {0}")] Io(#[from] std::io::Error),
    #[error("secret store format: {0}")] Format(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Sealed { nonce: String, ciphertext: String, updated_at: u64 }

/// What the API may return about a secret.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct SecretStatus { pub set: bool, pub updated_at: Option<u64> }

pub struct SecretStore {
    path: PathBuf,
    cipher: ChaCha20Poly1305,
    entries: RwLock<BTreeMap<String, Sealed>>,
}

fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) }

impl SecretStore {
    pub fn master_key_from_env() -> Result<Zeroizing<Vec<u8>>, SecretError> {
        let raw = match (std::env::var("WHAL_MASTER_KEY"), std::env::var("WHAL_MASTER_KEY_FILE")) {
            (Ok(k), _) => Zeroizing::new(k),
            (_, Ok(p)) => Zeroizing::new(fs::read_to_string(p)?.trim().to_string()),
            _ => return Err(SecretError::NoMasterKey),
        };
        let key = Zeroizing::new(B64.decode(raw.trim()).map_err(|_| SecretError::BadMasterKey)?);
        if key.len() != 32 { return Err(SecretError::BadMasterKey); }
        Ok(key)
    }

    pub fn open(path: impl AsRef<Path>, master_key: &[u8]) -> Result<Self, SecretError> {
        let cipher = ChaCha20Poly1305::new_from_slice(master_key).map_err(|_| SecretError::BadMasterKey)?;
        let path = path.as_ref().to_path_buf();
        let entries = if path.exists() { serde_json::from_slice(&fs::read(&path)?)? } else { BTreeMap::new() };
        let store = Self { path, cipher, entries: RwLock::new(entries) };
        // Fail fast on a wrong key instead of at first use.
        for id in store.entries.read().unwrap().keys().cloned().collect::<Vec<_>>() { store.reveal(&id)?; }
        Ok(store)
    }

    fn check_id(id: &str) -> Result<(), SecretError> {
        if crate::model::secret_ids().iter().any(|s| s == id) { Ok(()) } else { Err(SecretError::UnknownId(id.into())) }
    }

    /// Set from the operator API. Rejects ids that must be provisioned on the host (signer key).
    pub fn set_from_api(&self, id: &str, value: Zeroizing<String>) -> Result<SecretStatus, SecretError> {
        if !crate::model::ui_settable_secret(id) { return Err(SecretError::NotApiSettable(id.into())); }
        self.set(id, value.as_bytes())
    }

    /// Set from a host-side CLI (e.g. `whal-engine secrets import-keypair <path>`).
    pub fn set(&self, id: &str, value: &[u8]) -> Result<SecretStatus, SecretError> {
        Self::check_id(id)?;
        if value.is_empty() || value.len() > 16 * 1024 { return Err(SecretError::BadValue); }
        let mut nonce = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce);
        let ct = self.cipher
            .encrypt(Nonce::from_slice(&nonce), Payload { msg: value, aad: id.as_bytes() })
            .map_err(|_| SecretError::Decrypt(id.into()))?;
        let sealed = Sealed { nonce: B64.encode(nonce), ciphertext: B64.encode(ct), updated_at: now() };
        let status = SecretStatus { set: true, updated_at: Some(sealed.updated_at) };
        self.entries.write().unwrap().insert(id.to_string(), sealed);
        self.persist()?;
        Ok(status)
    }

    pub fn clear(&self, id: &str) -> Result<(), SecretError> {
        Self::check_id(id)?;
        if id == "wallets.hot_wallet_keypair" { return Err(SecretError::NotApiSettable(id.into())); }
        self.entries.write().unwrap().remove(id);
        self.persist()
    }

    /// Engine-internal only. Do not expose through any API handler.
    pub fn reveal(&self, id: &str) -> Result<Zeroizing<Vec<u8>>, SecretError> {
        let entries = self.entries.read().unwrap();
        let Some(s) = entries.get(id) else { return Err(SecretError::UnknownId(id.into())) };
        let nonce = B64.decode(&s.nonce).map_err(|_| SecretError::Decrypt(id.into()))?;
        let ct = B64.decode(&s.ciphertext).map_err(|_| SecretError::Decrypt(id.into()))?;
        if nonce.len() != 12 { return Err(SecretError::Decrypt(id.into())); }
        self.cipher
            .decrypt(Nonce::from_slice(&nonce), Payload { msg: &ct, aad: id.as_bytes() })
            .map(Zeroizing::new)
            .map_err(|_| SecretError::Decrypt(id.into()))
    }

    /// Safe for the API: presence and timestamp only.
    pub fn status(&self) -> BTreeMap<String, SecretStatus> {
        let entries = self.entries.read().unwrap();
        crate::model::secret_ids().into_iter().map(|id| {
            let s = entries.get(&id).map(|e| SecretStatus { set: true, updated_at: Some(e.updated_at) }).unwrap_or(SecretStatus { set: false, updated_at: None });
            (id, s)
        }).collect()
    }

    fn persist(&self) -> Result<(), SecretError> {
        let data = serde_json::to_vec_pretty(&*self.entries.read().unwrap())?;
        let tmp = self.path.with_extension("enc.tmp");
        {
            let mut opts = fs::OpenOptions::new();
            opts.write(true).create(true).truncate(true);
            #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; opts.mode(0o600); }
            let mut f = opts.open(&tmp)?;
            f.write_all(&data)?;
            f.sync_all()?;
        }
        fs::rename(tmp, &self.path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_status_never_leaks() {
        let dir = tempfile::tempdir().unwrap();
        let key = [7u8; 32];
        let s = SecretStore::open(dir.path().join("secrets.enc"), &key).unwrap();
        s.set_from_api("network.geyser_token", Zeroizing::new("tok-123".into())).unwrap();
        assert_eq!(&*s.reveal("network.geyser_token").unwrap(), b"tok-123");
        let json = serde_json::to_string(&s.status()).unwrap();
        assert!(!json.contains("tok-123"));
        let file = fs::read_to_string(dir.path().join("secrets.enc")).unwrap();
        assert!(!file.contains("tok-123"));
        assert!(matches!(s.set_from_api("wallets.hot_wallet_keypair", Zeroizing::new("x".into())), Err(SecretError::NotApiSettable(_))));
        assert!(SecretStore::open(dir.path().join("secrets.enc"), &[8u8; 32]).is_err());
    }
}
