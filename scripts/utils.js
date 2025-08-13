/* Utility helpers */
export function formatDateKey(date = new Date()){
  const y = date.getFullYear();
  const m = String(date.getMonth()+1).padStart(2,'0');
  const d = String(date.getDate()).padStart(2,'0');
  return `${y}-${m}-${d}`;
}

export function $(selector, root=document){
  return root.querySelector(selector);
}
export function $all(selector, root=document){
  return Array.from(root.querySelectorAll(selector));
}

export function chunk(array, size){
  const result=[];
  for(let i=0;i<array.length;i+=size){
    result.push(array.slice(i, i+size));
  }
  return result;
}

export function playAudioBlob(blob){
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.play();
  audio.onended = () => URL.revokeObjectURL(url);
}

export function speak(text){
  const content = String(text || '').trim();
  if(!content) return;
  const ua = (navigator.userAgent||'').toLowerCase();
  const isWeChat = /micromessenger|wxwork/.test(ua);
  const isIOS = /iphone|ipad|ipod/.test(ua);
  const isAndroid = /android/.test(ua);
  const isMobile = isWeChat || isIOS || isAndroid || /mobile/.test(ua);
  const synth = window.speechSynthesis;
  const playTtsWithGuard = (url)=>{
    try{
      const audio = new Audio(url);
      audio.setAttribute?.('playsinline','');
      audio.setAttribute?.('webkit-playsinline','');
      audio.preload = 'auto';
      audio.crossOrigin = 'anonymous';
      let settled = false;
      const clear = ()=>{
        audio.removeEventListener('playing', onok);
        audio.removeEventListener('canplay', onok);
        audio.removeEventListener('error', onerr);
      };
      const onok = ()=>{ if(!settled){ settled=true; clear(); } };
      const onerr = ()=>{ if(!settled){ settled=true; clear(); alert('暂不支持发音'); } };
      audio.addEventListener('playing', onok);
      audio.addEventListener('canplay', onok);
      audio.addEventListener('error', onerr);
      const timer = setTimeout(()=>{ if(!settled){ settled=true; clear(); try{ audio.pause(); }catch{} alert('暂不支持发音'); } }, 1800);
      audio.play().catch(()=>{ /* 某些内核会抛出但随后进入 playing */ });
      audio.addEventListener('playing', ()=> clearTimeout(timer), { once: true });
    }catch{ alert('暂不支持发音'); }
  };
  // 策略：移动端优先走后端 TTS（尤其是微信内核），桌面端优先本地合成
  if(isMobile && !isWeChat){
    const url = `/api/tts?text=${encodeURIComponent(content)}&lang=en&_=${Date.now()}`;
    playTtsWithGuard(url);
    return;
  }
  // WeChat 或无合成能力时，直接走后端 TTS
  if(isWeChat || !synth || typeof SpeechSynthesisUtterance === 'undefined'){
    const url = `/api/tts?text=${encodeURIComponent(content)}&lang=en&_=${Date.now()}`;
    playTtsWithGuard(url);
    return;
  }

  const speakNow = () => {
    try{ if(synth.speaking) synth.cancel(); if(synth.paused) synth.resume(); }catch{}
    const u = new SpeechSynthesisUtterance(content);
    u.lang = 'en-US';
    u.rate = 1.0;
    u.pitch = 1.0;
    try{
      const voices = synth.getVoices ? synth.getVoices() : [];
      const en = voices.find(v=> /en[-_]?US/i.test(v.lang)) || voices.find(v=> /en/i.test(v.lang));
      if(en) u.voice = en;
    }catch{}
    synth.speak(u);
  };

  // 如果还没加载到 voices，等到 onvoiceschanged 再播，超时兜底回退到 TTS
  let voices = [];
  try{ voices = synth.getVoices() || []; }catch{}
  if(voices.length === 0 && 'onvoiceschanged' in synth){
    let done = false;
    const fire = ()=>{ if(!done){ done=true; synth.onvoiceschanged=null; speakNow(); } };
    synth.onvoiceschanged = fire;
    try{ synth.getVoices(); }catch{}
    setTimeout(fire, 1200);
    // 进一步兜底：若 2 秒后仍未触发，走服务端 TTS
    setTimeout(()=>{
      if(!done){
        try{
          const audio = new Audio(`/api/tts?text=${encodeURIComponent(content)}&lang=en`);
          audio.preload = 'auto';
          audio.crossOrigin = 'anonymous';
          audio.play().catch(()=>{});
        }catch{}
      }
    }, 2000);
  }else{
    speakNow();
  }
}

export function cosineSimilarity(a,b){
  const len = Math.min(a.length,b.length);
  let dot=0, na=0, nb=0;
  for(let i=0;i<len;i++){
    dot += a[i]*b[i];
    na += a[i]*a[i];
    nb += b[i]*b[i];
  }
  return dot / (Math.sqrt(na)*Math.sqrt(nb) || 1);
}


