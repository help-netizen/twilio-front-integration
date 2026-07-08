#!/usr/bin/env node
/**
 * verify-mail-local-llm-001.js — runnable verification for MAIL-LOCAL-LLM-001.
 *
 * Implements Docs/test-cases/MAIL-LOCAL-LLM-001.md (TC-MLL-001..009) against
 * backend/src/services/mailAgentClassifier.js. Plain node, no jest.
 *
 * Usage:  node scripts/verify-mail-local-llm-001.js [--section=shape|parse|fence|error|
 *                                                     empty|switch|config|sabotage|live|unit|all]
 * Default section = all (live auto-SKIPs unless the mini is reachable at the tunnel port).
 * Exit non-zero on any FAIL. Live SKIP/PASS never fails the run.
 *
 * NOTE on env-var names: the classifier reads MAIL_AGENT_OLLAMA_URL / MAIL_AGENT_OLLAMA_MODEL
 * (the spec's "OLLAMA_URL"/"OLLAMA_MODEL" are shorthand). Config consts (PROVIDER / URL / MODEL /
 * TIMEOUT / RETRY) are captured at MODULE-LOAD, hence freshLoad() = set env -> bust cache -> re-require.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const REAL_PATH = path.join(__dirname, '..', 'backend', 'src', 'services', 'mailAgentClassifier.js');
const EMAILS_PATH = process.env.EMAILS_JSON
  || '/private/tmp/claude-501/-Users-rgareev91-contact-center-twilio-front-integration--claude-worktrees-sharp-mirzakhani-56c9fb/52f49133-0c7d-46cb-b291-de9b91d770ea/scratchpad/emails.json';
const LIVE_URL = process.env.MAIL_AGENT_OLLAMA_URL_LIVE || 'http://127.0.0.1:11435';

// Every env var the classifier reads at load — cleared before each freshLoad for isolation.
const MANAGED = [
  'MAIL_AGENT_PROVIDER', 'MAIL_AGENT_OLLAMA_URL', 'MAIL_AGENT_OLLAMA_MODEL',
  'GEMINI_API_KEY', 'MAIL_AGENT_MODEL', 'MAIL_AGENT_FALLBACK_MODEL',
  'MAIL_AGENT_TIMEOUT_MS', 'MAIL_AGENT_RETRY_MAX',
];

// Shared fixtures (from the test-cases doc).
const SAMPLE = {
  fromName: 'Jane Doe', fromEmail: 'jane@acme.com', subject: 'Reschedule Tuesday visit',
  bodyText: 'Hi, can we move my appointment to Thursday morning?', knownContact: true, contactName: 'Jane Doe',
};
const VALID = '{"needs_attention":true,"category":"scheduling","confidence":0.9,"priority":"p2","reason":"Customer wants to reschedule.","task_title":"Reply to reschedule request from Jane"}';
const CATEGORIES = new Set([
  'customer_request', 'potential_lead', 'scheduling', 'invoice_billing',
  'complaint', 'spam', 'newsletter', 'automated_notification', 'other',
]);

const SECTION = (process.argv.find(a => a.startsWith('--section=')) || '--section=all').split('=')[1];
const ORIGINAL_FETCH = global.fetch;

// ---------------------------------------------------------------------------
// tiny harness
// ---------------------------------------------------------------------------
const results = []; // { tc, name, status, detail }
function record(tc, name, status, detail = '') {
  results.push({ tc, name, status, detail });
  const tag = status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : 'SKIP';
  const line = `  [${tag}] ${tc} :: ${name}${detail ? `  (${detail})` : ''}`;
  if (status === 'PASS') console.log(line);
  else console.log(line.toUpperCase().includes('FAIL') ? `\x1b[31m${line}\x1b[0m` : line);
}
function check(tc, name, cond, detail = '') { record(tc, name, cond ? 'PASS' : 'FAIL', detail); return !!cond; }
function skip(tc, name, reason) { record(tc, name, 'SKIP', reason); }
async function safe(tc, fn) {
  try { await fn(); } catch (e) { record(tc, 'unexpected exception in harness', 'FAIL', (e && (e.stack || e.message)) || String(e)); }
}

function validateVerdict(v) {
  const errs = [];
  if (!v || typeof v !== 'object') return ['verdict missing/not object'];
  if (typeof v.needs_attention !== 'boolean') errs.push('needs_attention not boolean');
  if (!CATEGORIES.has(v.category)) errs.push('category not in set: ' + v.category);
  if (typeof v.confidence !== 'number' || v.confidence < 0 || v.confidence > 1) errs.push('confidence out of 0..1: ' + v.confidence);
  if (v.priority !== 'p1' && v.priority !== 'p2') errs.push('priority not p1|p2: ' + v.priority);
  if (typeof v.reason !== 'string' || v.reason.length === 0) errs.push('reason empty/not string');
  if (typeof v.task_title !== 'string' || v.task_title.length > 60) errs.push('task_title not string or >60: ' + JSON.stringify(v.task_title));
  return errs;
}

// ---------------------------------------------------------------------------
// module (re)loading — captures config env at load time
// ---------------------------------------------------------------------------
function loadModule(modPath, env) {
  for (const k of MANAGED) delete process.env[k];
  Object.assign(process.env, env || {});
  delete require.cache[require.resolve(modPath)];
  return require(modPath);
}
function freshLoad(env) { return loadModule(REAL_PATH, env); }

// ---------------------------------------------------------------------------
// WHATWG-Response-shaped fetch stub (records url/method/headers/body/signal)
// handler(info, callIndex) -> { status?, ok?, json?, text? }  OR throws to simulate a network error
// ---------------------------------------------------------------------------
function installFetch(handler) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const info = {
      url,
      method: opts.method,
      headers: opts.headers || {},
      body: opts.body ? JSON.parse(opts.body) : null,
      signal: opts.signal,
    };
    calls.push(info);
    const spec = handler(info, calls.length - 1); // may throw
    const status = spec.status || 200;
    return {
      ok: spec.ok !== undefined ? spec.ok : status < 400,
      status,
      json: async () => spec.json,
      text: async () => (spec.text !== undefined ? spec.text : ''),
    };
  };
  return calls;
}
function restoreFetch() { global.fetch = ORIGINAL_FETCH; }

const okOllama = (respStr) => () => ({ status: 200, json: { response: respStr } });
const okGemini = (respStr) => () => ({ status: 200, json: { candidates: [{ content: { parts: [{ text: respStr }] } }] } });
const rejectAlways = (msg) => () => { throw new Error(msg); };
const httpAlways = (status) => () => ({ status, ok: false, text: 'error body' });
const byUrl = (info) => info.url.includes('generativelanguage')
  ? { status: 200, json: { candidates: [{ content: { parts: [{ text: VALID }] } }] } }
  : { status: 200, json: { response: VALID } };

// generic single-shot runner used by unit + sabotage cases
async function runOnce(modPath, env, handler, input = SAMPLE) {
  const mod = loadModule(modPath, env);
  const calls = installFetch(handler);
  let result = null, error = null;
  try { result = await mod.classifyEmail(input); } catch (e) { error = e; } finally { restoreFetch(); }
  return { calls, result, error };
}

// ===========================================================================
// TC-MLL-001 — request shape
// ===========================================================================
async function tc001() {
  const { calls } = await runOnce(REAL_PATH,
    { MAIL_AGENT_PROVIDER: 'ollama', MAIL_AGENT_OLLAMA_URL: 'http://mini:11434', MAIL_AGENT_OLLAMA_MODEL: 'qwen2.5:14b' },
    okOllama(VALID));
  const tc = 'TC-MLL-001';
  check(tc, 'exactly one request', calls.length === 1, `calls=${calls.length}`);
  const req = calls[0] || {}; const b = req.body || {};
  check(tc, '.1 URL == http://mini:11434/api/generate', req.url === 'http://mini:11434/api/generate', req.url);
  check(tc, '.1 method POST', req.method === 'POST', String(req.method));
  check(tc, '.1 Content-Type application/json', (req.headers || {})['Content-Type'] === 'application/json');
  check(tc, '.2 body.model qwen2.5:14b', b.model === 'qwen2.5:14b', String(b.model));
  check(tc, '.2 body.format json', b.format === 'json', String(b.format));
  check(tc, '.2 body.system empty-string', b.system === '', JSON.stringify(b.system));
  check(tc, '.2 body.stream false', b.stream === false, String(b.stream));
  check(tc, '.2 body.keep_alive 10m', b.keep_alive === '10m', String(b.keep_alive));
  check(tc, '.3 options.temperature 0.1', !!b.options && b.options.temperature === 0.1, JSON.stringify(b.options));
  check(tc, '.3 options.num_ctx 4096', !!b.options && b.options.num_ctx === 4096);
  check(tc, '.3 options.num_predict 512', !!b.options && b.options.num_predict === 512);
  const p = b.prompt || '';
  check(tc, '.4 prompt has SYSTEM_PROMPT anchor', p.includes('You triage inbound email'));
  check(tc, '.4 prompt has fromName', p.includes('Jane Doe'));
  check(tc, '.4 prompt has fromEmail', p.includes('jane@acme.com'));
  check(tc, '.4 prompt has subject', p.includes('Reschedule Tuesday visit'));
  check(tc, '.4 prompt has body text', p.includes('move my appointment to Thursday'));
  check(tc, '.4 prompt has KNOWN CONTACT marker', p.includes('KNOWN CONTACT'));
  check(tc, '.5 no request to generativelanguage', !calls.some(c => c.url.includes('generativelanguage')));
}

// ===========================================================================
// TC-MLL-002 — parse/verdict + clamp probe
// ===========================================================================
async function tc002() {
  const tc = 'TC-MLL-002';
  let r = (await runOnce(REAL_PATH, { MAIL_AGENT_OLLAMA_URL: 'http://mini:11434' }, okOllama(VALID))).result;
  check(tc, 'return shape {verdict,model,latency_ms}', !!r && 'verdict' in r && 'model' in r && 'latency_ms' in r);
  check(tc, 'model === qwen2.5:14b', r && r.model === 'qwen2.5:14b', r && r.model);
  check(tc, 'latency_ms is number >= 0', r && typeof r.latency_ms === 'number' && r.latency_ms >= 0, r && String(r.latency_ms));
  const errs = validateVerdict(r && r.verdict);
  check(tc, 'verdict schema-valid (parseVerdict guarantees)', errs.length === 0, errs.join('; '));
  check(tc, 'needs_attention strict true', r && r.verdict.needs_attention === true);
  check(tc, 'category in CATEGORIES (scheduling)', r && r.verdict.category === 'scheduling', r && r.verdict.category);
  check(tc, 'confidence 0.9 in 0..1', r && r.verdict.confidence === 0.9, r && String(r.verdict.confidence));
  check(tc, 'priority p2', r && r.verdict.priority === 'p2', r && r.verdict.priority);
  check(tc, 'task_title length <= 60', r && r.verdict.task_title.length <= 60, r && String(r.verdict.task_title.length));

  // clamp probe: confidence 5 -> 1, priority p3 -> p2, category bogus -> other
  const CLAMP = '{"needs_attention":true,"category":"bogus","confidence":5,"priority":"p3","reason":"x","task_title":"t"}';
  r = (await runOnce(REAL_PATH, { MAIL_AGENT_OLLAMA_URL: 'http://mini:11434' }, okOllama(CLAMP))).result;
  check(tc, 'clamp confidence 5 -> 1', r && r.verdict.confidence === 1, r && String(r.verdict.confidence));
  check(tc, 'clamp priority p3 -> p2', r && r.verdict.priority === 'p2', r && r.verdict.priority);
  check(tc, 'clamp category bogus -> other', r && r.verdict.category === 'other', r && r.verdict.category);
}

// ===========================================================================
// TC-MLL-003 — code-fence variant (proves raw STRING passed to parseVerdict)
// ===========================================================================
async function tc003() {
  const tc = 'TC-MLL-003';
  const fenced = '```json\n' + VALID + '\n```';
  const { result, error } = await runOnce(REAL_PATH, { MAIL_AGENT_OLLAMA_URL: 'http://mini:11434' }, okOllama(fenced));
  check(tc, 'code-fenced output parses (no throw)', !error, error && error.message);
  const errs = validateVerdict(result && result.verdict);
  check(tc, 'fenced verdict schema-valid', !!result && errs.length === 0, errs.join('; '));
  check(tc, 'fenced category scheduling (fence stripped)', !!result && result.verdict.category === 'scheduling');
}

// ===========================================================================
// TC-MLL-004 — error path: all-attempts-fail throws (caller writes verdict='error')
// ===========================================================================
async function tc004() {
  const tc = 'TC-MLL-004';
  // (a) fetch rejects every attempt
  let { calls, error } = await runOnce(REAL_PATH,
    { MAIL_AGENT_OLLAMA_URL: 'http://mini:11434', MAIL_AGENT_RETRY_MAX: '1' }, rejectAlways('ECONNREFUSED'));
  check(tc, '(a) reject-always -> throws (no return)', !!error, error && error.message);
  check(tc, '(a) fetch called MAX_RETRIES+1 (2)', calls.length === 2, `calls=${calls.length}`);
  check(tc, '(a) error not a Gemini string', !!error && !/Gemini/i.test(error.message), error && error.message);
  check(tc, '(a) error surfaces transport cause', !!error && /ECONNREFUSED/.test(error.message), error && error.message);

  // (b) retryable 503 every attempt
  ({ calls, error } = await runOnce(REAL_PATH,
    { MAIL_AGENT_OLLAMA_URL: 'http://mini:11434', MAIL_AGENT_RETRY_MAX: '1' }, httpAlways(503)));
  check(tc, '(b) 503-always -> throws', !!error, error && error.message);
  check(tc, '(b) fetch called MAX_RETRIES+1 (2)', calls.length === 2, `calls=${calls.length}`);
  check(tc, '(b) error references Ollama+model, not Gemini',
    !!error && /Ollama/.test(error.message) && /qwen2\.5:14b/.test(error.message) && !/Gemini/i.test(error.message),
    error && error.message);
}

// ===========================================================================
// TC-MLL-005 — 200 but empty/missing/garbage response -> throws
// ===========================================================================
async function tc005() {
  const tc = 'TC-MLL-005';
  const variants = [
    ['no response field', {}],
    ['empty string', { response: '' }],
    ['whitespace only', { response: '   ' }],
    ['non-JSON garbage', { response: 'not json' }],
  ];
  for (const [label, jsonBody] of variants) {
    const { result, error } = await runOnce(REAL_PATH,
      { MAIL_AGENT_OLLAMA_URL: 'http://mini:11434', MAIL_AGENT_RETRY_MAX: '0' }, () => ({ status: 200, json: jsonBody }));
    check(tc, `${label} -> throws (no fabricated verdict)`, !!error && !result, error ? '' : `returned ${JSON.stringify(result)}`);
  }
}

// ===========================================================================
// TC-MLL-006 — provider switch routing
// ===========================================================================
async function tc006() {
  const tc = 'TC-MLL-006';
  // gemini leg
  let { calls } = await runOnce(REAL_PATH, { MAIL_AGENT_PROVIDER: 'gemini', GEMINI_API_KEY: 'k' }, byUrl);
  check(tc, 'gemini -> hits generativelanguage', calls.some(c => c.url.includes('generativelanguage')), calls.map(c => c.url)[0]);
  check(tc, 'gemini -> never /api/generate', !calls.some(c => c.url.includes('/api/generate')));
  // explicit ollama
  ({ calls } = await runOnce(REAL_PATH, { MAIL_AGENT_PROVIDER: 'ollama', MAIL_AGENT_OLLAMA_URL: 'http://mini:11434' }, byUrl));
  check(tc, 'ollama -> hits /api/generate', calls.some(c => c.url.includes('/api/generate')));
  check(tc, 'ollama -> never generativelanguage', !calls.some(c => c.url.includes('generativelanguage')));
  // default (provider unset) -> ollama
  ({ calls } = await runOnce(REAL_PATH, { MAIL_AGENT_OLLAMA_URL: 'http://mini:11434' }, byUrl));
  check(tc, 'unset provider defaults to ollama /api/generate',
    calls.length === 1 && calls[0].url.includes('/api/generate') && !calls[0].url.includes('generativelanguage'),
    calls[0] && calls[0].url);
}

// ===========================================================================
// TC-MLL-007 — config: URL trim, TIMEOUT 60000 default, model independence
// ===========================================================================
async function tc007() {
  const tc = 'TC-MLL-007';
  // 1. trailing-slash trim
  let { calls } = await runOnce(REAL_PATH, { MAIL_AGENT_OLLAMA_URL: 'http://mini:11434/' }, okOllama(VALID));
  check(tc, '.1 single trailing slash trimmed', calls[0].url === 'http://mini:11434/api/generate', calls[0].url);
  ({ calls } = await runOnce(REAL_PATH, { MAIL_AGENT_OLLAMA_URL: 'http://mini:11434///' }, okOllama(VALID)));
  check(tc, '.1 multiple trailing slashes trimmed', calls[0].url === 'http://mini:11434/api/generate', calls[0].url);

  // 2. TIMEOUT default 60000 (not the old Gemini 15000) via setTimeout spy on a success path
  const mod = freshLoad({ MAIL_AGENT_OLLAMA_URL: 'http://mini:11434' });
  const realST = global.setTimeout;
  const delays = [];
  global.setTimeout = (fn, delay, ...a) => { delays.push(delay); return realST(fn, delay, ...a); };
  installFetch(okOllama(VALID));
  try { await mod.classifyEmail(SAMPLE); } finally { restoreFetch(); global.setTimeout = realST; }
  check(tc, '.2 abort timeout default === 60000', delays.includes(60000), `setTimeout delays=[${delays.join(',')}]`);
  check(tc, '.2 not the old 15000 Gemini timeout', !delays.includes(15000), `delays=[${delays.join(',')}]`);

  // 3. model independence
  ({ calls } = await runOnce(REAL_PATH, { MAIL_AGENT_OLLAMA_URL: 'http://mini:11434', MAIL_AGENT_MODEL: 'gemini-2.5-flash' }, okOllama(VALID)));
  check(tc, '.3 ollama body.model ignores MAIL_AGENT_MODEL (stays qwen2.5:14b)', calls[0].body.model === 'qwen2.5:14b', calls[0].body.model);
  ({ calls } = await runOnce(REAL_PATH, { MAIL_AGENT_OLLAMA_URL: 'http://mini:11434', MAIL_AGENT_OLLAMA_MODEL: 'qwen2.5:7b' }, okOllama(VALID)));
  check(tc, '.3 MAIL_AGENT_OLLAMA_MODEL override respected', calls[0].body.model === 'qwen2.5:7b', calls[0].body.model);
}

// ===========================================================================
// TC-MLL-008 — negative control / sabotage: each mutation flips a named check RED
// ===========================================================================
async function tc008() {
  const tc = 'TC-MLL-008';
  const SRC = fs.readFileSync(REAL_PATH, 'utf8');
  const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mll-sabotage-'));
  let n = 0;
  const madeFiles = [];
  function sabotage(find, repl) {
    const src = SRC.replace(find, repl);
    if (src === SRC) throw new Error('sabotage anchor did not match — mutation is a no-op (would be a vacuous test)');
    const p = path.join(TMPDIR, `sab-${++n}.js`);
    fs.writeFileSync(p, src);
    madeFiles.push(p);
    return p;
  }

  // (a) temperature wrong -> TC-001.3 temperature check must go RED
  try {
    const p = sabotage('temperature: 0.1, num_ctx: 4096, num_predict: 512', 'temperature: 0.7, num_ctx: 4096, num_predict: 512');
    const { calls } = await runOnce(p, { MAIL_AGENT_OLLAMA_URL: 'http://mini:11434' }, okOllama(VALID));
    const temp = calls[0] && calls[0].body.options && calls[0].body.options.temperature;
    check(tc, '(a) temperature=0.7 flips TC-001.3 RED', (temp === 0.1) === false, `sabotaged temp=${temp}`);
  } catch (e) { check(tc, '(a) temperature sabotage applied', false, e.message); }

  // (b) format omitted -> TC-001.2 format check must go RED
  try {
    const p = sabotage("\n        format: 'json',", '');
    const { calls } = await runOnce(p, { MAIL_AGENT_OLLAMA_URL: 'http://mini:11434' }, okOllama(VALID));
    const fmt = calls[0] && calls[0].body.format;
    check(tc, '(b) format-omitted flips TC-001.2 RED', (fmt === 'json') === false, `sabotaged format=${fmt}`);
  } catch (e) { check(tc, '(b) format sabotage applied', false, e.message); }

  // (c) pre-parse reintroduced -> TC-003 (fence) throws + TC-002 (valid) throws
  try {
    const p = sabotage('const rawOutput = data && data.response;', 'const rawOutput = JSON.parse(data && data.response);');
    const fenced = '```json\n' + VALID + '\n```';
    const fRes = await runOnce(p, { MAIL_AGENT_OLLAMA_URL: 'http://mini:11434', MAIL_AGENT_RETRY_MAX: '0' }, okOllama(fenced));
    check(tc, '(c) pre-parse flips TC-003 RED (fence now throws)', !!fRes.error, fRes.error ? '' : `no throw, got ${JSON.stringify(fRes.result)}`);
    const vRes = await runOnce(p, { MAIL_AGENT_OLLAMA_URL: 'http://mini:11434', MAIL_AGENT_RETRY_MAX: '0' }, okOllama(VALID));
    check(tc, '(c) pre-parse flips TC-002 RED (valid now throws)', !!vRes.error, vRes.error ? '' : `no throw, got ${JSON.stringify(vRes.result)}`);
  } catch (e) { check(tc, '(c) pre-parse sabotage applied', false, e.message); }

  // (d) provider dispatch inverted -> ollama routes to Gemini -> TC-006/TC-001.5 RED
  try {
    const p = sabotage(
      "    if (PROVIDER === 'gemini') return classifyViaGemini(input);\n    return classifyViaOllama(input);",
      "    if (PROVIDER === 'gemini') return classifyViaOllama(input);\n    return classifyViaGemini(input);");
    const { calls } = await runOnce(p, { MAIL_AGENT_OLLAMA_URL: 'http://mini:11434', GEMINI_API_KEY: 'k' }, byUrl);
    const hitsGenerate = calls.some(c => c.url.includes('/api/generate'));
    const hitsGemini = calls.some(c => c.url.includes('generativelanguage'));
    check(tc, '(d) inverted dispatch flips TC-006/TC-001.5 RED', hitsGenerate === false && hitsGemini === true, calls.map(c => c.url).join(' | '));
  } catch (e) { check(tc, '(d) dispatch sabotage applied', false, e.message); }

  // (e) error path softened (return instead of throw) -> TC-004 RED
  try {
    const p = sabotage(
      "    throw lastError || new Error('mail agent ollama classification failed');",
      "    return { verdict: 'error', model: OLLAMA_MODEL, latency_ms: 0 };");
    const { result, error } = await runOnce(p, { MAIL_AGENT_OLLAMA_URL: 'http://mini:11434', MAIL_AGENT_RETRY_MAX: '0' }, rejectAlways('ECONNREFUSED'));
    check(tc, '(e) softened error flips TC-004 RED (returns, no throw)', !error && !!result && result.verdict === 'error',
      error ? `still threw: ${error.message}` : JSON.stringify(result));
  } catch (e) { check(tc, '(e) error-soften sabotage applied', false, e.message); }

  // cleanup temp sabotage files
  try { for (const f of madeFiles) fs.unlinkSync(f); fs.rmdirSync(TMPDIR); } catch { /* best effort */ }
}

// ===========================================================================
// TC-MLL-009 — live integration on the real mini (sequential; SKIP if unreachable)
// ===========================================================================
async function reachable(url, ms) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    const res = await ORIGINAL_FETCH(url, { signal: c.signal });
    clearTimeout(t);
    return res && res.ok;
  } catch { return false; }
}
async function tc009() {
  const tc = 'TC-MLL-009';
  global.fetch = ORIGINAL_FETCH; // live path uses REAL fetch
  if (!fs.existsSync(EMAILS_PATH)) { skip(tc, 'live smoke', `emails fixture not found: ${EMAILS_PATH}`); return; }
  const up = await reachable(LIVE_URL + '/api/version', 4000);
  if (!up) { skip(tc, 'live smoke', `mini/tunnel unreachable at ${LIVE_URL}/api/version`); return; }

  let emails;
  try { emails = JSON.parse(fs.readFileSync(EMAILS_PATH, 'utf8')); } catch (e) { skip(tc, 'live smoke', `emails fixture parse error: ${e.message}`); return; }
  const five = emails.slice(0, 5);
  const mod = freshLoad({ MAIL_AGENT_OLLAMA_URL: LIVE_URL, MAIL_AGENT_OLLAMA_MODEL: 'qwen2.5:14b' });

  for (const em of five) {
    const input = {
      fromName: em.from_name, fromEmail: em.from_email, subject: em.subject,
      bodyText: em.body_text, knownContact: em.known_contact, contactName: null,
    };
    let r = null, err = null;
    try { r = await mod.classifyEmail(input); } catch (e) { err = e; } // SEQUENTIAL await, never parallel
    if (err) { check(tc, `email ${em.id} classifies without throw`, false, err.message); continue; }
    const errs = validateVerdict(r.verdict);
    const ok = errs.length === 0 && r.model === 'qwen2.5:14b';
    check(tc, `email ${em.id} schema-valid verdict + model`, ok, ok ? '' : `${errs.join('; ')} model=${r.model}`);
    console.log(`     [live] id=${em.id} cat=${r.verdict.category} needs=${r.verdict.needs_attention} conf=${r.verdict.confidence} pri=${r.verdict.priority} lat=${r.latency_ms}ms  (gemini:${em.gemini_category})`);
  }
}

// ===========================================================================
// runner
// ===========================================================================
function want(name) {
  if (SECTION === 'all') return true;
  if (SECTION === 'unit') return name !== 'live';
  return SECTION === name;
}

async function main() {
  console.log(`\n=== verify-mail-local-llm-001  (section=${SECTION}) ===\n`);
  if (want('shape')) { console.log('-- TC-MLL-001 request shape'); await safe('TC-MLL-001', tc001); }
  if (want('parse')) { console.log('-- TC-MLL-002 parse/verdict + clamp'); await safe('TC-MLL-002', tc002); }
  if (want('fence')) { console.log('-- TC-MLL-003 code-fence'); await safe('TC-MLL-003', tc003); }
  if (want('error')) { console.log('-- TC-MLL-004 error path throws'); await safe('TC-MLL-004', tc004); }
  if (want('empty')) { console.log('-- TC-MLL-005 empty/garbage response throws'); await safe('TC-MLL-005', tc005); }
  if (want('switch')) { console.log('-- TC-MLL-006 provider switch'); await safe('TC-MLL-006', tc006); }
  if (want('config')) { console.log('-- TC-MLL-007 config defaults'); await safe('TC-MLL-007', tc007); }
  if (want('sabotage')) { console.log('-- TC-MLL-008 sabotage / negative control'); await safe('TC-MLL-008', tc008); }
  if (want('live')) { console.log('-- TC-MLL-009 live integration'); await safe('TC-MLL-009', tc009); }

  // per-case tally
  const byTc = {};
  for (const r of results) {
    byTc[r.tc] = byTc[r.tc] || { PASS: 0, FAIL: 0, SKIP: 0 };
    byTc[r.tc][r.status]++;
  }
  console.log('\n=== PER-CASE TALLY ===');
  let anyFail = false;
  for (const tcId of Object.keys(byTc).sort()) {
    const s = byTc[tcId];
    const status = s.FAIL > 0 ? 'FAIL' : (s.PASS > 0 ? 'PASS' : 'SKIP');
    if (s.FAIL > 0) anyFail = true;
    console.log(`  ${status.padEnd(4)}  ${tcId}   P:${s.PASS} F:${s.FAIL} S:${s.SKIP}`);
  }
  const totals = results.reduce((a, r) => (a[r.status]++, a), { PASS: 0, FAIL: 0, SKIP: 0 });
  console.log(`\nTOTAL checks: PASS ${totals.PASS} · FAIL ${totals.FAIL} · SKIP ${totals.SKIP}`);
  console.log(anyFail ? '\nRESULT: FAIL\n' : '\nRESULT: PASS\n');
  process.exit(anyFail ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
