#!/usr/bin/env node
/**
 * scripts/fetch-global-games.js
 * 在 GitHub Actions 海外机器上运行的发售日历清洗脚本。
 *
 * 必填环境变量：
 *   CALENDAR_SOURCE_URL
 *     开源总库 JSON 的完整 raw 地址，例如：
 *     https://raw.githubusercontent.com/<用户名>/<仓库>/<分支>/<文件>.json
 *
 * 可选环境变量：
 *   CF_DEPLOY_HOOK 或 DEPLOY_HOOK_URL
 *     Cloudflare Pages / Worker 的 Deploy Hook
 *   MAX_GAMES
 *     最终保留条数，默认 100
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DOCS_FILE = path.join(ROOT, 'docs/games.json');
const SRC_FILE = path.join(ROOT, 'src/data/games.json');
const DOCS_INDEX = path.join(ROOT, 'docs/index.html');

const MAX_GAMES = Number.parseInt(process.env.MAX_GAMES || '100', 10) || 100;
const ALLOWED_YEARS = new Set(['2026', '2027']);
const USER_AGENT = 'releasestoday-data-sync/2.0 (github-actions)';

/** 将各种平台写法统一成主站标准字段 */
const PLATFORM_CANON = {
  pc: 'PC',
  windows: 'PC',
  win: 'PC',
  steam: 'PC',
  epic: 'PC',
  macos: 'PC',
  mac: 'PC',
  linux: 'PC',
  ps5: 'PS5',
  'playstation 5': 'PS5',
  playstation5: 'PS5',
  'ps5 pro': 'PS5',
  xbox: 'Xbox Series X',
  'xbox series': 'Xbox Series X',
  'xbox series x': 'Xbox Series X',
  'xbox series s': 'Xbox Series X',
  'xbox series x|s': 'Xbox Series X',
  xsx: 'Xbox Series X',
  xss: 'Xbox Series X',
  switch: 'Switch',
  'nintendo switch': 'Switch',
  'switch 2': 'Switch 2',
  'nintendo switch 2': 'Switch 2',
};

const CORE_PLATFORMS = new Set(['PC', 'PS5', 'Xbox Series X', 'Switch', 'Switch 2']);

/** 欧美玩家关注度较高的系列/作品，仅用于排序加权，不是白名单 */
const PRIORITY_TITLES = [
  'grand theft auto vi',
  'gta vi',
  'gta 6',
  "marvel's wolverine",
  'wolverine',
  'resident evil requiem',
  'resident evil 9',
  '007 first light',
  'pragmata',
  'onimusha',
  'okami 2',
  'the witcher 4',
  'fable',
  'perfect dark',
  'intergalactic',
  'marathon',
  'gears of war',
  'state of decay 3',
  'crimson desert',
  'duskbloods',
  'persona 4 revival',
  'control resonant',
  'phantom blade',
  'god of war',
  'elder scrolls vi',
  'judas',
  'exodus',
  'clockwork revolution',
  'the wolf among us 2',
  'assassin\'s creed',
  'final fantasy',
  'kingdom hearts',
  'metroid prime 4',
  'monster hunter',
  'silent hill',
  'tomb raider',
  'halo',
  'battlefield',
  'call of duty',
  'elden ring',
  'fromsoftware',
  'zelda',
  'super mario',
  'alan wake',
  'cyberpunk',
  'mass effect',
  'dragon age',
  'star wars',
  'death stranding',
  'horizon',
  'ghost of yotei',
  'the last of us',
  'hades 2',
  'hollow knight silksong',
  'like a dragon',
  'yakuza',
  'persona',
  'subnautica 2',
  'path of exile 2',
  'diablo',
  'skater',
  'indiana jones',
];

/** 明显的低质/周边内容，避免污染 SEO */
const JUNK_TITLE =
  /\b(idle|tycoon|clicker|simulator 20\d{2}|soundtrack|ost\b|dlc\b|season pass|cosmetic pack|demo\b|playtest|wallpaper|hentai|nutaku)\b/i;

function slugify(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function firstString(...values) {
  for (const value of values) {
    if (value == null) continue;
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'object') {
      const nested = firstString(
        value.name,
        value.title,
        value.original,
        value.original_name,
        value.en,
        value.english,
        value.date,
        value.text,
        value.url,
        value.id,
      );
      if (nested) return nested;
    }
  }
  return '';
}

function monthFromName(token) {
  const map = {
    jan: '01',
    january: '01',
    feb: '02',
    february: '02',
    mar: '03',
    march: '03',
    apr: '04',
    april: '04',
    may: '05',
    jun: '06',
    june: '06',
    jul: '07',
    july: '07',
    aug: '08',
    august: '08',
    sep: '09',
    sept: '09',
    september: '09',
    oct: '10',
    october: '10',
    nov: '11',
    november: '11',
    dec: '12',
    december: '12',
    winter: '01',
    spring: '03',
    summer: '06',
    fall: '09',
    autumn: '09',
    holiday: '11',
  };
  return map[String(token).toLowerCase()] || '';
}

/** 把各种发售时间写法清洗成 YYYY-MM-DD */
function toISODate(value) {
  if (!value) return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const asDate = value > 1e12 ? new Date(value) : value > 1e9 ? new Date(value * 1000) : null;
    if (asDate && !Number.isNaN(asDate.getTime())) return asDate.toISOString().slice(0, 10);
  }

  const raw = String(value).trim();
  if (!raw || /^tba|tbd|coming soon|unknown$/i.test(raw)) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const yearOnly = raw.match(/^(20\d{2})$/);
  if (yearOnly) return `${yearOnly[1]}-12-31`;

  const q = raw.match(/\bQ([1-4])\s*(20\d{2})/i) || raw.match(/(20\d{2})\s*Q([1-4])/i);
  if (q) {
    const year = q[1].startsWith('20') ? q[1] : q[2];
    const quarter = q[1].startsWith('20') ? q[2] : q[1];
    const month = String((Number(quarter) - 1) * 3 + 1).padStart(2, '0');
    return `${year}-${month}-01`;
  }

  const named = raw.match(
    /\b(winter|spring|summer|fall|autumn|holiday|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b[^\d]*(20\d{2})/i,
  );
  if (named) {
    const month = monthFromName(named[1]);
    if (month) return `${named[2]}-${month}-01`;
  }

  const ymd = raw.match(/(20\d{2})[./-](\d{1,2})[./-](\d{1,2})/);
  if (ymd) return `${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}`;

  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10);

  const year = raw.match(/(20\d{2})/);
  return year ? `${year[1]}-12-31` : '';
}

function extractYear(iso) {
  return iso && iso.length >= 4 ? iso.slice(0, 4) : '';
}

function flattenPlatformTokens(input) {
  const tokens = [];
  const walk = (node) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node === 'string' || typeof node === 'number') {
      tokens.push(String(node));
      return;
    }
    if (typeof node === 'object') {
      if (node.windows || node.mac || node.linux) tokens.push('PC');
      walk(node.name);
      walk(node.slug);
      walk(node.abbreviation);
      walk(node.platform);
      walk(node.platforms);
    }
  };
  walk(input);
  return tokens;
}

function mapPlatforms(raw) {
  const out = new Set();
  const tokens = flattenPlatformTokens(
    raw.platforms || raw.platform || raw.systems || raw.consoles || raw.os,
  );
  const blob = `${tokens.join(' ')} ${firstString(raw.title, raw.name)}`.toLowerCase();

  for (const token of tokens) {
    const key = String(token).toLowerCase().replace(/[_-]+/g, ' ').trim();
    if (PLATFORM_CANON[key]) out.add(PLATFORM_CANON[key]);
  }

  if (/\b(pc|windows|steam|epic games)\b/.test(blob)) out.add('PC');
  if (/\b(ps5|playstation 5|playstation5)\b/.test(blob)) out.add('PS5');
  if (/\bxbox/.test(blob)) out.add('Xbox Series X');
  if (/\bswitch 2\b/.test(blob)) out.add('Switch 2');
  else if (/\b(switch|nintendo switch)\b/.test(blob)) out.add('Switch');

  return [...out].filter((p) => CORE_PLATFORMS.has(p));
}

function extractYoutubeId(raw) {
  const candidates = [
    raw.youtube_id,
    raw.youtubeId,
    raw.trailer_id,
    raw.trailer,
    raw.youtube,
    raw.video_id,
    raw.video,
  ];
  for (const value of candidates) {
    if (!value) continue;
    const text = String(value);
    const id =
      text.match(/(?:v=|youtu\.be\/|youtube\.com\/(?:embed|shorts)\/)([A-Za-z0-9_-]{11})/)?.[1] ||
      (/^[A-Za-z0-9_-]{11}$/.test(text) ? text : '');
    if (id) return id;
  }
  return '';
}

function extractCover(raw) {
  const candidates = [
    raw.cover_url,
    raw.coverUrl,
    raw.header_image,
    raw.headerImage,
    raw.capsule,
    raw.poster,
    raw.thumbnail,
    raw.image,
    raw.cover,
    raw.background,
    raw.banner,
    raw.artwork,
  ];
  for (const value of candidates) {
    const url = firstString(value, value && value.url, value && value.src);
    if (/^https?:\/\//i.test(url)) return url;
  }
  return '';
}

/** 兼容总库常见的数组/对象包裹结构 */
function extractList(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const nested = [
    payload.games,
    payload.items,
    payload.results,
    payload.data,
    payload.releases,
    payload.records,
    payload.list,
    payload.entries,
    payload.calendar,
  ];
  for (const node of nested) {
    if (Array.isArray(node)) return node;
    if (node && typeof node === 'object') {
      const deeper = extractList(node);
      if (deeper.length) return deeper;
    }
  }
  return [];
}

function normalizeSourceUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';

  const blob = raw.match(
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/([^/]+)\/(.+)$/i,
  );
  if (blob) {
    return `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}/${blob[4]}`;
  }

  if (/^https?:\/\/githubusercontent\.com\/?$/i.test(raw)) {
    throw new Error(
      'CALENDAR_SOURCE_URL 只写了域名。请填写完整 raw 地址，例如 https://raw.githubusercontent.com/<用户名>/<仓库>/<分支>/<文件>.json',
    );
  }

  if (/^https?:\/\/githubusercontent\.com\//i.test(raw)) {
    return raw.replace(/^https?:\/\/githubusercontent\.com\//i, 'https://raw.githubusercontent.com/');
  }

  return raw;
}

/** 把开源总库字段强制映射成主站结构 */
function mapGame(raw = {}) {
  const title = firstString(
    raw.title,
    raw.name,
    raw.original_name,
    raw.originalName,
    raw.game_name,
    raw.gameName,
    raw.displayName,
    raw.en_name,
  );
  const slugSource = firstString(raw.slug, raw.id, raw.uid, raw.appid, raw.app_id, raw.url_slug, raw.key);
  const slug = slugify(
    /^[A-Za-z0-9_-]+$/.test(slugSource) && /[a-zA-Z]/.test(slugSource) ? slugSource : title,
  );
  const release_date = toISODate(
    raw.release_date ||
      raw.releaseDate ||
      raw.released ||
      raw.date ||
      raw.release ||
      raw.launch_date ||
      raw.launchDate ||
      (raw.release_date && raw.release_date.date),
  );

  return {
    title,
    slug,
    release_date,
    platforms: mapPlatforms(raw),
    status: firstString(raw.status, raw.state) || (release_date ? 'Locked' : 'TBA'),
    delay_history: Array.isArray(raw.delay_history) ? raw.delay_history : [],
    specs_min: raw.specs_min || undefined,
    specs_rec: raw.specs_rec || undefined,
    cover_url: extractCover(raw),
    youtube_id: extractYoutubeId(raw),
    affiliate_links: raw.affiliate_links || undefined,
  };
}

function isCorePlatformSet(platforms) {
  return platforms.some((p) => CORE_PLATFORMS.has(p));
}

function keep(game) {
  if (!game.title || !game.slug) return false;
  if (game.title.length < 2) return false;
  if (JUNK_TITLE.test(game.title) && anticipationScore(game) < 80) return false;
  if (!/^https?:\/\//i.test(game.cover_url || '')) return false;
  if (!game.release_date) return false;
  if (!ALLOWED_YEARS.has(extractYear(game.release_date))) return false;
  if (!isCorePlatformSet(game.platforms)) return false;
  return true;
}

function anticipationScore(game) {
  const hay = `${game.title} ${game.slug}`.toLowerCase();
  let score = 0;
  for (const needle of PRIORITY_TITLES) {
    if (hay.includes(needle.toLowerCase())) {
      score += needle.length >= 12 ? 120 : 80;
      break;
    }
  }
  if (game.platforms.includes('PC')) score += 8;
  if (game.platforms.includes('PS5')) score += 10;
  if (game.platforms.includes('Xbox Series X')) score += 8;
  if (game.platforms.length >= 2) score += 12;
  if (game.platforms.length >= 3) score += 8;
  if (game.youtube_id) score += 10;
  if (game.cover_url) score += 4;
  if (game.status && /lock|confirm|delay/i.test(game.status)) score += 6;
  return score;
}

function mergeBySlug(base, incoming) {
  const map = new Map();
  for (const row of base) {
    if (row?.slug) map.set(row.slug, row);
  }
  for (const row of incoming) {
    const prev = map.get(row.slug);
    if (!prev) {
      map.set(row.slug, row);
      continue;
    }
    map.set(row.slug, {
      ...row,
      ...prev,
      title: prev.title || row.title,
      release_date: row.release_date || prev.release_date,
      platforms: [...new Set([...(row.platforms || []), ...(prev.platforms || [])])].filter((p) =>
        CORE_PLATFORMS.has(p),
      ),
      status: row.status || prev.status,
      cover_url: prev.cover_url || row.cover_url,
      youtube_id: prev.youtube_id || row.youtube_id,
      delay_history: prev.delay_history?.length ? prev.delay_history : row.delay_history,
      specs_min: prev.specs_min || row.specs_min,
      specs_rec: prev.specs_rec || row.specs_rec,
      affiliate_links: prev.affiliate_links || row.affiliate_links,
    });
  }
  return [...map.values()];
}

function selectTop(games) {
  const unique = [];
  const seen = new Set();
  for (const game of games) {
    if (seen.has(game.slug)) continue;
    seen.add(game.slug);
    unique.push(game);
  }
  unique.sort((a, b) => {
    const scoreDelta = anticipationScore(b) - anticipationScore(a);
    if (scoreDelta !== 0) return scoreDelta;
    return String(a.release_date).localeCompare(String(b.release_date));
  });
  return unique
    .slice(0, MAX_GAMES)
    .sort((a, b) => String(a.release_date).localeCompare(String(b.release_date)));
}

function compact(game) {
  const out = {
    title: game.title,
    slug: game.slug,
    release_date: game.release_date,
    platforms: game.platforms,
    status: game.status || 'Locked',
    delay_history: Array.isArray(game.delay_history) ? game.delay_history : [],
    cover_url: game.cover_url,
    youtube_id: game.youtube_id || '',
  };
  if (game.specs_min) out.specs_min = game.specs_min;
  if (game.specs_rec) out.specs_rec = game.specs_rec;
  if (game.affiliate_links) out.affiliate_links = game.affiliate_links;
  return out;
}

function readExisting() {
  for (const file of [SRC_FILE, DOCS_FILE]) {
    if (!fs.existsSync(file)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const list = extractList(data);
      if (list.length) return list.map(mapGame);
    } catch (err) {
      console.warn('跳过损坏文件', file, err.message);
    }
  }
  return [];
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json,text/plain;q=0.9,*/*;q=0.8',
      'User-Agent': USER_AGENT,
    },
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('json')) return res.json();
  const text = await res.text();
  return JSON.parse(text);
}

async function triggerDeployHook() {
  const hook = process.env.CF_DEPLOY_HOOK || process.env.DEPLOY_HOOK_URL;
  if (!hook) {
    console.log('未配置 CF_DEPLOY_HOOK，跳过部署钩子');
    return;
  }
  const res = await fetch(hook, { method: 'POST', headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`部署钩子失败 -> ${res.status}`);
  console.log('部署钩子已触发', res.status);
}

async function main() {
  const existing = readExisting();
  const remoteUrl = normalizeSourceUrl(process.env.CALENDAR_SOURCE_URL);
  if (!remoteUrl) throw new Error('缺少环境变量 CALENDAR_SOURCE_URL');

  console.log('数据源', remoteUrl);
  const payload = await fetchJson(remoteUrl);
  const incoming = extractList(payload).map(mapGame).filter(keep);
  console.log('映射并过滤后', incoming.length);

  const merged = mergeBySlug(existing, incoming).filter(keep);
  const selected = selectTop(merged).map(compact);
  const text = `${JSON.stringify(selected, null, 2)}\n`;

  fs.mkdirSync(path.dirname(DOCS_FILE), { recursive: true });
  fs.mkdirSync(path.dirname(SRC_FILE), { recursive: true });
  fs.writeFileSync(DOCS_FILE, text);
  fs.writeFileSync(SRC_FILE, text);
  fs.writeFileSync(
    DOCS_INDEX,
    '<!doctype html><meta charset="utf-8"><title>games.json</title><p><a href="./games.json">games.json</a></p>\n',
  );
  console.log('已写入', selected.length, '款游戏 ->', DOCS_FILE);

  await triggerDeployHook();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
