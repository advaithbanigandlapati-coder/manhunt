export { Room } from './room';

interface Env {
  ROOMS: DurableObjectNamespace;
}

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[A-Z2-9]{5}$/;

function newCode() {
  const r = new Uint8Array(5);
  crypto.getRandomValues(r);
  return [...r].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}

// The app may be hosted elsewhere (e.g. Vercel), so the small JSON endpoints allow cross-origin calls.
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
function withCors(r: Response) {
  if (r.status === 101) return r; // websocket upgrades pass through untouched
  const out = new Response(r.body, r);
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    return withCors(await route(req, env));
  },
} satisfies ExportedHandler<Env>;

async function route(req: Request, env: Env): Promise<Response> {
  {
    const url = new URL(req.url);

    // POST /api/create {hostId} -> {code}
    if (url.pathname === '/api/create' && req.method === 'POST') {
      const { hostId } = (await req.json().catch(() => ({}))) as { hostId?: string };
      if (!hostId) return new Response('hostId required', { status: 400 });
      for (let i = 0; i < 8; i++) {
        const code = newCode();
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const r = await stub.fetch('https://room/init', { method: 'POST', body: JSON.stringify({ code, hostId }) });
        if (r.ok) return Response.json({ code });
      }
      return new Response('could not allocate a code', { status: 500 });
    }

    // GET /api/party/:code            -> {exists, phase}
    // GET /api/party/:code/ws (upgrade) -> game socket
    const m = url.pathname.match(/^\/api\/party\/([A-Za-z0-9]{5})(\/ws)?$/);
    if (m) {
      const code = m[1].toUpperCase();
      if (!CODE_RE.test(code)) return new Response('bad code', { status: 400 });
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      if (m[2]) return stub.fetch(req);
      return stub.fetch('https://room/exists');
    }

    return new Response('not found', { status: 404 });
  }
}
