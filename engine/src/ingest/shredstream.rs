//! Primary feed: Jito ShredStream ingestor.
//!
//! Connects to the Jito ShredStream proxy over gRPC (`/shredstream.ShredstreamProxy/SubscribeEntries`),
//! decodes raw Solana bincode `Vec<Entry>` batches directly from shreds before block confirmation,
//! converts transactions into `DecodedTx`, and feeds them into `SignalDetector` -> `OpportunityBus`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use prost::Message as ProstMessage;
use tokio::sync::mpsc;
use tonic::codec::ProstCodec;
use tonic::metadata::MetadataValue;
use tracing::{debug, info, warn};

use super::bus::OpportunityBus;
use super::detector::SignalDetector;
use super::telemetry::TelemetryEmitter;
use super::types::{DecodedInstruction, DecodedTx, PubkeyBytes};
use crate::executor::wire::decode_short_u16;

#[derive(Debug, Clone)]
pub struct ShredStreamConfig {
    pub endpoint_url: String,
    pub auth_token: Option<String>,
}

/// Wire-compatible `shredstream.SubscribeEntriesRequest`.
#[derive(Clone, PartialEq, ProstMessage)]
struct SubscribeEntriesRequest {}

/// Wire-compatible `shredstream.Entry`.
#[derive(Clone, PartialEq, ProstMessage)]
struct ShredEntryBatch {
    #[prost(uint64, tag = "1")]
    pub slot: u64,
    #[prost(bytes = "vec", tag = "2")]
    pub entries: Vec<u8>,
}

/// Runs the primary Jito ShredStream ingestion loop with automatic exponential backoff.
pub struct ShredStreamIngestor {
    cfg: ShredStreamConfig,
    detector: Arc<SignalDetector>,
    bus: OpportunityBus,
    telemetry: Option<TelemetryEmitter>,
    latest_slot: Arc<AtomicU64>,
}

impl ShredStreamIngestor {
    pub fn new(
        cfg: ShredStreamConfig,
        detector: Arc<SignalDetector>,
        bus: OpportunityBus,
        telemetry: Option<TelemetryEmitter>,
    ) -> Self {
        Self {
            cfg,
            detector,
            bus,
            telemetry,
            latest_slot: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn latest_slot(&self) -> u64 {
        self.latest_slot.load(Ordering::Relaxed)
    }

    /// Processes a single reconstructed shred transaction through the detector,
    /// publishes any resulting `TriggerEvent` onto the bounded broadcast bus, and
    /// emits `kol_shred_detected` telemetry non-blockingly.
    #[inline]
    pub fn handle_decoded_tx(&self, tx: &DecodedTx) -> usize {
        self.latest_slot.fetch_max(tx.slot, Ordering::Relaxed);
        let triggers = self.detector.inspect_tx(tx);
        let count = triggers.len();
        for ev in triggers {
            // Publish directly to OpportunityBus without flooding the remote Control Plane WS with raw shred events.
            self.bus.publish(ev);
        }
        count
    }

    /// Spawns a consumer task reading reconstructed transactions from an upstream channel.
    pub fn spawn_channel_consumer(
        self: Arc<Self>,
        mut rx: mpsc::Receiver<DecodedTx>,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            info!(endpoint = %self.cfg.endpoint_url, "ShredStream consumer started");
            while let Some(tx) = rx.recv().await {
                self.handle_decoded_tx(&tx);
            }
            warn!("ShredStream transaction channel closed");
        })
    }

    /// Spawns the live Jito ShredStream gRPC `SubscribeEntries` loop with automatic reconnects.
    pub fn spawn_live(self: Arc<Self>) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            if self.cfg.endpoint_url.trim().is_empty() {
                warn!("ShredStream endpoint empty; live ShredStream ingestor disabled");
                return;
            }
            let mut backoff_ms = 500u64;
            loop {
                match self.connect_endpoint().await {
                    Ok(channel) => {
                        backoff_ms = 500;
                        if let Err(e) = self.stream_entries(channel).await {
                            warn!(error = %e, "ShredStream stream ended; reconnecting");
                        }
                    }
                    Err(e) => {
                        warn!(error = %e, backoff_ms, "Invalid ShredStream endpoint; backing off");
                    }
                }
                tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                backoff_ms = (backoff_ms * 2).min(10_000);
            }
        })
    }

    async fn stream_entries(&self, channel: tonic::transport::Channel) -> Result<(), String> {
        let mut grpc = tonic::client::Grpc::new(channel);
        grpc.ready().await.map_err(|e| format!("grpc ready: {e}"))?;

        let codec: ProstCodec<SubscribeEntriesRequest, ShredEntryBatch> = ProstCodec::default();
        let path = tonic::codegen::http::uri::PathAndQuery::from_static(
            "/shredstream.ShredstreamProxy/SubscribeEntries",
        );
        let mut req = tonic::Request::new(SubscribeEntriesRequest {});
        if let Some(tok) = &self.cfg.auth_token {
            if let Ok(val) = MetadataValue::try_from(tok.as_str()) {
                req.metadata_mut().insert("x-token", val.clone());
                req.metadata_mut().insert("authorization", val);
            }
        }

        let mut stream = grpc
            .server_streaming(req, path, codec)
            .await
            .map_err(|e| format!("SubscribeEntries failed: {e}"))?
            .into_inner();

        info!(endpoint = %self.cfg.endpoint_url, "Subscribed to Jito ShredStream SubscribeEntries");
        while let Some(batch) = stream.message().await.map_err(|e| e.to_string())? {
            self.latest_slot.fetch_max(batch.slot, Ordering::Relaxed);
            let now_us = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_micros() as u64)
                .unwrap_or(0);
            let txs = decode_bincode_entries(batch.slot, now_us, &batch.entries);
            debug!(slot = batch.slot, txs = txs.len(), "Decoded shred entry batch");
            for tx in &txs {
                self.handle_decoded_tx(tx);
            }
        }
        Ok(())
    }

    /// Maintains the gRPC channel to the Jito ShredStream proxy with backoff reconnects.
    pub async fn connect_endpoint(&self) -> Result<tonic::transport::Channel, tonic::transport::Error> {
        let mut backoff_ms = 250u64;
        loop {
            match tonic::transport::Endpoint::from_shared(self.cfg.endpoint_url.clone()) {
                Ok(ep) => match ep.tcp_nodelay(true).connect().await {
                    Ok(ch) => {
                        info!(endpoint = %self.cfg.endpoint_url, "Connected to Jito ShredStream gRPC");
                        return Ok(ch);
                    }
                    Err(e) => {
                        warn!(error = %e, backoff_ms, "ShredStream connect failed; retrying");
                    }
                },
                Err(e) => return Err(e),
            }
            tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
            backoff_ms = (backoff_ms * 2).min(5_000);
        }
    }
}

/// Zero-dependency bincode parser for Solana `Vec<solana_entry::entry::Entry>`:
///   - `u64` entry count
///   - For each Entry: `num_hashes: u64`, `hash: [u8; 32]`, `tx_count: u64`, `transactions: [VersionedTransaction]`
pub fn decode_bincode_entries(slot: u64, received_at_us: u64, bytes: &[u8]) -> Vec<DecodedTx> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    let Some(entry_count) = read_u64(bytes, &mut pos) else {
        return out;
    };
    let entry_count = entry_count.min(4096) as usize;
    for _ in 0..entry_count {
        // num_hashes (8) + hash (32)
        if pos + 40 > bytes.len() {
            break;
        }
        pos += 40;
        let Some(tx_count) = read_u64(bytes, &mut pos) else {
            break;
        };
        let tx_count = tx_count.min(4096) as usize;
        for _ in 0..tx_count {
            match parse_solana_tx(slot, received_at_us, bytes, &mut pos) {
                Some(tx) => out.push(tx),
                None => return out,
            }
        }
    }
    out
}

fn read_u64(buf: &[u8], pos: &mut usize) -> Option<u64> {
    if *pos + 8 > buf.len() {
        return None;
    }
    let val = u64::from_le_bytes(buf[*pos..*pos + 8].try_into().ok()?);
    *pos += 8;
    Some(val)
}

fn parse_solana_tx(slot: u64, received_at_us: u64, buf: &[u8], pos: &mut usize) -> Option<DecodedTx> {
    // Signatures: short_u16 count + count * 64 bytes
    let (sig_count, n) = decode_short_u16(&buf[*pos..]).ok()?;
    *pos += n;
    let sig_bytes = (sig_count as usize) * 64;
    if *pos + sig_bytes > buf.len() {
        return None;
    }
    let mut signature = [0u8; 64];
    if sig_count > 0 {
        signature.copy_from_slice(&buf[*pos..*pos + 64]);
    }
    *pos += sig_bytes;

    if *pos >= buf.len() {
        return None;
    }
    let first = buf[*pos];
    let is_v0 = (first & 0x80) != 0;
    if is_v0 {
        *pos += 1;
    }
    if *pos + 3 > buf.len() {
        return None;
    }
    let num_required_signatures = buf[*pos] as usize;
    *pos += 3; // header (num_req_sigs, num_ro_signed, num_ro_unsigned)

    let (key_count, n) = decode_short_u16(&buf[*pos..]).ok()?;
    *pos += n;
    let mut account_keys: Vec<PubkeyBytes> = Vec::with_capacity(key_count as usize);
    for _ in 0..key_count {
        if *pos + 32 > buf.len() {
            return None;
        }
        let mut pk = [0u8; 32];
        pk.copy_from_slice(&buf[*pos..*pos + 32]);
        account_keys.push(pk);
        *pos += 32;
    }
    // Recent blockhash (32 bytes)
    if *pos + 32 > buf.len() {
        return None;
    }
    *pos += 32;

    // Compiled instructions
    let (ix_count, n) = decode_short_u16(&buf[*pos..]).ok()?;
    *pos += n;
    let mut instructions = Vec::with_capacity(ix_count as usize);
    for _ in 0..ix_count {
        if *pos >= buf.len() {
            return None;
        }
        let prog_idx = buf[*pos] as usize;
        *pos += 1;
        let (acc_count, n) = decode_short_u16(&buf[*pos..]).ok()?;
        *pos += n;
        if *pos + acc_count as usize > buf.len() {
            return None;
        }
        let mut ix_accounts = Vec::with_capacity(acc_count as usize);
        for &idx in &buf[*pos..*pos + acc_count as usize] {
            // Preserve exact instruction account indices even on v0 ALT txs by filling ALT-resolved slots with [0; 32].
            let pk = account_keys.get(idx as usize).copied().unwrap_or([0u8; 32]);
            ix_accounts.push(pk);
        }
        *pos += acc_count as usize;
        let (data_len, n) = decode_short_u16(&buf[*pos..]).ok()?;
        *pos += n;
        if *pos + data_len as usize > buf.len() {
            return None;
        }
        let data = buf[*pos..*pos + data_len as usize].to_vec();
        *pos += data_len as usize;

        if let Some(&program_id) = account_keys.get(prog_idx) {
            instructions.push(DecodedInstruction {
                program_id,
                accounts: ix_accounts,
                data,
            });
        }
    }

    // Skip v0 address table lookups if present
    if is_v0 {
        let (alt_count, n) = decode_short_u16(&buf[*pos..]).ok()?;
        *pos += n;
        for _ in 0..alt_count {
            if *pos + 32 > buf.len() {
                return None;
            }
            *pos += 32; // table key
            let (w_len, n) = decode_short_u16(&buf[*pos..]).ok()?;
            *pos += n + w_len as usize;
            if *pos > buf.len() {
                return None;
            }
            let (r_len, n) = decode_short_u16(&buf[*pos..]).ok()?;
            *pos += n + r_len as usize;
            if *pos > buf.len() {
                return None;
            }
        }
    }

    let signers = account_keys
        .iter()
        .take(num_required_signatures)
        .copied()
        .collect();

    Some(DecodedTx {
        slot,
        received_at_us,
        signature,
        signers,
        instructions,
    })
}
