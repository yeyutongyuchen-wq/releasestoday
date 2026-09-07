export const prerender = false;

import { env } from 'cloudflare:workers';

export async function POST({ request }: { request: Request }) {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return Response.json({ ok: false, error: 'Unsupported Media Type' }, { status: 415 });
  }

  const body = await request.json().catch(() => null);
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const gameId = typeof body?.game_id === 'string' ? body.game_id.trim() : '';

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return Response.json({ ok: false, error: 'Invalid email' }, { status: 400 });
  }

  if (!gameId) {
    return Response.json({ ok: false, error: 'Invalid game_id' }, { status: 400 });
  }

  const db = (env as { DB?: D1Database }).DB;
  if (!db) {
    return Response.json({ ok: false, error: 'D1 binding DB is missing' }, { status: 500 });
  }

  try {
    await db
      .prepare('INSERT INTO subscribers (email, game_id) VALUES (?, ?)')
      .bind(email, gameId)
      .run();

    return Response.json({ ok: true }, { status: 201 });
  } catch (error) {
    const err = error as { message?: string; cause?: { message?: string } };
    const message = [err?.message, err?.cause?.message].filter(Boolean).join(' | ');

    if (message.includes('UNIQUE') || message.includes('constraint')) {
      return Response.json({ ok: false, error: 'Already subscribed' }, { status: 409 });
    }

    return Response.json({ ok: false, error: message || 'Database error' }, { status: 500 });
  }
}

export function GET() {
  return new Response(null, { status: 405, headers: { Allow: 'POST' } });
}
