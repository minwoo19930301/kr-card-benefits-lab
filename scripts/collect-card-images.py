#!/usr/bin/env python3
"""Restore product artwork from cached official pages and public issuer responses."""
import concurrent.futures, datetime, hashlib, json, pathlib, re, urllib.parse, urllib.request
from html.parser import HTMLParser
from html import unescape
ROOT=pathlib.Path(__file__).resolve().parent.parent
CACHE=ROOT.parent/'bd-card-cache'
OUT=ROOT/'site/images/cards'
OUT.mkdir(parents=True,exist_ok=True)
CARDS=json.loads((ROOT/'data/cards.json').read_text())['cards']
DOMAINS={'woori':'wooricard.com','hyundai':'hyundaicard.com','shinhan':'shinhancard.com','kb':'kbcard.com','hana':'hanacard.co.kr','lotte':'lottecard.co.kr','nh':'nonghyup.com','bc':'bccard.com','samsung':'samsungcard.com'}
def canon(u):
 p=urllib.parse.urlsplit(u);return urllib.parse.urlunsplit((p.scheme,p.netloc,p.path,urllib.parse.urlencode(sorted(urllib.parse.parse_qsl(p.query))),''))
def get(u,body=None,headers=None):
 req=urllib.request.Request(u,data=body,headers=headers or {'User-Agent':'OfficialCardResearch/1.0'})
 with urllib.request.urlopen(req,timeout=25) as r:return r.read(),r.headers.get('Content-Type',''),r.url
class Images(HTMLParser):
 def __init__(self):super().__init__();self.tags=[]
 def handle_starttag(self,t,a):
  if t in ('img','meta'):self.tags.append((t,dict(a)))
index={}
api_images={}
for f in CACHE.glob('*.json'):
 try:
  d=json.loads(f.read_text());u=d.get('sourceUrl',d.get('url'))
  if f.name.startswith('shinhan-fee-'):
   product=json.loads(d['body'])['payload']['cardProduct']; pu=urllib.parse.urljoin('https://www.shinhancard.com',product['cardProductUrl'])
   if product.get('mainImgUrl'):api_images[canon(pu)]=(urllib.parse.urljoin(pu,product['mainImgUrl']),pu,d['retrievedAt'])
  if not u:continue
  h=d.get('html')
  if h is None and f.with_suffix('.html').exists():h=f.with_suffix('.html').read_text()
  if h:index.setdefault(canon(u),[]).append((h,d.get('retrievedAt')))
 except (ValueError,OSError):pass
def candidates(c):
 issuer=c['issuer'];page=c['product_url'];results=[]
 if issuer=='woori':
  code=urllib.parse.parse_qs(urllib.parse.urlsplit(page).query)['cdPrdCd'][0]
  f=CACHE/f'woori-public-{code}.json'
  if f.exists():d=json.loads(f.read_text());v=d['resultVo']['crd01DtlVo'];date=d['retrievedAt']
  else:
   raw,_,_=get('https://pc.wooricard.com/dcpc/yh1/crd/crd01/searchCrdDtl.pwkjson',json.dumps({'crd01DtlVo':{'cdPrdCd':code}}).encode(),{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8','Proworks-Body':'Y','Proworks-Lang':'ko'})
   d=json.loads(raw);v=d['resultVo']['crd01DtlVo'];date=datetime.datetime.now(datetime.timezone.utc).isoformat()
  norm=lambda x:re.sub(r'\s','',unescape(x)).casefold()
  if str(v['cdPrdCd'])!=code or norm(v['cdPrdNm'])!=norm(c['name']):raise ValueError('product_identity_mismatch')
  if v.get('fileCoursWeb'):results.append((urllib.parse.urljoin(page,v['fileCoursWeb']),page,date))
  return results
 if issuer=='shinhan' and canon(page) in api_images:results.append(api_images[canon(page)])
 pages=index.get(canon(page),[])+index.get(canon(c['source']['url']),[])
 if issuer=='hyundai':
  code=urllib.parse.parse_qs(urllib.parse.urlsplit(page).query)['cardWcd'][0]
  # Follow only fragments explicitly linked from this product's own shell.
  for h,date in list(pages):
   for ref in re.findall(r'\$\([\"\']#cms_area[\"\']\)\.load\([\"\']([^\"\']+)',h):pages+=index.get(canon(urllib.parse.urljoin(page,ref)),[])
 for h,date in pages:
  p=Images();p.feed(h)
  if issuer=='bc':
   for ref in re.findall(r'cardImageUrl\s*=\s*[\"\']([^\"\']+)',h):results.append((urllib.parse.urljoin(page,ref),page,date))
  for tag,a in p.tags:
   src=a.get('src') or a.get('data-src') or a.get('data-original-src') or (a.get('content') if a.get('property')=='og:image' else None)
   if not src or '{{' in src or "'+" in src:continue
   tests={'hyundai':lambda: ('/images/cardscommon/' in src or '/img/com/card' in src or '/gpcc/pc/images/img_card_' in src or '/detail/bg_top_card_' in src) and not re.search(r'(?:_back|_b)\.',src), 'shinhan':lambda:'/card/plate/' in src and not re.search(r'_b_',src),'kb':lambda:'/upload/img/product/' in src,'hana':lambda:'/cardinfo/card_img/' in src,'lotte':lambda:('/ecenterPath/cdInfo/' in src or a.get('alt','').replace(' ','').casefold()==c['name'].replace(' ','').casefold()),'nh':lambda:'/shopmall/pro_img/card/' in src,'bc':lambda:'/card/renew/list/card_' in src and 'default' not in src,'samsung':lambda:('/scard/image/personal/' in src and urllib.parse.parse_qs(urllib.parse.urlsplit(page).query).get('code',['!'])[0] in src)}
   if tests[issuer]():results.append((urllib.parse.urljoin(page,src.strip()),page,date))
 # Deduplicate while keeping official document order.
 return list(dict.fromkeys(results))
def collect(c):
 try:
  existing=ROOT/'data/card-images.json'
  old=json.loads(existing.read_text()).get('images',{}).get(c['id']) if existing.exists() else None
  if old and (ROOT/'site'/old['src']).is_file() and hashlib.sha256((ROOT/'site'/old['src']).read_bytes()).hexdigest()==old['sha256']:return c['id'],old,None
  urls=candidates(c)
  for url,page,date in urls:
   host=urllib.parse.urlsplit(url).hostname or '';base=DOMAINS[c['issuer']]
   if not (host==base or host.endswith('.'+base)) or urllib.parse.urlsplit(url).scheme!='https':continue
   try:
    data,mime,final=get(url);end=urllib.parse.urlsplit(final).hostname or ''
    if not(end==base or end.endswith('.'+base)):continue
    ext='png' if data.startswith(b'\x89PNG\r\n\x1a\n') else 'jpg' if data.startswith(b'\xff\xd8\xff') else 'gif' if data.startswith((b'GIF87a',b'GIF89a')) else 'webp' if data[:4]==b'RIFF' and data[8:12]==b'WEBP' else None
    if not ext or len(data)<300 or len(data)>10000000:continue
    sha=hashlib.sha256(data).hexdigest();name=f'{sha[:20]}.{ext}';(OUT/name).write_bytes(data)
    return c['id'],{'src':f'images/cards/{name}','image_url':url,'source_url':page,'source_retrieved_at':date,'retrieved_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sha256':sha,'bytes':len(data)},None
   except Exception:continue
  return c['id'],None,'no_verified_product_image'
 except Exception as e:return c['id'],None,type(e).__name__
if __name__=='__main__':
 images={};missing={}
 with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
  for ident,img,error in pool.map(collect,CARDS):
   if img:images[ident]=img
   else:missing[ident]=error
 manifest={'generated_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'images':images,'missing':missing}
 (ROOT/'data/card-images.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
 print(json.dumps({'images':len(images),'missing':missing},ensure_ascii=False))
