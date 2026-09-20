import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BrightDataError, createRequestBudget, fetchBrightData } from '../scripts/lib/brightdata.mjs';

const URL = 'https://www.shinhancard.com/pconts/html/card/apply/credit/1187937_2207.html';
const HTML = '<html><title>신한카드 Mr.Life</title><body>연회비 18,000원 전월 30만원 할인</body></html>';
const env = { BRIGHT_DATA_API_KEY: 'private-unit-test-key', BRIGHT_DATA_ZONE: 'existing_unlocker' };
const envelope = (body = HTML, status = 200) => new Response(JSON.stringify({ status_code: status, body }), { status: 200 });
const options = (extra = {}) => ({ env, budget: createRequestBudget(3), fetchImpl: async () => envelope(), ...extra });

test('REST envelope produces auditable HTML, without implying product verification', async () => {
  let request;
  const budget = createRequestBudget(1);
  const result = await fetchBrightData(URL, options({ budget, render: true, country: 'kr', fetchImpl: async (url, init) => {
    request = { url, init }; return envelope();
  } }));
  assert.equal(request.url, 'https://api.brightdata.com/request');
  assert.equal(request.init.headers.Authorization, `Bearer ${env.BRIGHT_DATA_API_KEY}`);
  assert.deepEqual(JSON.parse(request.init.body), { zone: 'existing_unlocker', url: URL, format: 'json', render: 'true', country: 'kr' });
  assert.equal(result.html, HTML);
  assert.equal(result.status, 200);
  assert.equal(result.bytes, Buffer.byteLength(HTML));
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.contentVerified, false);
  assert.equal(budget.used, 1);
  assert.ok(!JSON.stringify(result).includes(env.BRIGHT_DATA_API_KEY));
});

test('one shared budget counts failures and stops before another charged request', async () => {
  const budget = createRequestBudget(1);
  let calls = 0;
  const config = options({ budget, fetchImpl: async () => { calls += 1; return new Response('insufficient balance', { status: 402 }); } });
  await assert.rejects(fetchBrightData(URL, config), { code: 'quota' });
  await assert.rejects(fetchBrightData(URL, config), { code: 'budget_exhausted' });
  assert.equal(calls, 1);
});

test('permission, rate-limit, target and malformed responses are distinct', async () => {
  for (const [status, code] of [[401, 'authentication'], [403, 'permission'], [429, 'rate_limit'], [502, 'api_http']]) {
    await assert.rejects(fetchBrightData(URL, options({ fetchImpl: async () => new Response('failed', { status }) })), { code, status });
  }
  await assert.rejects(fetchBrightData(URL, options({ fetchImpl: async () => envelope('Not found', 404) })), { code: 'target_http', status: 404 });
  await assert.rejects(fetchBrightData(URL, options({ fetchImpl: async () => new Response('<html>not JSON</html>') })), { code: 'invalid_response' });
  await assert.rejects(fetchBrightData(URL, options({ fetchImpl: async () => envelope('') })), { code: 'empty_body' });
});

test('provider errors and network failures redact the selected credential', async () => {
  for (const fetchImpl of [
    async () => new Response(`Denied Bearer ${env.BRIGHT_DATA_API_KEY}`, { status: 403 }),
    async () => { throw new Error(`network token=${env.BRIGHT_DATA_API_KEY}`); },
  ]) {
    await assert.rejects(fetchBrightData(URL, options({ fetchImpl })), (error) => {
      assert.ok(error instanceof BrightDataError);
      assert.ok(!String(error.stack).includes(env.BRIGHT_DATA_API_KEY));
      return true;
    });
  }
  await assert.rejects(fetchBrightData(URL, options({ fetchImpl: async () => envelope(env.BRIGHT_DATA_API_KEY) })), { code: 'invalid_response' });
});

test('timeout aborts an unresponsive transport and does not retry', async () => {
  let signal;
  let calls = 0;
  await assert.rejects(fetchBrightData(URL, options({ timeoutMs: 15, fetchImpl: async (_, init) => {
    signal = init.signal; calls += 1; return new Promise(() => {});
  } })), { code: 'timeout' });
  assert.equal(signal.aborted, true);
  assert.equal(calls, 1);
});

test('cache hits preserve acquisition time and consume no requests; corrupt cache is refetched', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'card-bd-test-'));
  try {
    const first = await fetchBrightData(URL, options({ cacheDir, now: () => Date.UTC(2026, 8, 21) }));
    const budget = createRequestBudget(0);
    const hit = await fetchBrightData(URL, { cacheDir, budget, env: {}, now: () => Date.UTC(2026, 8, 21, 1) });
    assert.equal(hit.cacheHit, true);
    assert.equal(hit.retrievedAt, first.retrievedAt);
    assert.equal(budget.used, 0);
    const metadata = await readFile(path.join(cacheDir, `${first.cacheKey}.json`), 'utf8');
    assert.ok(!metadata.includes(env.BRIGHT_DATA_API_KEY));
    await writeFile(path.join(cacheDir, `${first.cacheKey}.html`), 'tampered');
    let calls = 0;
    await fetchBrightData(URL, options({ cacheDir, now: () => Date.UTC(2026, 8, 21, 2), fetchImpl: async () => { calls += 1; return envelope(); } }));
    assert.equal(calls, 1);
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
});

test('stale cache and rendered/unrendered variants require distinct acquisitions', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'card-bd-test-'));
  try {
    const first = await fetchBrightData(URL, options({ cacheDir, now: () => 1_000_000 }));
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return envelope(); };
    await fetchBrightData(URL, options({ cacheDir, fetchImpl, now: () => 1_000_020, cacheMaxAgeMs: 10 }));
    const rendered = await fetchBrightData(URL, options({ cacheDir, fetchImpl, render: true, now: () => 1_000_021 }));
    assert.equal(calls, 2);
    assert.notEqual(first.cacheKey, rendered.cacheKey);
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
});

test('runtime file reads exactly the named key without shell expansion or fallback', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'card-bd-test-'));
  try {
    const keyFile = path.join(dir, '.env');
    await writeFile(keyFile, 'KEY_ONE="chosen-private-key"\nKEY_TWO=other-private-key\n');
    let auth;
    await fetchBrightData(URL, options({ env: { BRIGHT_DATA_ZONE: 'existing' }, keyFile, keyName: 'KEY_ONE', fetchImpl: async (_, init) => { auth = init.headers.Authorization; return envelope(); } }));
    assert.equal(auth, 'Bearer chosen-private-key');
    await assert.rejects(fetchBrightData(URL, options({ env: { BRIGHT_DATA_ZONE: 'existing' }, keyFile, keyName: 'MISSING' })), { code: 'configuration' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('unofficial, authenticated and private URLs never reach the provider', async () => {
  let calls = 0;
  for (const url of ['http://www.shinhancard.com/card', 'https://www.shinhancard.com.evil.example/card', 'https://user:pass@www.shinhancard.com/card', 'https://127.0.0.1/', 'https://www.shinhancard.com/login/']) {
    await assert.rejects(fetchBrightData(url, options({ fetchImpl: async () => { calls += 1; return envelope(); } })), { code: 'target_not_allowed' });
  }
  assert.equal(calls, 0);
});
