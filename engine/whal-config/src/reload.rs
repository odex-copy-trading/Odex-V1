//! Hot reload.
//!
//! * `live()` is a lock-free `Arc<BotConfig>` snapshot (ArcSwap). Hot paths in the engine read it per
//!   opportunity, so a new value applies on the next detection with no restart.
//! * Changes to restart-required paths are persisted but NOT swapped into the live snapshot; they are
//!   reported as `pending_restart` until the engine restarts and loads the file.
//! * Updates are optimistic: the caller sends the version it edited; a mismatch is a conflict.
//! * Hand edits to the file are picked up by `watch()` and go through the same validate/apply path.

use crate::{diff::{diff, Change}, model::BotConfig, validate::{validate, FieldError}};
use arc_swap::ArcSwap;
use serde::Serialize;
use serde_json::Value;
use std::{fs, path::{Path, PathBuf}, sync::{Arc, Mutex}};

#[derive(Debug, thiserror::Error)]
pub enum UpdateError {
    #[error("config changed since version {expected}; current is {current}")] Conflict { expected: u64, current: u64 },
    #[error("invalid config")] Invalid(Vec<FieldError>),
    #[error("config I/O: {0}")] Io(#[from] std::io::Error),
    #[error("config format: {0}")] Format(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Serialize)]
pub struct ApplyOutcome {
    pub version: u64,
    pub changes: Vec<Change>,
    /// Paths applied to the running engine immediately.
    pub applied_live: Vec<String>,
    /// Paths saved to disk that take effect after restart.
    pub pending_restart: Vec<String>,
}

struct State { version: u64, persisted: BotConfig, pending_restart: Vec<String> }

pub struct ConfigManager {
    path: PathBuf,
    live: ArcSwap<BotConfig>,
    state: Mutex<State>,
}

impl ConfigManager {
    pub fn load(path: impl AsRef<Path>) -> Result<Self, UpdateError> {
        let path = path.as_ref().to_path_buf();
        let cfg: BotConfig = serde_json::from_slice(&fs::read(&path)?)?;
        validate(&cfg).map_err(UpdateError::Invalid)?;
        Ok(Self { path, live: ArcSwap::from_pointee(cfg.clone()), state: Mutex::new(State { version: 1, persisted: cfg, pending_restart: vec![] }) })
    }

    /// Snapshot used by the engine. Cheap; call per opportunity.
    pub fn live(&self) -> Arc<BotConfig> { self.live.load_full() }
    /// What is on disk (includes not-yet-applied restart-required changes).
    pub fn persisted(&self) -> (u64, BotConfig, Vec<String>) {
        let s = self.state.lock().unwrap();
        (s.version, s.persisted.clone(), s.pending_restart.clone())
    }

    pub fn apply(&self, base_version: u64, next: BotConfig) -> Result<ApplyOutcome, UpdateError> {
        validate(&next).map_err(UpdateError::Invalid)?;
        let mut s = self.state.lock().unwrap();
        if base_version != s.version { return Err(UpdateError::Conflict { expected: base_version, current: s.version }); }

        let before = serde_json::to_value(&s.persisted)?;
        let after = serde_json::to_value(&next)?;
        let changes = diff(&before, &after);
        if changes.is_empty() { return Ok(ApplyOutcome { version: s.version, changes, applied_live: vec![], pending_restart: s.pending_restart.clone() }); }

        // Persist first (atomic rename), then swap live.
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(&next)?)?;
        fs::rename(&tmp, &self.path)?;

        // Live snapshot = new hot values merged over the current live restart-required values.
        let mut live = serde_json::to_value(&*self.live.load_full())?;
        let mut applied_live = Vec::new();
        for c in &changes {
            if c.restart {
                if !s.pending_restart.contains(&c.path) { s.pending_restart.push(c.path.clone()); }
            } else {
                set_path(&mut live, &c.path, c.after.clone());
                applied_live.push(c.path.clone());
            }
        }
        let live_cfg: BotConfig = serde_json::from_value(live)?;
        self.live.store(Arc::new(live_cfg));

        s.version += 1;
        s.persisted = next;
        tracing::info!(version = s.version, live = applied_live.len(), pending = s.pending_restart.len(), "config updated");
        Ok(ApplyOutcome { version: s.version, changes, applied_live, pending_restart: s.pending_restart.clone() })
    }

    /// Reload after an external edit of the config file.
    pub fn reload_from_disk(&self) -> Result<ApplyOutcome, UpdateError> {
        let next: BotConfig = serde_json::from_slice(&fs::read(&self.path)?)?;
        let v = self.state.lock().unwrap().version;
        self.apply(v, next)
    }

    /// Watch the file and hot-reload on change. Keep the returned watcher alive.
    pub fn watch(self: &Arc<Self>) -> notify::Result<notify::RecommendedWatcher> {
        use notify::{RecursiveMode, Watcher};
        let me = Arc::clone(self);
        let mut w = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(ev) = res {
                if ev.kind.is_modify() || ev.kind.is_create() {
                    match me.reload_from_disk() {
                        Ok(o) if !o.changes.is_empty() => tracing::info!(changes = o.changes.len(), "config reloaded from disk"),
                        Ok(_) => {}
                        Err(e) => tracing::warn!(error = %e, "config file change rejected"),
                    }
                }
            }
        })?;
        w.watch(&self.path, RecursiveMode::NonRecursive)?;
        Ok(w)
    }
}

/// Set a dotted path (`a.b.c`, array indices as `[n]`) in a JSON value.
fn set_path(root: &mut Value, path: &str, val: Value) {
    let mut cur = root;
    let parts: Vec<&str> = path.split('.').collect();
    for (i, part) in parts.iter().enumerate() {
        let (key, idx) = match part.find('[') {
            Some(b) => (&part[..b], part[b + 1..part.len() - 1].parse::<usize>().ok()),
            None => (*part, None),
        };
        let last = i == parts.len() - 1;
        if last && idx.is_none() { cur[key] = val; return; }
        cur = &mut cur[key];
        if let Some(n) = idx {
            if last { cur[n] = val; return; }
            cur = &mut cur[n];
        }
    }
}
