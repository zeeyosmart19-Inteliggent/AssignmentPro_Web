// AssignmentPro in-browser backend: IndexedDB database, auth, permissions, file storage. CREATED BY ZEEYO
// Every API route the UI calls is handled here, so the whole platform runs from one HTML file.

const IDB_NAME = 'assignmentpro';
const SESSION_SHORT = 12 * 3600 * 1000;
const SESSION_LONG = 30 * 24 * 3600 * 1000;
const MAX_AUDIO = 30 * 1024 * 1024;
const MAX_ATTACHMENT = 25 * 1024 * 1024;
const MAX_CLASS_STUDENTS = 38;
const TOKEN_KEY = 'ap-session-token';

class LocalError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, msg) => { throw new LocalError(status, msg); };
const now = () => Date.now();

/* ---------------- storage environment ----------------
 * The same engine runs in two places:
 *  - the browser (single-file mode): IndexedDB + web storage
 *  - a Node server (shared mode): JSON database file + files on disk (see server.mjs)
 */
let ENV = null;
export function setEnv(e) { ENV = e; }
function browserEnv() {
  let idbPromise = null;
  const idb = () => {
    if (!idbPromise) {
      idbPromise = new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) { reject(new LocalError(500, 'This browser does not support IndexedDB storage.')); return; }
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
          if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(new LocalError(500, 'Could not open the AssignmentPro database. Private browsing may block storage.'));
      });
    }
    return idbPromise;
  };
  return {
    async get(store, key) { const d = await idb(); return new Promise((ok, bad) => { const r = d.transaction(store).objectStore(store).get(key); r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); }); },
    async put(store, key, val) {
      const d = await idb();
      return new Promise((ok, bad) => {
        const tx = d.transaction(store, 'readwrite'); tx.objectStore(store).put(val, key);
        tx.oncomplete = () => ok(); tx.onerror = () => bad(tx.error); tx.onabort = () => bad(tx.error || new Error('Storage quota exceeded'));
      });
    },
    async del(store, key) { const d = await idb(); return new Promise((ok, bad) => { const tx = d.transaction(store, 'readwrite'); tx.objectStore(store).delete(key); tx.oncomplete = () => ok(); tx.onerror = () => bad(tx.error); }); },
    tokenGet() { try { return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY); } catch { return null; } },
    tokenSet(token, remember) { try { (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token); } catch { /* storage blocked */ } },
    tokenClear() { try { sessionStorage.removeItem(TOKEN_KEY); localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } },
  };
}
const env = () => ENV || (ENV = browserEnv());
const idbGet = (store, key) => env().get(store, key);
const idbPut = (store, key, val) => env().put(store, key, val);
const idbDel = (store, key) => env().del(store, key);

const EMPTY = () => ({
  version: 1, seq: {}, users: [], sessions: [], classes: [], enrollments: [], assignments: [], assignmentStudents: [],
  questions: [], attachments: [], submissions: [], answers: [], recordings: [], notifications: [], messages: [],
});
let db = EMPTY();
async function load() {
  db = (await idbGet('kv', 'db')) || EMPTY();
  for (const k of Object.keys(EMPTY())) if (db[k] === undefined) db[k] = EMPTY()[k];
  // Migration: classes created with the old letter+number codes get a new numeric code (students/assignments are untouched).
  const bad = db.classes.filter((c) => !CODE_RE.test(String(c.inviteCode)));
  const seen = new Set(); let dup = false;
  for (const c of db.classes) { if (CODE_RE.test(String(c.inviteCode))) { if (seen.has(c.inviteCode)) { c.inviteCode = ''; dup = true; } else seen.add(c.inviteCode); } }
  if (bad.length || dup) {
    for (const c of db.classes) if (!CODE_RE.test(String(c.inviteCode))) c.inviteCode = newInviteCode(seen);
    await persist();
  }
}
async function persist() {
  try { await idbPut('kv', 'db', db); }
  catch { fail(507, 'Your browser storage is full. Free some space and try again.'); }
}
const nextId = (t) => { db.seq[t] = (db.seq[t] || 0) + 1; return db.seq[t]; };

/* Ask the browser to keep this site's data permanently (not evicted under storage pressure). */
try { if (typeof navigator !== 'undefined') navigator.storage?.persist?.(); } catch { /* ignore */ }

/* ---------------- crypto helpers ---------------- */
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
const randHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
async function sha256(s) { return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))); }
const HAS_SUBTLE = !!(globalThis.crypto && globalThis.crypto.subtle);
async function pbkdf2(pw, saltHex, iter) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(saltHex), iterations: iter }, key, 256));
}
async function hashPassword(pw) {
  if (!HAS_SUBTLE) fail(500, 'This browser cannot securely store passwords. Please use a modern browser.');
  const salt = randHex(16); const iter = 210000;
  return `pbkdf2$${iter}$${salt}$${await pbkdf2(pw, salt, iter)}`;
}
async function verifyPassword(pw, stored) {
  const [alg, iter, salt, h] = String(stored).split('$');
  if (alg !== 'pbkdf2') return false;
  const test = await pbkdf2(pw, salt, Number(iter));
  let diff = test.length ^ h.length;
  for (let i = 0; i < Math.min(test.length, h.length); i++) diff |= test.charCodeAt(i) ^ h.charCodeAt(i);
  return diff === 0;
}
/** Class codes are 6–8 digit numeric strings (strings keep leading zeros), unique across all classes. */
const CODE_RE = /^\d{6,8}$/;
const classByCode = (v) => { const d = cleanCode(v); return CODE_RE.test(d) ? db.classes.find((k) => String(k.inviteCode) === d) : undefined; };
function newInviteCode(taken) {
  const used = taken || new Set(db.classes.map((k) => String(k.inviteCode)));
  for (let tries = 0; tries < 10000; tries++) {
    const len = 6 + (crypto.getRandomValues(new Uint8Array(1))[0] % 3); // 6, 7 or 8 digits
    const digits = crypto.getRandomValues(new Uint32Array(len));
    const c = [...digits].map((d) => d % 10).join('');
    if (!used.has(c)) { used.add(c); return c; }
  }
  fail(500, 'Could not generate a unique class code. Please try again.');
}
/** Keeps digits only: removes spaces, dashes and letters people type by accident. */
const cleanCode = (v) => String(v == null ? '' : v).replace(/\D/g, '');

/* ---------------- validation & sanitizing ---------------- */
function str(v, { min = 0, max = 200, field = 'Field' } = {}) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < min) fail(400, min <= 1 ? `${field} is required.` : `${field} must be at least ${min} characters.`);
  if (s.length > max) fail(400, `${field} must be at most ${max} characters.`);
  return s;
}
const intId = (v) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) fail(400, 'Invalid id.'); return n; };
const ALLOWED_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'strike', 'p', 'br', 'ul', 'ol', 'li', 'h2', 'h3', 'h4', 'blockquote', 'code', 'pre', 'div', 'hr', 'sub', 'sup']);
const VOID_TAGS = new Set(['br', 'hr']);
function sanitizeHtml(input, maxLen = 200000) {
  let s = String(input || '');
  if (s.length > maxLen) fail(413, 'Text is too long.');
  s = s.replace(/<!--[\s\S]*?(-->|$)/g, '').replace(/<(script|style|iframe|object|embed|noscript|template|svg|math)\b[\s\S]*?(<\/\1\s*>|$)/gi, '');
  let out = ''; const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g; let last = 0, m;
  const esc = (t) => t.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  while ((m = re.exec(s))) {
    out += esc(s.slice(last, m.index)); last = re.lastIndex;
    const tag = m[1].toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) continue;
    const closing = m[0][1] === '/';
    if (VOID_TAGS.has(tag)) { if (!closing) out += `<${tag}>`; continue; }
    out += closing ? `</${tag}>` : `<${tag}>`;
  }
  return out + esc(s.slice(last));
}
const textOf = (html) => String(html || '').replace(/<[^>]*>/g, '').replace(/&nbsp;| /g, ' ').trim();

/* ---------------- rate limiting ---------------- */
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const t = now(); const b = buckets.get(key);
  if (!b || b.reset < t) { buckets.set(key, { count: 1, reset: t + windowMs }); return; }
  if (++b.count > max) fail(429, 'Too many attempts. Please wait a few minutes and try again.');
}

/* ---------------- sessions ---------------- */
function storedToken() { return env().tokenGet(); }
function clearToken() { env().tokenClear(); }
async function createSession(userId, remember) {
  const token = randHex(32);
  db.sessions = db.sessions.filter((s) => s.expiresAt > now());
  db.sessions.push({ tokenHash: await sha256(token), userId, expiresAt: now() + (remember ? SESSION_LONG : SESSION_SHORT), remember: !!remember, createdAt: now() });
  clearToken();
  env().tokenSet(token, remember);
}
async function currentUser() {
  const token = storedToken(); if (!token) return null;
  const th = await sha256(token);
  const s = db.sessions.find((x) => x.tokenHash === th);
  if (!s) return null;
  if (s.expiresAt < now()) { db.sessions = db.sessions.filter((x) => x !== s); clearToken(); return null; }
  if (s.remember && s.expiresAt - now() < SESSION_LONG / 2) s.expiresAt = now() + SESSION_LONG;
  const u = db.users.find((x) => x.id === s.userId);
  return u ? { ...u, tokenHash: th } : null;
}
const rolesOf = (u) => (u.roles && u.roles.length ? u.roles : [u.role]);
const publicUser = (u) => ({ id: u.id, role: u.role, roles: rolesOf(u), name: u.name, email: u.email, createdAt: u.createdAt });
/** One account can be both a student and a teacher. The role chosen at sign-in becomes the active one. */
function activateRole(u, role) {
  if (role !== 'student' && role !== 'teacher') return false;
  const had = rolesOf(u).includes(role);
  u.roles = had ? rolesOf(u) : [...rolesOf(u), role];
  u.role = role;
  return !had;
}
/* notifications */
function notify(userId, role, type, title, body, link) {
  db.notifications.push({ id: nextId('notifications'), userId, role, type, title, body: body || '', link: link || '', read: false, createdAt: now() });
  const mine = db.notifications.filter((n) => n.userId === userId);
  if (mine.length > 150) { const drop = new Set(mine.slice(0, mine.length - 150).map((n) => n.id)); db.notifications = db.notifications.filter((n) => !drop.has(n.id)); }
}
function notifyPublished(a) {
  const cls = byId('classes', a.classId);
  for (const st of targetStudents(a)) notify(st.id, 'student', 'assignment', `New assignment: ${a.title}`, `${cls ? cls.name : 'Class'}${a.dueAt ? ' · due ' + new Date(a.dueAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : ''}`, `#/work/${a.id}`);
}
function notifyJoined(student, c) { notify(c.teacherId, 'teacher', 'join', `${student.name} joined ${c.name}`, '', `#/t/classes/${c.id}`); }
/** People this user may message: everyone who shares a class with them (teacher ↔ student). */
function contactIds(userId) {
  const ids = new Set();
  for (const c of db.classes) {
    if (c.teacherId === userId) db.enrollments.filter((e) => e.classId === c.id).forEach((e) => ids.add(e.studentId));
  }
  for (const e of db.enrollments) {
    if (e.studentId === userId) { const c = byId('classes', e.classId); if (c) ids.add(c.teacherId); }
  }
  ids.delete(userId);
  return ids;
}

/* ---------------- lookups & access rules ---------------- */
const byId = (t, id) => db[t].find((x) => x.id === id);
const userById = (id) => byId('users', id);
const classFull = (c) => db.enrollments.filter((e) => e.classId === c.id).length >= MAX_CLASS_STUDENTS;
const enrolled = (classId, studentId) => db.enrollments.some((e) => e.classId === classId && e.studentId === studentId);
function teacherClass(user, classId) { const c = db.classes.find((x) => x.id === classId && x.teacherId === user.id); if (!c) fail(404, 'Class not found.'); return c; }
function teacherAssignment(user, id) { const a = db.assignments.find((x) => x.id === id && x.teacherId === user.id); if (!a) fail(404, 'Assignment not found.'); return a; }
function canStudentSee(a, studentId) {
  return a.status === 'published' && enrolled(a.classId, studentId) && (a.assignAll || db.assignmentStudents.some((x) => x.assignmentId === a.id && x.studentId === studentId));
}
function studentAssignment(user, id) { const a = byId('assignments', id); if (!a || !canStudentSee(a, user.id)) fail(404, 'Assignment not found.'); return a; }
function accessSubmission(user, subId) {
  const sub = byId('submissions', subId); if (!sub) fail(404, 'Submission not found.');
  if (user.role === 'student') {
    if (sub.studentId !== user.id) fail(404, 'Submission not found.');
    return { sub, assignment: studentAssignment(user, sub.assignmentId), isOwner: true };
  }
  const a = db.assignments.find((x) => x.id === sub.assignmentId && x.teacherId === user.id);
  if (!a) fail(404, 'Submission not found.');
  return { sub, assignment: a, isOwner: false };
}
const sortByName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
function classStudents(classId) {
  return db.enrollments.filter((e) => e.classId === classId).map((e) => userById(e.studentId)).filter(Boolean).sort(sortByName);
}
function targetStudents(a) {
  const list = classStudents(a.classId);
  if (a.assignAll) return list.map((u) => ({ id: u.id, name: u.name, email: u.email }));
  const set = new Set(db.assignmentStudents.filter((x) => x.assignmentId === a.id).map((x) => x.studentId));
  return list.filter((u) => set.has(u.id)).map((u) => ({ id: u.id, name: u.name, email: u.email }));
}
const subFor = (aid, sid) => db.submissions.find((s) => s.assignmentId === aid && s.studentId === sid);
const questionsOf = (aid) => db.questions.filter((q) => q.assignmentId === aid).sort((a, b) => a.position - b.position || a.id - b.id);
const attachmentsOf = (aid) => db.attachments.filter((f) => f.assignmentId === aid).sort((a, b) => a.createdAt - b.createdAt);

/* Deleting rows also removes their stored files. */
async function removeFiles(keys) { for (const k of keys) { try { await idbDel('files', k); } catch { /* ignore */ } } }
function deleteSubmissions(pred) {
  const subs = db.submissions.filter(pred); const ids = new Set(subs.map((s) => s.id));
  const files = db.recordings.filter((r) => ids.has(r.submissionId)).map((r) => r.fileKey);
  db.recordings = db.recordings.filter((r) => !ids.has(r.submissionId));
  db.answers = db.answers.filter((x) => !ids.has(x.submissionId));
  db.submissions = db.submissions.filter((s) => !ids.has(s.id));
  return files;
}
function deleteAssignments(pred) {
  const as = db.assignments.filter(pred); const ids = new Set(as.map((a) => a.id));
  let files = deleteSubmissions((s) => ids.has(s.assignmentId));
  files = files.concat(db.attachments.filter((f) => ids.has(f.assignmentId)).map((f) => f.fileKey));
  db.attachments = db.attachments.filter((f) => !ids.has(f.assignmentId));
  db.questions = db.questions.filter((q) => !ids.has(q.assignmentId));
  db.assignmentStudents = db.assignmentStudents.filter((x) => !ids.has(x.assignmentId));
  db.assignments = db.assignments.filter((a) => !ids.has(a.id));
  return files;
}

/* ---------------- serializers ---------------- */
const mapAssignment = (a, extra = {}) => ({
  id: a.id, classId: a.classId, title: a.title, instructions: a.instructions, dueAt: a.dueAt, maxScore: 100,
  status: a.status, assignAll: !!a.assignAll, createdAt: a.createdAt, updatedAt: a.updatedAt, publishedAt: a.publishedAt, ...extra,
});
const mapRecording = (r) => ({ id: r.id, questionId: r.questionId, label: r.label, mime: r.mime, size: r.size, duration: r.duration, createdAt: r.createdAt });
const mapAttachment = (f) => ({ id: f.id, filename: f.filename, mime: f.mime, size: f.size, createdAt: f.createdAt });
const mapQuestion = (q) => ({ id: q.id, position: q.position, prompt: q.prompt });
const mapSubmission = (s) => s && ({
  id: s.id, assignmentId: s.assignmentId, studentId: s.studentId, status: s.status, score: s.score ?? null, feedback: s.feedback || '',
  startedAt: s.startedAt, updatedAt: s.updatedAt, submittedAt: s.submittedAt || null, gradedAt: s.gradedAt || null,
});
const fullSubmission = (s) => ({
  ...mapSubmission(s),
  answers: db.answers.filter((x) => x.submissionId === s.id).map((x) => ({ questionId: x.questionId, html: x.html, updatedAt: x.updatedAt })),
  recordings: db.recordings.filter((r) => r.submissionId === s.id).sort((a, b) => a.createdAt - b.createdAt).map(mapRecording),
});
const avg = (arr) => (arr.length ? Math.round(arr.reduce((t, v) => t + v, 0) / arr.length) : null);

/* ---------------- routes ---------------- */
const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, auth: opts.auth !== false, role: opts.role, write: method !== 'GET' });
}

route('POST', '/api/auth/register', async ({ body: b }) => {
  rateLimit('reg', 20, 15 * 60000);
  const role = b.role === 'teacher' ? 'teacher' : b.role === 'student' ? 'student' : fail(400, 'Choose Student or Teacher.');
  const name = str(b.name, { min: 2, max: 80, field: 'Name' });
  const email = str(b.email, { min: 3, max: 160, field: 'Email' }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid email address.');
  const pw = typeof b.password === 'string' ? b.password : '';
  if (pw.length < 8) fail(400, 'Password must be at least 8 characters.');
  if (pw.length > 200) fail(400, 'Password is too long.');
  if (db.users.some((u) => u.email === email)) fail(409, 'An account with this email already exists.');
  const u = { id: nextId('users'), role, roles: [role], name, email, passHash: await hashPassword(pw), createdAt: now() };
  db.users.push(u);
  await createSession(u.id, !!b.remember);
  let joined = null, classIsFull = null;
  if (role === 'student' && typeof b.inviteCode === 'string' && b.inviteCode.trim()) {
    const c = classByCode(b.inviteCode);
    if (c && classFull(c)) classIsFull = c.name;
    else if (c) { db.enrollments.push({ classId: c.id, studentId: u.id, joinedAt: now() }); joined = c.name; notifyJoined(u, c); }
  }
  return { user: publicUser(u), joined, classIsFull };
}, { auth: false });

route('POST', '/api/auth/login', async ({ body: b }) => {
  const email = str(b.email, { min: 1, max: 160, field: 'Email' }).toLowerCase();
  rateLimit('login:' + email, 10, 15 * 60000);
  const pw = typeof b.password === 'string' ? b.password.slice(0, 200) : '';
  const u = db.users.find((x) => x.email === email);
  if (!u) fail(401, db.users.length
    ? 'No account with this email was found in this browser. Check the spelling, or create an account.'
    : 'No accounts exist in this browser yet. Accounts are saved only in the browser where they were created — create an account first.');
  if (!(await verifyPassword(pw, u.passHash))) fail(401, 'Incorrect password. Please try again.');
  // The Student/Teacher tab decides which side of the account you open; an account can have both.
  const roleAdded = activateRole(u, b.role);
  await createSession(u.id, !!b.remember);
  return { user: publicUser(u), roleAdded };
}, { auth: false });

route('POST', '/api/auth/oauth', async ({ body: b }) => {
  rateLimit('oauth', 30, 15 * 60000);
  const provider = ['google', 'facebook', 'apple', 'telegram'].includes(b.provider) ? b.provider : fail(400, 'Unknown sign-in provider.');
  const pid = String(b.id || '').slice(0, 120);
  if (!pid) fail(400, 'The sign-in provider did not return an account id.');
  let email = String(b.email || '').trim().toLowerCase().slice(0, 160);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) email = '';
  let u = db.users.find((x) => x.oauth && x.oauth[provider] === pid);
  let joined = null, classIsFull = null;
  if (!u && email) u = db.users.find((x) => x.email === email);
  let roleAdded = false;
  if (u) { u.oauth = { ...(u.oauth || {}), [provider]: pid }; roleAdded = activateRole(u, b.role); }
  else {
    const role = b.role === 'teacher' ? 'teacher' : 'student';
    const name = String(b.name || '').trim().slice(0, 80) || (email ? email.split('@')[0] : 'New user');
    u = { id: nextId('users'), role, name: name.length < 2 ? name + ' ' : name, email: email || `${provider}-${pid}@users.assignmentpro.local`, passHash: null, roles: [role], oauth: { [provider]: pid }, createdAt: now() };
    db.users.push(u);
    if (role === 'student' && typeof b.inviteCode === 'string' && b.inviteCode.trim()) {
      const c = classByCode(b.inviteCode);
      if (c && classFull(c)) classIsFull = c.name;
      else if (c) { db.enrollments.push({ classId: c.id, studentId: u.id, joinedAt: now() }); joined = c.name; notifyJoined(u, c); }
    }
  }
  await createSession(u.id, !!b.remember);
  return { user: publicUser(u), joined, roleAdded, classIsFull };
}, { auth: false });

route('POST', '/api/auth/logout', async () => {
  const t = storedToken();
  if (t) { const th = await sha256(t); db.sessions = db.sessions.filter((s) => s.tokenHash !== th); }
  clearToken();
  return { ok: true };
}, { auth: false });
route('POST', '/api/auth/logout-all', async ({ user }) => { db.sessions = db.sessions.filter((s) => s.userId !== user.id); clearToken(); return { ok: true }; });
route('GET', '/api/me', async ({ user }) => ({ user: user ? publicUser(user) : null }), { auth: false });
route('PATCH', '/api/me', async ({ user, body }) => {
  const u = userById(user.id); u.name = str(body.name, { min: 2, max: 80, field: 'Name' });
  return { user: publicUser(u) };
});
route('POST', '/api/me/role', async ({ user, body: b }) => {
  const u = userById(user.id);
  if (b.role !== 'student' && b.role !== 'teacher') fail(400, 'Choose Student or Teacher.');
  activateRole(u, b.role);
  return { user: publicUser(u) };
});
route('POST', '/api/me/password', async ({ user, body: b }) => {
  rateLimit('pw:' + user.id, 10, 15 * 60000);
  const u = userById(user.id);
  if (!u.passHash) fail(400, 'This account signs in with a social provider and has no password.');
  if (!(await verifyPassword(String(b.current || '').slice(0, 200), u.passHash))) fail(400, 'Current password is incorrect.');
  const next = typeof b.next === 'string' ? b.next : '';
  if (next.length < 8 || next.length > 200) fail(400, 'New password must be at least 8 characters.');
  u.passHash = await hashPassword(next);
  db.sessions = db.sessions.filter((s) => s.userId !== u.id || s.tokenHash === user.tokenHash);
  return { ok: true };
});

/* classes */
route('GET', '/api/classes', async ({ user }) => {
  if (user.role === 'teacher') {
    return {
      classes: db.classes.filter((c) => c.teacherId === user.id).sort((a, b) => b.createdAt - a.createdAt).map((c) => ({
        id: c.id, name: c.name, subject: c.subject, inviteCode: c.inviteCode, createdAt: c.createdAt,
        students: db.enrollments.filter((e) => e.classId === c.id).length, assignments: db.assignments.filter((a) => a.classId === c.id).length,
      })),
    };
  }
  return {
    classes: db.enrollments.filter((e) => e.studentId === user.id).sort((a, b) => b.joinedAt - a.joinedAt).map((e) => {
      const c = byId('classes', e.classId); if (!c) return null;
      return { id: c.id, name: c.name, subject: c.subject, teacher: userById(c.teacherId)?.name || 'Teacher', students: db.enrollments.filter((x) => x.classId === c.id).length, joinedAt: e.joinedAt };
    }).filter(Boolean),
  };
});
route('POST', '/api/classes', async ({ user, body: b }) => {
  const c = { id: nextId('classes'), teacherId: user.id, name: str(b.name, { min: 1, max: 80, field: 'Class name' }), subject: str(b.subject, { max: 80, field: 'Subject' }), inviteCode: newInviteCode(), createdAt: now() };
  db.classes.push(c);
  return { class: { id: c.id, name: c.name, subject: c.subject, inviteCode: c.inviteCode, students: 0, assignments: 0 } };
}, { role: 'teacher' });
route('POST', '/api/classes/join', async ({ user, body: b }) => {
  rateLimit('join:' + user.id, 30, 15 * 60000);
  const code = cleanCode(b.code);
  if (!code) fail(400, 'Enter the 6–8 digit class code from your teacher.');
  if (!CODE_RE.test(code)) fail(400, 'Class codes are 6 to 8 digits long, numbers only. Check the code and try again.');
  const c = classByCode(code);
  if (!c) fail(404, `No class matches the code ${code}. Check it with your teacher.`);
  const existed = enrolled(c.id, user.id);
  if (!existed && classFull(c)) fail(409, `${c.name} is full (${MAX_CLASS_STUDENTS} students maximum). Ask your teacher for help.`);
  if (!existed) { db.enrollments.push({ classId: c.id, studentId: user.id, joinedAt: now() }); notifyJoined(user, c); }
  return { class: { id: c.id, name: c.name, subject: c.subject, teacher: userById(c.teacherId)?.name }, alreadyMember: existed };
}, { role: 'student' });
route('GET', '/api/classes/:id', async ({ user, params }) => {
  const id = intId(params.id);
  if (user.role === 'student') {
    const c = byId('classes', id); if (!c || !enrolled(id, user.id)) fail(404, 'Class not found.');
    return { class: { id: c.id, name: c.name, subject: c.subject, teacher: userById(c.teacherId)?.name } };
  }
  const c = teacherClass(user, id);
  const classAssign = db.assignments.filter((a) => a.classId === id);
  const aIds = new Set(classAssign.map((a) => a.id));
  return {
    class: { id: c.id, name: c.name, subject: c.subject, inviteCode: c.inviteCode, createdAt: c.createdAt },
    students: classStudents(id).map((u) => {
      const subs = db.submissions.filter((s) => s.studentId === u.id && aIds.has(s.assignmentId));
      const e = db.enrollments.find((x) => x.classId === id && x.studentId === u.id);
      return { id: u.id, name: u.name, email: u.email, joinedAt: e.joinedAt, avgScore: avg(subs.filter((s) => s.status === 'graded').map((s) => s.score)), turnedIn: subs.filter((s) => s.status !== 'in_progress').length };
    }),
    assignments: classAssign.sort((a, b) => (a.dueAt || 9e15) - (b.dueAt || 9e15) || b.createdAt - a.createdAt).map((a) => mapAssignment(a)),
  };
});
route('PATCH', '/api/classes/:id', async ({ user, params, body: b }) => {
  const c = teacherClass(user, intId(params.id));
  c.name = str(b.name, { min: 1, max: 80, field: 'Class name' }); c.subject = str(b.subject, { max: 80, field: 'Subject' });
  return { ok: true };
}, { role: 'teacher' });
route('POST', '/api/classes/:id/regenerate-code', async ({ user, params }) => {
  const c = teacherClass(user, intId(params.id)); c.inviteCode = newInviteCode(); return { inviteCode: c.inviteCode };
}, { role: 'teacher' });
route('DELETE', '/api/classes/:id', async ({ user, params, after }) => {
  const c = teacherClass(user, intId(params.id));
  const files = deleteAssignments((a) => a.classId === c.id);
  db.enrollments = db.enrollments.filter((e) => e.classId !== c.id);
  db.classes = db.classes.filter((k) => k.id !== c.id);
  after.push(() => removeFiles(files));
  return { ok: true };
}, { role: 'teacher' });
route('DELETE', '/api/classes/:id/students/:sid', async ({ user, params }) => {
  const c = teacherClass(user, intId(params.id)); const sid = intId(params.sid);
  db.enrollments = db.enrollments.filter((e) => !(e.classId === c.id && e.studentId === sid));
  return { ok: true };
}, { role: 'teacher' });
route('POST', '/api/classes/:id/leave', async ({ user, params }) => {
  const id = intId(params.id);
  db.enrollments = db.enrollments.filter((e) => !(e.classId === id && e.studentId === user.id));
  return { ok: true };
}, { role: 'student' });

route('GET', '/api/students/:id', async ({ user, params }) => {
  const sid = intId(params.id);
  const myClasses = db.classes.filter((c) => c.teacherId === user.id && enrolled(c.id, sid));
  const st = userById(sid);
  if (!st || !myClasses.length) fail(404, 'Student not found.');
  const list = db.assignments.filter((a) => a.teacherId === user.id && canStudentSee(a, sid)).sort((a, b) => (a.dueAt || 9e15) - (b.dueAt || 9e15));
  return {
    student: { id: st.id, name: st.name, email: st.email },
    classes: myClasses.map((c) => ({ id: c.id, name: c.name })),
    assignments: list.map((a) => {
      const s = subFor(a.id, sid);
      return { id: a.id, title: a.title, className: byId('classes', a.classId).name, dueAt: a.dueAt, submissionId: s?.id || null, status: s ? s.status : 'not_started', score: s?.score ?? null, submittedAt: s?.submittedAt || null, updatedAt: s?.updatedAt || null };
    }),
  };
}, { role: 'teacher' });

/* assignments */
route('GET', '/api/assignments', async ({ user }) => {
  if (user.role === 'teacher') {
    return {
      assignments: db.assignments.filter((a) => a.teacherId === user.id).sort((a, b) => b.updatedAt - a.updatedAt).map((a) => {
        const subs = db.submissions.filter((s) => s.assignmentId === a.id);
        return mapAssignment(a, {
          className: byId('classes', a.classId)?.name, questionCount: questionsOf(a.id).length,
          toGrade: subs.filter((s) => s.status === 'submitted').length, graded: subs.filter((s) => s.status === 'graded').length,
          inProgress: subs.filter((s) => s.status === 'in_progress').length, assigned: targetStudents(a).length,
        });
      }),
    };
  }
  return {
    assignments: db.assignments.filter((a) => canStudentSee(a, user.id))
      .sort((a, b) => (a.dueAt || 9e15) - (b.dueAt || 9e15) || (b.publishedAt || 0) - (a.publishedAt || 0))
      .map((a) => {
        const s = subFor(a.id, user.id); const c = byId('classes', a.classId);
        return mapAssignment(a, {
          instructions: undefined, className: c.name, teacherName: userById(a.teacherId)?.name, questionCount: questionsOf(a.id).length,
          submissionId: s?.id || null, progress: s ? s.status : 'not_started', score: s?.score ?? null, feedback: s?.feedback || '',
          submittedAt: s?.submittedAt || null, gradedAt: s?.gradedAt || null, workUpdatedAt: s?.updatedAt || null,
        });
      }),
  };
});
function validateAssignment(user, b) {
  const title = str(b.title, { min: 1, max: 160, field: 'Title' });
  const classId = intId(b.classId); teacherClass(user, classId);
  const instructions = sanitizeHtml(b.instructions, 100000);
  let dueAt = null;
  if (b.dueAt !== null && b.dueAt !== undefined && b.dueAt !== '') { dueAt = Number(b.dueAt); if (!Number.isFinite(dueAt) || dueAt < 0) fail(400, 'Invalid deadline.'); }
  const assignAll = b.assignAll !== false;
  const ids = Array.isArray(b.studentIds) ? [...new Set(b.studentIds.map(Number).filter(Number.isInteger))] : [];
  const targets = ids.filter((id) => enrolled(classId, id));
  if (!assignAll && !targets.length && b.publish) fail(400, 'Select at least one student, or assign to the entire class.');
  const qs = (Array.isArray(b.questions) ? b.questions : []).slice(0, 101);
  if (qs.length > 100) fail(400, 'Too many questions.');
  const cleanQs = qs.map((x) => ({ id: x && Number.isInteger(x.id) ? x.id : null, prompt: str(x && x.prompt, { max: 5000, field: 'Question' }) })).filter((x) => x.prompt);
  if (b.publish && !cleanQs.length) fail(400, 'Add at least one question before publishing.');
  return { title, classId, instructions, dueAt, assignAll, targets, cleanQs };
}
function saveQuestions(aid, cleanQs, after) {
  const existing = new Set(db.questions.filter((q) => q.assignmentId === aid).map((q) => q.id));
  const keep = new Set();
  cleanQs.forEach((x, i) => {
    if (x.id && existing.has(x.id)) { const q = byId('questions', x.id); q.prompt = x.prompt; q.position = i; keep.add(x.id); }
    else db.questions.push({ id: nextId('questions'), assignmentId: aid, position: i, prompt: x.prompt });
  });
  const gone = new Set([...existing].filter((id) => !keep.has(id)));
  if (gone.size) {
    const files = db.recordings.filter((r) => gone.has(r.questionId)).map((r) => r.fileKey);
    db.recordings = db.recordings.filter((r) => !gone.has(r.questionId));
    db.answers = db.answers.filter((x) => !gone.has(x.questionId));
    db.questions = db.questions.filter((q) => !gone.has(q.id));
    after.push(() => removeFiles(files));
  }
}
function saveTargets(aid, assignAll, targets) {
  db.assignmentStudents = db.assignmentStudents.filter((x) => x.assignmentId !== aid);
  if (!assignAll) targets.forEach((sid) => db.assignmentStudents.push({ assignmentId: aid, studentId: sid }));
}
route('POST', '/api/assignments', async ({ user, body: b, after }) => {
  const v = validateAssignment(user, b); const t = now();
  const a = { id: nextId('assignments'), teacherId: user.id, classId: v.classId, title: v.title, instructions: v.instructions, dueAt: v.dueAt, status: b.publish ? 'published' : 'draft', assignAll: v.assignAll, createdAt: t, updatedAt: t, publishedAt: b.publish ? t : null };
  db.assignments.push(a);
  saveQuestions(a.id, v.cleanQs, after); saveTargets(a.id, v.assignAll, v.targets);
  if (b.publish) notifyPublished(a);
  return { id: a.id };
}, { role: 'teacher' });
route('PUT', '/api/assignments/:id', async ({ user, params, body: b, after }) => {
  const a = teacherAssignment(user, intId(params.id));
  if (b.publish === undefined) b.publish = a.status === 'published';
  const v = validateAssignment(user, b);
  if (v.classId !== a.classId && db.submissions.some((s) => s.assignmentId === a.id)) fail(400, 'Students have already started this assignment, so its class cannot be changed.');
  const t = now(); const firstPublish = b.publish && !a.publishedAt;
  Object.assign(a, { classId: v.classId, title: v.title, instructions: v.instructions, dueAt: v.dueAt, status: b.publish ? 'published' : 'draft', assignAll: v.assignAll, updatedAt: t, publishedAt: a.publishedAt || (b.publish ? t : null) });
  saveQuestions(a.id, v.cleanQs, after); saveTargets(a.id, v.assignAll, v.targets);
  if (firstPublish) notifyPublished(a);
  return { id: a.id };
}, { role: 'teacher' });
route('POST', '/api/assignments/:id/publish', async ({ user, params, body: b }) => {
  const a = teacherAssignment(user, intId(params.id));
  if (b.published) {
    if (!questionsOf(a.id).length) fail(400, 'Add at least one question before publishing.');
    if (!a.assignAll && !targetStudents(a).length) fail(400, 'Select at least one student before publishing.');
  }
  const first = b.published && !a.publishedAt;
  a.status = b.published ? 'published' : 'draft'; a.updatedAt = now(); if (b.published && !a.publishedAt) a.publishedAt = now();
  if (first) notifyPublished(a);
  return { status: a.status };
}, { role: 'teacher' });
route('DELETE', '/api/assignments/:id', async ({ user, params, after }) => {
  const a = teacherAssignment(user, intId(params.id));
  const files = deleteAssignments((x) => x.id === a.id);
  after.push(() => removeFiles(files));
  return { ok: true };
}, { role: 'teacher' });
route('GET', '/api/assignments/:id', async ({ user, params }) => {
  const id = intId(params.id);
  const isTeacher = user.role === 'teacher';
  const a = isTeacher ? teacherAssignment(user, id) : studentAssignment(user, id);
  const c = byId('classes', a.classId);
  const base = mapAssignment(a, { className: c.name, classSubject: c.subject, teacherName: userById(c.teacherId)?.name, questions: questionsOf(a.id).map(mapQuestion), attachments: attachmentsOf(a.id).map(mapAttachment) });
  if (isTeacher) {
    const studentIds = a.assignAll ? [] : db.assignmentStudents.filter((x) => x.assignmentId === a.id).map((x) => x.studentId);
    const progress = targetStudents(a).map((st) => {
      const s = subFor(a.id, st.id);
      return { student: st, submissionId: s?.id || null, status: s ? s.status : 'not_started', score: s?.score ?? null, updatedAt: s?.updatedAt || null, submittedAt: s?.submittedAt || null, recordings: s ? db.recordings.filter((r) => r.submissionId === s.id).length : 0 };
    });
    return { assignment: { ...base, studentIds }, progress };
  }
  const s = subFor(a.id, user.id);
  return { assignment: base, submission: s ? fullSubmission(s) : null };
});

/* attachments */
route('POST', '/api/assignments/:id/attachments', async ({ user, params, blob, headers }) => {
  const a = teacherAssignment(user, intId(params.id));
  if (attachmentsOf(a.id).length >= 20) fail(400, 'An assignment can have at most 20 attachments.');
  if (!blob || !blob.size) fail(400, 'Empty file.');
  if (blob.size > MAX_ATTACHMENT) fail(413, 'File is too large.');
  let filename = ''; try { filename = decodeURIComponent(headers['X-Filename'] || ''); } catch { /* ignore */ }
  filename = filename.replace(/[\\/\r\n"]/g, '_').trim().slice(0, 180) || 'attachment';
  const mime = String(headers['Content-Type'] || blob.type || 'application/octet-stream').split(';')[0].trim().slice(0, 100) || 'application/octet-stream';
  const fileKey = 'f' + randHex(16);
  try { await idbPut('files', fileKey, blob); } catch { fail(507, 'Your browser storage is full. Free some space and try again.'); }
  const f = { id: nextId('attachments'), assignmentId: a.id, filename, mime, size: blob.size, fileKey, createdAt: now() };
  db.attachments.push(f);
  return { attachment: mapAttachment(f) };
}, { role: 'teacher' });
route('DELETE', '/api/attachments/:id', async ({ user, params, after }) => {
  const f = byId('attachments', intId(params.id)); if (!f) fail(404, 'File not found.');
  teacherAssignment(user, f.assignmentId);
  db.attachments = db.attachments.filter((x) => x !== f);
  after.push(() => removeFiles([f.fileKey]));
  return { ok: true };
}, { role: 'teacher' });

/* student work */
route('POST', '/api/assignments/:id/start', async ({ user, params }) => {
  const a = studentAssignment(user, intId(params.id));
  let s = subFor(a.id, user.id);
  if (!s) { const t = now(); s = { id: nextId('submissions'), assignmentId: a.id, studentId: user.id, status: 'in_progress', score: null, feedback: '', startedAt: t, updatedAt: t }; db.submissions.push(s); notify(a.teacherId, 'teacher', 'started', `${user.name} started “${a.title}”`, byId('classes', a.classId)?.name || '', `#/t/assignments/${a.id}`); }
  return { submission: fullSubmission(s) };
}, { role: 'student' });
function editable(user, params) {
  const r = accessSubmission(user, intId(params.id));
  if (!r.isOwner) fail(403, 'Only the student can edit this submission.');
  if (r.sub.status !== 'in_progress') fail(409, 'This assignment has already been submitted.');
  return r;
}
route('PUT', '/api/submissions/:id/answers', async ({ user, params, body: b }) => {
  const { sub, assignment } = editable(user, params);
  if (!Array.isArray(b.answers)) fail(400, 'Missing answers.');
  const qids = new Set(questionsOf(assignment.id).map((q) => q.id)); const t = now();
  for (const x of b.answers) {
    const qid = Number(x && x.questionId); if (!qids.has(qid)) continue;
    const html = sanitizeHtml(x.html, 300000);
    const ex = db.answers.find((y) => y.submissionId === sub.id && y.questionId === qid);
    if (ex) { ex.html = html; ex.updatedAt = t; } else db.answers.push({ submissionId: sub.id, questionId: qid, html, updatedAt: t });
  }
  sub.updatedAt = t;
  return { savedAt: t };
}, { role: 'student' });
route('POST', '/api/submissions/:id/recordings', async ({ user, params, blob, headers }) => {
  const { sub, assignment } = editable(user, params);
  if (db.recordings.filter((r) => r.submissionId === sub.id).length >= 30) fail(400, 'You can attach at most 30 recordings to one assignment.');
  const qid = Number(headers['X-Question-Id']);
  if (!db.questions.some((q) => q.id === qid && q.assignmentId === assignment.id)) fail(400, 'Unknown question.');
  let mime = String(headers['Content-Type'] || blob?.type || '').split(';')[0].trim().toLowerCase();
  if (mime === 'video/webm') mime = 'audio/webm';
  if (!/^audio\/(webm|ogg|mp4|mpeg|aac|wav|x-m4a|m4a)$/.test(mime)) fail(415, 'Unsupported audio format.');
  if (!blob || !blob.size) fail(400, 'Empty recording.');
  if (blob.size > MAX_AUDIO) fail(413, 'Recording is too large.');
  let label = ''; try { label = decodeURIComponent(headers['X-Label'] || ''); } catch { /* ignore */ }
  const fileKey = 'r' + randHex(16);
  try { await idbPut('files', fileKey, new Blob([blob], { type: mime })); } catch { fail(507, 'Your browser storage is full. Free some space and try again.'); }
  const t = now();
  const r = { id: nextId('recordings'), submissionId: sub.id, questionId: qid, label: label.replace(/[\r\n]/g, ' ').trim().slice(0, 80), mime, size: blob.size, duration: Math.max(0, Math.min(3600, Number(headers['X-Duration']) || 0)), fileKey, createdAt: t };
  db.recordings.push(r); sub.updatedAt = t;
  return { recording: mapRecording(r) };
}, { role: 'student' });
function recordingAccess(user, params) {
  const rec = byId('recordings', intId(params.id)); if (!rec) fail(404, 'Recording not found.');
  return { rec, ...accessSubmission(user, rec.submissionId) };
}
route('PATCH', '/api/recordings/:id', async ({ user, params, body: b }) => {
  const { rec, sub, isOwner } = recordingAccess(user, params);
  if (!isOwner || sub.status !== 'in_progress') fail(409, 'This recording can no longer be changed.');
  rec.label = str(b.label, { max: 80, field: 'Label' });
  return { ok: true };
}, { role: 'student' });
route('DELETE', '/api/recordings/:id', async ({ user, params, after }) => {
  const { rec, sub, isOwner } = recordingAccess(user, params);
  if (!isOwner || sub.status !== 'in_progress') fail(409, 'This recording can no longer be changed.');
  db.recordings = db.recordings.filter((x) => x !== rec); sub.updatedAt = now();
  after.push(() => removeFiles([rec.fileKey]));
  return { ok: true };
}, { role: 'student' });
route('POST', '/api/submissions/:id/submit', async ({ user, params }) => {
  const { sub, assignment } = editable(user, params);
  const answered = questionsOf(assignment.id).filter((q) => db.answers.some((x) => x.submissionId === sub.id && x.questionId === q.id && textOf(x.html)) || db.recordings.some((r) => r.submissionId === sub.id && r.questionId === q.id)).length;
  if (!answered) fail(400, 'Add a written answer or a recording before submitting.');
  const t = now(); sub.status = 'submitted'; sub.submittedAt = t; sub.updatedAt = t;
  notify(assignment.teacherId, 'teacher', 'submitted', `${user.name} submitted “${assignment.title}”`, 'Ready to review and grade', `#/t/review/${sub.id}`);
  return { submission: fullSubmission(sub) };
}, { role: 'student' });
route('GET', '/api/submissions/:id', async ({ user, params }) => {
  const { sub, assignment: a } = accessSubmission(user, intId(params.id));
  const st = userById(sub.studentId);
  let siblings = [];
  if (user.role === 'teacher') {
    siblings = db.submissions.filter((s) => s.assignmentId === a.id && s.status !== 'in_progress')
      .map((s) => ({ id: s.id, name: userById(s.studentId)?.name || 'Student', status: s.status })).sort(sortByName);
  }
  return {
    submission: fullSubmission(sub), student: { id: st.id, name: st.name, email: st.email },
    assignment: mapAssignment(a, { className: byId('classes', a.classId).name, questions: questionsOf(a.id).map(mapQuestion), attachments: attachmentsOf(a.id).map(mapAttachment) }),
    siblings,
  };
});
route('POST', '/api/submissions/:id/grade', async ({ user, params, body: b }) => {
  const { sub } = accessSubmission(user, intId(params.id));
  if (sub.status === 'in_progress') fail(409, 'This student has not submitted yet.');
  const score = Number(b.score);
  if (!Number.isInteger(score) || score < 0 || score > 100) fail(400, 'Score must be a whole number from 0 to 100.');
  const t = now();
  Object.assign(sub, { status: 'graded', score, feedback: typeof b.feedback === 'string' ? b.feedback.trim().slice(0, 10000) : '', gradedAt: t, updatedAt: t });
  { const a = byId('assignments', sub.assignmentId); notify(sub.studentId, 'student', 'graded', `Graded: ${a ? a.title : 'Assignment'}`, `You scored ${score}/100${sub.feedback ? ' — feedback added' : ''}`, `#/work/${sub.assignmentId}`); }
  return { submission: mapSubmission(sub) };
}, { role: 'teacher' });
route('GET', '/api/teacher/overview', async ({ user }) => {
  const myA = db.assignments.filter((a) => a.teacherId === user.id); const aIds = new Set(myA.map((a) => a.id));
  const myC = db.classes.filter((c) => c.teacherId === user.id); const cIds = new Set(myC.map((c) => c.id));
  const subs = db.submissions.filter((s) => aIds.has(s.assignmentId));
  return {
    stats: {
      classes: myC.length,
      students: new Set(db.enrollments.filter((e) => cIds.has(e.classId)).map((e) => e.studentId)).size,
      published: myA.filter((a) => a.status === 'published').length,
      toGrade: subs.filter((s) => s.status === 'submitted').length,
      avgScore: avg(subs.filter((s) => s.status === 'graded').map((s) => s.score)),
    },
    queue: subs.filter((s) => s.status === 'submitted').sort((a, b) => a.submittedAt - b.submittedAt).slice(0, 12).map((s) => {
      const a = byId('assignments', s.assignmentId);
      return { submissionId: s.id, submittedAt: s.submittedAt, student: userById(s.studentId)?.name, title: a.title, assignmentId: a.id, dueAt: a.dueAt, className: byId('classes', a.classId)?.name };
    }),
  };
}, { role: 'teacher' });

/* notifications */
const unreadMessages = (uid) => db.messages.filter((m) => m.toId === uid && !m.readAt).length;
route('GET', '/api/notifications', async ({ user }) => {
  const mine = db.notifications.filter((n) => n.userId === user.id && (n.role === 'any' || n.role === user.role)).sort((a, b) => b.createdAt - a.createdAt);
  return { items: mine.slice(0, 40).map((n) => ({ id: n.id, type: n.type, title: n.title, body: n.body, link: n.link, read: n.read, createdAt: n.createdAt })), unread: mine.filter((n) => !n.read).length, unreadMessages: unreadMessages(user.id) };
});
route('POST', '/api/notifications/read', async ({ user, body: b }) => {
  const ids = Array.isArray(b.ids) ? new Set(b.ids.map(Number)) : null;
  for (const n of db.notifications) if (n.userId === user.id && (b.all || (ids && ids.has(n.id)))) n.read = true;
  return { ok: true };
});

/* messages */
route('GET', '/api/messages/contacts', async ({ user }) => {
  const ids = contactIds(user.id);
  for (const m of db.messages) { if (m.fromId === user.id) ids.add(m.toId); if (m.toId === user.id) ids.add(m.fromId); }
  const list = [...ids].map((id) => {
    const u = userById(id); if (!u) return null;
    const thread = db.messages.filter((m) => (m.fromId === user.id && m.toId === id) || (m.fromId === id && m.toId === user.id));
    const last = thread[thread.length - 1];
    const shared = [...new Set([
      ...db.classes.filter((c) => c.teacherId === user.id && enrolled(c.id, id)).map((c) => c.name),
      ...db.classes.filter((c) => c.teacherId === id && enrolled(c.id, user.id)).map((c) => c.name),
    ])];
    const asTeacher = db.classes.some((c) => c.teacherId === id && enrolled(c.id, user.id));
    return { id, name: u.name, label: asTeacher ? 'Teacher' : 'Student', classes: shared, last: last ? { body: last.body.slice(0, 120), mine: last.fromId === user.id, at: last.createdAt } : null, unread: thread.filter((m) => m.toId === user.id && !m.readAt).length, canMessage: contactIds(user.id).has(id) };
  }).filter(Boolean);
  list.sort((a, b) => (b.last ? b.last.at : 0) - (a.last ? a.last.at : 0) || a.name.localeCompare(b.name));
  return { contacts: list, unread: unreadMessages(user.id) };
});
route('GET', '/api/messages/:id', async ({ user, params }) => {
  const id = intId(params.id); const other = userById(id); if (!other) fail(404, 'Person not found.');
  const thread = db.messages.filter((m) => (m.fromId === user.id && m.toId === id) || (m.fromId === id && m.toId === user.id));
  if (!thread.length && !contactIds(user.id).has(id)) fail(404, 'Person not found.');
  const t = now();
  for (const m of thread) if (m.toId === user.id && !m.readAt) m.readAt = t;
  for (const n of db.notifications) if (n.userId === user.id && n.type === 'message' && n.link === `#/messages/${id}`) n.read = true;
  return { person: { id, name: other.name }, canMessage: contactIds(user.id).has(id), messages: thread.slice(-200).map((m) => ({ id: m.id, mine: m.fromId === user.id, body: m.body, createdAt: m.createdAt, read: !!m.readAt })) };
});
route('POST', '/api/messages/:id', async ({ user, params, body: b }) => {
  rateLimit('msg:' + user.id, 120, 60000);
  const id = intId(params.id); if (!userById(id)) fail(404, 'Person not found.');
  if (!contactIds(user.id).has(id)) fail(403, 'You can only message people in your classes.');
  const text = str(b.body, { min: 1, max: 2000, field: 'Message' });
  const m = { id: nextId('messages'), fromId: user.id, toId: id, body: text, createdAt: now(), readAt: null };
  db.messages.push(m);
  const link = `#/messages/${user.id}`;
  if (!db.notifications.some((n) => n.userId === id && n.type === 'message' && n.link === link && !n.read)) notify(id, 'any', 'message', `New message from ${user.name}`, text.slice(0, 90), link);
  return { message: { id: m.id, mine: true, body: m.body, createdAt: m.createdAt, read: false } };
});

/* teacher: all students across my classes */
route('GET', '/api/teacher/students', async ({ user }) => {
  const myC = db.classes.filter((c) => c.teacherId === user.id);
  const map = new Map();
  for (const c of myC) for (const e of db.enrollments.filter((x) => x.classId === c.id)) {
    const u = userById(e.studentId); if (!u) continue;
    if (!map.has(u.id)) map.set(u.id, { id: u.id, name: u.name, email: u.email, classes: [] });
    map.get(u.id).classes.push({ id: c.id, name: c.name });
  }
  const out = [...map.values()].map((s) => {
    const as = db.assignments.filter((a) => a.teacherId === user.id && canStudentSee(a, s.id));
    const subs = as.map((a) => subFor(a.id, s.id)).filter(Boolean);
    const graded = subs.filter((x) => x.status === 'graded');
    return { ...s, assigned: as.length, completed: subs.filter((x) => x.status === 'submitted' || x.status === 'graded').length, avg: avg(graded.map((x) => x.score)), unreadFrom: db.messages.filter((m) => m.fromId === s.id && m.toId === user.id && !m.readAt).length };
  }).sort(sortByName);
  return { students: out };
}, { role: 'teacher' });

/* ---------------- dispatcher ---------------- */
let queue = Promise.resolve();
/** Handles one API call. Calls run one at a time and always work on the freshest saved data, so several open tabs stay consistent. */
export function localRequest(method, url, { body, blob, headers = {}, ctx } = {}) {
  const run = async () => {
    if (ctx) env().ctx = ctx;
    const path = url.split('?')[0];
    const r = routes.find((x) => x.method === method && x.re.test(path));
    if (!r) fail(404, 'Not found.');
    const m = r.re.exec(path);
    const params = {}; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    await load();
    const user = await currentUser();
    if (r.auth && !user) fail(401, 'Please sign in.');
    if (r.role && user.role !== r.role) fail(403, 'You do not have access to this.');
    const after = [];
    const snapshot = JSON.stringify(db);
    let data;
    try {
      data = await r.handler({ user, params, body: body || {}, blob, headers, after });
    } catch (e) { db = JSON.parse(snapshot); throw e; } // roll back partial changes
    if (r.write || user) await persist();
    for (const fn of after) await fn();
    return data;
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p.catch((e) => {
    if (e instanceof LocalError) throw e;
    console.warn('[AssignmentPro]', e);
    throw new LocalError(500, 'Something went wrong while saving. Please try again.');
  });
}

/* ---------------- stored files → object URLs ---------------- */
const urlCache = new Map();
/** Returns a playable/downloadable URL for a recording or attachment after a permission check. */
export async function fileURL(kind, id) {
  const key = `${kind}:${id}`;
  if (urlCache.has(key)) return urlCache.get(key);
  const meta = await localRequest('GET', `/api/_file/${kind}/${id}`);
  const blob = await idbGet('files', meta.fileKey);
  if (!blob) throw new LocalError(404, 'File not found.');
  const url = URL.createObjectURL(new Blob([blob], { type: meta.mime }));
  urlCache.set(key, url);
  return url;
}
route('GET', '/api/_file/:kind/:id', async ({ user, params }) => {
  const id = intId(params.id);
  if (params.kind === 'recordings') {
    const { rec } = recordingAccess(user, params);
    return { fileKey: rec.fileKey, mime: rec.mime };
  }
  if (params.kind === 'attachments') {
    const f = byId('attachments', id); if (!f) fail(404, 'File not found.');
    if (user.role === 'teacher') teacherAssignment(user, f.assignmentId); else studentAssignment(user, f.assignmentId);
    return { fileKey: f.fileKey, mime: f.mime, filename: f.filename };
  }
  fail(404, 'Not found.');
});
export async function attachmentInfo(id) { return localRequest('GET', `/api/_file/attachments/${id}`); }
/** Verifies this page can actually save data (fails in previews, sandboxes and some private modes). */
export async function storageCheck() {
  try {
    await idbPut('kv', '__check', now());
    if (!(await idbGet('kv', '__check'))) return false;
    return !!(globalThis.crypto && globalThis.crypto.subtle);
  } catch { return false; }
}
export { LocalError };
