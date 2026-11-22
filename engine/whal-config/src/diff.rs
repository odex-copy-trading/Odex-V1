//! Path-level diff between two configs, flagging changes that need an engine restart.
//! Must match RESTART_REQUIRED in lib/config/schema.ts.

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Change { pub path: String, pub before: Value, pub after: Value, pub restart: bool }

const RESTART_REQUIRED: &[&str] = &[
    "network.rpc_primary_url", "network.rpc_backup_urls", "network.geyser_grpc_url", "network.shredstream_url", "network.commitment",
    "wallets.hot_wallet_pubkey", "wallets.signer_source", "wallets.wsol_vault_ata",
    "landers.providers.jito.endpoint_url", "landers.providers.nozomi.endpoint_url", "landers.providers.stellium.endpoint_url",
    "landers.providers.landx.endpoint_url", "landers.providers.bloom.endpoint_url", "landers.providers.astralane.endpoint_url",
    "landers.providers.glaive.endpoint_url", "landers.providers.fastlanes.endpoint_url",
    "landers.providers.tpu.endpoint_url", "landers.tx.version",
];

pub fn needs_restart(path: &str) -> bool {
    RESTART_REQUIRED.iter().any(|p| path == *p || path.starts_with(&format!("{p}.")) || path.starts_with(&format!("{p}[")))
}

pub fn diff(before: &Value, after: &Value) -> Vec<Change> {
    let mut out = Vec::new();
    walk("", before, after, &mut out);
    out
}

fn walk(path: &str, a: &Value, b: &Value, out: &mut Vec<Change>) {
    if a == b { return; }
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            let mut keys: Vec<&String> = x.keys().chain(y.keys()).collect();
            keys.sort(); keys.dedup();
            for k in keys {
                let p = if path.is_empty() { k.clone() } else { format!("{path}.{k}") };
                walk(&p, x.get(k).unwrap_or(&Value::Null), y.get(k).unwrap_or(&Value::Null), out);
            }
        }
        _ => out.push(Change { path: path.to_string(), before: a.clone(), after: b.clone(), restart: needs_restart(path) }),
    }
}
