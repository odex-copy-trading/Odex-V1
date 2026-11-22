//! Fallback / State Sync feed: Yellowstone Geyser gRPC account & slot subscriber.
//!
//! Continuously tracks live native SOL lamports and SPL/Token-2022 token balances for every
//! watched KOL wallet and token account inside the lock-free `BalanceCache` (`DashMap<PubkeyBytes, u64>`),
//! plus live Solana mainnet slot progression.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use prost::Message as ProstMessage;
use tokio_stream::wrappers::ReceiverStream;
use tonic::codec::ProstCodec;
use tonic::metadata::MetadataValue;
use tracing::{info, warn};

use super::state::{BalanceCache, WatchlistCache};
use super::types::{pubkey_to_bs58, PubkeyBytes};
use crate::executor::builder::{SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID};

#[derive(Debug, Clone)]
pub struct GeyserConfig {
    pub grpc_url: String,
    pub x_token: Option<String>,
}

/// Raw account update delivered by Yellowstone Geyser gRPC (`SubscribeUpdateAccount`).
#[derive(Debug, Clone)]
pub struct GeyserAccountUpdate {
    pub slot: u64,
    pub pubkey: PubkeyBytes,
    pub lamports: u64,
    pub is_spl_token_account: bool,
    pub data: Vec<u8>,
}

// --- Wire-compatible Yellowstone Geyser protobuf subset (no protoc required) ---

#[derive(Clone, PartialEq, ProstMessage)]
struct SubscribeRequestFilterAccounts {
    #[prost(string, repeated, tag = "2")]
    pub account: Vec<String>,
}

#[derive(Clone, PartialEq, ProstMessage)]
struct SubscribeRequestFilterSlots {}

#[derive(Clone, PartialEq, ProstMessage)]
struct SubscribeRequest {
    #[prost(map = "string, message", tag = "1")]
    pub accounts: HashMap<String, SubscribeRequestFilterAccounts>,
    #[prost(map = "string, message", tag = "2")]
    pub slots: HashMap<String, SubscribeRequestFilterSlots>,
    /// 0 = PROCESSED, 1 = CONFIRMED, 2 = FINALIZED
    #[prost(int32, optional, tag = "6")]
    pub commitment: Option<i32>,
}

#[derive(Clone, PartialEq, ProstMessage)]
struct SubscribeUpdateAccountInfo {
    #[prost(bytes = "vec", tag = "1")]
    pub pubkey: Vec<u8>,
    #[prost(uint64, tag = "2")]
    pub lamports: u64,
    #[prost(bytes = "vec", tag = "3")]
    pub owner: Vec<u8>,
    #[prost(bytes = "vec", tag = "6")]
    pub data: Vec<u8>,
}

#[derive(Clone, PartialEq, ProstMessage)]
struct SubscribeUpdateAccountMsg {
    #[prost(message, optional, tag = "1")]
    pub account: Option<SubscribeUpdateAccountInfo>,
    #[prost(uint64, tag = "2")]
    pub slot: u64,
}

#[derive(Clone, PartialEq, ProstMessage)]
struct SubscribeUpdateSlotMsg {
    #[prost(uint64, tag = "1")]
    pub slot: u64,
}

#[derive(Clone, PartialEq, ProstMessage)]
struct SubscribeUpdate {
    #[prost(message, optional, tag = "2")]
    pub account: Option<SubscribeUpdateAccountMsg>,
    #[prost(message, optional, tag = "3")]
    pub slot: Option<SubscribeUpdateSlotMsg>,
}

pub struct GeyserStateSync {
    cfg: GeyserConfig,
    balances: BalanceCache,
    watchlist: WatchlistCache,
    latest_slot: Arc<AtomicU64>,
}

impl GeyserStateSync {
    pub fn new(cfg: GeyserConfig, balances: BalanceCache, watchlist: WatchlistCache) -> Self {
        Self {
            cfg,
            balances,
            watchlist,
            latest_slot: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn latest_slot(&self) -> u64 {
        self.latest_slot.load(Ordering::Relaxed)
    }

    /// Applies an incoming Geyser account update into the lock-free `DashMap<PubkeyBytes, u64>`.
    #[inline]
    pub fn apply_account_update(&self, update: &GeyserAccountUpdate) {
        self.latest_slot.fetch_max(update.slot, Ordering::Relaxed);
        if update.is_spl_token_account {
            self.balances
                .update_from_spl_data(update.pubkey, &update.data);
        } else {
            self.balances.set(update.pubkey, update.lamports);
        }
    }

    /// Returns the current set of accounts to include in the Yellowstone Geyser subscription filter.
    pub fn subscription_accounts(&self) -> Vec<PubkeyBytes> {
        self.watchlist.watched_accounts()
    }

    /// Spawns the live Yellowstone Geyser gRPC `/geyser.Geyser/Subscribe` loop with automatic reconnects.
    pub fn spawn_live(self: Arc<Self>) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            if self.cfg.grpc_url.trim().is_empty() {
                warn!("Geyser gRPC URL empty; live Geyser sync disabled");
                return;
            }
            let mut backoff_ms = 500u64;
            loop {
                match self.connect_endpoint().await {
                    Ok(channel) => {
                        backoff_ms = 500;
                        if let Err(e) = self.stream_updates(channel).await {
                            warn!(error = %e, "Yellowstone Geyser stream ended; reconnecting");
                        }
                    }
                    Err(e) => {
                        warn!(error = %e, backoff_ms, "Invalid Geyser endpoint; backing off");
                    }
                }
                tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                backoff_ms = (backoff_ms * 2).min(10_000);
            }
        })
    }

    async fn stream_updates(&self, channel: tonic::transport::Channel) -> Result<(), String> {
        let mut grpc = tonic::client::Grpc::new(channel);
        grpc.ready().await.map_err(|e| format!("grpc ready: {e}"))?;

        let codec: ProstCodec<SubscribeRequest, SubscribeUpdate> = ProstCodec::default();
        let path = tonic::codegen::http::uri::PathAndQuery::from_static("/geyser.Geyser/Subscribe");

        let (tx, rx) = tokio::sync::mpsc::channel::<SubscribeRequest>(8);
        let watched: Vec<String> = self
            .subscription_accounts()
            .iter()
            .map(pubkey_to_bs58)
            .collect();

        let mut accounts = HashMap::new();
        if !watched.is_empty() {
            accounts.insert(
                "whal_kols".to_string(),
                SubscribeRequestFilterAccounts { account: watched },
            );
        }
        let mut slots = HashMap::new();
        slots.insert("whal_slots".to_string(), SubscribeRequestFilterSlots {});

        let _ = tx
            .send(SubscribeRequest {
                accounts,
                slots,
                commitment: Some(0), // PROCESSED
            })
            .await;

        let mut req = tonic::Request::new(ReceiverStream::new(rx));
        if let Some(tok) = &self.cfg.x_token {
            if let Ok(val) = MetadataValue::try_from(tok.as_str()) {
                req.metadata_mut().insert("x-token", val);
            }
        }

        let mut stream = grpc
            .streaming(req, path, codec)
            .await
            .map_err(|e| format!("Geyser Subscribe failed: {e}"))?
            .into_inner();

        info!(endpoint = %self.cfg.grpc_url, "Subscribed to Yellowstone Geyser gRPC");
        while let Some(update) = stream.message().await.map_err(|e| e.to_string())? {
            if let Some(slot_msg) = update.slot {
                self.latest_slot.fetch_max(slot_msg.slot, Ordering::Relaxed);
            }
            if let Some(acc_msg) = update.account {
                if let Some(info) = acc_msg.account {
                    if info.pubkey.len() == 32 {
                        let mut pubkey = [0u8; 32];
                        pubkey.copy_from_slice(&info.pubkey);
                        let is_spl = info.owner.as_slice() == SPL_TOKEN_PROGRAM_ID
                            || info.owner.as_slice() == TOKEN_2022_PROGRAM_ID;
                        self.apply_account_update(&GeyserAccountUpdate {
                            slot: acc_msg.slot,
                            pubkey,
                            lamports: info.lamports,
                            is_spl_token_account: is_spl,
                            data: info.data,
                        });
                    }
                }
            }
        }
        Ok(())
    }

    /// Establishes the Yellowstone Geyser gRPC transport channel with backoff reconnects.
    pub async fn connect_endpoint(&self) -> Result<tonic::transport::Channel, tonic::transport::Error> {
        let mut backoff_ms = 500u64;
        loop {
            match tonic::transport::Endpoint::from_shared(self.cfg.grpc_url.clone()) {
                Ok(ep) => match ep.tcp_nodelay(true).connect().await {
                    Ok(ch) => {
                        info!(
                            endpoint = %self.cfg.grpc_url,
                            watched = self.watchlist.watched_accounts().len(),
                            "Connected to Yellowstone Geyser gRPC"
                        );
                        return Ok(ch);
                    }
                    Err(e) => {
                        warn!(error = %e, backoff_ms, "Geyser gRPC connect failed; retrying");
                    }
                },
                Err(e) => return Err(e),
            }
            tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
            backoff_ms = (backoff_ms * 2).min(10_000);
        }
    }
}
