//! Lock-free Prometheus metrics registry exported in Prometheus text format for Grafana.

use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Default)]
pub struct EngineMetrics {
    pub shred_latency_ms: AtomicU64,
    pub bursts_dispatched_total: AtomicU64,
    pub tx_landed_total: AtomicU64,
    pub reverts_duplicate_total: AtomicU64,
    pub reverts_kol_guard_total: AtomicU64,
    pub reverts_expired_total: AtomicU64,
    pub hourly_burn_lamports: AtomicU64,
    pub circuit_breaker_trips_total: AtomicU64,
}

impl EngineMetrics {
    pub fn render_prometheus(&self) -> String {
        format!(
            concat!(
                "# HELP whal_shred_latency_ms Latest ShredStream detection latency in milliseconds.\n",
                "# TYPE whal_shred_latency_ms gauge\n",
                "whal_shred_latency_ms {}\n",
                "# HELP whal_bursts_dispatched_total Total multi-lander snipe bursts dispatched.\n",
                "# TYPE whal_bursts_dispatched_total counter\n",
                "whal_bursts_dispatched_total {}\n",
                "# HELP whal_tx_landed_total Total winning transactions landed on-chain.\n",
                "# TYPE whal_tx_landed_total counter\n",
                "whal_tx_landed_total {}\n",
                "# HELP whal_reverts_duplicate_total Duplicate burst reverts (ring-buffer / mutex).\n",
                "# TYPE whal_reverts_duplicate_total counter\n",
                "whal_reverts_duplicate_total {}\n",
                "# HELP whal_reverts_kol_guard_total Premature burst reverts at KOL balance-delta guard.\n",
                "# TYPE whal_reverts_kol_guard_total counter\n",
                "whal_reverts_kol_guard_total {}\n",
                "# HELP whal_reverts_expired_total Slot-TTL expired burst reverts.\n",
                "# TYPE whal_reverts_expired_total counter\n",
                "whal_reverts_expired_total {}\n",
                "# HELP whal_hourly_burn_lamports Rolling 1-hour gas + tip burn in lamports.\n",
                "# TYPE whal_hourly_burn_lamports gauge\n",
                "whal_hourly_burn_lamports {}\n",
                "# HELP whal_circuit_breaker_trips_total Total hard circuit breaker trips.\n",
                "# TYPE whal_circuit_breaker_trips_total counter\n",
                "whal_circuit_breaker_trips_total {}\n",
            ),
            self.shred_latency_ms.load(Ordering::Relaxed),
            self.bursts_dispatched_total.load(Ordering::Relaxed),
            self.tx_landed_total.load(Ordering::Relaxed),
            self.reverts_duplicate_total.load(Ordering::Relaxed),
            self.reverts_kol_guard_total.load(Ordering::Relaxed),
            self.reverts_expired_total.load(Ordering::Relaxed),
            self.hourly_burn_lamports.load(Ordering::Relaxed),
            self.circuit_breaker_trips_total.load(Ordering::Relaxed),
        )
    }
}
