//! Bounded Opportunity Bus (`tokio::sync::broadcast`) delivering `TriggerEvent`s in < 2ms.

use tokio::sync::broadcast;
use tracing::warn;

use super::types::TriggerEvent;

/// Default bounded capacity for the opportunity bus (absorbs micro-bursts without unbounded memory).
pub const DEFAULT_BUS_CAPACITY: usize = 1024;

#[derive(Clone)]
pub struct OpportunityBus {
    tx: broadcast::Sender<TriggerEvent>,
}

impl OpportunityBus {
    pub fn new(capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity.max(16));
        Self { tx }
    }

    /// Publishes a `TriggerEvent` to all subscribed Transaction Builders.
    /// Returns the number of active receivers that received the event.
    #[inline]
    pub fn publish(&self, event: TriggerEvent) -> usize {
        match self.tx.send(event) {
            Ok(n) => n,
            Err(_) => {
                warn!("OpportunityBus published event with zero active subscribers");
                0
            }
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<TriggerEvent> {
        self.tx.subscribe()
    }
}

impl Default for OpportunityBus {
    fn default() -> Self {
        Self::new(DEFAULT_BUS_CAPACITY)
    }
}
