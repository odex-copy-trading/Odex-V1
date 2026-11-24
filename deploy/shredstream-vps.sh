#!/usr/bin/env bash
# One-command LocalShred Lite (Dedicated Nodes Amsterdam) + whal-engine VPS setup.
# Usage:
#   export LOCALSHRED_AUTH_KEY="your-localshred-key"
#   export LOCALSHRED_ENDPOINT="https://localshred-lite.nlams.dedicatednodes.io"
#   bash deploy/shredstream-vps.sh
set -euo pipefail

: "${LOCALSHRED_AUTH_KEY:?Set LOCALSHRED_AUTH_KEY before running}"
LOCALSHRED_ENDPOINT="${LOCALSHRED_ENDPOINT:-https://localshred-lite.nlams.dedicatednodes.io}"
GRPC_BIND="${GRPC_BIND:-127.0.0.1:9999}"
UDP_PORT="${UDP_PORT:-20000}"

echo "[1/3] Cloning dedicatednodes/shredstream-proxy..."
if [ ! -d "$HOME/shredstream-proxy" ]; then
  git clone https://github.com/dedicatednodes/shredstream-proxy.git "$HOME/shredstream-proxy"
fi

echo "[2/3] Building shredstream-proxy (release)..."
cd "$HOME/shredstream-proxy"
cargo build --release --bin jito-shredstream-proxy

echo "[3/3] Starting LocalShred Lite proxy -> gRPC ${GRPC_BIND} (UDP ${UDP_PORT})..."
exec ./target/release/jito-shredstream-proxy shredstream \
  --block-engine-url "$LOCALSHRED_ENDPOINT" \
  --auth-key "$LOCALSHRED_AUTH_KEY" \
  --desired-regions amsterdam \
  --dest-ip-ports "127.0.0.1:${UDP_PORT}" \
  --grpc-service-port "${GRPC_BIND##*:}"
