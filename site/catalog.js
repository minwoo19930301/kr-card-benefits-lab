/** Historical records remain separate from current issuer-source records. */
export function normalizedProductName(card) {
  return card.name.normalize('NFKC').toLowerCase().replace(/^(?:kb국민|신한카드|삼성카드|현대카드|하나카드|우리카드|롯데카드)\s*/,'').replace(/[\s\p{P}\p{S}]/gu,'');
}
export function mergeCatalog(official, archive = []) {
  const key = c => `${c.issuer}:${c.card_type}:${normalizedProductName(c)}`;
  const groups = new Map();
  for (const c of official) { const k=key(c); if(!groups.has(k))groups.set(k,[]);groups.get(k).push(c); }
  const historicalCounts=new Map();for(const c of archive)historicalCounts.set(key(c),(historicalCounts.get(key(c))||0)+1);
  const matched=[], unmatched=[];
  const cards=official.map(c=>({...c,catalog_origin:'official'}));
  for(const old of archive){
    const candidates=groups.get(key(old))||[];
    // Ambiguous same-name variants stay visible as historical records.
    if(candidates.length===1&&historicalCounts.get(key(old))===1){matched.push({archive_id:old.id,official_id:candidates[0].id});}
    else unmatched.push({...old,catalog_origin:'archive'});
  }
  return {cards:[...cards,...unmatched],matched,archive_total:archive.length,archive_unmatched:unmatched.length,official_total:official.length};
}
