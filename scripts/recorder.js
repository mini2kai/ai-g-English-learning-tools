/* Microphone recording and simple pronunciation scoring using Web Speech API */
import { playAudioBlob, cosineSimilarity } from './utils.js';

export class MicRecorder{
  constructor(){
    this.mediaRecorder = null;
    this.chunks = [];
  }

  async start(){
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.mediaRecorder = new MediaRecorder(stream);
    this.chunks = [];
    return new Promise(resolve =>{
      this.mediaRecorder.ondataavailable = e=> this.chunks.push(e.data);
      this.mediaRecorder.onstart = ()=> resolve();
      this.mediaRecorder.start();
    });
  }

  async stop(){
    if(!this.mediaRecorder) return null;
    return new Promise(resolve =>{
      this.mediaRecorder.onstop = ()=>{
        const blob = new Blob(this.chunks, { type: 'audio/webm' });
        resolve(blob);
      };
      this.mediaRecorder.stop();
    });
  }
}

/* Naive scoring using SpeechRecognition transcript similarity to target word */
export async function scorePronunciation(targetWord){
  const hasAPI = 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;
  if(!hasAPI){
    // Fallback: cannot score; return neutral score
    return { score: 0.5, transcript: '' };
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const sr = new SR();
  sr.lang = 'en-US';
  sr.interimResults = false;
  sr.maxAlternatives = 1;

  const result = await new Promise(resolve=>{
    let resolved=false;
    const timer = setTimeout(()=>{ if(!resolved) resolve({ transcript:'', confidence:0 }); }, 4000);
    sr.onresult = e=>{
      resolved = true; clearTimeout(timer);
      const t = e.results[0][0];
      resolve({ transcript: t.transcript || '', confidence: t.confidence || 0 });
    };
    sr.onerror = ()=>{ if(!resolved){ resolved=true; resolve({ transcript:'', confidence:0 }); } };
    sr.onend = ()=>{ /* noop */ };
    try{ sr.start(); }catch{ resolve({ transcript:'', confidence:0 }); }
  });

  const a = normalizeVector(targetWord);
  const b = normalizeVector(result.transcript || '');
  const cos = cosineSimilarity(a,b);
  const finalScore = Math.max(0, Math.min(1, 0.5*cos + 0.5*result.confidence));
  return { score: finalScore, transcript: result.transcript };
}

function normalizeVector(text){
  const s = text.toLowerCase().replace(/[^a-z]/g,'');
  const vector = new Array(26).fill(0);
  for(const ch of s){
    const idx = ch.charCodeAt(0)-97; if(idx>=0 && idx<26) vector[idx] += 1;
  }
  return vector;
}


