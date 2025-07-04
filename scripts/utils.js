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
  const synth = window.speechSynthesis;
  if(!synth || typeof SpeechSynthesisUtterance === 'undefined') return;

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

  // 如果还没加载到 voices，等到 onvoiceschanged 再播，超时兜底
  let voices = [];
  try{ voices = synth.getVoices() || []; }catch{}
  if(voices.length === 0 && 'onvoiceschanged' in synth){
    let done = false;
    const fire = ()=>{ if(!done){ done=true; synth.onvoiceschanged=null; speakNow(); } };
    synth.onvoiceschanged = fire;
    try{ synth.getVoices(); }catch{}
    setTimeout(fire, 700);
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


