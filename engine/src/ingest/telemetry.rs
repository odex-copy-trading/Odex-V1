//! Non-blocking telemetry emitter sending `kol_shred_detected` events to the Step 3
//! control plane WebSocket bridge (`/internal/engine`).

use std::time::{Duration, SystemTime, UNIX_EPOCH};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tokio::sync::mpsc;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
};
use tracing::{info, warn};

use super::types::{pubkey_to_bs58, TriggerEvent, TriggerKind, Venue};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KolShredDetectedPayload {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub ts: u64,
    pub slot: u64,
    pub kol_id: Option<String>,
    pub mint: String,
    pub symbol: String,
    pub venue: Venue,
}

#[derive(Debug, Clone, Serialize)]
struct BridgeEventEnvelope {
    #[serde(rename = "type")]
    msg_type: &'static str,
    event: KolShredDetectedPayload,
}

/// Fire-and-forget telemetry handle so emitting `kol_shred_detected` never blocks detection.
#[derive(Clone)]
pub struct TelemetryEmitter {
    tx: mpsc::Sender<KolShredDetectedPayload>,
}

impl TelemetryEmitter {
    /// Spawns the background WebSocket bridge task targeting Step 3's `/internal/engine`.
    pub fn spawn(bridge_ws_url: String, bridge_token: String) -> Self {
        let (tx, mut rx) = mpsc::channel::<KolShredDetectedPayload>(512);
        tokio::spawn(async move {
            let mut backoff_ms = 500u64;
            loop {
                match Self::connect_and_pump(&bridge_ws_url, &bridge_token, &mut rx).await {
                    Ok(()) => break, // channel closed
                    Err(e) => {
                        warn!(error = %e, backoff_ms, "Telemetry bridge disconnected; reconnecting");
                        tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                        backoff_ms = (backoff_ms * 2).min(10_000);
                    }
                }
            }
        });
        Self { tx }
    }

    async fn connect_and_pump(
        url: &str,
        token: &str,
        rx: &mut mpsc::Receiver<KolShredDetectedPayload>,
    ) -> Result<(), String> {
        let mut req = url.into_client_request().map_err(|e| e.to_string())?;
        let auth_val = format!("Bearer {token}")
            .parse()
            .map_err(|e: tokio_tungstenite::tungstenite::http::header::InvalidHeaderValue| e.to_string())?;
        req.headers_mut().insert("Authorization", auth_val);
        let (ws, _) = connect_async(req).await.map_err(|e| e.to_string())?;
        info!(url, "Connected to Step 3 control-plane telemetry bridge");
        let (mut sink, mut stream) = ws.split();

        loop {
            tokio::select! {
                maybe_ev = rx.recv() => {
                    let Some(event) = maybe_ev else { return Ok(()); };
                    let envelope = BridgeEventEnvelope { msg_type: "event", event };
                    let json = serde_json::to_string(&envelope).map_err(|e| e.to_string())?;
                    sink.send(Message::Text(json.into())).await.map_err(|e| e.to_string())?;
                }
                incoming = stream.next() => {
                    match incoming {
                        Some(Ok(Message::Ping(p))) => {
                            let _ = sink.send(Message::Pong(p)).await;
                        }
                        Some(Ok(Message::Close(_))) | None => {
                            return Err("remote closed bridge".into());
                        }
                        Some(Err(e)) => return Err(e.to_string()),
                        _ => {}
                    }
                }
            }
        }
    }

    /// Emits `kol_shred_detected` for a `TriggerEvent` without blocking the hot path.
    #[inline]
    pub fn emit_trigger(&self, ev: &TriggerEvent) {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let (kol_id, symbol) = match &ev.kind {
            TriggerKind::KolBuy { kol_id, .. } => (Some(kol_id.clone()), "TOKEN".to_string()),
            TriggerKind::ZeroBlockLaunch { symbol, .. } => (
                None,
                if symbol.is_empty() { "LAUNCH".to_string() } else { symbol.clone() },
            ),
        };
        let payload = KolShredDetectedPayload {
            kind: "kol_shred_detected",
            ts,
            slot: ev.trigger_slot,
            kol_id,
            mint: pubkey_to_bs58(&ev.mint),
            symbol,
            venue: ev.venue,
        };
        let _ = self.tx.try_send(payload);
    }
}
