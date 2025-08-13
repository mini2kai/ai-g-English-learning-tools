import { $, $all, formatDateKey, speak } from './utils.js';
import { MicRecorder, scorePronunciation } from './recorder.js';
import { getKidDay, recordWordLearned, saveRecording, getGlobal, setGlobal, deleteRecording, submitWord, putRecordingBlob, getRecordingBlobByKey, persistDirectoryHandle, loadDirectoryHandle, deleteRecordingBlobByKey, markTaskCompleted, setTaskAvgScore } from './storage.js';
import { loadWords, buildUpdatedWordsCsv, resolveBestImageUrl } from './data/words_loader.js?v=20250810';
import { generateSentenceForWord } from './sentence_gen.js';

let LEARN_COUNT = 5;      // 学习新词个数（可调）
const TASK_COUNT = 5;     // 每日任务固定 5
const MAX_RECORDS = 3;
let __syncingAll = false;

const state = {
  route: 'task',
  kidId: 'kid1',
  todayKey: formatDateKey(),
  allSearch: '',
  learnBatchIds: [],
  progressKind: 'task', // 'task' | 'learn'
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
  // 恢复持久化的目录句柄（若浏览器支持）
  try{
    const recHandle = await loadDirectoryHandle('recordsDir');
    if(recHandle){
      if(!recHandle.requestPermission || (await recHandle.requestPermission({ mode: 'readwrite' })) === 'granted'){
        recordsDirHandle = recHandle;
      }
    }
  }catch{}
  const hashRoute = location.hash.replace('#','');
  state.route = hashRoute || 'task';
  if(!hashRoute){ location.hash = 'task'; }
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
    if(hashRoute==='learn' || hashRoute==='task' || hashRoute==='all' || hashRoute==='progress'){
      state.route = hashRoute;
      render();
      // 切换到 progress 时，做一次防抖的全量同步
      if(state.route==='progress'){
        debounceSyncAll();
      }
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
    dailyInput.value = String(LEARN_COUNT);
    dailyInput.addEventListener('change', ()=>{
      const v = Math.max(1, Math.min(20, Number(dailyInput.value)||5));
      LEARN_COUNT = v;
      render();
    });
  }
  const swapBtn = document.getElementById('btnSwapBatch');
  if(swapBtn){
    swapBtn.addEventListener('click', ()=>{
      if(state.route !== 'learn') return;
      // 学习新词换一批：生成新批次 id 列表
      const ids = (pickRandomDistinct(window.__WORDS__||[], LEARN_COUNT) || []).map(w=> w.id);
      state.learnBatchIds = ids;
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
  // 切换手机版/桌面版（带容错）
  const swMobile = document.getElementById('btnSwitchToMobile');
  if(swMobile){
    swMobile.addEventListener('click', async()=>{
      try{
        const resp = await fetch('/switch-view?view=mobile&next=/mobile', { method:'GET' });
        if(resp.redirected){ location.href = resp.url; return; }
        if(resp.ok){ location.href = '/mobile'; return; }
        alert('暂时不支持切换');
      }catch{ alert('暂时不支持切换'); }
    });
  }
  const swDesktop = document.getElementById('btnSwitchToDesktop');
  if(swDesktop){
    swDesktop.addEventListener('click', async()=>{
      try{
        const resp = await fetch('/switch-view?view=desktop&next=/', { method:'GET' });
        if(resp.redirected){ location.href = resp.url; return; }
        if(resp.ok){ location.href = '/'; return; }
        alert('暂时不支持切换');
      }catch{ alert('暂时不支持切换'); }
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
        try{ await persistDirectoryHandle('recordsDir', recordsDirHandle); }catch{}
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
  try{ await syncAllProgressFromServer(); }catch{}
  render();
}

function pickRandomDistinct(arr, n){
  const total = arr.length; if(total===0) return [];
  const idxs = new Set();
  while(idxs.size < Math.min(n, total)){
    idxs.add(Math.floor(Math.random()*total));
  }
  return Array.from(idxs).map(i=> arr[i]);
}

function getLearnWords(){
  const words = window.__WORDS__ || [];
  // 若 state.learnBatchIds 有值，则按该批次
  if(state.learnBatchIds && state.learnBatchIds.length){
    const list = state.learnBatchIds.map(id=> words.find(w=> String(w.id)===String(id))).filter(Boolean);
    return { list };
  }
  const picked = pickRandomDistinct(words, LEARN_COUNT);
  state.learnBatchIds = picked.map(w=> w.id);
  return { list: picked };
}

function getTaskWords(){
  const db = getGlobal();
  if(!db.taskSelections) db.taskSelections = {};
  const dayKey = formatDateKey();
  const all = window.__WORDS__ || [];
  if(db.taskSelections[dayKey]?.wordIds?.length === TASK_COUNT){
    const ids = db.taskSelections[dayKey].wordIds;
    return { list: ids.map(id => all.find(w=> String(w.id)===String(id))).filter(Boolean) };
  }
  const start = (db.lastTaskIdx || 0) % (all.length || 1);
  const picked = [];
  for(let i=0;i<TASK_COUNT;i++) picked.push(all[(start + i) % (all.length || 1)]);
  const ids = picked.map(w=> w.id);
  db.taskSelections[dayKey] = { startIndex: start, wordIds: ids };
  db.lastTaskIdx = (start + TASK_COUNT) % (all.length || 1);
  setGlobal(db);
  return { list: picked };
}

// 提交后再推进指针

function render(){
  $all('.nav-link').forEach(l=> l.classList.toggle('active', l.getAttribute('data-route')===state.route));
  const root = $('#app');
  if(state.route === 'learn') return renderWordModule(root, 'learn');
  if(state.route === 'task') return renderWordModule(root, 'task');
  // 去掉“练习”模块，改为“全部”
  if(state.route === 'all') return renderAllWords(root);
  if(state.route === 'progress') return renderProgress(root);
}

function renderWordModule(root, mode){
  const isLearn = mode==='learn';
  const { list } = isLearn ? getLearnWords() : getTaskWords();
  const day = getKidDay('single', state.todayKey);
  const htmlCards = list.map((w,i)=>{
    const branch = isLearn ? (day.learnRecordings||{}) : (day.recordings||{});
    const dots = new Array(MAX_RECORDS).fill(0).map((_,k)=>`<span class="dot ${branch[w.id]?.[k]? 'on':''}"></span>`).join('');
    const { preferred, fallback } = preferJpgUrlFast(w.img || '');
    return `
      <div class="card" data-word-id="${w.id}">
        <div class="word-row"><div class="word">${w.en}</div><button class="icon-btn btn-say" aria-label="play">🔊</button></div>
        <img class="img lazy" loading="lazy" data-src="${preferred}" data-fallback-src="${fallback}" alt="${w.en}" />
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

  const title = isLearn ? '学习新词' : '每日任务';
  const subtitle = isLearn ? `随机挑选 ${LEARN_COUNT} 个单词` : `今日固定 ${TASK_COUNT} 个单词`;
  let doneHtml = '';
  if(!isLearn){
    const db = getGlobal();
    const dayData = db.days?.[state.todayKey] || {};
    if(dayData.taskCompleted){
      doneHtml = `<div style="text-align:center;margin:8px 0"><span class="done-banner">任务已完成 ✓</span></div>`;
    }
  }
  root.innerHTML = `
    <section class="view">
      <div class="page-title">${title}</div>
      <div class="page-subtitle">${subtitle}。点击卡片上的按钮来听读与录音。每个单词可录音 ${MAX_RECORDS} 次。</div>
      ${doneHtml}
      <div class="grid">${htmlCards}</div>
      <div style="text-align:center;margin-top:16px"><div class="badge">录满${MAX_RECORDS}次的单词可单独提交${!isLearn ? '；全部5个均提交后自动完成今日任务' : ''}</div></div>
      ${isLearn ? `<div style="text-align:center;margin-top:10px"><button class="btn" id="btnSwapLearn">换一批</button></div>` : ''}
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
    const branch = isLearn ? (day.learnRecordings||{}) : (day.recordings||{});
    const recs = branch[word.id] || [];
    const listWrap = card.querySelector('[data-rec-list]');
    recs.forEach((r, idx)=>{
      if(!r) return;
      const el = document.createElement('div');
      el.className = 'stat';
      el.setAttribute('data-rec-idx', String(idx));
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
        try{
          const d = getKidDay('single', state.todayKey);
          const rec = d.recordings[word.id]?.[idx];
          const lurl = rec?.localUrl || '';
          const bkey = rec?.blobKey || '';
          if(lurl) removeLocalRecordingFileByUrl(lurl);
          if(bkey) deleteRecordingBlobByKey(bkey);
        }catch{}
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
      const branch2 = isLearn ? (d.learnRecordings||{}) : (d.recordings||{});
      const arr = branch2[word.id] || [];
      let cnt=0; (arr||[]).forEach(x=>{ if(x) cnt++; });
    submitBtn.disabled = false; // 允许点击，由点击逻辑判断是否满足3次
      submitBtn.textContent = '提交此单词';
    };
    refreshSingle();
    submitBtn.addEventListener('click', async ()=>{
    const d = getKidDay('single', state.todayKey);
      const branch3 = isLearn ? (d.learnRecordings||{}) : (d.recordings||{});
      const arr = branch3[word.id] || [];
    let cnt=0; (arr||[]).forEach(x=>{ if(x) cnt++; });
    if(cnt < MAX_RECORDS){
      alert(`请录入三次录音`);
      return;
    }
    const prevText = submitBtn.textContent;
    submitBtn.textContent = '数据上传中…';
    submitBtn.disabled = true;
    let ok = true;
    try{
      // 保障录音也同步：将本地该词的录音逐条上报并等待完成
      const recs = (branch3[word.id] || []).filter(Boolean);
      await Promise.all(recs.map(r=>{
        const url = r.url || r.localUrl || '';
        if(!url) return Promise.resolve();
        return fetch('/api/progress/recording', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ day: state.todayKey, wordId: String(word.id), url, score: Number(r.score||0), ts: Number(r.ts||Date.now()), transcript: r.transcript||'', kind: isLearn ? 'learn' : 'task' })
        }).then(res=> res.ok ? res.json().catch(()=>({ok:true})) : Promise.reject()).then(j=>{ if(!(j&&j.ok)) ok=false; }).catch(()=>{ ok=false; });
      }));
      // 上报提交
      if(ok){
        const resp = await fetch('/api/progress/submit-word', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ day: state.todayKey, wordId: String(word.id), ts: Date.now(), kind: isLearn ? 'learn' : 'task' })
        });
        ok = resp.ok && !!(await resp.json().catch(()=>({ok:false}))).ok;
      }
    }catch{ ok = false; }
    if(ok){
      submitWord('single', word.id, state.todayKey, isLearn ? 'learn' : 'task');
      alert('提交成功');
      if(!isLearn){
        try{ await autoCheckCompleteTask(); }catch{}
      }
    }else{
      // 仍显示上传中，不提示成功
      alert('数据上传中，稍后再试');
    }
    submitBtn.textContent = prevText;
    submitBtn.disabled = false;
    refreshSingle();
    });
  });

  // 懒加载图片
  setupLazyImages(root);
  // 录音变化刷新所有卡片的单词提交按钮
  document.addEventListener('ww4k:record-updated', ()=>{ renderWordModule(root, mode); }, { once: false });
  // 仅学习新词换一批
  const swapBtnInline = document.getElementById('btnSwapLearn');
  if(swapBtnInline){ swapBtnInline.addEventListener('click', ()=>{ state.learnBatchIds = []; renderWordModule(root, 'learn'); }); }
  // 取消“完成今日任务”按钮，改为自动完成：在每次提交单词后与渲染时检测
  if(!isLearn){
    autoCheckCompleteTask();
  }
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
  // 选择首个空位；若满，则替换最早的记录
  const idx = chooseAttemptIndex(word.id);
  // 若当前位置已有旧文件且为本地文件/旧blob，先删除
  try{
    const day = getKidDay(kidId, formatDateKey());
    const old = day.recordings[word.id]?.[idx];
    const oldUrl = old?.localUrl || '';
    const oldBlobKey = old?.blobKey || '';
    if(oldUrl) await removeLocalRecordingFileByUrl(oldUrl);
    if(oldBlobKey) await deleteRecordingBlobByKey(oldBlobKey);
  }catch{}
  // 将音频持久化到 IndexedDB，并写入 blobKey
  const blobKey = await putRecordingBlob('single', word.id, idx, formatDateKey(), blob);
  const url = localUrl || URL.createObjectURL(blob);
  // learn/task 分支：根据当前页面
  const isLearn = document.querySelector('.page-title')?.textContent?.includes('学习新词');
  saveRecording(kidId, word.id, idx, { url, localUrl, score, ts: Date.now(), transcript, blobKey }, formatDateKey(), isLearn ? 'learn' : 'task');
  // 同步到服务器（追加一条）
  try{
    await fetch('/api/progress/recording', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ day: formatDateKey(), wordId: String(word.id), url, score, ts: Date.now(), transcript, kind: isLearn ? 'learn' : 'task' })
    });
  }catch{}
  const dots = card.querySelectorAll('.dot');
  if(dots[idx]) dots[idx].classList.add('on');
  const list = card.querySelector('[data-rec-list]');
  const el = document.createElement('div');
  el.className = 'stat';
  el.innerHTML = `<audio controls src="${url}"></audio><span class="badge">得分 ${Math.round(score*100)}</span><button class="btn secondary" data-del-idx="${idx}">删除</button>`;
  list.appendChild(el);
  el.querySelector('[data-del-idx]').addEventListener('click', ()=>{
    // 删除本地文件
    try{
      const d = getKidDay(kidId, formatDateKey());
      const r = d.recordings[word.id]?.[idx];
      const lurl = r?.localUrl || '';
      const bkey = r?.blobKey || '';
      if(lurl) removeLocalRecordingFileByUrl(lurl);
      if(bkey) deleteRecordingBlobByKey(bkey);
    }catch{}
    deleteRecording(kidId, word.id, idx);
    el.remove();
    const dEl = card.querySelectorAll('.dot')[idx];
    if(dEl) dEl.classList.remove('on');
  });
  // 通知刷新提交按钮状态
  document.dispatchEvent(new CustomEvent('ww4k:record-updated'));
}

async function maybeSaveRecordingToLocalDir(blob, word){
  // 优先走后端保存，无需前端授权
  try{
    const form = new FormData();
    const ext = 'webm';
    form.append('audio', blob, `${(word.en||'record').toLowerCase()}.${ext}`);
    form.append('word', word.en || String(word.id||'word'));
    const resp = await fetch('/api/recordings', { method: 'POST', body: form });
    if(resp.ok){
      const data = await resp.json();
      if(data && data.ok && data.url){
        return data.url;
      }
    }
  }catch{}
  // 回退：若配置过目录，则写入本地目录；否则返回空串
  if(!recordsDirHandle){
    return '';
  }
  try{
    const safeName = (word.en || String(word.id)).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'') || `w-${word.id}`;
    const ts = new Date();
    const tsStr = `${ts.getFullYear()}${String(ts.getMonth()+1).padStart(2,'0')}${String(ts.getDate()).padStart(2,'0')}_${String(ts.getHours()).padStart(2,'0')}${String(ts.getMinutes()).padStart(2,'0')}${String(ts.getSeconds()).padStart(2,'0')}`;
    const rand = Math.random().toString(36).slice(2,8);
    const fname = `${safeName}_${tsStr}_${rand}.webm`;
    const fh = await recordsDirHandle.getFileHandle(fname, { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
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
    try{ await persistDirectoryHandle('recordsDir', recordsDirHandle); }catch{}
  }catch{ /* 用户取消 */ }
}

function findAvailableAttemptIndex(wordId){
  const d = getKidDay('single', formatDateKey());
  const arr = d.recordings[wordId] || [];
  for(let i=0;i<MAX_RECORDS;i++){
    if(!arr[i]) return i;
  }
  return -1;
}

function chooseAttemptIndex(wordId){
  const available = findAvailableAttemptIndex(wordId);
  if(available >= 0) return available;
  // 若无空位，找最早的 ts 进行替换
  const d = getKidDay('single', formatDateKey());
  const arr = d.recordings[wordId] || [];
  let bestIdx = 0;
  let bestTs = Number.MAX_SAFE_INTEGER;
  for(let i=0;i<Math.min(MAX_RECORDS, arr.length); i++){
    const ts = (arr[i]?.ts) || 0;
    if(ts < bestTs){ bestTs = ts; bestIdx = i; }
  }
  return bestIdx;
}

async function removeLocalRecordingFileByUrl(localUrl){
  if(!localUrl) return;
  // 优先走后端删除
  try{
    const name = (localUrl.split('/').pop()||'');
    if(name){
      await fetch(`/api/recordings/${encodeURIComponent(name)}`, { method: 'DELETE' });
      return;
    }
  }catch{}
  // 回退：前端已保存目录的情况下，尝试直接删除
  if(!recordsDirHandle) return;
  try{
    const m = localUrl.match(/assets\/records\/(.+)$/i) || localUrl.match(/assets\/records\/(.+)$/i);
    const name = m ? m[1] : (localUrl.split('/').pop()||'');
    if(!name) return;
    await recordsDirHandle.removeEntry(name);
  }catch{ /* 可能文件不存在或权限问题 */ }
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

  const cards = slice.map(w=>{
    const { preferred, fallback } = preferJpgUrlFast(w.img || '');
    return `
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
        <img class="img lazy" loading="lazy" data-src="${preferred}" data-fallback-src="${fallback}" alt="${w.en}" style="border-radius:16px"/>
      </div>
      <div class="pinyin">${w.pinyin}</div>
      <div class="cn">${w.cn}</div>
      <div class="sentence">
        <div class="en">${w.sent || ''}<button class="icon-btn btn-sent-say" title="读短句">🔊</button></div>
        <div class="cn">${w.sent_cn || ''}</div>
      </div>
    </div>`;
  }).join('');

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
  // 懒加载图片
  setupLazyImages(root);
  $('#prevAll').addEventListener('click', ()=>{ if(allPage>1){ allPage--; renderAllWords(root); } });
  $('#nextAll').addEventListener('click', ()=>{ const tp=Math.ceil(total/perPage); if(allPage<tp){ allPage++; renderAllWords(root); } });
}

async function renderProgress(root){
  // 服务器为准，失败再回退本地
  root.innerHTML = `
    <section class="view progress-wrap">
      <div class="page-title">学习进度</div>
      <div class="page-subtitle">加载中…</div>
      <div class="card">请稍候</div>
    </section>`;
  let serverDays = null;
  try{
    const resp = await fetch('/api/progress', { cache: 'no-store' });
    if(resp.ok){ const d = await resp.json(); if(d && d.ok) serverDays = d.days || {}; }
  }catch{}
  const useDays = serverDays || (getGlobal().days || {});
  const tab = state.progressKind === 'learn' ? 'learn' : 'task';
  const tabsHtml = `
    <div style="display:flex;gap:8px;justify-content:center;margin:8px 0">
      <button class="btn small ${tab==='task'?'':'secondary'}" id="btnTabTask">每日任务进度</button>
      <button class="btn small ${tab==='learn'?'':'secondary'}" id="btnTabLearn">学习新词进度</button>
    </div>`;
  const dayKeys = Object.keys(useDays).sort();
  let totalLearned = 0;
  const rows = dayKeys.map(dayKey=>{
    const d = (useDays[dayKey]||{})[tab] || {};
    const submittedCount = (d.submittedWordIds||[]).length;
    totalLearned += submittedCount;
    // 计算均分：遍历录音
    const scores=[];
    Object.values(d.recordings||{}).forEach(arr=>{ (arr||[]).forEach(r=>{ if(r && typeof r.score==='number') scores.push(Number(r.score)||0); }); });
    const passed = scores.length ? (scores.reduce((a,b)=>a+b,0)/scores.length) : 0;
    const taskInfo = d.taskCompleted ? `<span class=\"badge\">任务完成 ✓</span><span class=\"badge\">任务均分 ${Math.round((d.taskAvgScore||0)*100)}</span>` : `<span class=\"badge\">任务未完成</span>`;
    return `<div class=\"progress-row\"><div>${dayKey}</div><div class=\"stat\"><span class=\"badge\">${submittedCount} 词</span><span class=\"badge\">平均得分 ${Math.round(passed*100)}</span>${taskInfo}<button data-detail=\"${dayKey}\" class=\"btn small secondary\">查看详情</button></div></div>`;
  }).join('');
  root.innerHTML = `
    <section class="view progress-wrap">
      <div class="page-title">学习进度</div>
      <div class="page-subtitle">累计已认识 <b>${totalLearned}</b> 个单词</div>
      ${tabsHtml}
      <div class="card">${rows || '暂无记录'}</div>
    </section>`;
  // bind detail links
  $all('[data-detail]').forEach(a=>{
    a.addEventListener('click', (e)=>{
      const dayKey = e.currentTarget.getAttribute('data-detail');
      renderProgressDetail($('#app'), dayKey);
    });
  });
  const btnTabTask = document.getElementById('btnTabTask');
  const btnTabLearn = document.getElementById('btnTabLearn');
  if(btnTabTask){ btnTabTask.addEventListener('click', ()=>{ state.progressKind='task'; renderProgress(root); }); }
  if(btnTabLearn){ btnTabLearn.addEventListener('click', ()=>{ state.progressKind='learn'; renderProgress(root); }); }
}
async function renderProgressDetail(root, dayKey){
  root.innerHTML = `
    <section class=\"view\">
      <div class=\"page-title\">${dayKey} 详情</div>
      <div class=\"page-subtitle\">加载中…</div>
      <div class=\"grid\">请稍候</div>
      <div style=\"margin-top:16px;text-align:center\"><a href=\"#progress\" class=\"btn small\" id=\"btnBackProgress\">返回</a></div>
    </section>`;
  let d = null;
  try{
    const resp = await fetch(`/api/progress/${encodeURIComponent(dayKey)}`, { cache: 'no-store' });
    if(resp.ok){ const j = await resp.json(); if(j && j.ok) d = j.day || null; }
  }catch{}
  if(!d){
    const db = getGlobal();
    d = (db.days?.[dayKey] || {});
  }
  const tab = state.progressKind === 'learn' ? 'learn' : 'task';
  const branch = d[tab] || { recordings:{}, submittedWordIds:[], submittedAtMap:{} };
  const submittedSet = new Set((branch.submittedWordIds||[]).map(x=> String(x)));
  const items = Object.entries(branch.recordings||{})
    .filter(([wid])=> submittedSet.has(String(wid)))
    .map(([wid, recs])=>{
      const w = window.__WORDS__.find(x=> String(x.id)===String(wid));
      const submitTs = (branch.submittedAtMap?.[wid] ?? branch.submittedAtMap?.[String(wid)] ?? 0);
      const submitTimeStr = submitTs ? new Date(Number(submitTs)).toLocaleString() : '';
      const audios = (recs||[]).map((r)=> r ? `<div class=\"stat\"><audio controls src=\"${r.url}\"></audio><span class=\"badge\">${Math.round((Number(r.score||0))*100)}</span></div>` : '').join('');
      return `<div class=\"card\"><div class=\"word\">${w?.en || '未知'}</div><div class=\"cn\">${w?.cn || ''} · ${w?.pinyin || ''}</div>${submitTimeStr ? `<div class=\"badge\">提交时间 ${submitTimeStr}</div>` : ''}${audios}</div>`;
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

async function autoCheckCompleteTask(){
  const db = getGlobal();
  const d = db.days?.[state.todayKey] || { recordings: {} };
  const taskIds = (db.taskSelections?.[state.todayKey]?.wordIds) || [];
  if(taskIds.length !== TASK_COUNT) return;
  for(const id of taskIds){
    const recs = (d.recordings?.[id] || []).filter(Boolean);
    if(recs.length < MAX_RECORDS){
      return;
    }
  }
  // 所有任务词达标，计算均分并标记完成
  const scores = [];
  taskIds.forEach(id=>{
    const recs = d.recordings?.[id] || [];
    (recs||[]).forEach(r=>{ if(r && typeof r.score==='number') scores.push(r.score); });
  });
  const avg = scores.length ? (scores.reduce((a,b)=>a+b,0)/scores.length) : 0;
  setTaskAvgScore(avg, state.todayKey);
  markTaskCompleted(state.todayKey);
  try{
    fetch('/api/progress/complete-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ day: state.todayKey, taskAvgScore: avg })
    });
  }catch{}
}

function preferJpgUrl(src){
  if(!src) return { preferred: '', fallback: '' };
  const s = String(src);
  if(/\.jpg($|\?)/i.test(s)) return { preferred: s, fallback: s };
  // 优先尝试 .jpg 同名
  try{
    const u = new URL(s, location.origin);
    const parts = u.pathname.split('/');
    const name = parts.pop() || '';
    const base = name.replace(/\.[^.]*$/, '');
    const jpgName = base + '.jpg';
    const jpgPath = [...parts, jpgName].join('/');
    const preferred = (u.origin + jpgPath + (u.search||''));
    return { preferred, fallback: s };
  }catch{
    // 可能是相对路径
    const base = s.replace(/\.[^.]*($|\?.*)/, '');
    const preferred = base + '.jpg';
    return { preferred, fallback: s };
  }
}

function setupLazyImages(root){
  const imgs = root.querySelectorAll('img.lazy[data-src]');
  const loadImg = (img)=>{
    if(img.dataset.loaded) return;
    const src = img.getAttribute('data-src') || '';
    const fallback = img.getAttribute('data-fallback-src') || '';
    img.src = src;
    img.onerror = ()=>{ if(fallback && img.src !== fallback){ img.src = fallback; } };
    img.dataset.loaded = '1';
  };
  const io = new IntersectionObserver((entries)=>{
    entries.forEach(e=>{ if(e.isIntersecting) loadImg(e.target); });
  }, { rootMargin: '200px' });
  imgs.forEach(img=> io.observe(img));
}

// 快速版本：若已有 assets/words/*.jpg 则直接用；否则原样
function preferJpgUrlFast(src){
  if(!src) return { preferred: '', fallback: '' };
  const s = String(src);
  if(/^assets\/words\//i.test(s)){
    // 若不是 .jpg，替换为 .jpg 作为首选
    if(!/\.jpg($|\?)/i.test(s)){
      const preferred = s.replace(/\.[^.]*($|\?.*)/, '.jpg$1');
      return { preferred, fallback: s };
    }
  }
  return { preferred: s, fallback: s };
}

// 简单防抖：在导航到进度页时触发一次同步，避免重复请求
let __syncTimer = null;
function debounceSyncAll(){
  if(__syncTimer){ clearTimeout(__syncTimer); __syncTimer=null; }
  __syncTimer = setTimeout(()=>{ __syncTimer=null; syncAllProgressFromServer().then(()=>{ if(state.route==='progress') render(); }); }, 200);
}


async function syncProgressFromServer(dayKey){
  try{
    const resp = await fetch(`/api/progress/${encodeURIComponent(dayKey)}`, { cache: 'no-store' });
    if(!resp.ok) return;
    const data = await resp.json();
    if(!data || !data.ok) return;
    const serverDay = data.day || {};
    // 合并到本地
    const local = getGlobal();
    if(!local.days) local.days = {};
    const d = local.days[dayKey] || { learnedIds: [], recordings: {}, notes: '', submittedWordIds: [], submittedAtMap: {}, taskCompleted: false, taskAvgScore: 0 };
    // 合并录音：按 wordId 追加并裁剪为 3 条
    Object.entries(serverDay.recordings||{}).forEach(([wid, recs])=>{
      const a = Array.isArray(d.recordings[wid]) ? d.recordings[wid].filter(Boolean) : [];
      const b = (recs||[]).filter(Boolean);
      const merged = [...a, ...b].slice(-3);
      d.recordings[wid] = merged;
    });
    // 合并提交
    const sIds = new Set(serverDay.submittedWordIds||[]);
    d.submittedWordIds = Array.from(new Set([...(d.submittedWordIds||[]), ...sIds]));
    d.submittedAtMap = { ...(d.submittedAtMap||{}), ...(serverDay.submittedAtMap||{}) };
    // 任务
    d.taskCompleted = Boolean(d.taskCompleted) || Boolean(serverDay.taskCompleted);
    d.taskAvgScore = Math.max(Number(d.taskAvgScore||0), Number(serverDay.taskAvgScore||0));
    local.days[dayKey] = d;
    setGlobal(local);
  }catch{}
}

async function syncAllProgressFromServer(){
  if(__syncingAll) return;
  __syncingAll = true;
  try{
    const resp = await fetch('/api/progress', { cache: 'no-store' });
    if(!resp.ok) return;
    const data = await resp.json();
    if(!data || !data.ok) return;
    const days = data.days || {};
    const local = getGlobal();
    if(!local.days) local.days = {};
    for(const [dayKey, serverDay] of Object.entries(days)){
      const d = local.days[dayKey] || { learnedIds: [], recordings: {}, notes: '', submittedWordIds: [], submittedAtMap: {}, taskCompleted: false, taskAvgScore: 0 };
      Object.entries(serverDay.recordings||{}).forEach(([wid, recs])=>{
        const a = Array.isArray(d.recordings[wid]) ? d.recordings[wid].filter(Boolean) : [];
        const b = (recs||[]).filter(Boolean);
        const merged = [...a, ...b].slice(-3);
        d.recordings[wid] = merged;
      });
      const sIds = new Set(serverDay.submittedWordIds||[]);
      d.submittedWordIds = Array.from(new Set([...(d.submittedWordIds||[]), ...sIds]));
      d.submittedAtMap = { ...(d.submittedAtMap||{}), ...(serverDay.submittedAtMap||{}) };
      d.taskCompleted = Boolean(d.taskCompleted) || Boolean(serverDay.taskCompleted);
      d.taskAvgScore = Math.max(Number(d.taskAvgScore||0), Number(serverDay.taskAvgScore||0));
      local.days[dayKey] = d;
    }
    setGlobal(local);
  }catch{}
  finally{ __syncingAll = false; }
}

