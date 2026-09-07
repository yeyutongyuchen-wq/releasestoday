export const prerender = false;

export async function POST({ request }: { request: Request }) {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return Response.json({ ok: false, error: 'Unsupported Media Type' }, { status: 415 });
  }

  const body = await request.json().catch(() => null);
  const email = typeof body?.email === 'string' ? body.email.trim() : '';

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return Response.json({ ok: false, error: 'Invalid email' }, { status: 400 });
  }

  return Response.json({ ok: true }, { status: 201 });
}

export function GET() {
  return new Response(null, { status: 405, headers: { Allow: 'POST' } });
}
