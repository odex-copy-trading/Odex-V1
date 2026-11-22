//! High-speed ShredStream / Geyser ingestion and signal engine (`/engine/src/ingest`).

pub mod bus;
pub mod detector;
pub mod geyser;
pub mod shredstream;
pub mod state;
pub mod telemetry;
pub mod types;

use std::sync::Arc;

pub use bus::{OpportunityBus, DEFAULT_BUS_CAPACITY};
pub use detector::SignalDetector;
pub use geyser::{GeyserAccountUpdate, GeyserConfig, GeyserStateSync};
pub use shredstream::{ShredStreamConfig, ShredStreamIngestor};
pub use state::{BalanceCache, WatchlistCache};
pub use telemetry::{KolShredDetectedPayload, TelemetryEmitter};
pub use types::{
    compute_opportunity_key, pubkey_from_bs58, pubkey_to_bs58, DecodedInstruction, DecodedTx,
    KolRule, LaunchFilterConfig, PubkeyBytes, StrategyId, TriggerEvent, TriggerKind, Venue,
    WSOL_MINT,
};

/// Top-level facade bundling the dual-feed ingestor, lock-free caches, detector, bus, and telemetry.
pub struct IngestEngine {
    pub balances: BalanceCache,
    pub watchlist: WatchlistCache,
    pub detector: Arc<SignalDetector>,
    pub bus: OpportunityBus,
    pub shredstream: Arc<ShredStreamIngestor>,
    pub geyser: Arc<GeyserStateSync>,
}

impl IngestEngine {
    pub fn new(
        shred_cfg: ShredStreamConfig,
        geyser_cfg: GeyserConfig,
        launch_filter: LaunchFilterConfig,
        telemetry: Option<TelemetryEmitter>,
    ) -> Self {
        let balances = BalanceCache::new();
        let watchlist = WatchlistCache::new();
        let detector = Arc::new(SignalDetector::new(
            watchlist.clone(),
            balances.clone(),
            launch_filter,
        ));
        let bus = OpportunityBus::default();
        let shredstream = Arc::new(ShredStreamIngestor::new(
            shred_cfg,
            detector.clone(),
            bus.clone(),
            telemetry,
        ));
        let geyser = Arc::new(GeyserStateSync::new(
            geyser_cfg,
            balances.clone(),
            watchlist.clone(),
        ));
        Self {
            balances,
            watchlist,
            detector,
            bus,
            shredstream,
            geyser,
        }
    }
}
