#!/usr/bin/env node
/**
 * 저장소 전체에서 금지 출처 흔적을 찾는다.
 *
 * 이 프로젝트는 제3자 카드 비교 서비스의 비공개 API 를 사용하지 않는다.
 * 코드·데이터·문서·워크플로 어디에도 해당 호출 흔적이 남지 않아야 한다.
 *
 * docs/ 는 "쓰지 않는 이유"를 설명해야 하므로 정책 문서에서의 언급은 허용한다.
 * 그 외 경로에서 발견되면 실패한다.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PATTERNS = [
  { name: 'cardgorilla', re: /card[-_]?gorilla/i },
  { name: 'cardgorilla(붙여쓰기)', re: /cardgorilla/i },
  { name: 'banksalad 비공개 API', re: /api\.banksalad/i },
  { name: '비공개 API 포트/버전 경로', re: /:8080\/v1/ },
  { name: '외부 이미지 CDN 호스트', re: /d1c5n4ri2guedi/i },
];

/** 정책상 언급이 필요한 경로. 여기서는 문자열 등장을 허용한다. */
const DOC_ALLOWLIST = [
  'docs/legal-notes.md',
  'docs/sources.md',
  'scripts/validate.mjs',
  'scripts/check-forbidden.mjs',
  'tests/validate.test.mjs',
];

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.github/cache']);

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || SKIP_DIRS.has(rel)) continue;
      yield* walk(full);
    } else {
      yield rel;
    }
  }
}

async function main() {
  const hits = [];
  let scanned = 0;

  for await (const rel of walk(ROOT)) {
    const info = await stat(path.join(ROOT, rel));
    if (info.size > 20 * 1024 * 1024) continue;
    let content;
    try {
      content = await readFile(path.join(ROOT, rel), 'utf8');
    } catch {
      continue; // 바이너리
    }
    scanned += 1;
    const exempt = DOC_ALLOWLIST.includes(rel);
    for (const { name, re } of PATTERNS) {
      const lines = content.split('\n');
      for (const [i, line] of lines.entries()) {
        if (!re.test(line)) continue;
        if (exempt) continue;
        hits.push(`${rel}:${i + 1}  [${name}]  ${line.trim().slice(0, 100)}`);
      }
    }
  }

  console.log(`검사한 텍스트 파일: ${scanned}개`);
  console.log(`검사 패턴: ${PATTERNS.map((p) => p.name).join(', ')}`);
  console.log(`정책 문서 예외: ${DOC_ALLOWLIST.join(', ')}`);

  if (hits.length) {
    console.error(`\n금지 출처 흔적 ${hits.length}건 발견`);
    for (const h of hits) console.error(`  · ${h}`);
    process.exit(1);
  }
  console.log('\n금지 출처 흔적 0건');
}

main().catch((err) => {
  console.error(`실패: ${err.message}`);
  process.exit(1);
});
