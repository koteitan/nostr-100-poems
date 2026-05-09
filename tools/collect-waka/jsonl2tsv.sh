#!/bin/bash
# Convert waka.jsonl to a 12-column TSV with 5-7-5-7-7 block splits and yomi.
#
# Mirrors the haikubot's matching pipeline:
#   * normalize content (strip URLs, hashtags, NIP-08 mentions, nostr: refs)
#   * tokenize with kagome (ipa-neologd) + userdic.txt
#   * split into 5-7-5-7-7 blocks via the same logic as go-haiku.MatchWithOpt
#   * emit hiragana yomi per block
#
# Columns:
#   1     flag (default 1)
#   2-6   block0..block4 (original surface)
#   7-11  block0..block4 (hiragana yomi)
#   12    note1 of the original waka
#
# Rows that fail 5-7-5-7-7 matching under the same dict are dropped (logged).
#
# Usage:
#   ./jsonl2tsv.sh                  # waka.jsonl -> waka.tsv
#   ./jsonl2tsv.sh in.jsonl out.tsv

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
INPUT="${1:-$REPO_ROOT/waka.jsonl}"
OUTPUT="${2:-$REPO_ROOT/waka.tsv}"

USERDIC="${USERDIC:-$REPO_ROOT/tmp/nostr-haikubot/userdic.txt}"
SPLITTER_DIR="$SCRIPT_DIR/blocksplit"
SPLITTER="$SPLITTER_DIR/blocksplit"

[ -f "$INPUT" ] || { echo "[error] not found: $INPUT" >&2; exit 1; }
[ -f "$USERDIC" ] || { echo "[error] userdic not found: $USERDIC" >&2; exit 1; }

# Build the splitter binary on demand.
if [ ! -x "$SPLITTER" ] || [ "$SPLITTER_DIR/main.go" -nt "$SPLITTER" ]; then
  echo "[build] $SPLITTER" >&2
  ( cd "$SPLITTER_DIR" && go build -o blocksplit ./... ) || {
    echo "[error] go build failed" >&2; exit 1;
  }
fi

# Step 1 (Python): pull (text, note1) per event as JSON.
#   text  : raw waka body (NIP-08 mentions, nostr: refs, hashtags removed,
#           newlines collapsed to a single space — the bot's normalize uses
#           TrimSpace and the body fits on one line for tokenization)
#   note1 : NIP-19 bech32 of the *original* waka id
python3 - "$INPUT" "$OUTPUT.in" <<'PY'
import json
import re
import sys

import bech32

NEVENT_RE = re.compile(r'nostr:nevent1[a-z0-9]+')
NOSTR_BECH_RE = re.compile(r'nostr:(?:npub|note|nevent|naddr|nprofile)1[a-z0-9]+')
NIP08_RE = re.compile(r'#\[\d+\]')
HASHTAG_RE = re.compile(r'#[A-Za-z0-9_]+')
WS_RE = re.compile(r'[ \t　]+')


def decode_nevent_id(bech: str) -> str | None:
    body = bech[len('nostr:'):] if bech.startswith('nostr:') else bech
    hrp, data = bech32.bech32_decode(body)
    if hrp != 'nevent' or data is None:
        return None
    raw = bech32.convertbits(data, 5, 8, False)
    if not raw:
        return None
    buf = bytes(raw)
    i = 0
    while i + 2 <= len(buf):
        t, ln = buf[i], buf[i + 1]
        v = buf[i + 2:i + 2 + ln]
        if t == 0 and ln == 32:
            return v.hex()
        i += 2 + ln
    return None


def to_note1(hex_id: str) -> str:
    five = bech32.convertbits(bytes.fromhex(hex_id), 8, 5)
    return bech32.bech32_encode('note', five)


def clean(content: str) -> str:
    s = content
    s = NIP08_RE.sub('', s)
    s = NOSTR_BECH_RE.sub('', s)
    s = HASHTAG_RE.sub('', s)
    s = s.replace('\t', ' ')
    parts = [WS_RE.sub(' ', line).strip() for line in s.splitlines()]
    return ' '.join(p for p in parts if p)


def find_etag_id(tags) -> str | None:
    for t in tags or []:
        if len(t) >= 2 and t[0] == 'e':
            return t[1]
    return None


with open(sys.argv[1], 'r', encoding='utf-8') as fin, \
     open(sys.argv[2], 'w', encoding='utf-8') as fout:
    for line in fin:
        line = line.strip()
        if not line:
            continue
        ev = json.loads(line)
        content = ev.get('content', '') or ''
        wid = None
        m = NEVENT_RE.search(content)
        if m:
            wid = decode_nevent_id(m.group(0))
        if not wid:
            wid = find_etag_id(ev.get('tags'))
        if not wid:
            continue
        text = clean(content)
        if not text:
            continue
        fout.write(json.dumps({'text': text, 'note1': to_note1(wid)},
                              ensure_ascii=False) + '\n')
PY

# Step 2 (Go): tokenize each line and split into 5-7-5-7-7 blocks.
"$SPLITTER" -userdic "$USERDIC" < "$OUTPUT.in" > "$OUTPUT"
rc=$?
rm -f "$OUTPUT.in"
exit "$rc"
