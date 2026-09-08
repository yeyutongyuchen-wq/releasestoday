type Env = {
  DB: D1Database;
  CALENDAR_JSON_URL?: string;
  DEPLOY_HOOK_URL?: string;
};

type RemoteGame = {
  title: string;
  slug: string;
  release_date?: string | null;
  platforms?: string[];
  status?: string;
  cover_url?: string | null;
  youtube_id?: string | null;
};

type StoredGame = {
  slug: string;
  release_date: string | null;
  status: string;
};

const DEFAULT_SOURCE =
  'https://raw.githubusercontent.com/OWNER/REPO/main/data/games.json';

function normDate(value?: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 10);
}

function normStatus(value?: string | null): string {
  const allowed = new Set(['Locked', 'Delayed', 'TBA', 'Rumored', 'Released']);
  return value && allowed.has(value) ? value : 'Locked';
}

async function loadRemote(url: string): Promise<RemoteGame[]> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'releasestoday-sync' },
  });
  if (!res.ok) throw new Error(`Source ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) throw new Error('Remote JSON must be an array');

  return data.filter((row): row is RemoteGame => {
    return !!row && typeof row === 'object' && typeof (row as RemoteGame).slug === 'string' && typeof (row as RemoteGame).title === 'string';
  });
}

async function triggerRebuild(env: Env, changed: number): Promise<void> {
  if (changed < 1 || !env.DEPLOY_HOOK_URL) return;
  const res = await fetch(env.DEPLOY_HOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'calendar-diff', changed }),
  });
  if (!res.ok) console.error('Deploy hook failed', res.status, await res.text());
}

async function runSync(env: Env) {
  const source = env.CALENDAR_JSON_URL || DEFAULT_SOURCE;
  const list = await loadRemote(source);

  let inserted = 0;
  let delayed = 0;

  for (const game of list) {
    const slug = game.slug.trim();
    const title = game.title.trim();
    const releaseDate = normDate(game.release_date);
    const status = normStatus(game.status);
    const platforms = JSON.stringify(game.platforms ?? []);
    const cover = game.cover_url || null;
    const youtube = game.youtube_id || null;

    const found = await env.DB.prepare(
      'SELECT slug, release_date, status FROM games WHERE slug = ? LIMIT 1',
    )
      .bind(slug)
      .first<StoredGame>();

    if (!found) {
      await env.DB.prepare(
        `INSERT INTO games
          (slug, title, release_date, status, platforms, cover_url, youtube_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      )
        .bind(slug, title, releaseDate, status === 'TBA' ? 'TBA' : 'Locked', platforms, cover, youtube)
        .run();

      await env.DB.prepare(
        `INSERT INTO date_events (game_id, old_date, new_date, event_type, change_reason)
         VALUES (?, NULL, ?, ?, ?)`,
      )
        .bind(slug, releaseDate, releaseDate ? 'locked' : 'tba', 'Remote calendar first seen')
        .run();

      inserted += 1;
      continue;
    }

    const oldDate = found.release_date || null;
    const dateChanged = oldDate !== releaseDate;
    const statusChanged = found.status !== status;

    if (!dateChanged && !statusChanged) continue;

    await env.DB.prepare(
      `INSERT INTO date_events (game_id, old_date, new_date, event_type, change_reason)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(
        slug,
        oldDate,
        releaseDate,
        dateChanged ? 'delayed' : 'status',
        `Remote calendar diff (${found.status} -> ${status})`,
      )
      .run();

    await env.DB.prepare(
      `UPDATE games SET
         title = ?,
         release_date = ?,
         status = ?,
         platforms = ?,
         cover_url = ?,
         youtube_id = ?,
         updated_at = datetime('now')
       WHERE slug = ?`,
    )
      .bind(title, releaseDate, status, platforms, cover, youtube, slug)
      .run();

    delayed += 1;
  }

  const changed = inserted + delayed;
  await triggerRebuild(env, delayed);

  return { ok: true, source, fetched: list.length, inserted, delayed, changed };
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runSync(env));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/sync' && request.method === 'POST') {
      try {
        return Response.json(await runSync(env));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'sync failed';
        return Response.json({ ok: false, error: message }, { status: 500 });
      }
    }
    return new Response('calendar-sync ok', { status: 200 });
  },
};
