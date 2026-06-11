/* ============================================================
   The Vault — catalogue builder
   Reads the published Google Sheet CSV, extracts ONLY the
   "Games" column, cleans it up, queries RAWG for cover art /
   Metascore / official store link, merges manual overrides,
   and writes games.json for the static page.

   Env vars (set as GitHub Action secrets):
     RAWG_API_KEY   — free key from https://rawg.io/apidocs
     SHEET_CSV_URL  — "Publish to web" CSV link of the GAMES-ONLY tab
   ============================================================ */

import fs from 'node:fs';

const RAWG_KEY = process.env.RAWG_API_KEY;
const SHEET_URL = process.env.SHEET_CSV_URL;
if (!RAWG_KEY) { console.error('Missing RAWG_API_KEY'); process.exit(1); }
if (!SHEET_URL) { console.error('Missing SHEET_CSV_URL'); process.exit(1); }

/* ---------- 1. Cell-level rewrites for messy sheet entries ----------
   Applied to the WHOLE cell before splitting. Use this for rows where
   plain comma-splitting would break. Keys are matched case-insensitively
   as substrings. */
const CELL_REWRITES = [
  { match: 'dark souls 1, 2, 3', replace: 'Dark Souls Remastered; Dark Souls II; Dark Souls III; Demon\u2019s Souls' },
  { match: 'resident evil village + hades', replace: 'Resident Evil Village; Hades' },
];

/* ---------- 2. Alias map: sheet shorthand -> searchable title ---------- */
const ALIASES = {
  'crash 4': "Crash Bandicoot 4: It's About Time",
  'tony hawk': "Tony Hawk's Pro Skater 1 + 2",
  'ff9': 'Final Fantasy IX',
  'ff15': 'Final Fantasy XV',
  'ff16': 'Final Fantasy XVI',
  'final fantasy 16': 'Final Fantasy XVI',
  'final fantasy 7 remake': 'Final Fantasy VII Remake',
  'final fantasy 7 rebirth': 'Final Fantasy VII Rebirth',
  'uncharted 1-3': 'Uncharted: The Nathan Drake Collection',
  'tomb raider 3': 'Shadow of the Tomb Raider',
  'sayonara wh': 'Sayonara Wild Hearts',
  'codevein': 'Code Vein',
  'tekken 7 + dlc': 'Tekken 7',
  'tekken 8 ultimate edition': 'Tekken 8',
  'alan wake 2 & dlcs': 'Alan Wake 2',
  'elden ring': 'Elden Ring',
  'shadow of the erdtree dlc': null,            // DLC of Elden Ring — skip as own entry
  'shadow of the erdtree': null,
  'dark souls 1': 'Dark Souls: Remastered',
  'dark souls 2': 'Dark Souls II',
  'dark souls 3': 'Dark Souls III',
  'nioh 1': 'Nioh',
  'armored core 6': 'Armored Core VI: Fires of Rubicon',
  'ratchet & clank 2016': 'Ratchet & Clank',
  'shadow of the collossus': 'Shadow of the Colossus',
  'uncharted lost legacy': 'Uncharted: The Lost Legacy',
  'the last of us part 2': 'The Last of Us Part II',
  'the ascend': 'The Ascent',
  'spider-man 2': "Marvel's Spider-Man 2",
  'spider-man miles morales': "Marvel's Spider-Man: Miles Morales",
  'guardians of the galaxy': "Marvel's Guardians of the Galaxy",
  'ratchet & clank': 'Ratchet & Clank',
  'death stranding 2': 'Death Stranding 2: On the Beach',
  'god of war sons of sparta': 'God of War Sons of Sparta',
  'final fantasy tactics - the ivalice chronicles': 'Final Fantasy Tactics: The Ivalice Chronicles',
  'crusader kings 3': 'Crusader Kings III',
  'the walking dead': 'The Walking Dead: Season 1',
  'demon souls': "Demon's Souls",
};

/* Entries to drop entirely (subscription labels, not games) */
const SKIP_PATTERNS = [
  /ps\+\s*premium library/i, /ps\+\s*monthly games/i, /ps\+\s*collection/i,
  /^ps\+/i, /^\d+$/, /^dlcs?$/i, /^with dlcs?$/i, /^update req/i,
];

/* ---------- CSV parsing (handles quoted cells with commas) ---------- */
function parseCSV(text) {
  const rows = []; let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i+1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function cleanCell(raw) {
  let s = raw
    .replace(/\[[^\]]*\]/g, '')        // strip [PS+ EXTRA ACTIVE ...] style notes
    .replace(/\*\*/g, '')              // stray bold markers
    .trim();
  for (const r of CELL_REWRITES) {
    if (s.toLowerCase().includes(r.match)) return r.replace;
  }
  return s;
}

function extractTitles(cell) {
  const out = [];
  for (let part of cell.split(/[;,]/)) {
    part = part.trim().replace(/\s+/g, ' ');
    part = part.replace(/\s*\((PS5|PS4|VR)\)$/i, '').replace(/\s*[–-]\s*PS[45]$/i, '').trim();
    if (!part) continue;
    if (SKIP_PATTERNS.some(p => p.test(part))) continue;
    const alias = ALIASES[part.toLowerCase()];
    if (alias === null) continue;      // explicitly skipped (DLC etc.)
    out.push(alias || part);
  }
  return out;
}

/* ---------- RAWG lookups ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function rawg(path, params = {}) {
  const url = new URL(`https://api.rawg.io/api/${path}`);
  url.searchParams.set('key', RAWG_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`RAWG ${path}: HTTP ${res.status}`);
  return res.json();
}

function similarity(a, b) {
  const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  a = norm(a); b = norm(b);
  if (a === b) return 1;
  if (b.startsWith(a) || a.startsWith(b)) return 0.9;
  const aw = new Set(a.split(' ')), bw = new Set(b.split(' '));
  const inter = [...aw].filter(w => bw.has(w)).length;
  return inter / Math.max(aw.size, bw.size);
}

async function lookupGame(title) {
  const data = await rawg('games', { search: title, page_size: 5, search_precise: 'true' });
  const results = data.results || [];
  if (!results.length) return null;
  results.sort((x, y) => similarity(title, y.name) - similarity(title, x.name));
  const best = results[0];
  if (similarity(title, best.name) < 0.4) return null;

  // Try to get an official store link (prefer PlayStation Store)
  let link = `https://rawg.io/games/${best.slug}`;
  try {
    const stores = await rawg(`games/${best.id}/stores`);
    const all = stores.results || [];
    const ps = all.find(s => /playstation/i.test(s.url));
    const steam = all.find(s => /steampowered/i.test(s.url));
    link = (ps || steam || all[0])?.url || link;
  } catch { /* keep rawg link */ }

  // RAWG community verdict: top ratings bucket label, average (0-5), vote count
  const topBucket = (best.ratings && best.ratings.length)
    ? [...best.ratings].sort((a, b) => b.count - a.count)[0].title : null;

  return {
    t: best.name,
    y: best.released ? Number(best.released.slice(0, 4)) : null,
    c: best.metacritic ?? null,                  // critic Metascore
    r: best.rating || null,                      // RAWG community rating 0-5
    rl: topBucket,                               // "exceptional" / "recommended" / "meh" / "skip"
    rc: best.ratings_count || 0,                 // number of votes
    img: best.background_image || null,          // official key art
    link,
    mc: `https://www.metacritic.com/search/${encodeURIComponent(best.name)}/`,
    slug: best.slug,
  };
}

/* ---------- main ---------- */
const overrides = JSON.parse(fs.readFileSync(new URL('../data/overrides.json', import.meta.url), 'utf8'));

const csvText = await (await fetch(SHEET_URL)).text();
const rows = parseCSV(csvText);
const header = rows[0].map(h => h.trim().toLowerCase());

// There may be several columns whose header contains "games" (or a stray empty
// duplicate). Pick the candidate column with the most non-empty data cells.
let candidates = header
  .map((h, i) => (h.includes('games') ? i : -1))
  .filter(i => i !== -1);
if (!candidates.length) candidates = header.map((_, i) => i); // fallback: any column
let gamesCol = -1, bestCount = -1;
for (const i of candidates) {
  const count = rows.slice(1).filter(r => r[i] && r[i].trim()).length;
  if (count > bestCount) { bestCount = count; gamesCol = i; }
}
if (gamesCol === -1 || bestCount === 0) { console.error('No populated "Games" column found in sheet'); process.exit(1); }
console.log(`Using column ${gamesCol + 1} ("${rows[0][gamesCol].trim() || 'unnamed'}") with ${bestCount} filled rows`);

const titles = [];
const seen = new Set();
for (const row of rows.slice(1)) {
  const cell = row[gamesCol];
  if (!cell || !cell.trim()) continue;
  // stop at the guidelines/notes section: rows whose Games cell is empty
  // are skipped naturally; rows from other tables won't have this column filled
  for (const t of extractTitles(cleanCell(cell))) {
    const key = t.toLowerCase();
    if (!seen.has(key)) { seen.add(key); titles.push(t); }
  }
}
console.log(`Parsed ${titles.length} unique titles from sheet`);

const games = [];
const warnings = [];
for (const title of titles) {
  try {
    const hit = await lookupGame(title);
    if (!hit) { warnings.push(`NOT FOUND on RAWG: "${title}"`); continue; }
    const ov = overrides[hit.t] || overrides[title] || {};
    games.push({
      t: ov.title || hit.t,
      y: ov.year ?? hit.y,
      c: ov.critic ?? hit.c,
      r: hit.r,                                  // RAWG community rating 0-5
      rl: hit.rl,
      rc: hit.rc,
      img: ov.img || hit.img,
      link: ov.link || hit.link,
      mc: ov.mc || hit.mc,
      dlc: ov.dlc || null,
    });
    console.log(`  ok: ${title} -> ${hit.t} [MC ${hit.c ?? '–'} | RAWG ${hit.r ?? '–'}]`);
  } catch (e) {
    warnings.push(`ERROR for "${title}": ${e.message}`);
  }
  await sleep(250); // be polite to the free API
}

games.sort((a, b) => (b.c ?? 0) - (a.c ?? 0) || (b.r ?? 0) - (a.r ?? 0) || a.t.localeCompare(b.t));

fs.writeFileSync(new URL('../games.json', import.meta.url),
  JSON.stringify({ updated: new Date().toISOString(), games }, null, 2));

if (warnings.length) {
  console.log('\n--- Warnings ---');
  warnings.forEach(w => console.log(w));
  fs.writeFileSync(new URL('../build-warnings.txt', import.meta.url), warnings.join('\n'));
}
console.log(`\nWrote games.json with ${games.length} games`);
