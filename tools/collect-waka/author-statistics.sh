#!/bin/bash
# Rank original waka authors referenced by @haiku bot's notes, and
# (when data/waka.tsv is present) write data/author.tsv with profile info
# for the authors of adopted waka (flag=1 rows).
#
# For each event in waka.jsonl:
#   - If content contains `nostr:nevent1...`, decode it for the author pubkey
#     AND the original event id.
#   - Otherwise, take the `e` tag id and fetch that event from relays
#     to look up its author. (Cached on disk between runs.)
#
# author.tsv columns: npub1, name, display_name, picture
#
# Usage:
#   ./author-statistics.sh
#   ./author-statistics.sh path/to/waka.jsonl

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
INPUT="${1:-$REPO_ROOT/waka.jsonl}"
WAKA_TSV="${WAKA_TSV:-$REPO_ROOT/data/waka.tsv}"
AUTHOR_TSV="${AUTHOR_TSV:-$REPO_ROOT/data/author.tsv}"
NOTE2AUTHOR_TSV="${NOTE2AUTHOR_TSV:-$REPO_ROOT/data/note2author.tsv}"

CACHE_DIR="$SCRIPT_DIR/.cache"
EVENT_CACHE="$CACHE_DIR/events-by-id.jsonl"

LOOKUP_RELAYS=(
  "wss://yabu.me"
  "wss://relay-jp.nostr.wirednet.jp"
  "wss://nos.lol"
  "wss://nostr.compile-error.net"
  "wss://nostr.wine"
)

PROFILE_RELAYS=(
  "wss://yabu.me"
  "wss://relay-jp.nostr.wirednet.jp"
  "wss://nos.lol"
  "wss://purplepag.es"
)

[ -f "$INPUT" ] || { echo "[error] not found: $INPUT" >&2; exit 1; }
mkdir -p "$CACHE_DIR"
[ -f "$EVENT_CACHE" ] || : > "$EVENT_CACHE"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# ---- Pass 1: per waka.jsonl event, capture haiku_id, original_id, author --

# extracted.tsv columns: haiku_event_id \t original_event_id \t author \t source
#   source = nevent  -> original_id and author both filled (decoded from content)
#   source = etag    -> original_id from `e` tag, author empty (resolved later)
jq -c '.' "$INPUT" \
  | while read -r ev; do
      eid=$(echo "$ev" | jq -r '.id')
      ne=$(echo "$ev" | jq -r '.content' | grep -oE 'nostr:nevent1[a-z0-9]+' | head -1 | sed 's/^nostr://')
      if [ -n "$ne" ]; then
        decoded=$(nak decode "$ne" 2>/dev/null)
        oid=$(echo "$decoded" | jq -r '.id // empty')
        au=$(echo "$decoded" | jq -r '.author // empty')
        if [ -n "$oid" ] && [ -n "$au" ]; then
          printf '%s\t%s\t%s\tnevent\n' "$eid" "$oid" "$au"
          continue
        fi
      fi
      etag=$(echo "$ev" | jq -r '[.tags[] | select(.[0]=="e")][0][1] // empty')
      printf '%s\t%s\t\tetag\n' "$eid" "$etag"
    done > "$TMP/extracted.tsv"

# ---- Pass 2: fetch missing original events for `etag` rows ---------------

awk -F'\t' '$4=="etag" && $2!="" {print $2}' "$TMP/extracted.tsv" \
  | sort -u > "$TMP/missing-ids.txt"

if [ -s "$TMP/missing-ids.txt" ]; then
  jq -r '.id' "$EVENT_CACHE" 2>/dev/null | sort -u > "$TMP/cached-ids.txt"
  comm -23 "$TMP/missing-ids.txt" "$TMP/cached-ids.txt" > "$TMP/to-fetch.txt"
  to_fetch_count=$(wc -l < "$TMP/to-fetch.txt")
  if [ "$to_fetch_count" -gt 0 ]; then
    echo "[lookup] $to_fetch_count event id(s) need a relay fetch" >&2
    args=()
    while read -r id; do
      [ -n "$id" ] && args+=("-i" "$id")
    done < "$TMP/to-fetch.txt"
    for r in "${LOOKUP_RELAYS[@]}"; do
      echo "[lookup] $r" >&2
      nak req "${args[@]}" "$r" 2>/dev/null >> "$EVENT_CACHE" || true
    done
    jq -c 'select(.id and .pubkey)' "$EVENT_CACHE" \
      | jq -cs 'unique_by(.id) | .[]' > "$TMP/cache.new" \
      && mv "$TMP/cache.new" "$EVENT_CACHE"
  fi
fi

# original_event_id -> author, from the cache only.
jq -r 'select(.id and .pubkey) | "\(.id)\t\(.pubkey)"' "$EVENT_CACHE" 2>/dev/null \
  | sort -u > "$TMP/cache-id2author.tsv"

# Combined original_event_id -> author map:
# nevent rows already carry both, plus cache fills in etag-only rows.
{
  awk -F'\t' '$4=="nevent" && $2!="" && $3!="" {print $2"\t"$3}' "$TMP/extracted.tsv"
  cat "$TMP/cache-id2author.tsv"
} | sort -u > "$TMP/originalid2author.tsv"

# resolved.tsv: haiku_event_id -> author (used for ranking).
awk -F'\t' '
  NR==FNR { id2au[$1] = $2; next }
  {
    eid = $1; oid = $2; au = $3; src = $4;
    if (au == "" && oid != "" && (oid in id2au)) au = id2au[oid];
    if (au != "") printf "%s\t%s\n", eid, au;
    else          printf "%s\t\n", eid;
  }
' "$TMP/originalid2author.tsv" "$TMP/extracted.tsv" > "$TMP/resolved.tsv"

# ---- Aggregate counts (ranking) ----------------------------------------

awk -F'\t' '$2!="" {print $2}' "$TMP/resolved.tsv" \
  | sort | uniq -c | sort -rn > "$TMP/rank.txt"

total_events=$(wc -l < "$INPUT")
resolved=$(awk -F'\t' '$2!=""' "$TMP/resolved.tsv" | wc -l)
unresolved=$(awk -F'\t' '$2==""' "$TMP/resolved.tsv" | wc -l)
unique=$(wc -l < "$TMP/rank.txt")

# ---- Fetch kind:0 profiles for every author -----------------------------

: > "$TMP/profiles.jsonl"
if [ "$unique" -gt 0 ]; then
  args=()
  while read -r line; do
    pk=$(echo "$line" | awk '{print $2}')
    [ -n "$pk" ] && args+=("-a" "$pk")
  done < "$TMP/rank.txt"
  for r in "${PROFILE_RELAYS[@]}"; do
    echo "[profiles] $r" >&2
    nak req -k 0 "${args[@]}" "$r" 2>/dev/null >> "$TMP/profiles.jsonl" || true
  done
fi

# Per pubkey, keep the newest kind:0; emit "pubkey\tname\tdisplay_name\tpicture".
python3 - "$TMP/profiles.jsonl" "$TMP/profile-fields.tsv" <<'PY'
import json
import sys

newest = {}  # pubkey -> (created_at, content)
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except Exception:
            continue
        if ev.get('kind') != 0 or not ev.get('pubkey'):
            continue
        pk = ev['pubkey']
        ca = ev.get('created_at', 0)
        if pk not in newest or ca > newest[pk][0]:
            newest[pk] = (ca, ev.get('content', '') or '')

with open(sys.argv[2], 'w', encoding='utf-8') as out:
    for pk, (_, content) in newest.items():
        try:
            obj = json.loads(content) if content else {}
            if not isinstance(obj, dict):
                obj = {}
        except Exception:
            obj = {}
        name = (obj.get('name') or '').replace('\t', ' ').replace('\n', ' ').strip()
        dn = (obj.get('display_name') or obj.get('displayName') or '').replace('\t', ' ').replace('\n', ' ').strip()
        pic = (obj.get('picture') or '').replace('\t', ' ').replace('\n', ' ').strip()
        out.write(f'{pk}\t{name}\t{dn}\t{pic}\n')
PY

# ---- Print ranking (with names) -----------------------------------------

declare -A NAME
while IFS=$'\t' read -r pk nm dn _pic; do
  display="$dn"
  [ -z "$display" ] && display="$nm"
  NAME[$pk]="$display"
done < "$TMP/profile-fields.tsv"

printf "%-4s  %-5s  %-63s  %s\n" "rank" "count" "npub" "name"
printf "%-4s  %-5s  %-63s  %s\n" "----" "-----" "----" "----"
rank=0
while read -r line; do
  rank=$((rank + 1))
  count=$(echo "$line" | awk '{print $1}')
  pubkey=$(echo "$line" | awk '{print $2}')
  npub=$(nak encode npub "$pubkey" 2>/dev/null)
  printf "%-4d  %-5d  %-63s  %s\n" "$rank" "$count" "$npub" "${NAME[$pubkey]:-}"
done < "$TMP/rank.txt"

printf "\n# events:%d, resolved:%d, unresolved:%d, unique authors:%d\n" \
  "$total_events" "$resolved" "$unresolved" "$unique"

# ---- author.tsv generation (only when data/waka.tsv exists) -------------

if [ ! -f "$WAKA_TSV" ]; then
  echo "[skip] $WAKA_TSV not found — skipping author.tsv" >&2
  exit 0
fi

mkdir -p "$(dirname "$AUTHOR_TSV")"

python3 - \
  "$WAKA_TSV" "$TMP/originalid2author.tsv" "$TMP/profile-fields.tsv" "$AUTHOR_TSV" "$NOTE2AUTHOR_TSV" \
<<'PY'
import sys
from collections import OrderedDict

import bech32

waka_tsv, oid2au_tsv, profile_tsv, out_path, note2au_path = sys.argv[1:6]


def decode_note1(s: str) -> str | None:
    hrp, data = bech32.bech32_decode(s)
    if hrp != 'note' or data is None:
        return None
    raw = bech32.convertbits(data, 5, 8, False)
    if not raw or len(raw) < 32:
        return None
    return bytes(raw[:32]).hex()


def encode_npub(pk_hex: str) -> str:
    five = bech32.convertbits(bytes.fromhex(pk_hex), 8, 5)
    return bech32.bech32_encode('npub', five)


# original_event_id -> author pubkey
oid2au: dict[str, str] = {}
with open(oid2au_tsv, 'r', encoding='utf-8') as f:
    for line in f:
        cols = line.rstrip('\n').split('\t')
        if len(cols) >= 2 and cols[0] and cols[1]:
            oid2au[cols[0]] = cols[1]

# pubkey -> (name, display_name, picture)
profiles: dict[str, tuple[str, str, str]] = {}
with open(profile_tsv, 'r', encoding='utf-8') as f:
    for line in f:
        cols = line.rstrip('\n').split('\t')
        while len(cols) < 4:
            cols.append('')
        profiles[cols[0]] = (cols[1], cols[2], cols[3])

# Walk adopted (flag=1) rows of waka.tsv, count waka per author preserving order.
counts: 'OrderedDict[str, int]' = OrderedDict()
unresolved: list[str] = []
note2npub: list[tuple[str, str]] = []
with open(waka_tsv, 'r', encoding='utf-8') as f:
    for line in f:
        cols = line.rstrip('\n').split('\t')
        if not cols or cols[0] != '1':
            continue
        if len(cols) < 12 or not cols[11]:
            continue
        note1 = cols[11].strip()
        oid = decode_note1(note1)
        if not oid:
            unresolved.append(note1)
            continue
        au = oid2au.get(oid)
        if not au:
            unresolved.append(note1)
            continue
        counts[au] = counts.get(au, 0) + 1
        note2npub.append((note1, encode_npub(au)))

# Order: by count desc, ties by first-encounter (OrderedDict insertion).
ordered = sorted(counts.items(), key=lambda kv: (-kv[1], list(counts).index(kv[0])))

with open(out_path, 'w', encoding='utf-8') as out:
    for pk, _cnt in ordered:
        npub = encode_npub(pk)
        name, dn, pic = profiles.get(pk, ('', '', ''))
        out.write(f'{npub}\t{name}\t{dn}\t{pic}\n')

with open(note2au_path, 'w', encoding='utf-8') as out:
    for note1, npub in note2npub:
        out.write(f'{note1}\t{npub}\n')

print(f'[author.tsv] {len(ordered)} unique authors -> {out_path}', file=sys.stderr)
print(f'[note2author.tsv] {len(note2npub)} mappings -> {note2au_path}', file=sys.stderr)
if unresolved:
    print(f'[author.tsv] {len(unresolved)} note1 unresolved (skipped)', file=sys.stderr)
PY
