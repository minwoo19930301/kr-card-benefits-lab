## 무엇을 바꿨는지

<!-- 카드 추가 / 값 수정 / 코드 변경 중 무엇인지 -->

## 카드를 추가·수정하는 PR 이면 아래를 채워주세요

**카드사 공식 상품 페이지 URL** (필수)

<!--
반드시 카드사 본인 도메인이어야 합니다.
검색 결과 링크, 카드 비교 사이트 링크, 블로그 링크는 출처로 인정하지 않습니다.
-->

- 카드명:
- 공식 URL:
- 확인한 날짜:

체크리스트

- [ ] 공식 페이지에 **실제로 적혀 있는 값만** 넣었다 (추측·기억으로 채운 값 없음)
- [ ] 확실하지 않은 필드는 **비워 두었다** (0 이나 추정치로 채우지 않았다)
- [ ] `source.kind` 가 `issuer_official_page` 또는 `issuer_machine_readable_feed` 다
- [ ] 사람이 눈으로 확인했으면 `review_status` 를 `human_reviewed` 로 두었다
- [ ] `data/issuers.json` 의 `allowed_domains` 에 해당 도메인이 있다
- [ ] 제3자 카드 비교 서비스·가계부 앱에서 가져온 값이 아니다
- [ ] 카드 이미지를 재호스팅하지 않았다
- [ ] `npm run validate && npm test` 통과

## 확인

- [ ] `npm test` 통과
- [ ] `npm run validate` 통과
- [ ] `node scripts/check-forbidden.mjs` 통과
