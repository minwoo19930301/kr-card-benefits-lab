# 데이터 스키마

기계 판독용 정본은 [`data/cards.schema.json`](../data/cards.schema.json) 이다. 이 문서는 그 의도를 설명한다.

## 문서 구조

```json
{
  "schema_version": 1,
  "generated_at": "2026-07-31",
  "cards": [ /* 카드 객체 */ ]
}
```

## 카드 객체

| 필드 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `id` | string | O | 내부 식별자. `{issuer}-{slug}` 규칙. slug 는 카드명을 라틴 문자로 음차해서 만든다. |
| `issuer` | string | O | `data/issuers.json` 의 `key`. |
| `name` | string | O | 카드사가 표기한 상품명. |
| `tagline` | string | | 카드사 상품 소개 한 줄. |
| `product_url` | string | O | 카드사 공식 상품 페이지 (사람이 볼 주소). |
| `card_type` | `credit` \| `check` | O | 알 수 없으면 카드를 수록하지 않는다. |
| `annual_fee_krw` | integer | | 국내 기준 **최저** 연회비. 불명확하면 생략. |
| `annual_fee_note` | string | | 브랜드별 연회비 원문 표기. |
| `prev_month_spend_tiers_krw` | integer[] | | 전월 이용실적 구간. |
| `no_prev_month_spend_condition` | boolean | | 실적 조건이 **없다고 확인된** 경우에만 `true`. |
| `integrated_monthly_cap_krw` | integer | | 카드 전체 **통합** 월 한도(최저 실적 구간 기준). 개별 혜택 한도의 합이 아니다. |
| `benefits` | object[] | O | 최소 1건. 비어 있으면 카드를 수록하지 않는다. |
| `tax` | object | | 세금·공과금 취급. 확실할 때만 채운다. |
| `confidence` | `low` \| `medium` \| `high` | O | 온전히 파싱된 필드 수로 결정. |
| `review_status` | `machine_extracted` \| `human_reviewed` | O | 사람이 눈으로 확인했는지. |
| `updated_at` | string (YYYY-MM-DD) | O | 데이터 기준일. |
| `source` | object | O | 출처. |

### `benefits[]`

| 필드 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `category` | enum | O | `shopping` `food` `transit` `fuel` `telecom` `utility` `tax` `overseas` `travel` `ott` `education` `medical` `mileage` `point` `other` |
| `title` | string | O | 혜택 이름. |
| `summary` | string | | 보조 설명. |
| `rate_pct` | number | | 표기된 **최대** 요율. 범위 표기(`3%~10%`)면 상한을 취한다. |
| `monthly_cap_krw` | integer | | 월 할인/적립 한도. |
| `per_txn_eligible_spend_cap_krw` | integer | | 결제 1건당 할인·적립 **대상으로 인정되는 이용금액**의 상한. 할인 금액 상한이 아니므로 `monthly_cap_krw` 보다 클 수 있다. |
| `requires_prev_month_spend_krw` | integer | | 이 혜택에 필요한 전월실적. |
| `counts_toward_prev_month_spend` | boolean | | 이 이용액이 실적에 포함되는지. |
| `notes` | string[] | | 예외·제외 조건. 원문이 손상된 경우 넣지 않는다. |

### `source`

| 필드 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `kind` | `issuer_machine_readable_feed` \| `issuer_official_page` | O | 허용되는 출처 종류가 이 둘뿐이다. |
| `url` | string | O | 실제로 값을 읽은 주소. |
| `retrieved_at` | string | O | 읽은 날짜. |
| `note` | string | | 보충 메모. |

## 설계 규칙

**빈 값은 "없음"이 아니라 "미확인"이다.**
원본에서 값을 온전히 읽지 못하면 필드를 생략한다. 0 이나 추정치로 채우지 않는다.
UI 도 "미확인"으로 표시한다.

**`prev_month_spend_tiers_krw` 가 비었다 ≠ 실적 조건이 없다.**
조건이 없다고 확인된 경우에만 `no_prev_month_spend_condition: true` 를 쓴다.
2026년 들어 전월실적 조건을 없앤 신상품이 늘고 있어 이 둘을 구분할 필요가 있다.
검증기는 두 필드가 동시에 채워지면 실패한다.

**통합 한도와 개별 한도를 구분한다.**
카드사 표에는 혜택별 한도와 카드 전체 통합 한도가 섞여 있다. 통합 한도를 혜택별 한도로
복제하면 피킹률 분자가 부풀려진다. 그래서 통합 한도는 카드 레벨
`integrated_monthly_cap_krw` 에 두고, 피킹률 계산에서 개별 한도 합보다 **우선**한다.

**피킹률은 저장하지 않는다.**
계산식이 바뀌면 데이터를 다시 만들어야 하므로, 뷰 레이어에서 계산한다
([`site/picking.js`](../site/picking.js)).

**`id` 는 우리 규칙으로만 만든다.**
외부 서비스의 숫자 ID, `idx`, `corp`, `key_benefit` 같은 타사 스키마 필드명을 쓰지 않는다.
스키마는 `additionalProperties: false` 이므로 그런 필드가 들어오면 검증에서 걸린다.

카드명을 라틴 문자로 환원할 수 없으면 공식 URL 기반 결정적 해시(`card-xxxxxxx`)로 대체한다.
같은 카드는 항상 같은 id 가 된다.

## 검증

```bash
npm run validate            # 스키마 + 출처 정책
npm run validate -- --check-urls   # 공식 URL 도달성까지 (네트워크 사용)
npm test
```

검사 항목: 스키마(타입·필수·enum·패턴·범위·미정의 필드), `id` 규칙과 중복,
`issuer` 등록 여부, `product_url`/`source.url` 도메인 화이트리스트,
금지 출처 문자열, 실적 조건 모순, 빈 혜택 목록.
