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
      const r = await q('SELECT data FROM assignmentpro.ap_kv WHERE key = $1', [key]);
      return r.rows[0] ? r.rows[0].data : undefined;
    }
    const r = await q('SELECT mime, data FROM assignmentpro.ap_files WHERE key = $1', [String(key)]);
    return r.rows[0] ? new Blob([r.rows[0].data], { type: r.rows[0].mime || '' }) : undefined;
  },
  async put(store, key, val) {
    if (store === 'kv') { await q('INSERT INTO assignmentpro.ap_kv (key, data) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data', [key, JSON.stringify(val)]); return; }
    await q('INSERT INTO assignmentpro.ap_files (key, mime, data) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data', [String(key), val.type || '', Buffer.from(await val.arrayBuffer())]);
  },
  async del(store, key) { if (store === 'files') await q('DELETE FROM assignmentpro.ap_files WHERE key = $1', [String(key)]); },
  tokenGet() { return this.ctx ? this.ctx.token : null; },
  tokenSet(token, remember) { if (this.ctx) this.ctx.out.token = { token, remember: !!remember }; },
  tokenClear() { if (this.ctx) this.ctx.out.clear = true; },
};
setEnv(env);

let schemaReady = false;
async function ensureSchema(query) {
  if (schemaReady) return;
  await query('CREATE SCHEMA IF NOT EXISTS assignmentpro');
  await query('CREATE TABLE IF NOT EXISTS assignmentpro.ap_kv (key text PRIMARY KEY, data jsonb NOT NULL)');
  await query('CREATE TABLE IF NOT EXISTS assignmentpro.ap_files (key text PRIMARY KEY, mime text NOT NULL DEFAULT \'\', data bytea NOT NULL)');
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
  if (url.pathname === '/api/health/db') {
    try { await withDb(connect, async () => (await q('SELECT 1')).rows); return json(200, { ok: true }); }
    catch (e) { return json(500, { ok: false, error: String((e && e.message) || e), seenVariables: dbEnvNames() }); }
  }
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

/** A fresh connection per request: Netlify freezes idle function instances, which kills pooled connections. */
function envEntries() {
  const out = { ...process.env };
  try { if (typeof Netlify !== 'undefined' && Netlify.env && Netlify.env.toObject) Object.assign(out, Netlify.env.toObject()); } catch { /* not on Netlify */ }
  return out;
}
const isPg = (v) => typeof v === 'string' && /^postgres(ql)?:\/\//i.test(v.trim());
/** Known names first, then any variable whose value is a Postgres URL (so a differently named variable still works). */
function dbUrl() {
  const e = envEntries();
  for (const k of ['NETLIFY_DATABASE_URL', 'NETLIFY_DATABASE_URL_UNPOOLED', 'DATABASE_URL', 'NEON_DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL']) if (isPg(e[k])) return e[k].trim();
  const any = Object.keys(e).find((k) => isPg(e[k]));
  return any ? e[any].trim() : '';
}
export function dbEnvNames() { const e = envEntries(); return Object.keys(e).filter((k) => /DATA|DB|POSTGRES|NEON|PG|SQL/i.test(k)).map((k) => `${k}${isPg(e[k]) ? ' (postgres url)' : ' (not a postgres url)'}`); }
async function connectPg() {
  const cs = dbUrl();
  if (!cs) throw new LocalError(503, 'The database is not connected. In Netlify, enable Netlify DB for this site (it sets NETLIFY_DATABASE_URL) and redeploy.');
  const { default: pg } = await import('pg');
  const url = new URL(cs); url.searchParams.delete('sslmode'); url.searchParams.delete('channel_binding');
  const local = /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
  const client = new pg.Client({ connectionString: url.toString(), ssl: local ? false : { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
  client.on('error', (e) => console.warn('[pg]', e.message));
  try { await client.connect(); }
  catch (e) { console.error('[db connect]', e); throw new LocalError(503, 'Cannot reach the database (' + (e.code || e.message) + '). Check the Netlify DB connection and redeploy.'); }
  return client;
}

export default async (req) => handleApi(req, connectPg);
export const config = { path: '/api/*' };
