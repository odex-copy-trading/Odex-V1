//! Whal Bot high-speed Rust trading engine.

#[cfg(all(feature = "jemalloc", not(target_env = "msvc")))]
#[global_allocator]
static GLOBAL: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

pub mod executor;
pub mod exits;
pub mod ingest;
pub mod metrics;
pub mod safety;
pub mod treasury;
