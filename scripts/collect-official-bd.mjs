#!/usr/bin/env node
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { fetchBrightData, createRequestBudget } from './lib/brightdata.mjs';
import { parseCardPage } from './collect-issuer-feed.mjs';
import { parseHyundaiDetail, parseShinhanDetail } from './collect-issuer-rendered.mjs';
import { validateAgainstSchema, checkSourcePolicy } from './validate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dateKST = (value = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date(value));
const canonical = (value) => { const u = new URL(value); u.hash = ''; u.searchParams.sort(); return u.href; };
const fingerprint = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalizedName = (value) => String(value).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

export function makeJobs(cards, seeds, issuers) {
  const allowed = new Map(issuers.issuers.map(i => [i.key, new Set(i.allowed_domains)]));
  const jobs = new Map();
  function add(job) {
    const url = new URL(job.url);
    if (url.protocol !== 'https:' || !allowed.get(job.issuer)?.has(url.hostname)) throw new Error(`Unofficial source for ${job.issuer}`);
    const key = `${job.issuer}:${canonical(job.url)}`;
    if (!jobs.has(key)) jobs.set(key, { ...job, url: canonical(job.url) });
  }
  for (const card of cards) add({ issuer: card.issuer, url: card.source.url, name: card.name, card_type: card.card_type, existingId: card.id });
  for (const issuer of seeds.issuers ?? []) for (const product of issuer.products ?? []) {
    if (product.card_type != null && !['credit', 'check'].includes(product.card_type)) continue;
    add({ issuer: issuer.issuer, ...product });
  }
  // Round-robin issuers so a bounded run reaches every available issuer.
  const groups = new Map();
  for (const job of jobs.values()) { if (!groups.has(job.issuer)) groups.set(job.issuer, []); groups.get(job.issuer).push(job); }
  const result = [];
  while ([...groups.values()].some(g => g.length)) for (const group of groups.values()) if (group.length) result.push(group.shift());
  return result;
}

/** Reject incomplete refreshes instead of attaching a new date to old fields. */
export function assessCandidate(candidate, previous, schema, issuers) {
  if (!candidate?.benefits?.length) return ['no_product_benefits'];
  const errors = [
    ...validateAgainstSchema({ schema_version: 1, generated_at: candidate.updated_at, cards: [candidate] }, schema),
    ...checkSourcePolicy([candidate], issuers),
  ];
  if (/\{\{|\}\}|access denied|captcha|페이지를 찾을|오류가 발생/i.test(candidate.name)) errors.push('unresolved_or_error_title');
  if (/\{\{|\}\}/.test(JSON.stringify(candidate.benefits))) errors.push('unresolved_benefit_template');
  if (previous) {
    if (candidate.issuer !== previous.issuer || candidate.card_type !== previous.card_type) errors.push('product_identity_changed');
    if (normalizedName(candidate.name) !== normalizedName(previous.name)) errors.push('product_name_changed');
    if (candidate.source.retrieved_at < previous.source.retrieved_at) errors.push('older_than_stored_source');
    for (const key of ['annual_fee_krw', 'integrated_monthly_cap_krw', 'no_prev_month_spend_condition']) {
      if (previous[key] !== undefined && candidate[key] === undefined) errors.push(`lost_${key}`);
    }
    if (previous.prev_month_spend_tiers_krw?.length && !candidate.prev_month_spend_tiers_krw?.length) errors.push('lost_spend_tiers');
    if (candidate.benefits.length < Math.ceil(previous.benefits.length * 0.75)) errors.push('benefit_count_regression');
    const numericKeys = ['rate_pct', 'monthly_cap_krw', 'monthly_cap_points', 'per_txn_eligible_spend_cap_krw', 'requires_prev_month_spend_krw', 'counts_toward_prev_month_spend'];
    for (const benefit of previous.benefits) {
      const next = candidate.benefits.find(b => normalizedName(b.title) === normalizedName(benefit.title));
      if (numericKeys.some(key => benefit[key] !== undefined && next?.[key] === undefined)) errors.push('lost_benefit_conditions');
    }
    for (const key of ['counts_as_spend', 'earns_rewards']) if (previous.tax?.[key] !== undefined && candidate.tax?.[key] === undefined) errors.push('lost_tax_condition');
  }
  return errors;
}

export function mergeAccepted(original, accepted, retrievedAt) {
  const cards = new Map(original.cards.map(c => [c.id, c]));
  if (cards.size !== original.cards.length) throw new Error('Duplicate IDs in original corpus');
  for (const entry of accepted) {
    const card = structuredClone(entry.card);
    if (entry.existingId) {
      const previous = cards.get(entry.existingId);
      if (!previous || previous.issuer !== card.issuer || canonical(previous.source.url) !== canonical(card.source.url)) throw new Error('Invalid existingId or source identity');
      card.id = entry.existingId;
    }
    else if (cards.has(card.id) && canonical(cards.get(card.id).source.url) !== canonical(card.source.url)) throw new Error(`Conflicting new product ID: ${card.id}`);
    cards.set(card.id, card);
  }
  return { ...original, generated_at: retrievedAt, cards: [...cards.values()].sort((a,b) => a.id.localeCompare(b.id)) };
}

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, file);
}

async function fetchDirect(url, options) {
  const key = createHash('sha256').update(`direct-v1:${url}`).digest('hex');
  const cache = path.join(options.cacheDir, key);
  try {
    const meta = JSON.parse(await readFile(`${cache}.json`, 'utf8'));
    const html = await readFile(`${cache}.html`, 'utf8');
    const age = Date.now() - Date.parse(meta.retrievedAt);
    if (age >= 0 && age < 86400000 && meta.sourceUrl === url && meta.transport === 'direct_official_http'
      && meta.status >= 200 && meta.status < 300 && meta.bytes === Buffer.byteLength(html)
      && new URL(meta.finalUrl).hostname === new URL(url).hostname
      && meta.sha256 === createHash('sha256').update(html).digest('hex')) return { ...meta, html, cacheHit: true };
  } catch { /* No verified fresh cache. */ }
  options.budget.consume();
  const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'follow', headers: { 'User-Agent': 'OfficialCardResearch/1.0 (+https://github.com/minwoo19930301/kr-card-benefits-lab)' } });
  if (!response.ok) throw Object.assign(new Error('Issuer request failed'), { code: `target_http_${response.status}` });
  if (new URL(response.url).hostname !== new URL(url).hostname) throw Object.assign(new Error('Unexpected redirect host'), { code: 'redirect_host_changed' });
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > 16000000) throw Object.assign(new Error('Page too large'), { code: 'response_too_large' });
  const ascii = new TextDecoder().decode(buffer.slice(0, 4096));
  const charset = /charset\s*=\s*["']?([\w-]+)/i.exec(response.headers.get('content-type') ?? '')?.[1]
    ?? /charset\s*=\s*["']?([\w-]+)/i.exec(ascii)?.[1] ?? 'utf-8';
  const html = new TextDecoder(charset).decode(buffer);
  const meta = { transport: 'direct_official_http', retrievedAt: new Date().toISOString(), bytes: Buffer.byteLength(html), sha256: createHash('sha256').update(html).digest('hex'), status: response.status, sourceUrl: url, finalUrl: response.url };
  await mkdir(options.cacheDir, { recursive: true });
  await writeFile(`${cache}.html`, html);
  await atomicJson(`${cache}.json`, meta);
  return { ...meta, html, cacheHit: false };
}

function argumentsFor(argv) {
  const result = { transport: 'brightdata', limit: 400, concurrency: 3, apply: false, cacheDir: path.join(ROOT, '..', 'bd-card-cache') };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') result.apply = true;
    else if (['--limit','--concurrency'].includes(arg)) result[arg.slice(2)] = Number(argv[++i]);
    else if (arg === '--key-file') result.keyFile = argv[++i];
    else if (arg === '--key-name') result.keyName = argv[++i];
    else if (arg === '--zone') result.zone = argv[++i];
    else if (arg === '--cache-dir') result.cacheDir = path.resolve(argv[++i]);
    else if (arg === '--issuer') result.issuer = argv[++i];
    else if (arg === '--transport') result.transport = argv[++i];
    else throw new Error(`Unknown argument ${arg}`);
  }
  if (!Number.isInteger(result.limit) || result.limit < 1 || result.limit > 1000) throw new Error('--limit must be 1..1000');
  if (!Number.isInteger(result.concurrency) || result.concurrency < 1 || result.concurrency > 5) throw new Error('--concurrency must be 1..5');
  if (!['brightdata', 'direct'].includes(result.transport)) throw new Error('--transport must be brightdata or direct');
  return result;
}

async function main() {
  const args = argumentsFor(process.argv.slice(2));
  const read = async (name) => JSON.parse(await readFile(path.join(ROOT, 'data', name), 'utf8'));
  const original = await read('cards.json');
  const schema = await read('cards.schema.json');
  const issuers = await read('issuers.json');
  const seeds = await read('official-seeds.json').catch(() => ({ issuers: [] }));
  const { parseExtraDetail } = await import('./parse-official-extra.mjs');
  let allJobs = makeJobs(original.cards, seeds, issuers);
  if (args.issuer) allJobs = allJobs.filter(j => j.issuer === args.issuer);
  const jobs = allJobs.slice(0, args.limit);
  const budget = createRequestBudget(args.limit);
  const accepted = [], records = [];
  const priorById = new Map(original.cards.map(c => [c.id, c]));
  const identities = new Map(original.cards.map(c => [c.id, canonical(c.source.url)]));
  const failures = new Map();
  let cursor = 0, stopped = null;
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  async function worker() {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      if (stopped || (failures.get(job.issuer) ?? 0) >= 3) {
        records.push({ ...job, status: 'skipped', reason: stopped ?? 'issuer_failure_circuit' });
        continue;
      }
      const record = { ...job, attempted_at: new Date().toISOString() };
      try {
        const fetcher = args.transport === 'direct' ? fetchDirect : fetchBrightData;
        const response = await fetcher(job.url, {
          ...args, budget, render: ['hyundai', 'shinhan'].includes(job.issuer), timeoutMs: 120000,
        });
        Object.assign(record, { fetched_at: response.retrievedAt, sha256: response.sha256, bytes: response.bytes, cache_hit: response.cacheHit, transport: response.transport, http_status: response.status });
        const retrievedAt = dateKST(response.retrievedAt);
        const options = { issuerKey: job.issuer, pageUrl: job.url, retrievedAt, expectedName: job.name, cardType: job.card_type };
        const parse = job.issuer === 'woori' ? parseCardPage : job.issuer === 'hyundai' ? parseHyundaiDetail : job.issuer === 'shinhan' ? parseShinhanDetail : parseExtraDetail;
        const { card, warnings } = parse(response.html, options);
        record.warnings = warnings;
        const errors = assessCandidate(card, priorById.get(job.existingId), schema, issuers);
        if (card && !job.existingId && identities.has(card.id) && identities.get(card.id) !== canonical(card.source.url)) errors.push('conflicting_product_id');
        if (errors.length) {
          Object.assign(record, { status: 'rejected', reason: errors.join('; ').slice(0, 700) });
          failures.set(job.issuer, (failures.get(job.issuer) ?? 0) + 1);
        } else {
          if (job.existingId) card.id = job.existingId;
          card.source.note = `카드사 공식 공개 원문을 ${args.transport === 'direct' ? '직접 HTTP 요청' : 'Bright Data'}으로 수집하여 자동 추출. 상품 조건은 공식 원문 확인 필요.`;
          accepted.push({ card, existingId: job.existingId });
          identities.set(card.id, canonical(card.source.url));
          Object.assign(record, { status: 'accepted', card_id: card.id });
          failures.set(job.issuer, 0);
        }
      } catch (error) {
        Object.assign(record, { status: 'failed', reason: error.code ?? 'collection_error' });
        failures.set(job.issuer, (failures.get(job.issuer) ?? 0) + 1);
        if (['authentication', 'permission', 'quota', 'rate_limit', 'configuration', 'budget_exhausted'].includes(error.code)) stopped = error.code;
      }
      records.push(record);
      console.log(`${records.length}/${jobs.length} ${job.issuer} ${record.status} ${job.name ?? job.url}${record.reason ? ` (${record.reason})` : ''}`);
    }
  }
  await Promise.all(Array.from({ length: args.concurrency }, worker));
  for (const job of allJobs.slice(args.limit)) records.push({ ...job, status: 'skipped', reason: 'run_limit' });
  const staging = path.join(ROOT, 'work', 'collections', runId);
  // Preserve attempt evidence even if final corpus validation fails.
  await atomicJson(path.join(staging, 'collection-evidence.json'), { run_id: runId, records });
  const date = dateKST();
  const candidate = mergeAccepted(original, accepted, date);
  const errors = [...validateAgainstSchema(candidate, schema), ...checkSourcePolicy(candidate.cards, issuers)];
  if (errors.length) throw new Error(`Candidate validation failed: ${errors.slice(0, 5).join('; ')}`);
  const report = {
    generated_at: new Date().toISOString(), run_id: runId, transport: args.transport === 'direct' ? 'direct_official_http' : 'brightdata_web_unlocker',
    request_count: budget.used, request_limit: budget.limit, stopped_reason: stopped,
    known_source_count: allJobs.length, accepted_count: accepted.length, corpus_sha256: fingerprint(candidate),
    issuer_reports: issuers.issuers.map(i => {
      const rs = records.filter(r => r.issuer === i.key);
      const succeeded = rs.filter(r => r.status === 'accepted').length;
      const failed = rs.filter(r => ['failed', 'rejected'].includes(r.status)).length;
      const skipped = rs.filter(r => r.status === 'skipped').length;
      const refreshed = new Set(rs.filter(r => r.status === 'accepted').map(r => r.existingId).filter(Boolean));
      return {
        issuer: i.key, status: succeeded ? (failed || skipped ? 'partial' : 'collected') : (failed ? 'failed' : 'not_collected'),
        discovered: rs.length, attempted: succeeded + failed, succeeded, failed, skipped,
        updated_cards: succeeded, retained_cards: original.cards.filter(c => c.issuer === i.key && !refreshed.has(c.id)).length,
        checked_at: date, note: rs.length ? `발견된 공식 URL ${rs.length}개 중 검증 통과 ${succeeded}개. 전체 발급 상품 완전성은 미보증.` : '이번 실행에서 검증 가능한 상품 URL을 확보하지 못함.',
      };
    }),
  };
  await atomicJson(path.join(staging, 'cards.json'), candidate);
  await atomicJson(path.join(staging, 'collection-report.json'), report);
  if (args.apply) {
    await atomicJson(path.join(ROOT, 'data/cards.json'), candidate);
    await atomicJson(path.join(ROOT, 'data/collection-report.json'), report);
    await atomicJson(path.join(ROOT, 'data/collection-evidence.json'), { run_id: runId, records });
  }
  console.log(JSON.stringify({ applied: args.apply, requests: budget.used, accepted: accepted.length, total: candidate.cards.length, stopped, staging }));
  if (stopped || accepted.length === 0) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
