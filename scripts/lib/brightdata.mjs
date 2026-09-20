import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ENDPOINT = 'https://api.brightdata.com/request';
const TRANSPORT = 'brightdata_web_unlocker';
const OFFICIAL_DOMAINS = [
  'shinhancard.com', 'samsungcard.com', 'hyundaicard.com', 'kbcard.com',
  'wooricard.com', 'hanacard.co.kr', 'lottecard.co.kr', 'bccard.com',
  'nhcard.co.kr', 'nonghyup.com', 'ibk.co.kr', 'citi.co.kr', 'sc.co.kr',
];

export class BrightDataError extends Error {
  constructor(code, message, { status = null, retryable = false } = {}) {
    super(message);
    this.name = 'BrightDataError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

/** One shared budget per collection, including failures; no automatic retries. */
export function createRequestBudget(limit = 30) {
  if (!Number.isInteger(limit) || limit < 0) throw new TypeError('Invalid request budget');
  let used = 0;
  return Object.freeze({
    limit,
    get used() { return used; },
    get remaining() { return limit - used; },
    consume() {
      if (used >= limit) throw new BrightDataError('budget_exhausted', `Bright Data request budget exhausted (${limit})`);
      used += 1;
    },
  });
}

const defaultBudget = createRequestBudget();
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function redact(value, secret) {
  return String(value ?? '')
    .split(secret || '\u0000').join('[REDACTED]')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|token|password)\s*[=:]\s*)[^\s,;"']+/gi, '$1[REDACTED]')
    .slice(0, 500);
}

function validateTarget(value) {
  let url;
  try { url = new URL(value); } catch { throw new BrightDataError('target_not_allowed', 'A public official card URL is required'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !OFFICIAL_DOMAINS.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))
      || /(?:^|\/)(?:login|logout|signin|mypage|my-account)(?:\/|$)/i.test(url.pathname)) {
    throw new BrightDataError('target_not_allowed', 'Only HTTPS public official card pages are allowed');
  }
  url.hash = '';
  return url.href;
}

async function credentials(options) {
  const env = options.env ?? process.env;
  let key = env.BRIGHT_DATA_API_KEY;
  if (!key && options.keyFile) {
    const keyName = options.keyName ?? 'BRIGHT_DATA_API_KEY';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyName)) throw new BrightDataError('configuration', 'Invalid key variable name');
    let content;
    try { content = await readFile(options.keyFile, 'utf8'); }
    catch { throw new BrightDataError('configuration', 'Cannot read the selected runtime credential file'); }
    const match = content.split(/\r?\n/).map((line) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line))
      .find((entry) => entry?.[1] === keyName);
    key = match?.[2];
    if (key && /^(["']).*\1$/.test(key)) key = key.slice(1, -1);
  }
  const zone = options.zone ?? env.BRIGHT_DATA_ZONE;
  if (!key || !zone) throw new BrightDataError('configuration', 'BRIGHT_DATA_API_KEY and an existing BRIGHT_DATA_ZONE are required; no zone is created automatically');
  if (/[\r\n]/.test(key) || !/^[A-Za-z0-9_-]+$/.test(zone)) throw new BrightDataError('configuration', 'Invalid credential or zone format');
  return { key, zone };
}

function classify(status, message) {
  if (status === 402 || /insufficient|not enough|quota|balance|credit.*exhaust|usage limit/i.test(message)) return 'quota';
  if (status === 401) return 'authentication';
  if (status === 403) return 'permission';
  if (status === 429) return 'rate_limit';
  return 'api_http';
}

async function readCache(directory, cacheKey, { url, render, country, maxAgeMs, now }) {
  if (!directory || maxAgeMs <= 0) return null;
  try {
    const metadata = JSON.parse(await readFile(path.join(directory, `${cacheKey}.json`), 'utf8'));
    const html = await readFile(path.join(directory, `${cacheKey}.html`), 'utf8');
    const age = now - Date.parse(metadata.retrievedAt);
    if (metadata.version !== 1 || metadata.transport !== TRANSPORT || metadata.sourceUrl !== url || metadata.render !== render
        || metadata.country !== country || !Number.isInteger(metadata.status) || metadata.status < 200 || metadata.status > 299
        || !Number.isFinite(age) || age < 0 || age > maxAgeMs
        || metadata.sha256 !== sha256(html) || metadata.bytes !== Buffer.byteLength(html)) return null;
    return { ...metadata, html, cacheHit: true, contentVerified: false };
  } catch { return null; }
}

/**
 * Fetch a public issuer page via an EXISTING Web Unlocker zone.
 * Required env: BRIGHT_DATA_API_KEY, BRIGHT_DATA_ZONE. Optional keyFile/keyName
 * reads exactly one selected variable, without sourcing shell code or rotating keys.
 * Pass one createRequestBudget() object to all calls in a collection. A cache hit
 * consumes no request. Returned HTML still requires issuer-parser/content checks.
 * No provider response headers, credentials or cookies are logged or cached.
 */
export async function fetchBrightData(inputUrl, options = {}) {
  const url = validateTarget(inputUrl);
  const render = options.render === true;
  const country = options.country ?? null;
  if (country !== null && !/^[a-z]{2}$/.test(country)) throw new BrightDataError('configuration', 'country must be a lowercase ISO two-letter code');
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new BrightDataError('configuration', 'timeoutMs must be positive');
  const now = options.now?.() ?? Date.now();
  const cacheKey = sha256(JSON.stringify({ version: 1, url, render, country, transport: TRANSPORT }));
  const cached = await readCache(options.cacheDir, cacheKey, {
    url, render, country, maxAgeMs: options.cacheMaxAgeMs ?? 86_400_000, now,
  });
  if (cached) return cached;
  const { key, zone } = await credentials(options);
  const budget = options.budget ?? defaultBudget;
  if (typeof budget.consume !== 'function') throw new BrightDataError('configuration', 'A createRequestBudget() budget is required');
  budget.consume();
  const controller = new AbortController();
  const payload = { zone, url, format: 'json' };
  if (render) payload.render = 'true';
  if (country) payload.country = country;
  let timer;
  let response;
  let text;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new BrightDataError('timeout', `Bright Data request timed out after ${timeoutMs}ms`, { retryable: true }));
    }, timeoutMs);
  });
  try {
    ({ response, text } = await Promise.race([
      (async () => {
        const response = await (options.fetchImpl ?? fetch)(ENDPOINT, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload), signal: controller.signal, redirect: 'error',
        });
        return { response, text: await response.text() };
      })(),
      timeout,
    ]));
  } catch (error) {
    if (error instanceof BrightDataError) throw error;
    if (controller.signal.aborted) throw new BrightDataError('timeout', 'Bright Data request timed out', { retryable: true });
    throw new BrightDataError('network', `Bright Data network failure: ${redact(error.message, key)}`, { retryable: true });
  } finally { clearTimeout(timer); }
  if (!response.ok) {
    const message = redact(text, key);
    const code = classify(response.status, message);
    throw new BrightDataError(code, `Bright Data HTTP ${response.status}: ${message}`, {
      status: response.status, retryable: code === 'rate_limit' || response.status >= 500,
    });
  }
  if (Buffer.byteLength(text) > (options.maxResponseBytes ?? 16 * 1024 * 1024)) throw new BrightDataError('invalid_response', 'Bright Data response exceeds size limit');
  let data;
  try { data = JSON.parse(text); } catch { throw new BrightDataError('invalid_response', 'Bright Data returned a non-JSON envelope'); }
  const status = Number(data?.status_code);
  if (!Number.isInteger(status) || status < 100 || status > 599 || typeof data?.body !== 'string') {
    throw new BrightDataError('invalid_response', 'Bright Data envelope must include status_code and a string body');
  }
  if (status < 200 || status > 299) throw new BrightDataError('target_http', `Issuer page returned HTTP ${status}`, { status, retryable: status === 429 || status >= 500 });
  if (!data.body.trim()) throw new BrightDataError('empty_body', 'Issuer page returned an empty body', { status });
  // A provider error or echoed authorization value must never become a cache artifact.
  if (data.body.includes(key)) throw new BrightDataError('invalid_response', 'Response unexpectedly contains credential material');
  const metadata = {
    version: 1, sourceUrl: url, status, transport: TRANSPORT,
    retrievedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
    bytes: Buffer.byteLength(data.body), sha256: sha256(data.body), cacheKey,
    render, country, cacheHit: false, contentVerified: false,
    provenance: { endpoint: ENDPOINT, format: 'json', apiStatus: response.status },
  };
  if (options.cacheDir) {
    try {
      await mkdir(options.cacheDir, { recursive: true });
      await writeFile(path.join(options.cacheDir, `${cacheKey}.html`), data.body);
      await writeFile(path.join(options.cacheDir, `${cacheKey}.json`), `${JSON.stringify(metadata, null, 2)}\n`);
    } catch { metadata.cacheWarning = 'cache_write_failed'; }
  }
  return { ...metadata, html: data.body };
}
