#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const OUT_FILE = path.join(process.cwd(), 'src/data/games.json');
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
  const blob = `${data.name || ''} ${(data.supported_languages || '')}`.toLowerCase();
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
  const items = [];
  for (const start of [0, 100, 200]) {
    const page = await fetchJson(STEAM_SEARCH + start);
    const rows = Array.isArray(page.items) ? page.items : [];
    items.push(...rows);
    if (rows.length < 100) break;
  }
  return items;
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
  for (const row of base) map.set(row.slug, row);
  for (const row of incoming) {
    const prev = map.get(row.slug);
    map.set(row.slug, prev ? { ...row, ...prev, cover_url: prev.cover_url || row.cover_url } : row);
  }
  return [...map.values()].sort((a, b) =>
    String(a.release_date).localeCompare(String(b.release_date)),
  );
}

async function main() {
  const existing = fs.existsSync(OUT_FILE)
    ? JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'))
    : [];

  const remoteUrl = process.env.CALENDAR_SOURCE_URL;
  let incoming = [];

  if (remoteUrl) {
    const data = await fetchJson(remoteUrl);
    const list = Array.isArray(data) ? data : data.games || data.items || [];
    incoming = list.map(normalize).filter(keep);
    console.log(`remote source: ${incoming.length} after filter`);
  } else {
    const coming = await loadSteamComingSoon();
    const ids = [...new Set(coming.map((row) => Number(row.id || row.appid)).filter(Boolean))];
    console.log(`steam coming soon ids: ${ids.length}`);
    for (const id of ids.slice(0, 80)) {
      try {
        const app = await loadApp(id);
        if (!app || app.type !== 'game') continue;
        const date = toISODate(app.release_date?.date);
        incoming.push(
          normalize({
            title: app.name,
            slug: slugify(app.name),
            release_date: date,
            platforms: mapPlatforms(app),
            status: app.release_date?.coming_soon ? 'Locked' : 'Released',
            cover_url: app.header_image,
            youtube_id: Array.isArray(app.movies) && app.movies[0]?.id ? '' : '',
          }),
        );
        await new Promise((r) => setTimeout(r, 250));
      } catch (err) {
        console.warn('skip', id, err.message);
      }
    }
    incoming = incoming.filter(keep);
    console.log(`steam cleaned: ${incoming.length}`);
  }

  const merged = mergeBySlug(existing.map(normalize), incoming);
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(merged, null, 2) + '\n');
  fs.mkdirSync('docs', { recursive: true });
  fs.writeFileSync('docs/games.json', JSON.stringify(merged, null, 2) + '\n');
  fs.writeFileSync('docs/index.html', '<!doctype html><meta charset="utf-8"><p>games.json feed</p>');
  console.log(`wrote ${merged.length} games -> ${OUT_FILE} and docs/games.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
