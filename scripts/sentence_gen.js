// Elegant short sentence generator for a given English word (optionally with Chinese)
// Heuristic rules + themed templates; no external APIs.

function pickByHash(word, list){
  if(!list || list.length===0) return '';
  const s = String(word||'');
  let h = 0;
  for(let i=0;i<s.length;i++){ h = (h*31 + s.charCodeAt(i)) >>> 0; }
  return list[h % list.length];
}

function isLikelyVerb(word){
  const verbs = new Set(['be','have','go','do','make','take','see','come','know','get','give','find','think','tell','become','show','leave','feel','put','bring','begin','keep','hold','write','stand','hear','let','mean','set','meet','run','play','walk','open','close','drink','eat','love','like','smile','dance','sing','read','study','learn','draw','paint']);
  const w = String(word||'').toLowerCase();
  if(verbs.has(w)) return true;
  // naive suffix hints
  return /e$|n$|t$|k$|g$|p$|m$/.test(w) && w.length<=6; // very rough guess for common short verbs
}

function isLikelyAdjective(word){
  const adjectives = new Set(['bright','soft','sweet','warm','cool','quiet','gentle','kind','brave','calm','fresh','green','blue','golden','little','small','happy','lovely','clean','light']);
  const w = String(word||'').toLowerCase();
  if(adjectives.has(w)) return true;
  return /(ful|ous|ive|al|y)$/.test(w);
}

function thirdPersonVerb(word){
  const w = String(word||'');
  const lw = w.toLowerCase();
  if(lw==='be') return 'is';
  if(lw==='have') return 'has';
  if(lw==='do') return 'does';
  if(lw==='go') return 'goes';
  if(/(s|x|z|ch|sh)$/i.test(lw)) return w + 'es';
  if(/y$/i.test(lw) && !/[aeiou]y$/i.test(lw)) return w.slice(0,-1) + 'ies';
  return w + 's';
}

function aOrAn(word){
  const w = String(word||'').trim().toLowerCase();
  if(!w) return 'a';
  return /^[aeiou]/.test(w) ? 'an' : 'a';
}

function buildNounSentences(word){
  const det = aOrAn(word);
  const candidates = [
    `The ${word} rests in the gentle light.`,
    `Under the morning sky, ${det} ${word} quietly shines.`,
    `In the hush of daybreak, ${det} ${word} feels almost poetic.`,
    `A breeze passes; the ${word} stays calm and bright.`,
    `Between light and shadow, ${det} ${word} whispers of simple joy.`,
  ];
  return candidates;
}

function buildVerbSentences(word){
  const v3 = thirdPersonVerb(word);
  const candidates = [
    `She ${v3} with quiet grace.`,
    `He ${v3} as the soft wind drifts by.`,
    `It ${v3}, and the moment turns gentle.`,
    `Sometimes the heart ${v3} before the mind knows.`,
    `In small steps, one ${word}s and finds light.`,
  ];
  return candidates;
}

function buildAdjSentences(word){
  const candidates = [
    `So ${word} that even silence smiles.`,
    `A ${word} touch brightens the day.`,
    `How ${word} the world looks at dawn.`,
    `In a ${word} way, time grows tender.`,
    `Every little thing becomes ${word} for a while.`,
  ];
  return candidates;
}

function toChineseSentence(en, cnHint){
  const cn = (cnHint||'').trim();
  const nounCands = [
    `清晨的微光里，${cn||en}安静而明亮。`,
    `微风拂过，${cn||en}静静伫立。`,
    `光影之间，${cn||en}低声诉说着温柔。`,
    `在柔软的空气里，${cn||en}显得格外从容。`,
    `一缕清风，一份安宁，${cn||en}恰到好处。`,
  ];
  const verbCands = [
    `${cn||en}着着，心也跟着轻盈起来。`,
    `当它${cn||en}时，时间变得温柔。`,
    `轻轻地${cn||en}，不惊不扰。`,
    `不疾不徐地${cn||en}，像光在流动。`,
    `一步一步地${cn||en}，去遇见明亮。`,
  ];
  const adjCands = [
    `如此${cn||en}，连沉默都弯了眉眼。`,
    `一点点${cn||en}，一天就变得可爱。`,
    `${cn||en}里藏着不动声色的温柔。`,
    `原来，${cn||en}也可以是时光的礼物。`,
    `让日子多一点${cn||en}，再多一点。`,
  ];
  return { nounCands, verbCands, adjCands };
}

export function generateSentenceForWord(en, cn=''){
  const word = String(en||'').trim();
  if(!word){
    return { en: '', cn: '' };
  }
  const likelyVerb = isLikelyVerb(word);
  const likelyAdj = !likelyVerb && isLikelyAdjective(word);

  let enList;
  let cnList;
  if(likelyVerb){
    enList = buildVerbSentences(word);
    cnList = toChineseSentence(word, cn).verbCands;
  }else if(likelyAdj){
    enList = buildAdjSentences(word);
    cnList = toChineseSentence(word, cn).adjCands;
  }else{
    enList = buildNounSentences(word);
    cnList = toChineseSentence(word, cn).nounCands;
  }

  return {
    en: pickByHash(word, enList),
    cn: pickByHash(word, cnList),
  };
}


