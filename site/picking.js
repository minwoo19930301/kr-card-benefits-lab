/**
 * 피킹률 계산. 대시보드와 테스트가 같은 구현을 쓴다.
 *
 * 정의
 *   피킹률(%) = (월 추정 최대 혜택 합) / (전월 이용실적 기준 금액) x 100
 *
 * 이 값은 "약관상 월 한도를 모두 채웠을 때"의 상한이며, 실사용 절감액이 아니다.
 * 월 한도를 알 수 없는 혜택은 0 으로 계산하므로 결과는 하한이기도 하다.
 * 즉 계산 결과는 알려진 한도만으로 만든 보수적 추정치다.
 */

export const PICKING_STATUS = {
  OK: 'ok',
  NO_SPEND_CONDITION: 'no_spend_condition',
  INSUFFICIENT_DATA: 'insufficient_data',
};

/**
 * @param {object} card
 * @param {{tierKrw?: number|null}} [options] 특정 실적 구간으로 계산하고 싶을 때 지정
 */
export function computePickingRate(card, options = {}) {
  const benefits = Array.isArray(card?.benefits) ? card.benefits : [];
  const capped = benefits.filter((b) => Number.isFinite(b.monthly_cap_krw));
  const uncapped = benefits.length - capped.length;

  // 카드 전체 통합 월 한도가 확인되면 그것이 상한이다.
  // 개별 혜택 한도를 합하면 통합 한도를 넘어 과대추정된다.
  const integrated = Number.isFinite(card?.integrated_monthly_cap_krw)
    ? card.integrated_monthly_cap_krw
    : null;
  const summed = capped.reduce((sum, b) => sum + b.monthly_cap_krw, 0);
  const estimatedKrw = integrated ?? summed;

  const tiers = Array.isArray(card?.prev_month_spend_tiers_krw)
    ? card.prev_month_spend_tiers_krw.filter((t) => Number.isFinite(t) && t > 0)
    : [];
  const tierKrw = options.tierKrw ?? (tiers.length ? Math.min(...tiers) : null);

  const base = {
    estimatedKrw,
    tierKrw,
    cappedCount: capped.length,
    uncappedCount: uncapped,
    benefitCount: benefits.length,
    basis: integrated !== null ? 'integrated_cap' : 'summed_benefit_caps',
  };

  if (!tierKrw) {
    // 실적 조건이 없다고 확인된 카드는 분모가 없어 피킹률을 정의할 수 없다.
    const status = card?.no_prev_month_spend_condition
      ? PICKING_STATUS.NO_SPEND_CONDITION
      : PICKING_STATUS.INSUFFICIENT_DATA;
    return { ...base, status, pct: null };
  }
  if (integrated === null && !capped.length) {
    return { ...base, status: PICKING_STATUS.INSUFFICIENT_DATA, pct: null };
  }
  return {
    ...base,
    status: PICKING_STATUS.OK,
    pct: Math.round((estimatedKrw / tierKrw) * 1000) / 10,
  };
}

/** 피킹률 신뢰도 라벨. 한도 미상 혜택이 많으면 과소추정 위험을 알린다. */
export function pickingCaveat(result) {
  if (result.status === PICKING_STATUS.NO_SPEND_CONDITION) {
    return '전월 실적 조건이 없어 피킹률을 정의할 수 없습니다.';
  }
  if (result.status === PICKING_STATUS.INSUFFICIENT_DATA) {
    return '월 한도 또는 실적 구간이 확인되지 않아 계산하지 않았습니다.';
  }
  if (result.basis === 'integrated_cap') {
    return '카드 전체 통합 월 한도를 모두 채웠다고 가정한 상한값입니다.';
  }
  if (result.uncappedCount > 0) {
    return `혜택 ${result.benefitCount}건 중 ${result.uncappedCount}건은 월 한도가 확인되지 않아 0원으로 계산했습니다. 실제 상한은 이보다 높을 수 있습니다.`;
  }
  return '확인된 월 한도 전부를 채웠다고 가정한 상한값입니다. 통합 한도가 별도로 있으면 실제 상한은 더 낮을 수 있습니다.';
}

export function formatKrw(n) {
  if (!Number.isFinite(n)) return '-';
  if (n === 0) return '없음';
  if (n >= 10000 && n % 10000 === 0) return `${(n / 10000).toLocaleString('ko-KR')}만원`;
  return `${n.toLocaleString('ko-KR')}원`;
}
