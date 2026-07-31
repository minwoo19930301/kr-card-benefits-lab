import { computePickingRate, pickingCaveat, formatKrw, PICKING_STATUS } from './picking.js';
import { emptyFilters, matches, sortCards, minTier } from './filters.js';

const CATEGORY_LABELS = {
  shopping: '쇼핑',
  food: '외식·카페',
  transit: '교통',
  fuel: '주유',
  telecom: '통신',
  utility: '공과금·생활',
  tax: '세금',
  overseas: '해외',
  travel: '여행',
  ott: 'OTT·구독',
  education: '교육',
  medical: '의료',
  mileage: '마일리지',
  point: '포인트·적립',
  other: '기타',
};

const CARD_TYPE_LABELS = { credit: '신용', check: '체크' };
const CONFIDENCE_LABELS = { high: '높음', medium: '보통', low: '낮음' };

const state = {
  cards: [],
  issuers: new Map(),
  generatedAt: '',
  filters: emptyFilters(),
  sort: 'name',
};

const el = (id) => document.getElementById(id);

function text(node, value) {
  node.textContent = value ?? '';
  return node;
}

function create(tag, className, textContent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent != null) node.textContent = textContent;
  return node;
}

// ------------------------------------------------------------------ load

async function load() {
  const [cardsDoc, issuersDoc] = await Promise.all([
    fetch('cards.json').then((r) => r.json()),
    fetch('issuers.json').then((r) => r.json()),
  ]);
  state.cards = cardsDoc.cards;
  state.generatedAt = cardsDoc.generated_at;
  for (const i of issuersDoc.issuers) state.issuers.set(i.key, i);

  buildIssuerSelect();
  buildCategoryChips();
  bindControls();
  render();

  const collected = new Set(state.cards.map((c) => c.issuer));
  const notCollected = issuersDoc.issuers.filter((i) => !collected.has(i.key));
  // 미수록 사유는 카드사마다 다르다. robots 차단과 '피드 없음'을 뭉개지 않는다.
  const blocked = notCollected.filter((i) => i.status === 'blocked_by_robots');
  const noFeed = notCollected.filter((i) => i.status !== 'blocked_by_robots');
  const parts = [
    `데이터 기준일 ${state.generatedAt}`,
    `수록 카드사 ${collected.size}곳`,
    `미수록 ${notCollected.length}곳`,
  ];
  if (blocked.length) {
    parts.push(`${blocked.map((i) => i.name).join(', ')} — robots.txt 가 자동 수집을 차단해 수집하지 않음`);
  }
  if (noFeed.length) {
    parts.push(`${noFeed.map((i) => i.name).join(', ')} — 값을 신뢰할 수 있게 읽을 방법을 아직 못 찾음`);
  }
  text(el('meta-line'), parts.join(' · '));
}

function buildIssuerSelect() {
  const select = el('issuer');
  select.append(create('option', null, '전체'));
  const keys = [...new Set(state.cards.map((c) => c.issuer))];
  for (const key of keys) {
    const option = create('option', null, state.issuers.get(key)?.name ?? key);
    option.value = key;
    select.append(option);
  }
}

function buildCategoryChips() {
  const host = el('categories');
  const present = new Set(state.cards.flatMap((c) => c.benefits.map((b) => b.category)));
  for (const [key, label] of Object.entries(CATEGORY_LABELS)) {
    if (!present.has(key)) continue;
    const id = `cat-${key}`;
    const wrap = create('span', 'chip');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.value = key;
    input.addEventListener('change', () => {
      if (input.checked) state.filters.categories.add(key);
      else state.filters.categories.delete(key);
      render();
    });
    const lab = create('label', null, label);
    lab.setAttribute('for', id);
    wrap.append(input, lab);
    host.append(wrap);
  }
}

function bindControls() {
  el('q').addEventListener('input', (e) => {
    state.filters.q = e.target.value.trim();
    render();
  });
  for (const key of ['issuer', 'cardType', 'maxFee', 'maxSpend']) {
    el(key).addEventListener('change', (e) => {
      state.filters[key] = e.target.value;
      render();
    });
  }
  el('sort').addEventListener('change', (e) => {
    state.sort = e.target.value;
    render();
  });
  el('detail-close').addEventListener('click', () => el('detail').close());
}

// ------------------------------------------------------------------ render

function pickingBadge(result) {
  if (result.status === PICKING_STATUS.OK) {
    const badge = create('span', 'badge badge-picking', `피킹률 약 ${result.pct}%`);
    badge.title = `월 추정 혜택 ${formatKrw(result.estimatedKrw)} ÷ 전월실적 ${formatKrw(result.tierKrw)}`;
    return badge;
  }
  if (result.status === PICKING_STATUS.NO_SPEND_CONDITION) {
    return create('span', 'badge badge-muted', '실적 조건 없음');
  }
  return create('span', 'badge badge-muted', '피킹률 산출 불가');
}

function cardRow(card) {
  const picking = computePickingRate(card);
  const article = create('article', 'card');

  const header = create('header', 'card-head');
  const h2 = create('h2', null, card.name);
  header.append(h2);

  const tags = create('div', 'tags');
  tags.append(create('span', 'badge', state.issuers.get(card.issuer)?.name ?? card.issuer));
  tags.append(create('span', 'badge', `${CARD_TYPE_LABELS[card.card_type] ?? card.card_type}카드`));
  tags.append(
    create(
      'span',
      'badge',
      `연회비 ${Number.isFinite(card.annual_fee_krw) ? formatKrw(card.annual_fee_krw) : '미확인'}`,
    ),
  );
  const tier = minTier(card);
  tags.append(
    create(
      'span',
      'badge',
      card.no_prev_month_spend_condition
        ? '전월실적 조건 없음'
        : tier !== null
          ? `전월실적 ${formatKrw(tier)}부터`
          : '전월실적 미확인',
    ),
  );
  tags.append(pickingBadge(picking));
  tags.append(create('span', `badge conf-${card.confidence}`, `신뢰도 ${CONFIDENCE_LABELS[card.confidence]}`));
  header.append(tags);
  article.append(header);

  if (card.tagline) article.append(create('p', 'tagline', card.tagline));

  const list = create('ul', 'benefit-list');
  for (const b of card.benefits.slice(0, 4)) {
    const li = create('li');
    li.append(create('span', 'cat', CATEGORY_LABELS[b.category] ?? b.category));
    li.append(create('span', 'btitle', b.title));
    const numbers = [];
    if (Number.isFinite(b.rate_pct)) numbers.push(`최대 ${b.rate_pct}%`);
    if (Number.isFinite(b.monthly_cap_krw)) numbers.push(`월 한도 ${formatKrw(b.monthly_cap_krw)}`);
    else if (Number.isFinite(b.monthly_cap_points)) {
      numbers.push(`월 한도 ${b.monthly_cap_points.toLocaleString('ko-KR')}P`);
    }
    if (Number.isFinite(b.per_txn_eligible_spend_cap_krw)) numbers.push(`건당 ${formatKrw(b.per_txn_eligible_spend_cap_krw)}`);
    if (numbers.length) li.append(create('span', 'nums', numbers.join(' · ')));
    list.append(li);
  }
  if (card.benefits.length > 4) {
    list.append(create('li', 'more', `외 ${card.benefits.length - 4}건`));
  }
  article.append(list);

  const actions = create('div', 'actions');
  const detailBtn = create('button', 'link-btn', '자세히');
  detailBtn.addEventListener('click', () => openDetail(card));
  const official = create('a', 'link-btn', '공식 상품 페이지');
  official.href = card.product_url;
  official.rel = 'noopener noreferrer nofollow';
  official.target = '_blank';
  actions.append(detailBtn, official);
  article.append(actions);

  return article;
}

function openDetail(card) {
  const picking = computePickingRate(card);
  const body = el('detail-body');
  body.replaceChildren();

  const title = create('h2', null, card.name);
  title.id = 'detail-title';
  body.append(title);

  const dl = create('dl', 'detail-meta');
  const rows = [
    ['카드사', state.issuers.get(card.issuer)?.name ?? card.issuer],
    ['종류', `${CARD_TYPE_LABELS[card.card_type] ?? card.card_type}카드`],
    ['연회비', Number.isFinite(card.annual_fee_krw) ? formatKrw(card.annual_fee_krw) : '미확인'],
    ['연회비 원문', card.annual_fee_note ?? '-'],
    [
      '전월실적 구간',
      card.no_prev_month_spend_condition
        ? '조건 없음'
        : (card.prev_month_spend_tiers_krw ?? []).map(formatKrw).join(' / ') || '미확인',
    ],
    [
      '통합 월 한도',
      Number.isFinite(card.integrated_monthly_cap_krw)
        ? formatKrw(card.integrated_monthly_cap_krw)
        : '미확인',
    ],
    ['데이터 신뢰도', CONFIDENCE_LABELS[card.confidence]],
    ['검수 상태', card.review_status === 'human_reviewed' ? '사람이 검수' : '자동 추출 (미검수)'],
    ['기준일', card.updated_at],
    ['내부 ID', card.id],
  ];
  for (const [k, v] of rows) {
    dl.append(create('dt', null, k), create('dd', null, v));
  }
  body.append(dl);

  const pickingBox = create('div', 'notice notice-info');
  pickingBox.append(create('strong', null, '피킹률 추정'));
  const p = create('p');
  if (picking.status === PICKING_STATUS.OK) {
    p.textContent =
      `약 ${picking.pct}% = 월 추정 최대 혜택 ${formatKrw(picking.estimatedKrw)} ÷ ` +
      `전월실적 ${formatKrw(picking.tierKrw)}`;
  } else {
    p.textContent = '계산하지 않았습니다.';
  }
  pickingBox.append(p, create('p', 'caveat', pickingCaveat(picking)));
  body.append(pickingBox);

  body.append(create('h3', null, `혜택 ${card.benefits.length}건`));
  const table = create('table', 'benefit-table');
  const thead = create('thead');
  const hr = create('tr');
  for (const h of ['분야', '혜택', '최대 요율', '월 한도', '건당 대상금액 한도', '필요 전월실적']) {
    hr.append(create('th', null, h));
  }
  thead.append(hr);
  table.append(thead);
  const tbody = create('tbody');
  for (const b of card.benefits) {
    const tr = create('tr');
    tr.append(create('td', null, CATEGORY_LABELS[b.category] ?? b.category));
    const td = create('td');
    td.append(create('div', 'btitle', b.title));
    if (b.summary) td.append(create('div', 'bsummary', b.summary));
    tr.append(td);
    tr.append(create('td', 'num', Number.isFinite(b.rate_pct) ? `${b.rate_pct}%` : '미확인'));
    tr.append(
      create(
        'td',
        'num',
        Number.isFinite(b.monthly_cap_krw)
          ? formatKrw(b.monthly_cap_krw)
          : Number.isFinite(b.monthly_cap_points)
            ? `${b.monthly_cap_points.toLocaleString('ko-KR')}P`
            : '미확인',
      ),
    );
    tr.append(create('td', 'num', Number.isFinite(b.per_txn_eligible_spend_cap_krw) ? formatKrw(b.per_txn_eligible_spend_cap_krw) : '미확인'));
    tr.append(
      create(
        'td',
        'num',
        Number.isFinite(b.requires_prev_month_spend_krw)
          ? formatKrw(b.requires_prev_month_spend_krw)
          : '미확인',
      ),
    );
    tbody.append(tr);
  }
  table.append(tbody);
  body.append(table);

  const src = create('p', 'source-line');
  src.append(document.createTextNode('출처: '));
  const a = create('a', null, card.source.url);
  a.href = card.source.url;
  a.rel = 'noopener noreferrer nofollow';
  a.target = '_blank';
  src.append(a, document.createTextNode(` (수집일 ${card.source.retrieved_at})`));
  body.append(src);

  const warn = create('p', 'caveat');
  warn.textContent =
    '이 표의 "미확인"은 혜택이 없다는 뜻이 아니라 원본 피드에서 값을 확실히 읽어내지 못했다는 뜻입니다. ' +
    '정확한 조건은 공식 상품 페이지와 상품설명서를 확인하세요.';
  body.append(warn);

  el('detail').showModal();
}

function render() {
  const filtered = sortCards(state.cards.filter((c) => matches(c, state.filters)), state.sort);
  const host = el('results');
  host.replaceChildren();

  if (!filtered.length) {
    host.append(create('p', 'empty', '조건에 맞는 카드가 없습니다.'));
  } else {
    for (const card of filtered) host.append(cardRow(card));
  }

  const withPicking = filtered.filter((c) => computePickingRate(c).status === PICKING_STATUS.OK).length;
  text(
    el('summary'),
    `${filtered.length}장 표시 (전체 ${state.cards.length}장) · 피킹률 산출 가능 ${withPicking}장`,
  );
}

load().catch((err) => {
  el('results').append(create('p', 'empty', `데이터를 불러오지 못했습니다: ${err.message}`));
});
