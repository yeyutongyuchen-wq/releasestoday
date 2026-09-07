export const prerender = false;

type SubscribeBody = {
  email?: unknown;
  game_id?: unknown;
};

function getDb(locals: App.Locals) {
  const db = locals.runtime?.env?.DB;
  if (!db) {
    throw new Error('D1 binding DB is missing');
  }
  return db;
}

export async function POST({ request, locals }: { request: Request; locals: App.Locals }) {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return Response.json({ ok: false, error: 'Unsupported Media Type' }, { status: 415 });
  }

  const body = (await request.json().catch(() => null)) as SubscribeBody | null;
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const gameId = typeof body?.game_id === 'string' ? body.game_id.trim() : '';

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return Response.json({ ok: false, error: 'Invalid email' }, { status: 400 });
  }

  if (!gameId) {
    return Response.json({ ok: false, error: 'Invalid game_id' }, { status: 400 });
  }

  try {
    const db = getDb(locals);
    await db
      .prepare('INSERT INTO subscribers (email, game_id) VALUES (?, ?)')
      .bind(email, gameId)
      .run();

    return Response.json({ ok: true }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('UNIQUE') || message.includes('constraint')) {
      return Response.json({ ok: false, error: 'Already subscribed' }, { status: 409 });
    }
    return Response.json({ ok: false, error: 'Database error' }, { status: 500 });
  }
}

export function GET() {
  return new Response(null, { status: 405, headers: { Allow: 'POST' } });
}
