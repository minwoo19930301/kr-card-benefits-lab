#!/usr/bin/env node
import { createHash } from 'node:crypto';
const [inputUrl, expectedCommit] = process.argv.slice(2);
if (!inputUrl || !/^[a-f0-9]{40}$/.test(expectedCommit ?? '')) throw new Error('Usage: node scripts/verify-live.mjs https://site/ <commit SHA>');
const base = new URL(inputUrl.endsWith('/') ? inputUrl : `${inputUrl}/`);
async function get(file) {
  const url = new URL(file, base);
  url.searchParams.set('release', expectedCommit);
  const response = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'Cache-Control': 'no-cache' } });
  if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
  return response.text();
}
let lastError;
for (let attempt = 0; attempt < 6; attempt++) {
  try {
    const [releaseText, cardsText, html, js, css, eventsText, reportText] = await Promise.all(['release.json', 'cards.json', '', 'app.js', 'styles.css', 'card-events.json', 'collection-report.json'].map(get));
    const release = JSON.parse(releaseText), cards = JSON.parse(cardsText);
    if (release.commit !== expectedCommit) throw new Error('Live release has a different commit');
    if (release.card_count !== cards.cards.length || !cards.cards.length) throw new Error('Live card count mismatch');
    if (release.cards_sha256 !== createHash('sha256').update(cardsText).digest('hex')) throw new Error('Live corpus hash mismatch');
    if (!html.includes('app.js') || !js.includes('cards.json') || css.length < 100) throw new Error('Missing site assets');
    if (!Array.isArray(JSON.parse(eventsText).events) || !Array.isArray(JSON.parse(reportText).issuer_reports)) throw new Error('Missing event/coverage data');
    console.log(JSON.stringify({ url: base.href, commit: release.commit, cards: cards.cards.length, verified: true }));
    process.exit(0);
  } catch (error) {
    lastError = error;
    if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 10000));
  }
}
throw lastError;
