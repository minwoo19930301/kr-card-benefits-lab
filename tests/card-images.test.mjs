import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=new URL('../',import.meta.url);
test('card artwork is local, complete in the manifest, and backed by official source hashes',async()=>{
 const cards=JSON.parse(await readFile(new URL('data/cards.json',root))).cards;
 const manifest=JSON.parse(await readFile(new URL('data/card-images.json',root)));
 const domains={woori:'wooricard.com',hyundai:'hyundaicard.com',shinhan:'shinhancard.com',kb:'kbcard.com',hana:'hanacard.co.kr',lotte:'lottecard.co.kr',nh:'nonghyup.com',bc:'bccard.com',samsung:'samsungcard.com'};
 assert.equal(Object.keys(manifest.images).length+Object.keys(manifest.missing).length,cards.length);
 for(const card of cards){
  const image=manifest.images[card.id];if(!image){assert.ok(manifest.missing[card.id]);continue;}
  assert.match(image.src,/^images\/cards\/[a-f0-9]{20}\.(png|jpg|gif|webp)$/);
  for(const value of [image.image_url,image.source_url]){const u=new URL(value);assert.equal(u.protocol,'https:');assert.ok(u.hostname===domains[card.issuer]||u.hostname.endsWith('.'+domains[card.issuer]));}
  const bytes=await readFile(new URL('site/'+image.src,root));
  assert.equal(bytes.length,image.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),image.sha256);
 }
});
