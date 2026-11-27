// AssignmentPro — Netlify Function. Runs the shared engine on top of Netlify DB (Postgres). CREATED BY ZEEYO
// Every request runs inside one Postgres transaction that first takes a global advisory lock, so
// concurrent requests (even on different function instances) are applied one at a time and never
// overwrite each other.
import { localRequest, setEnv, LocalError } from '../../engine.mjs';

const MAX_JSON = 2 * 1024 * 1024;
const MAX_UPLOAD = 5 * 1024 * 1024; // Netlify Functions accept request bodies up to ~6 MB
const LOCK_ID = 727001;
const SEC = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'microphone=(self)',
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
};
const titleCase = (h) => h.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('-');
const json = (status, obj, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { ...SEC, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });

/* ---- storage environment for the shared engine (bound to the current request's transaction) ---- */
let q = null; // query(text, params) -> { rows }
const env = {
  ctx: null,
  async get(store, key) {
    if (store === 'kv') {
      const r = await q('SELECT data FROM ap_kv WHERE key = $1', [key]);
      return r.rows[0] ? r.rows[0].data : undefined;
    }
    const r = await q('SELECT mime, data FROM ap_files WHERE key = $1', [String(key)]);
    return r.rows[0] ? new Blob([r.rows[0].data], { type: r.rows[0].mime || '' }) : undefined;
  },
  async put(store, key, val) {
    if (store === 'kv') { await q('INSERT INTO ap_kv (key, data) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data', [key, JSON.stringify(val)]); return; }
    await q('INSERT INTO ap_files (key, mime, data) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data', [String(key), val.type || '', Buffer.from(await val.arrayBuffer())]);
  },
  async del(store, key) { if (store === 'files') await q('DELETE FROM ap_files WHERE key = $1', [String(key)]); },
  tokenGet() { return this.ctx ? this.ctx.token : null; },
  tokenSet(token, remember) { if (this.ctx) this.ctx.out.token = { token, remember: !!remember }; },
  tokenClear() { if (this.ctx) this.ctx.out.clear = true; },
};
setEnv(env);

let schemaReady = false;
async function ensureSchema(query) {
  if (schemaReady) return;
  await query('CREATE TABLE IF NOT EXISTS ap_kv (key text PRIMARY KEY, data jsonb NOT NULL)');
  await query('CREATE TABLE IF NOT EXISTS ap_files (key text PRIMARY KEY, mime text NOT NULL DEFAULT \'\', data bytea NOT NULL)');
  schemaReady = true;
}

/** Runs fn(query) in a transaction holding the global lock. Requests inside one instance are also queued. */
let chain = Promise.resolve();
export function withDb(connect, fn) {
  const run = async () => {
    const client = await connect();
    const query = (text, params) => client.query(text, params);
    try {
      await ensureSchema(query);
      await query('BEGIN');
      await query("SET LOCAL lock_timeout = '25s'");
      await query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
      q = query;
      let out;
      try { out = await fn(); } catch (e) {
        if (e instanceof LocalError) { await query('COMMIT'); throw e; } // engine already rolled back its own changes
        await query('ROLLBACK'); throw e;
      }
      await query('COMMIT');
      return out;
    } finally { q = null; if (client.release) client.release(); else if (client.end) await client.end().catch(() => {}); }
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

export async function handleApi(req, connect) {
  const url = new URL(req.url);
  const method = req.method;
  if (url.pathname === '/api/health') return json(200, { assignmentpro: true, mode: 'server' });
  const auth = req.headers.get('authorization') || '';
  const ctx = { token: auth.startsWith('Bearer ') ? auth.slice(7).trim() : null, out: {} };
  try {
    const fm = /^\/api\/file\/(recordings|attachments)\/(\d+)$/.exec(url.pathname);
    if (fm && method === 'GET') {
      return await withDb(connect, async () => {
        const meta = await localRequest('GET', `/api/_file/${fm[1]}/${fm[2]}`, { ctx });
        const blob = await env.get('files', meta.fileKey);
        if (!blob) throw new LocalError(404, 'File not found.');
        const buf = Buffer.from(await blob.arrayBuffer());
        return new Response(buf, { status: 200, headers: { ...SEC, 'Content-Type': meta.mime || 'application/octet-stream', 'Cache-Control': 'private, max-age=300' } });
      });
    }
    const headers = {};
    for (const [k, v] of req.headers) headers[titleCase(k)] = v;
    const ctype = req.headers.get('content-type') || '';
    let body, blob;
    if (method !== 'GET' && method !== 'HEAD') {
      const buf = Buffer.from(await req.arrayBuffer());
      if (/^application\/json/i.test(ctype) || !ctype) {
        if (buf.length > MAX_JSON) throw new LocalError(413, 'That request is too large.');
        try { body = buf.length ? JSON.parse(buf.toString('utf8')) : {}; } catch { throw new LocalError(400, 'Invalid request.'); }
      } else {
        if (buf.length > MAX_UPLOAD) throw new LocalError(413, 'That upload is too large (limit 5 MB).');
        blob = new Blob([buf], { type: ctype });
      }
    }
    const data = await withDb(connect, () => localRequest(method, url.pathname + url.search, { body, blob, headers, ctx }));
    const extra = {};
    if (ctx.out.token) { extra['X-AP-Token'] = ctx.out.token.token; extra['X-AP-Remember'] = ctx.out.token.remember ? '1' : '0'; }
    else if (ctx.out.clear) extra['X-AP-Clear'] = '1';
    return json(200, data ?? {}, extra);
  } catch (e) {
    if (e instanceof LocalError) return json(e.status || 500, { error: e.message }, ctx.out.clear ? { 'X-AP-Clear': '1' } : {});
    console.error('[api]', method, url.pathname, e);
    return json(500, { error: 'Something went wrong. Please try again.' });
  }
}

let pool = null;
async function connectPg() {
  if (!pool) {
    const { default: pg } = await import('pg');
    const cs = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
    if (!cs) throw new Error('No database configured: set NETLIFY_DATABASE_URL (Netlify DB) or DATABASE_URL.');
    pool = new pg.Pool({ connectionString: cs, max: 1, ssl: /localhost|127\.0\.0\.1/.test(cs) ? false : { rejectUnauthorized: false } });
  }
  return pool.connect();
}

export default async (req) => handleApi(req, connectPg);
export const config = { path: '/api/*' };
