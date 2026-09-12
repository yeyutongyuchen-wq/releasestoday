#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const OUT_FILE = path.join(process.cwd(), 'src/data/games.json');
const DOCS_FILE = path.join(process.cwd(), 'docs/games.json');
const DOCS_INDEX = path.join(process.cwd(), 'docs/index.html');

const STEAM_SEARCH =
  'https://store.steampowered.com/search/results/?filter=comingsoon&sort_by=_ASC&category1=998&json=1&cc=us&l=english&count=100&start=';
const STEAM_APP = (id) =>
  `https://store.steampowered.com/api/appdetails?appids=${id}&cc=us&l=english`;

const ALLOWED_PLATFORMS = new Set(['PC', 'PS5', 'Xbox Series X', 'Switch', 'Switch 2']);
const YEARS = new Set(['2026', '2027']);
const USER_AGENT = 'releasestoday-data-sync/1.0 (github-actions)';

function slugify(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');
}

function toISODate(value) {
  if (!value) return '';
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return '';
  return new Date(parsed).toISOString().slice(0, 10);
}

function mapPlatforms(data) {
  const out = new Set();
  const platforms = data.platforms || {};
  if (platforms.windows || platforms.mac || platforms.linux) out.add('PC');
  const blob = `${data.name || ''} ${JSON.stringify(data.categories || [])}`.toLowerCase();
  if (/\bps5\b|playstation 5/.test(blob)) out.add('PS5');
  if (/xbox series/.test(blob)) out.add('Xbox Series X');
  if (/switch 2/.test(blob)) out.add('Switch 2');
  else if (/\bswitch\b/.test(blob)) out.add('Switch');
  return [...out].filter((p) => ALLOWED_PLATFORMS.has(p));
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function loadSteamComingSoon() {
  try {
    const items = [];
    for (const start of [0, 100]) {
      const page = await fetchJson(STEAM_SEARCH + start);
      const rows = Array.isArray(page.items) ? page.items : [];
      items.push(...rows);
      if (rows.length < 100) break;
    }
    return items;
  } catch (err) {
    console.warn('steam search failed:', err.message);
    return [];
  }
}

async function loadApp(appId) {
  const json = await fetchJson(STEAM_APP(appId));
  const node = json?.[String(appId)];
  if (!node?.success || !node.data) return null;
  return node.data;
}

function normalize(raw) {
  const title = String(raw.title || raw.name || '').trim();
  const slug = String(raw.slug || slugify(title)).trim();
  const release_date = toISODate(raw.release_date || raw.released || raw.date);
  const platforms = Array.isArray(raw.platforms)
    ? raw.platforms.map(String)
    : mapPlatforms(raw);
  return {
    title,
    slug,
    release_date,
    platforms: platforms.filter((p) => ALLOWED_PLATFORMS.has(p)),
    status: raw.status || (release_date ? 'Locked' : 'TBA'),
    delay_history: Array.isArray(raw.delay_history) ? raw.delay_history : [],
    specs_min: raw.specs_min || undefined,
    specs_rec: raw.specs_rec || undefined,
    cover_url: raw.cover_url || raw.header_image || raw.capsule || '',
    youtube_id: raw.youtube_id || '',
    affiliate_links: raw.affiliate_links || undefined,
  };
}

function keep(game) {
  if (!game.title || !game.slug) return false;
  if (!game.cover_url) return false;
  if (!game.release_date) return false;
  if (!YEARS.has(game.release_date.slice(0, 4))) return false;
  if (!game.platforms.length) return false;
  return true;
}

function mergeBySlug(base, incoming) {
  const map = new Map();
  for (const row of base) if (row && row.slug) map.set(row.slug, row);
  for (const row of incoming) {
    const prev = map.get(row.slug);
    map.set(row.slug, prev ? { ...row, ...prev, cover_url: prev.cover_url || row.cover_url } : row);
  }
  return [...map.values()].sort((a, b) =>
    String(a.release_date || '').localeCompare(String(b.release_date || '')),
  );
}

function readExisting() {
  for (const file of [OUT_FILE, DOCS_FILE]) {
    if (!fs.existsSync(file)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(data)) return data;
    } catch (err) {
      console.warn('skip broken file', file, err.message);
    }
  }
  return [];
}

async function main() {
  const existing = readExisting();
  let incoming = [];
  const remoteUrl = process.env.CALENDAR_SOURCE_URL;

  try {
    if (remoteUrl) {
      const data = await fetchJson(remoteUrl);
      const list = Array.isArray(data) ? data : data.games || data.items || [];
      incoming = list.map(normalize).filter(keep);
      console.log('remote source:', incoming.length);
    } else {
      const coming = await loadSteamComingSoon();
      const ids = [...new Set(coming.map((row) => Number(row.id || row.appid)).filter(Boolean))];
      console.log('steam ids:', ids.length);
      for (const id of ids.slice(0, 40)) {
        try {
          const app = await loadApp(id);
          if (!app || app.type !== 'game') continue;
          incoming.push(
            normalize({
              title: app.name,
              slug: slugify(app.name),
              release_date: toISODate(app.release_date && app.release_date.date),
              platforms: mapPlatforms(app),
              status: app.release_date && app.release_date.coming_soon ? 'Locked' : 'Released',
              cover_url: app.header_image,
            }),
          );
          await new Promise((r) => setTimeout(r, 300));
        } catch (err) {
          console.warn('skip', id, err.message);
        }
      }
      incoming = incoming.filter(keep);
      console.log('steam cleaned:', incoming.length);
    }
  } catch (err) {
    console.warn('upstream failed, keep existing catalog:', err.message);
    incoming = [];
  }

  const merged = mergeBySlug(existing.map(normalize), incoming);
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.mkdirSync(path.dirname(DOCS_FILE), { recursive: true });
  const text = JSON.stringify(merged, null, 2) + '\n';
  fs.writeFileSync(OUT_FILE, text);
  fs.writeFileSync(DOCS_FILE, text);
  fs.writeFileSync(
    DOCS_INDEX,
    '<!doctype html><meta charset="utf-8"><p><a href="./games.json">games.json</a></p>\n',
  );
  console.log('wrote', merged.length, 'games');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
