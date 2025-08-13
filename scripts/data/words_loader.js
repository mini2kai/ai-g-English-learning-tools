// Load words from CSV file placed at /data/words.csv
// CSV header: id,en,cn,pinyin,img,sent,sent_cn

let csvHeader = [];

export async function loadWords(){
  // 快速加载：仅解析 CSV，不进行任何 HEAD/远程拉取，首次渲染更快
  const resp = await fetch('./data/words.csv?v=20250810', { cache: 'no-store' });
  const text = await resp.text();
  const rows = parseCSV(text);
  const items = rows.map((r, idx)=>{
    const item = { ...r };
    item.id = Number(r.id || idx + 1);
    item.en = (r.en?.trim() || '');
    item.cn = (r.cn?.trim() || '');
    item.pinyin = (r.pinyin?.trim() || '');
    const csvImg = (r.img?.trim() || '');
    // 若 CSV 已指向本地 assets/words/ 或远程，直接使用
    if(csvImg){
      item.img = csvImg;
      item.img_origin = 'csv';
    }else{
      // 默认推断一个本地 .jpg 路径（不做 HEAD 试探），懒加载阶段若 404 会回退
      const dashed = (item.en || String(item.id)).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'') || `w-${item.id}`;
      item.img = `assets/words/${dashed}.jpg`;
      item.img_origin = 'local_assumed_jpg';
    }
    item.sent = (r.sent?.trim() || '');
    item.sent_cn = (r.sent_cn?.trim() || '');
    return item;
  }).filter(x=>x.en);
  return items;
}

function parseCSV(text){
  // Simple CSV parser (no quoted comma complexities for our dataset)
  const lines = text.split(/\r?\n/).filter(l=>l.trim() && !l.trim().startsWith('#'));
  if(lines.length === 0) return [];
  const header = lines[0].split(',').map(h=>h.trim());
  csvHeader = header;
  const out = [];
  for(let i=1;i<lines.length;i++){
    const cols = splitCSVLine(lines[i]);
    const obj = {};
    header.forEach((h,idx)=> obj[h] = cols[idx] ?? '');
    out.push(obj);
  }
  return out;
}

function splitCSVLine(line){
  // Handle basic quotes
  const result=[]; let cur=''; let inQ=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(ch==='"'){
      if(inQ && line[i+1]==='"'){ cur+='"'; i++; }
      else inQ = !inQ;
    }else if(ch===',' && !inQ){
      result.push(cur); cur='';
    }else{ cur+=ch; }
  }
  result.push(cur);
  return result.map(s=>s.trim());
}

export function buildUpdatedWordsCsv(items){
  const headerOut = Array.from(new Set([...(csvHeader || ['id','en','cn','pinyin','img','sent','sent_cn']), 'img_flag']));
  const escape = (v)=>{
    const s = String(v ?? '');
    if(/[",\n]/.test(s)) return '"' + s.replace(/"/g,'""') + '"';
    return s;
  };
  const lines = [headerOut.join(',')];
  for(const w of items){
    const row = headerOut.map(h=>{
      if(h === 'img_flag') return w.img_flag || '';
      if(h === 'img') return w.img || '';
      return w[h] ?? '';
    }).map(escape);
    lines.push(row.join(','));
  }
  return lines.join('\n');
}

// 不再进行本地资源 HEAD 探测，以避免启动时大量 404；懒加载期间由 <img> 自行触发并回退

function buildNameVariants(englishWord){
  const raw = String(englishWord || '').trim();
  const lower = raw.toLowerCase();
  const compact = lower.replace(/[^a-z0-9]+/g, '');
  const dashed = lower.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const underscored = lower.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const unique = new Set([lower, compact, dashed, underscored]);
  return Array.from(unique).filter(Boolean);
}

async function fetchWikimediaThumb(title, locale='en'){
  const loc = String(locale||'en').toLowerCase();
  const url = `https://${loc}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  try{
    const resp = await fetch(url, { cache: 'no-store' });
    if(!resp.ok) return '';
    const data = await resp.json();
    return data?.thumbnail?.source || '';
  }catch{
    return '';
  }
}

function buildUnsplashSource(keyword){
  return `https://source.unsplash.com/600x400/?${encodeURIComponent(keyword)}`;
}

async function resolveImageForWord(keyword, cnAlternative=''){
  const fromWikiEn = await fetchWikimediaThumb(keyword, 'en');
  if(fromWikiEn) return fromWikiEn;
  if(cnAlternative){
    const fromWikiZh = await fetchWikimediaThumb(cnAlternative, 'zh');
    if(fromWikiZh) return fromWikiZh;
  }
  if(keyword) return buildUnsplashSource(keyword);
  if(cnAlternative) return buildUnsplashSource(cnAlternative);
  return '';
}

// Exported helper for UI: get best remote image URL (no local/CSV consideration)
export async function resolveBestImageUrl(en, cn){
  const wikiEn = await fetchWikimediaThumb(en || '', 'en');
  if(wikiEn) return wikiEn;
  const wikiZh = await fetchWikimediaThumb(cn || '', 'zh');
  if(wikiZh) return wikiZh;
  if(en) return buildUnsplashSource(en);
  if(cn) return buildUnsplashSource(cn);
  return '';
}


