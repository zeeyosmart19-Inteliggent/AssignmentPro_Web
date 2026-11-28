#!/usr/bin/env node
// AssignmentPro server — CREATED BY ZEEYO
// One shared database for every teacher and student, on any device. No dependencies (Node 20+).
//   node server.mjs            ->  http://localhost:8080
//   PORT=3000 DATA_DIR=/data node server.mjs
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { localRequest, setEnv, LocalError } from './engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const DATA = path.resolve(process.env.DATA_DIR || path.join(HERE, 'data'));
const FILES = path.join(DATA, 'files');
const DB_FILE = path.join(DATA, 'db.json');
const MAX_JSON = 2 * 1024 * 1024;
const MAX_UPLOAD = 32 * 1024 * 1024;
fs.mkdirSync(FILES, { recursive: true });

/* ---- storage environment for the shared engine ---- */
let dbText = fs.existsSync(DB_FILE) ? fs.readFileSync(DB_FILE, 'utf8') : null;
const fileP = (key) => path.join(FILES, String(key).replace(/[^A-Za-z0-9._-]/g, '_'));
async function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, text);
  await fsp.rename(tmp, file);
}
const env = {
  ctx: null,
  async get(store, key) {
    if (store === 'kv') return key === 'db' && dbText ? JSON.parse(dbText) : undefined;
    try { return new Blob([await fsp.readFile(fileP(key))]); } catch { return undefined; }
  },
  async put(store, key, val) {
    if (store === 'kv') { if (key === 'db') { const t = JSON.stringify(val); await atomicWrite(DB_FILE, t); dbText = t; } return; }
    await fsp.writeFile(fileP(key), Buffer.from(await val.arrayBuffer()));
  },
  async del(store, key) { if (store === 'files') { try { await fsp.unlink(fileP(key)); } catch { /* already gone */ } } },
  tokenGet() { return this.ctx ? this.ctx.token : null; },
  tokenSet(token, remember) { if (this.ctx) this.ctx.out.token = { token, remember: !!remember }; },
  tokenClear() { if (this.ctx) this.ctx.out.clear = true; },
};
setEnv(env);

/* ---- helpers ---- */
const SEC = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'microphone=(self)',
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
};
const titleCase = (h) => h.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('-');
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new LocalError(413, 'That upload is too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SEC, ...headers });
  res.end(body);
}
const sendJson = (res, status, obj, extra = {}) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });

let indexBuf = null, indexGz = null, indexMtime = 0;
function loadIndex() {
  const f = path.join(HERE, 'index.html');
  const st = fs.statSync(f);
  if (!indexBuf || st.mtimeMs !== indexMtime) { indexBuf = fs.readFileSync(f); indexGz = zlib.gzipSync(indexBuf, { level: 6 }); indexMtime = st.mtimeMs; }
}

/* ---- request handler ---- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p === '/favicon.ico') return send(res, 204, undefined);
    if (p === '/api/health') return sendJson(res, 200, { assignmentpro: true, mode: 'server' });
    if (p.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    if (p === '/' || p === '/index.html') {
      loadIndex();
      const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      return send(res, 200, req.method === 'HEAD' ? undefined : (gz ? indexGz : indexBuf), {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding', ...(gz ? { 'Content-Encoding': 'gzip' } : {}),
      });
    }
    return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  } catch (e) {
    console.error('[server]', e);
    if (!res.headersSent) sendJson(res, 500, { error: 'Something went wrong. Please try again.' });
  }
});

async function handleApi(req, res, url) {
  const method = req.method;
  const auth = String(req.headers.authorization || '');
  const ctx = { token: auth.startsWith('Bearer ') ? auth.slice(7).trim() : null, out: {} };
  try {
    // File download (permission-checked by the engine, then streamed from disk)
    const fm = /^\/api\/file\/(recordings|attachments)\/(\d+)$/.exec(url.pathname);
    if (fm && method === 'GET') {
      const meta = await localRequest('GET', `/api/_file/${fm[1]}/${fm[2]}`, { ctx });
      const blob = await env.get('files', meta.fileKey);
      if (!blob) throw new LocalError(404, 'File not found.');
      const buf = Buffer.from(await blob.arrayBuffer());
      return send(res, 200, buf, { 'Content-Type': meta.mime || 'application/octet-stream', 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=300' });
    }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) headers[titleCase(k)] = Array.isArray(v) ? v.join(', ') : v;
    const isJson = /^application\/json/i.test(req.headers['content-type'] || '');
    let body, blob;
    if (method !== 'GET' && method !== 'HEAD') {
      if (isJson || !req.headers['content-type']) {
        const buf = await readBody(req, MAX_JSON);
        try { body = buf.length ? JSON.parse(buf.toString('utf8')) : {}; } catch { throw new LocalError(400, 'Invalid request.'); }
      } else {
        const buf = await readBody(req, MAX_UPLOAD);
        blob = new Blob([buf], { type: req.headers['content-type'] });
      }
    }
    const data = await localRequest(method, req.url, { body, blob, headers, ctx });
    const extra = {};
    if (ctx.out.token) { extra['X-AP-Token'] = ctx.out.token.token; extra['X-AP-Remember'] = ctx.out.token.remember ? '1' : '0'; }
    else if (ctx.out.clear) extra['X-AP-Clear'] = '1';
    return sendJson(res, 200, data ?? {}, extra);
  } catch (e) {
    if (e instanceof LocalError) {
      const extra = ctx.out.clear ? { 'X-AP-Clear': '1' } : {};
      return sendJson(res, e.status || 500, { error: e.message }, extra);
    }
    console.error('[api]', method, url.pathname, e);
    return sendJson(res, 500, { error: 'Something went wrong. Please try again.' });
  }
}

server.listen(PORT, HOST, () => {
  console.log(`\n  AssignmentPro is running:  http://localhost:${PORT}`);
  const lan = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => `http://${i.address}:${PORT}`);
  if (lan.length) console.log(`  Same Wi-Fi (sign-in + class work; mic needs https): ${lan.join('  ')}`);
  console.log(`  Shared database folder:    ${DATA}`);
  console.log('  Keep this window open. Press Ctrl+C to stop.\n');
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); });
