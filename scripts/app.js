import { $, $all, formatDateKey, speak } from './utils.js';
import { MicRecorder, scorePronunciation } from './recorder.js';
import { getKidDay, recordWordLearned, saveRecording, getGlobal, setGlobal, deleteRecording, submitWord, putRecordingBlob, getRecordingBlobByKey } from './storage.js';
import { loadWords, buildUpdatedWordsCsv, resolveBestImageUrl } from './data/words_loader.js?v=20250810';
import { generateSentenceForWord } from './sentence_gen.js';

let DAILY_COUNT = 5;
const MAX_RECORDS = 3;

const state = {
  route: 'today',
  kidId: 'kid1',
  todayKey: formatDateKey(),
  allSearch: '',
};

// Persisted DirectoryHandle for assets/words via OPFS keys
const IMG_DIR_HANDLE_KEY = 'ww4k.imagesDirHandle';
const CSV_FILE_HANDLE_KEY = 'ww4k.csvFileHandle';
const REC_DIR_HANDLE_KEY = 'ww4k.recordsDirHandle';
let imagesDirHandle = null;
let csvFileHandle = null;
let recordsDirHandle = null;

async function loadImagesDirHandle(){
  try{
    const stored = localStorage.getItem(IMG_DIR_HANDLE_KEY);
    if(!stored) return null;
    const handle = await window.showDirectoryPicker({ startIn: 'pictures' });
    return handle; // Note: previously stored handles need the Storage Foundation; this is a simplified fallback
  }catch{ return null; }
}

async function ensurePinyinLib(){
  const isValid = () => {
    if(!(window.pinyinPro && typeof window.pinyinPro.pinyin === 'function')) return false;
    try{
      const arr = window.pinyinPro.pinyin('测试', { type: 'array', toneType: 'symbol' }) || [];
      const out = Array.isArray(arr) ? arr.join(' ') : String(arr||'');
      // 若仍含有中文字符，说明是占位/无效实现
      if(/[\u4e00-\u9fa5]/.test(out)) return false;
      return true;
    }catch{ return false; }
  };
  if(isValid()) return true;
  // 优先尝试本地 UMD（index.html 已引入），等待其初始化；失败再尝试 CDN
  const okLocal = await new Promise(resolve=> setTimeout(()=> resolve(isValid()), 80));
  if(okLocal) return true;
  // CDN 兜底
  const okCdn = await new Promise(resolve=>{
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/pinyin-pro@3.19.7/dist/pinyin-pro.umd.min.js';
    s.onload = () => resolve(isValid());
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
  return !!okCdn;
}

function isLikelyPinyin(text){
  if(!text) return false;
  const s = String(text).trim();
  // 允许字母、空格、连字符、点号以及常见带声调元音和 ü
  const re = /^[a-zA-Z\s\.\-āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü]+$/;
  return re.test(s);
}

async function init(){
  // load words from CSV
  const hideOverlay = ()=>{}; // overlay 已移除
  try{
    window.__WORDS__ = await loadWords();
  }catch{ window.__WORDS__ = window.__WORDS__ || []; }
  const hashRoute = location.hash.replace('#','');
  if(hashRoute) state.route = hashRoute;
  // 单孩子模式，无需切换
  $all('.nav-link').forEach(link=>{
    link.addEventListener('click', (e)=>{
      const route = e.target.getAttribute('data-route');
      state.route = route;
      location.hash = route;
      render();
    });
  });
  // 支持 hash 返回，例如详情页的“返回”按钮使用 #progress
  window.addEventListener('hashchange', ()=>{
    const hashRoute = (location.hash || '').replace('#','');
    if(hashRoute===state.route) return;
    if(hashRoute==='today' || hashRoute==='all' || hashRoute==='progress'){
      state.route = hashRoute;
      render();
    }
  });
  // 预热语音，确保首次点击快速发音
  try{ ensureSpeechReady(); }catch{}
  const settingsBtn = document.getElementById('btnSettings');
  const settingsMenu = document.getElementById('settingsMenu');
  if(settingsBtn && settingsMenu){
    settingsBtn.addEventListener('click', (e)=>{
      e.stopPropagation();
      settingsMenu.classList.toggle('hidden');
    });
    document.addEventListener('click', (e)=>{
      if(!settingsMenu.classList.contains('hidden')){
        settingsMenu.classList.add('hidden');
      }
    });
  }
  const clearBtn = document.getElementById('btnClearCache');
  if(clearBtn){
    clearBtn.addEventListener('click', ()=>{
      if(confirm('确认清空本地缓存并重置所有进度吗？此操作不可恢复。')){
        localStorage.clear();
        sessionStorage.clear();
        alert('已清理完成，页面将刷新。');
        location.reload();
      }
    });
  }
  const dailyInput = document.getElementById('dailyCountInput');
  if(dailyInput){
    dailyInput.value = String(DAILY_COUNT);
    dailyInput.addEventListener('change', ()=>{
      const v = Math.max(1, Math.min(20, Number(dailyInput.value)||5));
      DAILY_COUNT = v;
      render();
    });
  }
  const swapBtn = document.getElementById('btnSwapBatch');
  if(swapBtn){
    swapBtn.addEventListener('click', ()=>{
      // 每次点击，将指针向后移动 DAILY_COUNT，并刷新今日单词
      setGlobal(db=>({ ...db, lastWordIdx: ((db.lastWordIdx||0) + DAILY_COUNT) % (window.__WORDS__.length || 1) }));
      sessionStorage.removeItem('ww4k.todayCommitted');
      render();
    });
  }
  const setImgDirBtn = document.getElementById('btnSetImagesDir');
  if(setImgDirBtn){
    setImgDirBtn.addEventListener('click', async()=>{
      try{
        if(!('showDirectoryPicker' in window)){
          alert('当前浏览器不支持目录写入（需要 Chrome/Edge 92+）。');
          return;
        }
        imagesDirHandle = await window.showDirectoryPicker();
        if(imagesDirHandle.requestPermission){
          const perm = await imagesDirHandle.requestPermission({ mode: 'readwrite' });
          if(perm !== 'granted'){
            alert('未授予写入权限');
            return;
          }
        }
        // Try to create a test file to ensure write access then delete it
        const testFile = await imagesDirHandle.getFileHandle('.perm_test', { create: true });
        const w = await testFile.createWritable(); await w.write('ok'); await w.close();
        await imagesDirHandle.removeEntry('.perm_test');
        localStorage.setItem(IMG_DIR_HANDLE_KEY, 'set');
        alert('图片目录设置成功。请在“全部”页使用“替换图片”。');
      }catch(e){ /* 用户取消 */ }
    });
  }
  const setRecDirBtn = document.getElementById('btnSetRecordsDir');
  if(setRecDirBtn){
    setRecDirBtn.addEventListener('click', async()=>{
      try{
        if(!('showDirectoryPicker' in window)){
          alert('当前浏览器不支持目录写入（需要 Chrome/Edge 92+）。');
          return;
        }
        recordsDirHandle = await window.showDirectoryPicker();
        if(recordsDirHandle.requestPermission){
          const perm = await recordsDirHandle.requestPermission({ mode: 'readwrite' });
          if(perm !== 'granted'){
            alert('未授予写入权限');
            return;
          }
        }
        // 权限校验
        const testFile = await recordsDirHandle.getFileHandle('.perm_test', { create: true });
        const w = await testFile.createWritable(); await w.write('ok'); await w.close();
        await recordsDirHandle.removeEntry('.perm_test');
        localStorage.setItem(REC_DIR_HANDLE_KEY, 'set');
        alert('录音目录设置成功。建议选择项目内 assets/records/。');
      }catch(e){ /* 用户取消 */ }
    });
  }
  const setCsvBtn = document.getElementById('btnSetCsvFile');
  if(setCsvBtn){
    setCsvBtn.addEventListener('click', async()=>{
      try{
        if(!('showOpenFilePicker' in window)){
          alert('当前浏览器不支持文件写入（需要 Chrome/Edge 92+）。');
          return;
        }
        const [handle] = await window.showOpenFilePicker({
          multiple: false,
          types: [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }]
        });
        if(handle.requestPermission){
          const perm = await handle.requestPermission({ mode: 'readwrite' });
          if(perm !== 'granted'){
            alert('未授予写入权限');
            return;
          }
        }
        csvFileHandle = handle;
        localStorage.setItem(CSV_FILE_HANDLE_KEY, 'set');
        alert('CSV 文件设置成功。导入词表后将自动合并保存。');
      }catch(e){ /* 用户取消 */ }
    });
  }
  const fixCsvBtn = document.getElementById('btnFixCsv');
  if(fixCsvBtn){
    fixCsvBtn.addEventListener('click', async ()=>{
      if(!csvFileHandle){ alert('请先点击“设置CSV文件”，选择 data/words.csv 并授予写权限'); return; }
      try{
        await ensurePinyinLib();
        // 1) 读取当前 CSV 内容到内存（使用已加载的 window.__WORDS__）
        const words = window.__WORDS__ || [];
        let fixedPinyin = 0, localized = 0, fixedSent = 0;
        // 2) 补全句子/翻译/拼音
        for(const w of words){
          if(!w.sent || !w.sent_cn){
            const s = generateSentenceForWord(w.en, w.cn);
            if(!w.sent) w.sent = s.en || `This is ${w.en}.`;
            if(!w.sent_cn) w.sent_cn = s.cn || `这是${w.cn||'它'}。`;
            fixedSent++;
          }
          // 2.1 补全拼音（若缺失或非拼音且有中文名）
          try{
            if((!w.pinyin || !isLikelyPinyin(w.pinyin)) && w.cn && window.pinyinPro){
              w.pinyin = window.pinyinPro.pinyin(w.cn, { toneType: 'symbol', type: 'array' }).join(' ');
              fixedPinyin++;
            }
          }catch{}
        }
        // 3) 本地化远程图片（若已设置图片目录）
        if(imagesDirHandle){
          for(const w of words){
            const img = w.img || '';
            if(!img) continue;
            const isRemote = /^https?:\/\//i.test(img);
            const isLocal = /^assets\/words\//i.test(img);
            if(isLocal) continue;
            if(isRemote){
              try{
                const resp = await fetch(img, { cache: 'no-store' });
                if(!resp.ok) continue;
                const buf = await resp.arrayBuffer();
                const ct = resp.headers.get('Content-Type')||'';
                const ext = (ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : ct.includes('jpeg')||ct.includes('jpg') ? 'jpg' : (img.split('.').pop()||'jpg').split('?')[0]);
                const safeName = (w.en||String(w.id)).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'') || `w-${w.id}`;
                const targetName = `${safeName}.${ext}`;
                const fileHandle = await imagesDirHandle.getFileHandle(targetName, { create: true });
                const writable = await fileHandle.createWritable();
                await writable.write(new Blob([buf]));
                await writable.close();
                w.img = `assets/words/${targetName}`;
                w.img_flag = '';
                localized++;
              }catch{ /* 单个失败忽略 */ }
            }
          }
        }
        // 4) 写回 CSV
        const csv = buildUpdatedWordsCsv(words);
        const writable = await csvFileHandle.createWritable();
        await writable.write(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
        await writable.close();
        const noteImg = imagesDirHandle ? `，本地化图片 ${localized} 张` : '（未设置图片目录，跳过图片本地化）';
        alert(`已补全：拼音 ${fixedPinyin} 条、短句/翻译 ${fixedSent} 条${noteImg}，并写回 CSV。`);
      }catch(e){ alert('处理过程中出现问题，请重试。'); }
    });
  }
  const exportWordsBtn = document.getElementById('btnExportWordsCsv');
  if(exportWordsBtn){
    exportWordsBtn.addEventListener('click', ()=>{
      const csv = buildUpdatedWordsCsv(window.__WORDS__ || []);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'words.updated.csv';
      a.click();
      URL.revokeObjectURL(url);
    });
  }
  const saveWordsBtn = document.getElementById('btnSaveWordsCsv');
  if(saveWordsBtn){
    saveWordsBtn.addEventListener('click', async ()=>{
      try{
        const handle = await window.showSaveFilePicker({
          suggestedName: 'words.csv',
          types: [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }]
        });
        const csv = buildUpdatedWordsCsv(window.__WORDS__ || []);
        const writable = await handle.createWritable();
        await writable.write(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
        await writable.close();
        alert('已保存 CSV');
      }catch(e){ /* 用户取消等情况忽略 */ }
    });
  }
  const importBtn = document.getElementById('btnImportWords');
  if(importBtn){
    importBtn.addEventListener('click', async ()=>{
      try{
        const [handle] = await window.showOpenFilePicker({
          multiple: false,
          types: [
            { description: 'CSV', accept: { 'text/csv': ['.csv'] } },
            { description: 'Text', accept: { 'text/plain': ['.txt'] } },
          ]
        });
        const file = await handle.getFile();
        const text = await file.text();
        const newWords = parseWordsText(text);
        const added = await mergeWordsAndEnrich(newWords);
        // Auto-save to csv if user configured csv handle
        if(csvFileHandle){
          try{
            const csv = buildUpdatedWordsCsv(window.__WORDS__ || []);
            const writable = await csvFileHandle.createWritable();
            await writable.write(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
            await writable.close();
            alert(`已导入 ${added} 个新词，并自动保存到 CSV。`);
          }catch{ alert(`已导入 ${added} 个新词，但保存到 CSV 失败。请手动点击“保存到CSV（本地写入）”。`); }
        }else{
          alert(`已导入 ${added} 个新词。可点击“保存到CSV（本地写入）”写回文件。`);
        }
        render();
      }catch(e){ /* 用户取消 */ }
    });
  }
  render();
}

function getTodayWords(){
  const db = getGlobal();
  const words = window.__WORDS__;
  const start = (db.lastWordIdx || 0) % words.length;
  const picked = [];
  for(let i=0;i<DAILY_COUNT;i++){
    picked.push(words[(start+i)%words.length]);
  }
  return { list: picked, startIndex: start };
}

// 提交后再推进指针

function render(){
  $all('.nav-link').forEach(l=> l.classList.toggle('active', l.getAttribute('data-route')===state.route));
  const root = $('#app');
  if(state.route === 'today') return renderToday(root);
  // 去掉“练习”模块，改为“全部”
  if(state.route === 'all') return renderAllWords(root);
  if(state.route === 'progress') return renderProgress(root);
}

function renderToday(root){
  const { list, startIndex } = getTodayWords();
  const day = getKidDay('single', state.todayKey);
  const htmlCards = list.map((w,i)=>{
    const learned = day.learnedIds.includes(w.id);
    const dots = new Array(MAX_RECORDS).fill(0).map((_,k)=>`<span class="dot ${day.recordings[w.id]?.[k]? 'on':''}"></span>`).join('');
    return `
      <div class="card" data-word-id="${w.id}">
        <div class="word-row"><div class="word">${w.en}</div><button class="icon-btn btn-say" aria-label="play">🔊</button></div>
        <img class="img" src="${w.img}" alt="${w.en}" />
        <div class="pinyin">${w.pinyin}</div>
        <div class="cn">${w.cn}</div>
        <div class="sentence">
          <div class="en">${w.sent || ''}<button class="icon-btn btn-sent-say" title="读短句">🔊</button></div>
          <div class="cn">${w.sent_cn || translateSentence(w.sent)}</div>
        </div>
        <div class="actions">
          <button class="btn btn-rec-start">⏺️ 开始录音</button>
          <button class="btn btn-rec-stop" disabled>⏹️ 结束录音</button>
        </div>
        <div class="dots">${dots}</div>
        <div class="recordings" data-rec-list></div>
        <div style="text-align:center;margin-top:8px">
          <button class="btn btn-submit" data-submit-id="${w.id}" disabled>提交此单词</button>
        </div>
      </div>`;
  }).join('');

  root.innerHTML = `
    <section class="view">
      <div class="page-title">今天学习 5 个新单词</div>
      <div class="page-subtitle">点击卡片上的按钮来听读与录音。每个单词可录音 3 次。</div>
      <div class="grid">${htmlCards}</div>
      <div style="text-align:center;margin-top:16px"><div class="badge">录满3次的单词可单独提交</div></div>
    </section>`;

  // bind
  $all('.card').forEach(card=>{
    const id = card.getAttribute('data-word-id');
    const word = window.__WORDS__.find(w=>String(w.id)===String(id));
    const startBtn = card.querySelector('.btn-rec-start');
    const stopBtn = card.querySelector('.btn-rec-stop');
    card.querySelector('.btn-say').addEventListener('click', ()=> speak(word.en));
    const sentBtn = card.querySelector('.btn-sent-say');
    if(sentBtn){ sentBtn.addEventListener('click', ()=> speak(word.sent || '')); }
    bindManualRecord(card, word, startBtn, stopBtn);

    // 如果该词已有录音，渲染历史
    const day = getKidDay('single', state.todayKey);
    const recs = day.recordings[word.id] || [];
    const listWrap = card.querySelector('[data-rec-list]');
    recs.forEach((r, idx)=>{
      if(!r) return;
      const el = document.createElement('div');
      el.className = 'stat';
      el.innerHTML = `<audio controls src="${r.url || ''}" data-blob-key="${r.blobKey||''}"></audio><span class="badge">得分 ${Math.round((r.score||0)*100)}</span><button class="btn secondary" data-del-idx="${idx}">删除</button>`;
      listWrap.appendChild(el);
      // 若无 URL 但有 blobKey，尝试恢复
      const audioEl = el.querySelector('audio');
      if(!r.url && r.blobKey){
        getRecordingBlobByKey(r.blobKey).then(blob=>{
          if(blob){ audioEl.src = URL.createObjectURL(blob); }
        });
      }
      el.querySelector('[data-del-idx]').addEventListener('click', ()=>{
        deleteRecording('single', word.id, idx);
        el.remove();
        const dot = card.querySelectorAll('.dot')[idx];
        if(dot) dot.classList.remove('on');
      });
    });

    // 每个卡片单独提交按钮
    const submitBtn = card.querySelector('[data-submit-id]');
    const refreshSingle = ()=>{
      const d = getKidDay('single', state.todayKey);
      const arr = d.recordings[word.id] || [];
      let cnt=0; (arr||[]).forEach(x=>{ if(x) cnt++; });
      submitBtn.disabled = !(cnt>=MAX_RECORDS);
      submitBtn.textContent = '提交此单词';
    };
    refreshSingle();
    submitBtn.addEventListener('click', ()=>{
      submitWord('single', word.id, state.todayKey);
      // 可重复提交更新，不禁用按钮
      alert('已提交该单词');
      refreshSingle();
    });
  });

  // 录音变化刷新所有卡片的单词提交按钮
  document.addEventListener('ww4k:record-updated', ()=>{ renderToday(root); }, { once: false });
}

function bindManualRecord(card, word, startBtn, stopBtn){
  const rec = new MicRecorder();
  let isRecording = false;
  startBtn.addEventListener('click', async ()=>{
    if(isRecording) return; isRecording = true;
    startBtn.disabled = true; stopBtn.disabled = false; startBtn.textContent = '录音中…';
    try{ await rec.start(); }catch(e){ alert('无法开始录音'); isRecording=false; startBtn.disabled=false; stopBtn.disabled=true; startBtn.textContent='⏺️ 开始录音'; }
  });
  stopBtn.addEventListener('click', async ()=>{
    if(!isRecording) return; isRecording=false;
    startBtn.disabled = false; stopBtn.disabled = true; startBtn.textContent = '⏺️ 开始录音';
    try{
      // 首次需要时提示设置目录
      await ensureRecordsDirSelectedOnce();
      const blob = await rec.stop();
      const { score, transcript } = await scorePronunciation(word.en);
      // 若可写入，则保存并返回本地相对URL
      let localUrl = '';
      try{ localUrl = await maybeSaveRecordingToLocalDir(blob, word); }catch{}
      addRecordingUI(card, word, blob, score, transcript, localUrl);
    }catch(e){ console.error(e); }
  });
}

async function addRecordingUI(card, word, blob, score, transcript, localUrl=''){ 
  const kidId = 'single';
  const currentOn = card.querySelectorAll('.dot.on').length;
  if(currentOn>=MAX_RECORDS) return;
  const idx = currentOn;
  // 将音频持久化到 IndexedDB，并写入 blobKey
  const blobKey = await putRecordingBlob('single', word.id, idx, formatDateKey(), blob);
  const url = localUrl || URL.createObjectURL(blob);
  saveRecording(kidId, word.id, idx, { url, localUrl, score, ts: Date.now(), transcript, blobKey });
  card.querySelectorAll('.dot')[idx].classList.add('on');
  const list = card.querySelector('[data-rec-list]');
  const el = document.createElement('div');
  el.className = 'stat';
  el.innerHTML = `<audio controls src="${url}"></audio><span class="badge">得分 ${Math.round(score*100)}</span><button class="btn secondary" data-del-idx="${idx}">删除</button>`;
  list.appendChild(el);
  el.querySelector('[data-del-idx]').addEventListener('click', ()=>{
    deleteRecording(kidId, word.id, idx);
    el.remove();
    card.querySelectorAll('.dot')[idx].classList.remove('on');
  });
  // 通知刷新提交按钮状态
  document.dispatchEvent(new CustomEvent('ww4k:record-updated'));
}

async function maybeSaveRecordingToLocalDir(blob, word){
  // 若用户未设置目录，尝试提示一次
  if(!recordsDirHandle){
    return ''; // 默认不弹窗打断；用户可在“设置”中手动设置
  }
  try{
    const safeName = (word.en || String(word.id)).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'') || `w-${word.id}`;
    const ts = new Date();
    const tsStr = `${ts.getFullYear()}${String(ts.getMonth()+1).padStart(2,'0')}${String(ts.getDate()).padStart(2,'0')}_${String(ts.getHours()).padStart(2,'0')}${String(ts.getMinutes()).padStart(2,'0')}${String(ts.getSeconds()).padStart(2,'0')}`;
    const fname = `${safeName}_${tsStr}.webm`;
    const fh = await recordsDirHandle.getFileHandle(fname, { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
    // 约定所选目录为项目 assets/records/
    return `assets/records/${fname}`;
  }catch(e){ /* 忽略失败 */ }
  return '';
}

async function ensureRecordsDirSelectedOnce(){
  if(recordsDirHandle) return;
  try{
    if(!('showDirectoryPicker' in window)) return;
    // 弹出一次，建议选择项目内 assets/records/
    const ok = confirm('是否设置录音保存目录？建议选择项目内的 assets/records/ 目录，这样录音可直接在页面中回放。');
    if(!ok) return;
    const handle = await window.showDirectoryPicker();
    if(handle.requestPermission){
      const perm = await handle.requestPermission({ mode: 'readwrite' });
      if(perm !== 'granted') return;
    }
    // 简单权限校验
    const tf = await handle.getFileHandle('.perm_test', { create: true });
    const w = await tf.createWritable(); await w.write('ok'); await w.close();
    await handle.removeEntry('.perm_test');
    recordsDirHandle = handle;
    localStorage.setItem(REC_DIR_HANDLE_KEY, 'set');
  }catch{ /* 用户取消 */ }
}

// 删除练习渲染函数

// 全部单词：一行5个、展示两行、分页
let allPage = 1;
const ALL_PAGE_ROWS = 2;
function renderAllWords(root){
  const perPage = 5 * ALL_PAGE_ROWS;
  const q = (state.allSearch || '').trim().toLowerCase();
  const source = window.__WORDS__ || [];
  const list = q
    ? source.filter(w=> (w.en||'').toLowerCase().includes(q) || String(w.cn||'').includes(state.allSearch))
    : source;
  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if(allPage>totalPages) allPage=totalPages;
  if(allPage<1) allPage=1;
  const start = (allPage-1)*perPage;
  const slice = list.slice(start, start+perPage);

  const cards = slice.map(w=>`
    <div class="card" data-word-id="${w.id}">
      <div class="word-row">
        <div class="menu-host" style="display:flex;align-items:center;gap:8px;position:relative">
          <button class="card-menu-btn" data-card-menu="${w.id}" title="更多">▾</button>
          <div class="word">${w.en}</div>
          <div class="card-menu-list hidden" data-card-menu-list="${w.id}">
            <button class="btn secondary small" data-replace-img="${w.id}">替换图片</button>
          </div>
        </div>
        <button class="icon-btn btn-say" aria-label="play">🔊</button>
      </div>
      <div class="img-wrap">
        <img class="img" src="${w.img}" alt="${w.en}" style="border-radius:16px"/>
      </div>
      <div class="pinyin">${w.pinyin}</div>
      <div class="cn">${w.cn}</div>
      <div class="sentence">
        <div class="en">${w.sent || ''}<button class="icon-btn btn-sent-say" title="读短句">🔊</button></div>
        <div class="cn">${w.sent_cn || ''}</div>
      </div>
    </div>`).join('');

  root.innerHTML = `
    <section class="view">
      <div class="page-title">全部单词</div>
      <div class="page-subtitle" style="display:flex;justify-content:center;gap:8px;align-items:center">
        <input id="allSearchInput" class="search-input" placeholder="按英文或中文搜索" value="${state.allSearch||''}" />
        <button id="btnDoSearch" class="btn secondary small">搜索</button>
        <span class="badge">共 ${total} 条</span>
      </div>
      <div class="grid">${cards || '无匹配'}</div>
      <div class="pager"><button class="btn" id="prevAll">上一页</button><div class="badge">${allPage}/${totalPages}</div><button class="btn" id="nextAll">下一页</button></div>
    </section>`;

  $all('.card').forEach(card=>{
    const id = card.getAttribute('data-word-id');
    const w = window.__WORDS__.find(x=> String(x.id)===String(id));
    card.querySelector('.btn-say').addEventListener('click', ()=> speak(w.en));
    const sentBtn = card.querySelector('.btn-sent-say');
    if(sentBtn) sentBtn.addEventListener('click', ()=> speak(w.sent||''));
  });
  const searchInput = $('#allSearchInput');
  const doSearchBtn = $('#btnDoSearch');
  if(doSearchBtn && searchInput){
    const run = ()=>{ state.allSearch = searchInput.value || ''; allPage=1; renderAllWords(root); };
    doSearchBtn.addEventListener('click', run);
    searchInput.addEventListener('keydown', (e)=>{ if(e.key==='Enter') run(); });
  }

  // card dropdown menus
  $all('[data-card-menu]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      e.stopPropagation();
      const id = e.currentTarget.getAttribute('data-card-menu');
      const menu = document.querySelector(`[data-card-menu-list="${id}"]`);
      if(menu){ menu.classList.toggle('hidden'); }
    });
  });
  document.addEventListener('click', ()=>{
    $all('.card-menu-list').forEach(m=> m.classList.add('hidden'));
  }, { once: true });
  // Bind image replace (All page only)
  $all('[data-replace-img]').forEach(btn=>{
    btn.addEventListener('click', async (e)=>{
      const id = e.currentTarget.getAttribute('data-replace-img');
      const word = window.__WORDS__.find(x=> String(x.id)===String(id));
      if(!word) return;
      try{
        // File System Access API open file picker
        const [handle] = await window.showOpenFilePicker({
          multiple: false,
          types: [{ description: 'Images', accept: { 'image/*': ['.png','.jpg','.jpeg','.webp'] } }]
        });
        const file = await handle.getFile();
        const buf = await file.arrayBuffer();
        // 若未预先设置目录，这里引导用户选择一次
        if(!imagesDirHandle){
          if(!('showDirectoryPicker' in window)){
            alert('当前浏览器不支持目录写入（需 Chrome/Edge 92+ 且 http/https）。');
            return;
          }
          try{
            imagesDirHandle = await window.showDirectoryPicker();
            if(imagesDirHandle.requestPermission){
              const perm = await imagesDirHandle.requestPermission({ mode: 'readwrite' });
              if(perm !== 'granted'){
                alert('未授予写入权限');
                return;
              }
            }
          }catch{ return; }
        }
        const wordsDir = imagesDirHandle;
        const safeName = (word.en || String(word.id)).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'') || `w-${word.id}`;
        const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
        const targetName = `${safeName}.${ext}`;
        const fileHandle = await wordsDir.getFileHandle(targetName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(new Blob([buf], { type: file.type || 'application/octet-stream' }));
        await writable.close();
        // 约定用户选择的目录就是项目的 assets/words
        const oldUrl = (word.img || '').replace(/\\/g,'/');
        const localUrl = `assets/words/${targetName}`;
        word.img = localUrl;
        word.img_flag = '';
        // 如原图片位于 assets/words/ 且文件名不同，则删除旧文件
        try{
          const isOldLocal = /^assets\/words\//i.test(oldUrl);
          const oldName = isOldLocal ? oldUrl.split('/').pop() : '';
          if(oldName && oldName !== targetName){
            await wordsDir.removeEntry(oldName);
          }
        }catch{ /* 忽略删除失败 */ }
        // Update UI image
        const imgEl = e.currentTarget.closest('.card').querySelector('img.img');
        if(imgEl){ imgEl.src = localUrl; }
        alert('图片已替换并保存到所选目录。可点击“保存到CSV（本地写入）”写回 data/words.csv。');
      }catch(err){ /* 用户取消或浏览器不支持 */ }
    });
  });
  $('#prevAll').addEventListener('click', ()=>{ if(allPage>1){ allPage--; renderAllWords(root); } });
  $('#nextAll').addEventListener('click', ()=>{ const tp=Math.ceil(total/perPage); if(allPage<tp){ allPage++; renderAllWords(root); } });
}

function renderProgress(root){
  const db = getGlobal();
  const days = Object.keys(db.days||{}).sort();
  let totalLearned = 0;
  const rows = days.map(dayKey=>{
    const d = db.days[dayKey];
    // 只统计已提交的单词数量
    const submittedCount = (d.submittedWordIds||[]).length;
    totalLearned += submittedCount;
    const passed = averageDailyScore(d);
    return `<div class=\"progress-row\"><div>${dayKey}</div><div class=\"stat\"><span class=\"badge\">${submittedCount} 词</span><span class=\"badge\">平均得分 ${Math.round(passed*100)}</span><button data-detail=\"${dayKey}\" class=\"btn small secondary\">查看详情</button></div></div>`;
  }).join('');
  root.innerHTML = `
    <section class="view progress-wrap">
      <div class="page-title">学习进度</div>
      <div class="page-subtitle">累计已认识 <b>${totalLearned}</b> 个单词</div>
      <div class="card">${rows || '暂无记录'}</div>
    </section>`;

  // bind detail links
  $all('[data-detail]').forEach(a=>{
    a.addEventListener('click', (e)=>{
      const dayKey = e.currentTarget.getAttribute('data-detail');
      renderProgressDetail($('#app'), dayKey);
    });
  });
}
function renderProgressDetail(root, dayKey){
  const db = getGlobal();
  const d = db.days?.[dayKey];
  // 仅显示已提交的单词
  const submittedSet = new Set(d?.submittedWordIds || []);
  const items = Object.entries(d?.recordings || {}).filter(([wid])=> submittedSet.has(Number(wid))).map(([wid, recs])=>{
    const w = window.__WORDS__.find(x=> String(x.id)===String(wid));
    const audios = (recs||[]).map((r,i)=> r ? `<div class=\"stat\"><audio controls src=\"${r.url}\"></audio><span class=\"badge\">${Math.round((r.score||0)*100)}</span></div>` : '').join('');
    return `<div class=\"card\"><div class=\"word\">${w?.en || '未知'}</div><div class=\"cn\">${w?.cn || ''} · ${w?.pinyin || ''}</div>${audios}</div>`;
  }).join('');

  root.innerHTML = `
    <section class=\"view\">
      <div class=\"page-title\">${dayKey} 详情</div>
      <div class=\"page-subtitle\">可查看每个录音与得分</div>
      <div class=\"grid\">${items || '无录音'}</div>
      <div style=\"margin-top:16px;text-align:center\"><a href=\"#progress\" class=\"btn small\" id=\"btnBackProgress\">返回</a></div>
    </section>`;

  const backBtn = document.getElementById('btnBackProgress');
  if(backBtn){
    backBtn.addEventListener('click', (e)=>{
      e.preventDefault();
      state.route = 'progress';
      location.hash = 'progress';
      render();
    });
  }
}

function buildDayCsv(dayKey, d){
  const header = ['kid','day','wordId','word','score','transcript','audioUrl'];
  const lines = [header.join(',')];
  Object.entries(d?.recordings || {}).forEach(([wid, recs])=>{
    const w = window.__WORDS__.find(x=> String(x.id)===String(wid));
    (recs||[]).forEach(r=>{
      if(!r) return;
      lines.push([state.kidId, dayKey, wid, (w?.en||''), (r.score||0), JSON.stringify(r.transcript||''), r.url].join(','));
    });
  });
  return lines.join('\n');
}

function parseWordsText(text){
  // Support formats:
  // 1) CSV with header id,en,cn,pinyin,img,sent,sent_cn (others ignored)
  // 2) Plain text: one per line: "english,中文" or just "english"
  const lines = text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  if(lines.length === 0) return [];
  const out = [];

  const isCSV = /,/.test(lines[0]) && /en/i.test(lines[0]);
  if(isCSV){
    const header = lines[0].split(',').map(h=>h.trim());
    const idxEn = header.findIndex(h=> h.toLowerCase()==='en');
    const idxCn = header.findIndex(h=> h.toLowerCase()==='cn');
    for(let i=1;i<lines.length;i++){
      const cols = lines[i].split(',');
      const en = (cols[idxEn]||'').trim();
      const cn = (cols[idxCn]||'').trim();
      if(!en) continue;
      out.push({ en, cn });
    }
  }else{
    for(const line of lines){
      const [enRaw, cnRaw=''] = line.split(',');
      const en = (enRaw||'').trim();
      const cn = (cnRaw||'').trim();
      if(!en) continue;
      out.push({ en, cn });
    }
  }
  return out;
}

async function mergeWordsAndEnrich(newWords){
  const existing = window.__WORDS__ || [];
  const existsSet = new Set(existing.map(w=> (w.en||'').toLowerCase()+ '|' + (w.cn||'')));
  let added = 0;
  for(const nw of newWords){
    const key = (nw.en||'').toLowerCase()+ '|' + (nw.cn||'');
    if(!nw.en || existsSet.has(key)) continue;
    const item = { id: existing.length+1, en: nw.en, cn: nw.cn||'', pinyin:'', img:'', sent:'', sent_cn:'', img_flag:'新获取' };
    // 1) 图片 URL（远程最佳）
    try{ item.img = await resolveBestImageUrl(item.en, item.cn) || ''; }catch{ item.img=''; }
    // 2) 简易拼音：中文名存在时用 pinyin-pro 生成
    try{
      await ensurePinyinLib();
      if(nw.cn && window.pinyinPro){
        item.pinyin = window.pinyinPro.pinyin(nw.cn, { toneType: 'symbol', type: 'array' }).join(' ');
      }
    }catch{}
    // 3) 简短例句与翻译：模板生成
    if(!item.sent || !item.sent_cn){
      const s = generateSentenceForWord(item.en, item.cn);
      item.sent = s.en || `This is ${item.en}.`;
      item.sent_cn = s.cn || `这是${item.cn||'它'}。`;
    }
    existing.push(item);
    existsSet.add(key);
    added++;
  }
  window.__WORDS__ = existing;
  // 若已设置 imagesDirHandle，则尝试下载图片到本地 assets/words/
  if(imagesDirHandle){
    for(const w of existing.slice(-added)){
      if(!w.img || w.img.startsWith('assets/')) continue;
      try{
        const resp = await fetch(w.img);
        const buf = await resp.arrayBuffer();
        const ext = (w.img.split('.').pop()||'jpg').split('?')[0].toLowerCase();
        const safeName = (w.en||String(w.id)).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'') || `w-${w.id}`;
        const targetName = `${safeName}.${ext}`;
        const fileHandle = await imagesDirHandle.getFileHandle(targetName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(new Blob([buf]));
        await writable.close();
        w.img = `assets/words/${targetName}`;
        w.img_flag = '';
      }catch{ /* 忽略单个失败 */ }
    }
  }
  return added;
}

function translateSentence(sent){
  // 简单占位：若 CSV 未提供译文，可用固定提示；你也可以把译文单独加列并改此函数读取
  if(!sent) return '';
  // 此处仅演示：不自动翻译，返回提示文本
  return '（中文翻译：请在 CSV 的 sent_cn 列编写）';
}

function averageDailyScore(d){
  const scores=[];
  Object.values(d.recordings||{}).forEach(arr=>{
    (arr||[]).forEach(r=>{ if(r && typeof r.score==='number') scores.push(r.score); });
  });
  if(scores.length===0) return 0;
  return scores.reduce((a,b)=>a+b,0)/scores.length;
}

window.addEventListener('DOMContentLoaded', init);


