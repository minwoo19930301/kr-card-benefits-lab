/**
 * 검색·필터·정렬 로직. DOM 에 의존하지 않으므로 그대로 테스트할 수 있다.
 * 필터 정의는 docs/methodology.md 의 "필터 정의" 절과 일치해야 한다.
 */

import { computePickingRate } from './picking.js';

export function emptyFilters() {
  return { q: '', issuer: '', cardType: '', maxFee: '', maxSpend: '', categories: new Set() };
}

/** 카드의 최저 전월실적 구간. 없으면 null. */
export function minTier(card) {
  const tiers = card.prev_month_spend_tiers_krw ?? [];
  return tiers.length ? Math.min(...tiers) : null;
}

export function matches(card, filters) {
  if (filters.issuer && card.issuer !== filters.issuer) return false;
  if (filters.cardType && card.card_type !== filters.cardType) return false;

  // 상한 필터는 값을 모르는 카드를 통과시키지 않는다.
  // 미확인을 0 으로 보고 "연회비 없음" 결과에 섞으면 사용자를 오도한다.
  if (filters.maxFee !== '') {
    if (!Number.isFinite(card.annual_fee_krw)) return false;
    if (card.annual_fee_krw > Number(filters.maxFee)) return false;
  }
  if (filters.maxSpend !== '') {
    const tier = minTier(card);
    if (tier === null && !card.no_prev_month_spend_condition) return false;
    if (tier !== null && tier > Number(filters.maxSpend)) return false;
  }

  if (filters.categories?.size) {
    const cats = new Set((card.benefits ?? []).map((b) => b.category));
    let hit = false;
    for (const c of filters.categories) if (cats.has(c)) hit = true;
    if (!hit) return false;
  }

  if (filters.q) {
    const needle = filters.q.toLowerCase();
    const haystack = [
      card.name,
      card.tagline ?? '',
      ...(card.benefits ?? []).map((b) => `${b.title} ${b.summary ?? ''}`),
    ]
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

export function sortCards(cards, sortKey) {
  const copy = [...cards];
  if (sortKey === 'fee-asc') {
    // 연회비 미확인 카드는 뒤로 보낸다.
    copy.sort((a, b) => (a.annual_fee_krw ?? Infinity) - (b.annual_fee_krw ?? Infinity));
  } else if (sortKey === 'fee-desc') {
    copy.sort((a, b) => (b.annual_fee_krw ?? -1) - (a.annual_fee_krw ?? -1));
  } else if (sortKey === 'picking-desc') {
    copy.sort((a, b) => (computePickingRate(b).pct ?? -1) - (computePickingRate(a).pct ?? -1));
  } else {
    copy.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  }
  return copy;
}
