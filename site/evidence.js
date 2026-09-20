/** Presentation helpers keep missing evidence distinct from a negative finding. */
export const FRESH_DAYS = 30;

export function koreanToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

function dateDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) return null;
  const day = value.slice(0, 10);
  const stamp = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === day ? stamp : null;
}

export function freshness(card, today = koreanToday()) {
  const retrieved = card.source?.retrieved_at;
  const collected = dateDay(retrieved);
  const reference = dateDay(today);
  if (collected === null || reference === null || collected > reference) {
    return { key: 'unknown', label: '확인일 미확인', date: retrieved || null, days: null };
  }
  const days = Math.floor((reference - collected) / 86400000);
  return {
    key: days <= FRESH_DAYS ? 'fresh' : 'stale',
    label: days <= FRESH_DAYS ? '30일 이내 확인' : '재확인 필요',
    date: retrieved.slice(0, 10), days,
  };
}

export function taxState(card, field) {
  const value = card.tax?.[field];
  return value === true ? 'yes' : value === false ? 'no' : 'unknown';
}

export function taxLabel(card, field) {
  const labels = field === 'counts_as_spend'
    ? { yes: '실적 포함', no: '실적 제외', unknown: '미확인' }
    : { yes: '적립·할인 대상', no: '적립·할인 제외', unknown: '미확인' };
  return labels[taxState(card, field)];
}

export function reviewLabel(card) {
  if (card.review_status === 'human_reviewed') return '사람이 원문 검수';
  if (card.review_status === 'machine_extracted') return '자동 추출 · 사람 검수 전';
  return '검수 상태 미확인';
}

export function eventPeriod(event, today = koreanToday()) {
  const start = dateDay(event.starts_at);
  const end = dateDay(event.ends_at);
  const reference = dateDay(today);
  if (start === null || end === null || reference === null || end < start) return 'unknown';
  if (reference < start) return 'upcoming';
  if (reference > end) return 'expired';
  return 'active';
}

const STATUS_LABELS = {
  collected: '수집 성공',
  success: '수집 성공', succeeded: '수집 성공', completed: '수집 완료', ok: '수집 성공',
  partial: '일부 수집', partial_success: '일부 수집', failed: '수집 실패', error: '수집 실패',
  skipped: '수집 보류', not_attempted: '이번 실행 미시도', not_collected: '아직 미수집',
  blocked: '접근 제한', blocked_by_robots: '자동 수집 제한', retained: '이전 자료 유지',
};

export function coverageRows(cards, issuers, report) {
  const reports = Array.isArray(report?.issuer_reports) ? report.issuer_reports : [];
  const keys = new Set([...issuers.map((i) => i.key), ...cards.map((c) => c.issuer), ...reports.map((r) => r.issuer)]);
  return [...keys].filter(Boolean).map((key) => {
    const issuer = issuers.find((i) => i.key === key);
    const run = reports.find((r) => r.issuer === key);
    const count = cards.filter((c) => c.issuer === key).length;
    return {
      key, name: issuer?.name || key, count, run,
      label: run ? STATUS_LABELS[run.status] || `상태 확인 필요 (${run.status || '미기재'})` : '실행 기록 없음',
      note: run?.note || (!run && !count ? issuer?.status_reason : '') || '',
    };
  });
}
