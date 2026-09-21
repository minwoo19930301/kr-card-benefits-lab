#!/usr/bin/env node
/**
 * site/ 와 data/ 를 dist/ 로 모아 GitHub Pages 로 그대로 배포 가능한 정적 산출물을 만든다.
 * 번들러를 쓰지 않는다. 브라우저가 ES 모듈을 그대로 읽는다.
 */

import { readFile, writeFile, mkdir, rm, readdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

async function copyDir(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) await copyDir(src, dst);
    else await copyFile(src, dst);
  }
}

async function main() {
  await rm(DIST, { recursive: true, force: true });
  await copyDir(path.join(ROOT, 'site'), DIST);

  // 데이터는 사이트 루트에 평평하게 둔다 (app.js 가 ./cards.json 을 읽는다).
  for (const name of ['cards.json', 'issuers.json']) {
    await copyFile(path.join(ROOT, 'data', name), path.join(DIST, name));
  }
  for (const name of ['collection-report.json', 'collection-evidence.json', 'card-events.json', 'card-images.json']) {
    try { await copyFile(path.join(ROOT, 'data', name), path.join(DIST, name)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  // Jekyll 이 _ 로 시작하는 경로를 건드리지 않도록 한다.
  await writeFile(path.join(DIST, '.nojekyll'), '', 'utf8');

  const cards = JSON.parse(await readFile(path.join(DIST, 'cards.json'), 'utf8'));
  const sha = process.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  await writeFile(path.join(DIST, 'release.json'), `${JSON.stringify({
    commit: sha, built_at: new Date().toISOString(), card_count: cards.cards.length,
    cards_sha256: createHash('sha256').update(await readFile(path.join(DIST, 'cards.json'))).digest('hex'),
  }, null, 2)}\n`);
  const bytes = Buffer.byteLength(JSON.stringify(cards));
  console.log(
    `dist/ 생성 완료 — 카드 ${cards.cards.length}장, cards.json ${(bytes / 1024).toFixed(0)} KB`,
  );
}

main().catch((err) => {
  console.error(`빌드 실패: ${err.message}`);
  process.exit(1);
});
