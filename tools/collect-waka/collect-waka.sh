#!/bin/bash
# Collect notes whose content contains "#n57577" from @haiku bot across all relays.
# The bot writes "#n57577" as plain text in content (no indexed `t` tag),
# so we fetch all kind:1 from the author with since/until batching, then filter by content.
# Output: waka.jsonl (deduped by id, sorted by created_at asc)

set -u

PUBKEY="4afc021c034d6fc25aa7989f24f83d1ba214ca0aaf45e090efc98e4d866076b1"
HASHTAG="${HASHTAG:-#n57577}"
KIND=1
BATCH_LIMIT="${BATCH_LIMIT:-500}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUT="${1:-$REPO_ROOT/waka.jsonl}"

RELAYS=(
  "wss://relay.nostr.band/"
  "wss://nos.lol/"
  "wss://yabu.me/"
  "wss://relay-jp.nostr.wirednet.jp/"
  "wss://nostr.compile-error.net/"
  "wss://cagliostr.compile-error.net/"
  "wss://ruby-nostr-relay.compile-error.net/"
  "wss://lua-nostr-relay.compile-error.net/"
  "wss://lisp-nostr-relay.compile-error.net/"
  "wss://nim-nostr-relay.compile-error.net/"
)

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Seed existing events to enable incremental collection.
if [ -f "$OUT" ]; then
  cp "$OUT" "$TMP/all.jsonl"
  echo "[seed] $(wc -l < "$TMP/all.jsonl") existing events"
else
  : > "$TMP/all.jsonl"
fi

for relay in "${RELAYS[@]}"; do
  echo "[fetch] $relay"
  # --paginate walks back in time with decreasing 'until', batch size = -l.
  # nak prints one JSON event per line on stdout.
  nak req \
    -k "$KIND" \
    -a "$PUBKEY" \
    -l "$BATCH_LIMIT" \
    --paginate \
    "$relay" 2>>"$TMP/err.log" >> "$TMP/all.jsonl" || \
    echo "[warn] $relay failed (see $TMP/err.log)"
done

raw_count=$(wc -l < "$TMP/all.jsonl")
echo "[merge] raw lines: $raw_count"

# Filter valid JSON whose content contains the hashtag,
# dedupe by id, sort ascending by created_at.
jq -c --arg tag "$HASHTAG" \
  'select(type == "object" and .id and .created_at and (.content | contains($tag)))' \
  "$TMP/all.jsonl" 2>/dev/null \
  | jq -s 'unique_by(.id) | sort_by(.created_at) | .[]' \
  | jq -c '.' > "$OUT"

echo "[done] $(wc -l < "$OUT") unique events -> $OUT"
