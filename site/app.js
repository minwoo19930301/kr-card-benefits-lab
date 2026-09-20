import { computePickingRate, pickingCaveat, formatKrw, PICKING_STATUS } from './picking.js';
import { emptyFilters, matches, sortCards, minTier } from './filters.js';
import { freshness, taxLabel, reviewLabel, coverageRows, eventPeriod, koreanToday } from './evidence.js';

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
  collectionReport: null,
  eventsDoc: null,
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

async function fetchDocument(url, optional = false) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} (HTTP ${response.status})`);
    return await response.json();
  } catch (error) {
    if (optional) return null;
    throw error;
  }
}

async function load() {
  const [cardsDoc, issuersDoc] = await Promise.all([
    fetchDocument('cards.json'),
    fetchDocument('issuers.json'),
  ]);
  state.cards = cardsDoc.cards;
  state.generatedAt = cardsDoc.generated_at;
  for (const i of issuersDoc.issuers) state.issuers.set(i.key, i);

  buildIssuerSelect();
  buildCategoryChips();
  bindControls();
  render();

  renderOverview();
  text(el('meta-line'), `데이터 파일 생성일 ${state.generatedAt} · 각 카드의 확인일은 실제 원문 수집일 기준입니다.`);
  [state.collectionReport, state.eventsDoc] = await Promise.all([
    fetchDocument('collection-report.json', true), fetchDocument('card-events.json', true),
  ]);
  renderOverview();
  renderEvents();
}

function eventCard(event, status) {
  const article = create('article', 'event-card');
  const labels = { active: '기간상 진행 중', upcoming: '시작 예정', expired: '종료된 행사', unknown: '기간 미확인' };
  const header = create('div', 'tags');
  header.append(create('span', 'badge', state.issuers.get(event.issuer)?.name || event.issuer),
    create('span', `badge ${status === 'active' ? 'status-fresh' : 'badge-muted'}`, labels[status]));
  const title = create('h3');
  const link = create('a', null, event.title);
  link.href = event.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer nofollow';
  title.append(link);
  article.append(header, title, create('p', 'caveat', `행사 ${event.starts_at || '미확인'} ~ ${event.ends_at || '미확인'} · 원문 확인 ${event.checked_at || '미확인'}`));
  if (event.summary) article.append(create('p', null, event.summary));
  if (event.conditions?.length) {
    const conditions = create('ul');
    for (const condition of event.conditions) conditions.append(create('li', null, condition));
    article.append(conditions);
  }
  return article;
}

function renderEvents() {
  const current = el('current-events');
  current.replaceChildren();
  const events = state.eventsDoc?.events;
  if (!Array.isArray(events)) {
    current.append(create('p', 'caveat', '행사 자료를 불러오지 못했습니다. 현재 혜택이 없다는 뜻은 아닙니다.'));
    return;
  }
  const today = koreanToday();
  const active = events.filter((event) => eventPeriod(event, today) === 'active');
  const others = events.filter((event) => eventPeriod(event, today) !== 'active');
  if (!active.length) {
    current.append(create('p', 'event-empty', `${today} 기준, 저장된 자료에 기간상 진행 중인 행사가 없습니다.`));
  } else {
    current.append(create('p', 'caveat', `${today} 기준, 저장된 행사 기간과 대조한 결과입니다. 변경·조기 종료 여부는 공식 원문에서 다시 확인하세요.`));
    for (const event of active) current.append(eventCard(event, 'active'));
  }
  el('event-history').hidden = !others.length;
  text(el('event-history-label'), `종료·예정·기간 미확인 행사 ${others.length}건`);
  const history = el('other-events');
  history.replaceChildren();
  for (const event of others) history.append(eventCard(event, eventPeriod(event, today)));
}

function renderOverview() {
  const cards = state.cards;
  const collected = new Set(cards.map((c) => c.issuer));
  const recent = cards.filter((c) => freshness(c).key === 'fresh').length;
  const stale = cards.filter((c) => freshness(c).key === 'stale').length;
  const stats = el('data-stats');
  stats.replaceChildren();
  for (const [label, value] of [['저장 카드', `${cards.length}장`], ['수록 카드사', `${collected.size}곳`], ['30일 이내 확인', `${recent}장`], ['재확인 필요', `${stale}장`]]) {
    const item = create('div', 'stat');
    item.append(create('span', 'stat-label', label), create('strong', null, value));
    stats.append(item);
  }
  const rows = coverageRows(cards, [...state.issuers.values()], state.collectionReport);
  text(el('coverage-summary'), `수록 ${collected.size} / 조사 대상 ${rows.length}곳`);
  const missingDate = cards.length - recent - stale;
  const report = state.collectionReport;
  const transportName = report?.transport === 'brightdata_web_unlocker' ? 'Bright Data' : report?.transport === 'direct_official_http' ? '공식 사이트 직접 수집' : '수집 방식 미기재';
  text(el('collection-note'), (report
    ? `실행 기록 ${report.generated_at || '일자 미기재'} · ${transportName}. ${report.transport_note || ''} 저장 카드 수는 이번 실행의 성공 건수와 다릅니다.`
    : '실행 보고서가 없어 이번 수집의 성공·실패 여부를 확인할 수 없습니다. 저장된 카드와 기존 미수집 사유만 표시합니다.')
    + (missingDate ? ` 확인일 미확인 ${missingDate}장.` : ''));
  const body = el('coverage-body');
  body.replaceChildren();
  for (const row of rows) {
    const tr = create('tr');
    const label = create('th', null, row.name);
    label.scope = 'row';
    const result = row.run
      ? [['시도', row.run.attempted], ['성공', row.run.succeeded], ['실패', row.run.failed], ['갱신', row.run.updated_cards], ['이전 유지', row.run.retained_cards]]
        .filter(([, value]) => Number.isFinite(value)).map(([key, value]) => `${key} ${value}`).join(' · ') || '건수 미기재'
      : '미확인';
    tr.append(label, create('td', null, `${row.count}장`), create('td', null, row.label), create('td', null, result),
      create('td', 'coverage-note', [row.run?.checked_at, row.note].filter(Boolean).join(' · ') || '—'));
    body.append(tr);
  }
}

function buildIssuerSelect() {
  const select = el('issuer');
  const all = create('option', null, '전체');
  all.value = '';
  select.append(all);
  const keys = [...new Set([...state.issuers.keys(), ...state.cards.map((c) => c.issuer)])];
  for (const key of keys) {
    const count = state.cards.filter((card) => card.issuer === key).length;
    const option = create('option', null, `${state.issuers.get(key)?.name ?? key} (${count}장)`);
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
  for (const key of ['issuer', 'cardType', 'maxFee', 'maxSpend', 'taxSpend', 'taxRewards', 'freshness', 'reviewStatus']) {
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
  el('reset-filters').addEventListener('click', () => {
    state.filters = emptyFilters();
    state.sort = 'name';
    for (const control of document.querySelectorAll('.controls input, .controls select')) {
      if (control.type === 'checkbox') control.checked = false;
      else control.value = control.id === 'sort' ? 'name' : '';
    }
    render();
  });
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

function sourceLink(card, label = '수집에 사용한 공식 원문') {
  const a = create('a', null, label);
  a.href = card.source.url;
  a.rel = 'noopener noreferrer nofollow';
  a.target = '_blank';
  return a;
}

function taxSummary(card) {
  const box = create('div', 'tax-summary');
  for (const [field, label] of [['counts_as_spend', '세금 전월실적'], ['earns_rewards', '세금 적립·할인']]) {
    const item = create('div');
    item.append(create('span', 'tax-label', label), create('strong', null, taxLabel(card, field)));
    box.append(item);
  }
  return box;
}

function cardRow(card) {
  const picking = computePickingRate(card);
  const article = create('article', 'card');
  article.dataset.cardId = card.id;
  const checked = freshness(card);

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
      `연회비 ${Number.isFinite(card.annual_fee_krw) ? `${card.annual_fee_krw > 0 ? '최저 ' : ''}${formatKrw(card.annual_fee_krw)}` : '미확인'}`,
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
  tags.append(create('span', `badge status-${checked.key}`, checked.label));
  header.append(tags);
  article.append(header);

  const evidence = create('p', 'evidence-line');
  evidence.append(sourceLink(card, card.source.kind === 'issuer_machine_readable_feed' ? '공식 공개 피드' : '공식 상품 원문'),
    document.createTextNode(` · 확인 ${checked.date || '미확인'} · ${reviewLabel(card)}`));
  article.append(evidence);

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
  if (card.confidence === 'low') article.append(create('p', 'caveat', '소개 혜택만 수집한 자료입니다. 적용 가맹점·횟수·실적·제외 조건은 상세와 원문을 확인하세요.'));
  article.append(taxSummary(card));

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
    ['확인된 최저 연회비', Number.isFinite(card.annual_fee_krw) ? formatKrw(card.annual_fee_krw) : '미확인'],
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
    ['추출 충실도', `${CONFIDENCE_LABELS[card.confidence] || '미확인'} — 필드 추출 정도이며 혜택 보증이 아닙니다`],
    ['원문 검수', reviewLabel(card)],
    ['원문 확인일', `${card.source.retrieved_at || '미확인'} · ${freshness(card).label}`],
    ['레코드 갱신일', card.updated_at],
  ];
  for (const [k, v] of rows) {
    dl.append(create('dt', null, k), create('dd', null, v));
  }
  body.append(dl);

  body.append(create('h3', null, '세금 납부 조건'));
  body.append(taxSummary(card));
  body.append(create('p', 'caveat', card.tax?.note || '국세·지방세 적용 범위와 예외를 확인할 원문 근거가 아직 정리되지 않았습니다. 미확인은 포함 또는 제외를 뜻하지 않습니다.'));
  body.append(create('p', 'caveat', '전월실적에 포함되더라도 포인트 적립·할인 대상에서는 제외될 수 있습니다. 납부 할부 행사는 상품의 상시 혜택과 별도로 확인하세요.'));

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
    for (const note of b.notes ?? []) td.append(create('div', 'caveat', note));
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
  const scroll = create('div', 'table-scroll');
  scroll.tabIndex = 0;
  scroll.setAttribute('role', 'region');
  scroll.setAttribute('aria-label', '혜택 상세 표, 가로로 스크롤할 수 있습니다');
  scroll.append(table);
  body.append(scroll);

  const src = create('p', 'source-line');
  src.append(document.createTextNode('출처: '));
  const a = sourceLink(card, card.source.url);
  src.append(a, document.createTextNode(` (수집일 ${card.source.retrieved_at})`));
  body.append(src);
  if (card.source.note) body.append(create('p', 'caveat', card.source.note));

  const warn = create('p', 'caveat');
  warn.textContent =
    '이 표의 "미확인"은 혜택이 없다는 뜻이 아니라 공식 자료에서 값을 확실히 읽어내지 못했다는 뜻입니다. ' +
    '정확한 조건은 공식 상품 페이지와 상품설명서를 확인하세요.';
  body.append(warn);

  el('detail').showModal();
}

function render() {
  const filtered = sortCards(state.cards.filter((c) => matches(c, state.filters)), state.sort);
  const host = el('results');
  host.replaceChildren();

  if (!filtered.length) {
    host.append(create('p', 'empty', '저장된 자료에서 조건이 확인된 카드가 없습니다. 미확인 값이나 미수집 카드사가 있을 수 있습니다. 필터를 넓혀 다시 살펴보세요.'));
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
