// nostr 100-poems — live design preview
//
// Pipeline:
//   note fetch    : ask bootstrap relays for kind:1 by id (note1 in wakadata.tsv).
//   content proc  : on event received, fire display proc (existence == OK).
//   display proc  : create yomi+tori DOM. fill from cache or "詠み人知らず".
//   profile fetch : per unique author, ask kind:0 from bootstrap relays.
//   profile ready : on kind:0 event, update cache (newest wins) + DOM.
//
// Author-deleted notes never trigger display proc, so they vanish.
// Profile cache is persisted in localStorage with created_at for newest-wins.

import { createRxNostr, createRxBackwardReq } from 'https://esm.sh/rx-nostr@3';
import { verifier } from 'https://esm.sh/@rx-nostr/crypto';
import { nip19 } from 'https://esm.sh/nostr-tools@2';

const BOOTSTRAP_RELAYS = [
  'wss://directory.yabu.me',
  'wss://purplepag.es',
  'wss://relay.nostr.band',
  'wss://indexer.coracle.social',
  'wss://relay-jp.nostr.wirednet.jp',
  'wss://yabu.me',
  'wss://relay.damus.io',
];

const TSV = {
  WAKA: 'data/wakadata.tsv',
  NOTE2AUTHOR: 'data/note2author.tsv',
  AUTHOR: 'data/author.tsv',
};

const PLACEHOLDER_AUTHOR = '詠み人知らず';
const PROFILE_CACHE_KEY = 'nostr-100-poems:profiles';

// ----- module state -----

const profileCache = new Map();   // hex pubkey -> {name, dn, pic, created_at}
const cards = new Map();          // note1 -> { pairEl, pubkey }
const requestedAuthors = new Set(); // hex pubkeys for which kind:0 was requested
const imageCache = new Map();     // url -> Promise<{src, palette}>

let wakaByNote;        // note1 -> {surfaces, yomis, hex}
let noteHexToNote1;    // hex id -> note1
let rxNostr;

main();

// ----- main -----

async function main() {
  const root = document.getElementById('cards');

  // 1. Hydrate profile cache from author.tsv (created_at=0, lowest priority).
  try {
    const authorRows = await fetchTSV(TSV.AUTHOR);
    for (const [npub, name, dn, pic] of authorRows) {
      try {
        const dec = nip19.decode(npub);
        if (dec.type !== 'npub') continue;
        profileCache.set(dec.data, { name, dn, pic, created_at: 0 });
      } catch (_) { /* skip */ }
    }
  } catch (_) { /* author.tsv missing is fine */ }

  // 2. Hydrate from localStorage (overrides if newer).
  try {
    const stored = JSON.parse(localStorage.getItem(PROFILE_CACHE_KEY) || '{}');
    for (const [pubkey, p] of Object.entries(stored)) {
      const cur = profileCache.get(pubkey);
      if (!cur || (p.created_at || 0) >= (cur.created_at || 0)) {
        profileCache.set(pubkey, p);
      }
    }
  } catch (_) { /* corrupt cache, ignore */ }

  // 3. Load wakadata.tsv to know what to fetch.
  let wakaRows;
  try {
    wakaRows = await fetchTSV(TSV.WAKA);
  } catch (e) {
    root.innerHTML = `<div class="error">${e.message}</div>`;
    return;
  }

  wakaByNote = new Map();
  noteHexToNote1 = new Map();
  const noteHexIds = [];
  for (const row of wakaRows) {
    if (row[0] !== '1') continue;
    if (row.length < 12) continue;
    const note1 = row[11];
    let hex;
    try {
      const dec = nip19.decode(note1);
      if (dec.type !== 'note') continue;
      hex = dec.data;
    } catch (_) { continue; }
    wakaByNote.set(note1, {
      surfaces: [row[1], row[2], row[3], row[4], row[5]],
      yomis:    [row[6], row[7], row[8], row[9], row[10]],
      note1, hex,
    });
    noteHexToNote1.set(hex, note1);
    noteHexIds.push(hex);
  }

  // 4. Set up rx-nostr.
  rxNostr = createRxNostr({ verifier });
  rxNostr.setDefaultRelays(BOOTSTRAP_RELAYS);

  // 5. Note fetch.
  const noteReq = createRxBackwardReq();
  rxNostr.use(noteReq).subscribe({
    next: ({ event }) => handleNoteEvent(event),
  });
  noteReq.emit({ kinds: [1], ids: noteHexIds });
  noteReq.over();
}

// ----- note / content / display -----

function handleNoteEvent(event) {
  if (event.kind !== 1) return;
  const note1 = noteHexToNote1.get(event.id);
  if (!note1) return;
  if (cards.has(note1)) return; // already rendered (dedupe across relays)
  const waka = wakaByNote.get(note1);
  if (!waka) return;

  const pairEl = renderCard(waka, event.pubkey);
  cards.set(note1, { pairEl, pubkey: event.pubkey });
  document.getElementById('cards').appendChild(pairEl);

  ensureProfileFetch(event.pubkey);
}

function renderCard(waka, pubkeyHex) {
  const profile = profileCache.get(pubkeyHex);
  const displayName = (profile && (profile.dn || profile.name)) || PLACEHOLDER_AUTHOR;

  const pair = document.createElement('div');
  pair.className = 'pair';
  pair.dataset.pubkey = pubkeyHex;
  pair.appendChild(buildYomi(waka.surfaces, displayName, waka.note1));
  pair.appendChild(buildTori(waka.yomis));
  if (profile) applyProfileToCard(pair, profile);
  return pair;
}

// ----- profile fetch / ready -----

function ensureProfileFetch(pubkeyHex) {
  if (requestedAuthors.has(pubkeyHex)) return;
  requestedAuthors.add(pubkeyHex);
  const req = createRxBackwardReq();
  rxNostr.use(req).subscribe({
    next: ({ event }) => handleProfileEvent(event),
  });
  req.emit({ kinds: [0], authors: [pubkeyHex] });
  req.over();
}

function handleProfileEvent(event) {
  if (event.kind !== 0) return;
  const cur = profileCache.get(event.pubkey);
  if (cur && (cur.created_at || 0) >= event.created_at) return;
  let content = {};
  try { content = JSON.parse(event.content || '{}'); } catch (_) {}
  const profile = {
    name: (content.name || '').toString(),
    dn:   (content.display_name || content.displayName || '').toString(),
    pic:  (content.picture || '').toString(),
    created_at: event.created_at,
  };
  profileCache.set(event.pubkey, profile);
  persistProfileCache();
  for (const { pairEl, pubkey } of cards.values()) {
    if (pubkey === event.pubkey) applyProfileToCard(pairEl, profile);
  }
}

function persistProfileCache() {
  try {
    const obj = {};
    for (const [pubkey, p] of profileCache) obj[pubkey] = p;
    localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(obj));
  } catch (_) { /* quota or disabled — ignore */ }
}

function applyProfileToCard(pairEl, profile) {
  const displayName = (profile.dn || profile.name) || PLACEHOLDER_AUTHOR;
  const authorEl = pairEl.querySelector('.yomi-upper .col.author');
  if (authorEl) authorEl.textContent = displayName;

  const lower = pairEl.querySelector('.yomi-lower');
  const card = pairEl.querySelector('.yomi');
  if (!lower || !card) return;
  lower.innerHTML = '';
  // Guard: a later applyProfileToCard call must invalidate any earlier
  // pending image-load .then() for this same `lower`.
  const reqId = (lower._imgReqId || 0) + 1;
  lower._imgReqId = reqId;
  if (profile.pic) {
    loadImageOnce(profile.pic).then(({ src, palette }) => {
      if (lower._imgReqId !== reqId) return;
      const img = document.createElement('img');
      img.alt = displayName;
      img.referrerPolicy = 'no-referrer';
      img.src = src;
      lower.appendChild(img);
      if (palette) applyPalette(card, palette.bg, palette.fg);
    });
  } else {
    lower.innerHTML = '<div class="placeholder">no picture</div>';
  }
}

// ----- DOM builders -----

function buildYomi(surfaces, authorName, note1) {
  const card = document.createElement('a');
  card.className = 'card yomi';
  if (note1) {
    card.href = `https://nostter.app/${note1}`;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';
  }

  const upper = document.createElement('div');
  upper.className = 'yomi-upper';
  // visual order in vertical-rl (right to left):
  //   author -> b0 -> b1 -> b2 -> b3 -> b4
  const cols = [authorName, ...surfaces];
  for (const text of cols) {
    const col = document.createElement('div');
    col.className = 'col' + (text === authorName ? ' author' : '');
    col.textContent = text;
    upper.appendChild(col);
  }
  card.appendChild(upper);

  // The image is filled in by applyProfileToCard once a profile is
  // available. Keeping it here would race with the kind:0 path and
  // duplicate the image.
  const lower = document.createElement('div');
  lower.className = 'yomi-lower';
  lower.innerHTML = '<div class="placeholder">no picture</div>';
  card.appendChild(lower);

  return card;
}

function buildTori(yomis) {
  const card = document.createElement('div');
  card.className = 'card tori';
  const grid = document.createElement('div');
  grid.className = 'tori-grid';
  // block3 + block4 (下の句, 7+7=14 chars) into 3-col x 5-row, RTL fill.
  const chars = (yomis[3] + yomis[4]).split('');
  for (let i = 0; i < chars.length; i++) {
    const colIdx = 3 - Math.floor(i / 5);
    const rowIdx = (i % 5) + 1;
    const cell = document.createElement('div');
    cell.className = 'ch';
    cell.style.gridColumn = String(colIdx);
    cell.style.gridRow = String(rowIdx);
    cell.textContent = chars[i];
    grid.appendChild(cell);
  }
  card.appendChild(grid);
  return card;
}

// ----- image / palette -----

function loadImageOnce(url) {
  if (imageCache.has(url)) return imageCache.get(url);
  const p = (async () => {
    try {
      const res = await fetch(url, { mode: 'cors', referrerPolicy: 'no-referrer' });
      if (!res.ok) throw new Error('http ' + res.status);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const img = await loadImgEl(blobUrl);
      let palette = null;
      try { palette = computePalette(img); } catch (_) { /* tainted */ }
      return { src: blobUrl, palette };
    } catch (_) {
      return { src: url, palette: null };
    }
  })();
  imageCache.set(url, p);
  return p;
}

function loadImgEl(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function computePalette(img) {
  const W = 64, H = 64;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, W, H);
  const data = ctx.getImageData(0, 0, W, H).data;
  const ring = 4;
  const counts = new Map();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const onRing = x < ring || x >= W - ring || y < ring || y >= H - ring;
      if (!onRing) continue;
      const i = (y * W + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (a < 128) continue;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  if (counts.size === 0) return { bg: '#fffaf0', fg: '#111' };
  let bestKey = 0, bestCount = -1;
  for (const [k, c] of counts) {
    if (c > bestCount) { bestCount = c; bestKey = k; }
  }
  const r4 = (bestKey >> 8) & 0xf;
  const g4 = (bestKey >> 4) & 0xf;
  const b4 = bestKey & 0xf;
  const r = (r4 << 4) | 0x8;
  const g = (g4 << 4) | 0x8;
  const b = (b4 << 4) | 0x8;
  // fg: pure black on light bg, pure white on dark bg
  // (the one farther from the bg average luminance).
  const f = (r + g + b) / 3 > 127.5 ? 0 : 255;
  return {
    bg: `rgb(${r}, ${g}, ${b})`,
    fg: `rgb(${f}, ${f}, ${f})`,
  };
}

function applyPalette(card, bg, fg) {
  card.style.background = bg;
  card.style.color = fg;
  const upper = card.querySelector('.yomi-upper');
  if (upper) upper.style.color = fg;
  const author = card.querySelector('.yomi-upper .col.author');
  if (author) {
    author.style.color = fg;
    author.style.opacity = '0.7';
  }
}

// ----- TSV loader -----

async function fetchTSV(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch ${url}: ${res.status}`);
  const text = await res.text();
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => l.split('\t'));
}
