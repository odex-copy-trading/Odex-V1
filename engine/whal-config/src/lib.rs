//! Whal Bot engine configuration.
//!
//! * [`model`]    serde structs mirroring `lib/config/schema.ts` (frontend, Zod) and
//!   `config/bot-config.schema.json`.
//! * [`validate`] the same rules as the Zod schema, so the engine never trusts the UI.
//! * [`secrets`]  ChaCha20-Poly1305 encrypted secret store (shared file format with the control plane). Plaintext never leaves the engine
//!   process and is never serialized to the API.
//! * [`reload`]   lock-free hot reload with restart-required path tracking and optimistic versioning.
//! * [`diff`]     path-level diff used for the API response and the audit log.

pub mod diff;
pub mod model;
pub mod reload;
pub mod secrets;
pub mod validate;

pub use diff::{diff, needs_restart, Change};
pub use model::*;
pub use reload::{ApplyOutcome, ConfigManager, UpdateError};
pub use secrets::{SecretError, SecretStatus, SecretStore};
pub use validate::{validate, FieldError};
