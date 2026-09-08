export type DelayEvent = {
  date: string;
  type: string;
  reason?: string;
};

export type Specs = {
  cpu: string;
  ram: string;
  storage: string;
  gpu: string;
};

export type Game = {
  title: string;
  slug: string;
  release_date: string;
  platforms: string[];
  status: 'Locked' | 'Delayed' | 'TBA' | 'Rumored' | 'Released';
  delay_history: DelayEvent[];
  specs_min: Specs;
  specs_rec: Specs;
  cover_url: string;
  youtube_id: string;
  affiliate_links?: { humble?: string; gmg?: string };
};

type GameRow = {
  slug: string;
  title: string;
  release_date: string | null;
  status: string;
  platforms: string | null;
  cover_url: string | null;
  youtube_id: string | null;
};

type EventRow = {
  game_id: string;
  old_date: string | null;
  new_date: string | null;
  event_type: string | null;
  change_reason: string | null;
  created_at?: string | null;
};

const ACCOUNT = import.meta.env.CLOUDFLARE_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = import.meta.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
const DB_ID = import.meta.env.D1_DATABASE_ID || process.env.D1_DATABASE_ID || 'a03575e5-179c-42c9-b8d1-8aa48f59f61f';

const DEFAULT_MIN: Specs = {
  cpu: 'Intel Core i5-10400 / AMD Ryzen 5 3600',
  ram: '16 GB',
  storage: '80 GB SSD',
  gpu: 'NVIDIA GeForce RTX 3060 (8GB VRAM)',
};

const DEFAULT_REC: Specs = {
  cpu: 'Intel Core i7-12700 / AMD Ryzen 7 5700X',
  ram: '16 GB',
  storage: '80 GB NVMe SSD',
  gpu: 'NVIDIA GeForce RTX 4070 (12GB VRAM)',
};

function parsePlatforms(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return raw.split(',').map((item) => item.trim()).filter(Boolean);
  }
}

function mapStatus(value: string | null): Game['status'] {
  const allowed: Game['status'][] = ['Locked', 'Delayed', 'TBA', 'Rumored', 'Released'];
  return allowed.includes(value as Game['status']) ? (value as Game['status']) : 'Locked';
}

function mapGame(row: GameRow, events: EventRow[]): Game {
  return {
    title: row.title,
    slug: row.slug,
    release_date: row.release_date && row.release_date !== 'TBA' ? row.release_date : '',
    platforms: parsePlatforms(row.platforms),
    status: mapStatus(row.status),
    delay_history: events.map((event) => ({
      date: event.new_date || event.created_at || event.old_date || 'TBA',
      type: event.event_type || 'update',
      reason: event.change_reason || undefined,
    })),
    specs_min: DEFAULT_MIN,
    specs_rec: DEFAULT_REC,
    cover_url: row.cover_url || '',
    youtube_id: row.youtube_id || '',
  };
}

async function queryViaBinding(sql: string, params: unknown[] = []) {
  const mod = await import('cloudflare:workers');
  const db = (mod as { env?: { DB?: D1Database } }).env?.DB;
  if (!db) return null;
  const stmt = params.length ? db.prepare(sql).bind(...params) : db.prepare(sql);
  const res = await stmt.all();
  return res.results || [];
}

async function queryViaApi(sql: string, params: unknown[] = []) {
  if (!ACCOUNT || !TOKEN) {
    throw new Error('D1 unavailable: set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN for build.');
  }
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB_ID}/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql, params }),
    },
  );
  const json = (await res.json()) as {
    success: boolean;
    errors?: { message: string }[];
    result?: { results?: unknown[] }[];
  };
  if (!res.ok || !json.success) {
    throw new Error(json.errors?.[0]?.message || `D1 HTTP ${res.status}`);
  }
  return json.result?.[0]?.results || [];
}

async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  try {
    const bound = await queryViaBinding(sql, params);
    if (bound) return bound as T[];
  } catch {
    // fall through to HTTP API
  }
  return (await queryViaApi(sql, params)) as T[];
}

export async function loadGamesFromD1(): Promise<Game[]> {
  const games = await query<GameRow>(
    'SELECT slug, title, release_date, status, platforms, cover_url, youtube_id FROM games ORDER BY release_date IS NULL, release_date ASC',
  );
  const events = await query<EventRow>(
    'SELECT game_id, old_date, new_date, event_type, change_reason, created_at FROM date_events ORDER BY id ASC',
  );

  const bySlug = new Map<string, EventRow[]>();
  for (const event of events) {
    const list = bySlug.get(event.game_id) || [];
    list.push(event);
    bySlug.set(event.game_id, list);
  }

  return games.map((row) => mapGame(row, bySlug.get(row.slug) || []));
}
