// nostr 百人一首 — design preview
//
// Inputs (fetched at runtime):
//   data/wakadata.tsv     (12 cols: flag, b0..b4 surface, b0..b4 yomi, note1)
//   data/note2author.tsv  (note1, npub1)
//   data/author.tsv       (npub1, name, display_name, picture)
//
// Output: a list of <yomi-card, tori-card> pairs.

const TSV = {
  WAKA: 'data/wakadata.tsv',
  NOTE2AUTHOR: 'data/note2author.tsv',
  AUTHOR: 'data/author.tsv',
};

async function fetchTSV(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch ${url}: ${res.status}`);
  const text = await res.text();
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => l.split('\t'));
}

async function main() {
  const root = document.getElementById('cards');
  let waka, note2au, authors;
  try {
    [waka, note2au, authors] = await Promise.all([
      fetchTSV(TSV.WAKA),
      fetchTSV(TSV.NOTE2AUTHOR),
      fetchTSV(TSV.AUTHOR),
    ]);
  } catch (e) {
    root.innerHTML = `<div class="error">${e.message}</div>`;
    return;
  }

  const note2npub = new Map(note2au.map(([n, p]) => [n, p]));
  const npub2profile = new Map(
    authors.map(([npub, name, dn, pic]) => [npub, { name, dn, pic }]),
  );

  for (const row of waka) {
    if (row[0] !== '1') continue;
    if (row.length < 12) continue;
    const surfaces = [row[1], row[2], row[3], row[4], row[5]];
    const yomis = [row[6], row[7], row[8], row[9], row[10]];
    const note1 = row[11];
    const npub = note2npub.get(note1) || '';
    const profile = npub2profile.get(npub) || { name: '', dn: '', pic: '' };
    const displayName = profile.dn || profile.name || '';

    const pair = document.createElement('div');
    pair.className = 'pair';
    pair.appendChild(buildYomi(surfaces, displayName, profile.pic, note1));
    pair.appendChild(buildTori(yomis));
    root.appendChild(pair);
  }
}

// URL -> Promise<{ src, palette }>
// Ensures the image binary for a given URL is fetched at most once,
// even when the same author appears in multiple waka.
const imageCache = new Map();

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
      // CORS / network failure: fall back to direct <img src>.
      // Image will display but palette extraction is skipped.
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

function buildYomi(surfaces, authorName, picUrl, note1) {
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

  const lower = document.createElement('div');
  lower.className = 'yomi-lower';
  card.appendChild(lower);

  if (picUrl) {
    loadImageOnce(picUrl).then(({ src, palette }) => {
      const img = document.createElement('img');
      img.alt = authorName;
      img.referrerPolicy = 'no-referrer';
      img.src = src;
      lower.appendChild(img);
      if (palette) applyPalette(card, palette.bg, palette.fg);
    });
  } else {
    lower.innerHTML = '<div class="placeholder">no picture</div>';
  }

  return card;
}

function buildTori(yomis) {
  const card = document.createElement('div');
  card.className = 'card tori';

  const grid = document.createElement('div');
  grid.className = 'tori-grid';

  // block3 (yomi[3]) and block4 (yomi[4]) — the "下の句" 7+7 = 14 chars.
  const chars = (yomis[3] + yomis[4]).split('');

  // Vertical reading: top-to-bottom in each column, columns flow right-to-left.
  // Place chars in a 3-col x 5-row grid:
  //   char[0..4]   -> rightmost column (col 3), rows 1..5
  //   char[5..9]   -> col 2, rows 1..5
  //   char[10..13] -> col 1 (leftmost), rows 1..4 (col 1 row 5 empty)
  for (let i = 0; i < chars.length; i++) {
    const colIdx = 3 - Math.floor(i / 5); // 3,3,3,3,3, 2,2,2,2,2, 1,1,1,1
    const rowIdx = (i % 5) + 1;            // 1..5 repeating
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

// ----- color extraction -----

function computePalette(img) {
  const W = 64;
  const H = 64;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, W, H);
  const data = ctx.getImageData(0, 0, W, H).data;

  // Sample a 4-pixel-wide ring around the perimeter.
  const ring = 4;
  const counts = new Map();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const onRing = x < ring || x >= W - ring || y < ring || y >= H - ring;
      if (!onRing) continue;
      const i = (y * W + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (a < 128) continue;
      // Quantize 6 bits per channel (4-step) to bucket similar colors.
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
  // Recover to mid of bucket.
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
  // The lower (image area) keeps its own contrast; we only tint the upper text.
  const upper = card.querySelector('.yomi-upper');
  if (upper) {
    upper.style.color = fg;
  }
  const author = card.querySelector('.yomi-upper .col.author');
  if (author) {
    // Darken author to ~70% opacity of fg.
    author.style.color = fg;
    author.style.opacity = '0.7';
  }
}

main();
