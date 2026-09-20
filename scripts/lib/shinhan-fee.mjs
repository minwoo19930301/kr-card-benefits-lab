import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ORIGIN = 'https://www.shinhancard.com';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const nameKey = (s) => String(s ?? '').normalize('NFKC').replace(/[\s·ㆍ()\[\]]/g, '').toLowerCase();
const MAX_AGE = 86_400_000;
const plain = (s) => s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

/** Public official GET only. Returns {card,enriched,reason?,evidence?}; never mutates card.
 * Fees without explicit primary-holder evidence are returned for audit, not applied.
 * Cached evidence retains its original retrieval time and expires after one day.
 */
export async function enrichShinhanFee(card, html, { fetchImpl = fetch, cacheDir } = {}) {
  try {
    if (card?.issuer !== 'shinhan') return { card, enriched: false, reason: 'wrong_issuer' };
    const pageId = /getCardDetailInfo\s*\(\s*\{\s*pageId\s*:\s*['"](\d{8,20})['"]/.exec(html)?.[1];
    if (!pageId) return { card, enriched: false, reason: 'missing_page_id' };
    const url = `https://shapi.shinhancard.com/card-apply/search/v1.0/getCardProductsInformation?entryId=${pageId}`;
    const cacheFile = cacheDir && path.join(cacheDir, `shinhan-fee-${sha(url)}.json`);
    let stored, cacheHit = false;
    if (cacheFile) {
      try {
        const candidate = JSON.parse(await readFile(cacheFile, 'utf8'));
        const age = Date.now() - Date.parse(candidate.retrievedAt);
        if (candidate.url === url && candidate.version === 1 && age >= 0 && age < MAX_AGE && typeof candidate.body === 'string' && candidate.sha256 === sha(candidate.body)) {
          stored = candidate; cacheHit = true;
        }
      } catch {}
    }
    if (!stored) {
      const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20000), headers: { Accept: 'application/json' } });
      if (!response.ok) return { card, enriched: false, reason: 'fee_http_error' };
      const body = await response.text();
      if (Buffer.byteLength(body) > 2 * 1024 * 1024) return { card, enriched: false, reason: 'fee_response_too_large' };
      stored = { version: 1, url, body, retrievedAt: new Date().toISOString(), sha256: sha(body) };
    }
    const data = JSON.parse(stored.body);
    const product = data?.payload?.cardProduct;
    const productUrl = new URL(product?.cardProductUrl ?? '', ORIGIN);
    const expectedUrl = new URL(card.product_url);
    if (String(data.status) !== '200' || product?.cardProductEntryId !== pageId || nameKey(product.cardProductEntryName) !== nameKey(card.name)
        || productUrl.origin !== ORIGIN || expectedUrl.origin !== ORIGIN || productUrl.pathname !== expectedUrl.pathname) {
      return { card, enriched: false, reason: 'fee_identity_mismatch' };
    }
    if (!Array.isArray(product.afeInfoList) || !product.afeInfoList.length) return { card, enriched: false, reason: 'fee_list_missing' };
    // Explicit page language is required when the API has no holder-type field.
    const noFamily = /가족\s*카드(?:는|를|의)?\s*(?:신청|발급)(?:이|할\s*수)?\s*(?:불가|불가능|없습니다|없음)/.test(plain(html));
    const fees = product.afeInfoList.map((f) => ({
      brand: String(f.cardBrandCode ?? ''), option: String(f.afeCode ?? ''), name: String(f.afeName ?? ''),
      total: f.allAmountOrigin,
      holder: /가족/.test(String(f.afeName)) ? 'family' : /본인|개인/.test(String(f.afeName)) || noFamily ? 'primary' : 'unknown',
    }));
    const evidence = { url, retrievedAt: stored.retrievedAt, sha256: stored.sha256, transport: 'direct_official_http', cacheHit, fees };
    if (cacheFile && !cacheHit) {
      try { await mkdir(cacheDir, { recursive: true }); await writeFile(cacheFile, JSON.stringify(stored)); } catch {}
    }
    const relevant = fees.filter((f) => f.holder !== 'family');
    if (!relevant.length || relevant.some((f) => f.holder !== 'primary')) return { card, enriched: false, reason: 'fee_holder_unknown', evidence };
    if (relevant.some((f) => !Number.isSafeInteger(f.total) || f.total < 0)) return { card, enriched: false, reason: 'fee_total_invalid', evidence };
    const brands = { '0': '국내전용', '1': 'Mastercard', '2': 'Visa' };
    const note = `본인 총연회비: ${relevant.map((f) => `${brands[f.brand] ?? `브랜드코드 ${f.brand}`} ${f.name} ${f.total.toLocaleString('ko-KR')}원`).join(' / ')}. 공식 상품 API 확인.`;
    if (note.length > 300) return { card, enriched: false, reason: 'fee_variants_too_many', evidence };
    return { card: { ...card, annual_fee_krw: Math.min(...relevant.map((f) => f.total)), annual_fee_note: note }, enriched: true, evidence };
  } catch { return { card, enriched: false, reason: 'fee_fetch_or_parse_failed' }; }
}
