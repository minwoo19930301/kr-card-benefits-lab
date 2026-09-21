import test from 'node:test';import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';import{createHash}from'node:crypto';
import{mergeCatalog}from'../site/catalog.js';import{matches,emptyFilters}from'../site/filters.js';import{computePickingRate,PICKING_STATUS}from'../site/picking.js';
const card=(id,name='테스트')=>({id,name,issuer:'samsung',card_type:'credit',benefits:[]});
test('catalog matches only unique same-issuer/type/name records and retains original IDs',()=>{
 const official=[card('new')], old=[card('archive-1'),card('archive-2','다른 카드')];const r=mergeCatalog(official,old);assert.equal(r.cards.length,2);assert.deepEqual(r.matched,[{archive_id:'archive-1',official_id:'new'}]);assert.equal(old[0].catalog_origin,undefined);
 const ambiguous=mergeCatalog(official,[card('a'),card('b')]);assert.equal(ambiguous.matched.length,0);assert.equal(ambiguous.cards.length,3);
 const type=mergeCatalog(official,[{...card('a'),card_type:'check'}]);assert.equal(type.cards.length,2);
});
test('all 1563 historical identities and image bytes survive restoration without current numeric claims',async()=>{
 const doc=JSON.parse(await readFile(new URL('../data/archive-catalog.json',import.meta.url)));assert.equal(doc.cards.length,1563);assert.equal(new Set(doc.cards.map(c=>c.id)).size,1563);assert.equal(Object.keys(doc.images).length,1563);
 for(const c of doc.cards){assert.equal(c.source.kind,'legacy_snapshot');assert.equal(c.source.retrieved_at,null);assert.equal(c.annual_fee_krw,undefined);assert.equal(c.prev_month_spend_tiers_krw,undefined);assert.notEqual(computePickingRate(c).status,PICKING_STATUS.OK);assert.equal(matches(c,{...emptyFilters(),maxFee:'0'}),false);const d=JSON.parse(await readFile(new URL('../site/'+c.archive.detail_src,import.meta.url)));assert.equal(d.id,c.id);assert.equal(d.benefits.length,c.archive.benefit_count);const img=doc.images[c.id];assert.match(img.src,/^images\/archive\/[a-f0-9]{20}\.(png|jpg|gif|webp)$/);const bytes=await readFile(new URL('../site/'+img.src,import.meta.url));assert.equal(createHash('sha256').update(bytes).digest('hex'),img.sha256);}
});
