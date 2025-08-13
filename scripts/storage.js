/* Local progress storage per kid */
import { formatDateKey } from './utils.js';

const STORAGE_KEY = 'ww4k.v1';
const IDB_NAME = 'ww4k.db';
const IDB_STORE = 'recordings';
const IDB_FS_STORE = 'fsHandles';

function openIdb(){
  return new Promise((resolve, reject)=>{
    const req = indexedDB.open(IDB_NAME, 2);
    req.onupgradeneeded = ()=>{
      const db = req.result;
      if(!db.objectStoreNames.contains(IDB_STORE)){
        db.createObjectStore(IDB_STORE);
      }
      if(!db.objectStoreNames.contains(IDB_FS_STORE)){
        db.createObjectStore(IDB_FS_STORE);
      }
    };
    req.onsuccess = ()=> resolve(req.result);
    req.onerror = ()=> reject(req.error);
  });
}

async function idbPut(key, value){
  const db = await openIdb();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.oncomplete = ()=> resolve();
    tx.onerror = ()=> reject(tx.error);
    tx.objectStore(IDB_STORE).put(value, key);
  });
}

async function idbGet(key){
  const db = await openIdb();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = ()=> resolve(req.result);
    req.onerror = ()=> reject(req.error);
  });
}

async function idbDelete(key){
  const db = await openIdb();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.oncomplete = ()=> resolve();
    tx.onerror = ()=> reject(tx.error);
    tx.objectStore(IDB_STORE).delete(key);
  });
}

function readAll(){
  const raw = localStorage.getItem(STORAGE_KEY);
  if(!raw) return { days: {}, lastWordIdx: 0 };
  try{
    const obj = JSON.parse(raw);
    // schema migration: kids -> days
    if(!obj.days){
      const days = {};
      if(obj.kids){
        Object.values(obj.kids).forEach(kidDays=>{
          Object.entries(kidDays||{}).forEach(([dayKey, dayData])=>{
            if(!days[dayKey]) days[dayKey] = { learnedIds: [], recordings: {}, notes: '' };
            const target = days[dayKey];
            // merge learnedIds
            (dayData.learnedIds||[]).forEach(id=>{ if(!target.learnedIds.includes(id)) target.learnedIds.push(id); });
            // merge recordings
            Object.entries(dayData.recordings||{}).forEach(([wid, recs])=>{
              if(!target.recordings[wid]) target.recordings[wid] = [];
              (recs||[]).forEach((r,idx)=>{ if(r) target.recordings[wid][idx] = r; });
            });
          });
        });
      }
      const migrated = { days, lastWordIdx: obj.lastWordIdx || 0 };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
      return migrated;
    }
    return obj;
  }catch{
    return { days: {}, lastWordIdx: 0 };
  }
}

function writeAll(data){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

export function getKidDay(kidId, dayKey=formatDateKey()){
  const db = readAll();
  if(!db.days) db.days = {};
  if(!db.days[dayKey]) db.days[dayKey] = { learnedIds: [], recordings: {}, learnRecordings: {}, notes: '', submittedWordIds: [], submittedAtMap: {}, taskCompleted: false, taskAvgScore: 0 };
  // 旧数据补字段
  const day = db.days[dayKey];
  if(!day.submittedWordIds) day.submittedWordIds = [];
  if(!day.submittedAtMap) day.submittedAtMap = {};
  if(!day.learnRecordings) day.learnRecordings = {};
  if(typeof day.taskCompleted !== 'boolean') day.taskCompleted = false;
  if(typeof day.taskAvgScore !== 'number') day.taskAvgScore = 0;
  writeAll(db);
  return db.days[dayKey];
}

export function saveKidDay(kidId, dayKey, dayData){
  const db = readAll();
  if(!db.days) db.days = {};
  db.days[dayKey] = dayData;
  writeAll(db);
}

export function getGlobal(){
  return readAll();
}

export function setGlobal(updater){
  const db = readAll();
  const next = typeof updater === 'function' ? updater(db) : updater;
  writeAll(next);
}

export function markTaskCompleted(dayKey=formatDateKey()){
  const db = readAll();
  if(!db.days) db.days = {};
  if(!db.days[dayKey]) db.days[dayKey] = { learnedIds: [], recordings: {}, notes: '', submittedWordIds: [], taskCompleted: false, taskAvgScore: 0 };
  db.days[dayKey].taskCompleted = true;
  writeAll(db);
}

export function setTaskAvgScore(avg, dayKey=formatDateKey()){
  const db = readAll();
  if(!db.days) db.days = {};
  if(!db.days[dayKey]) db.days[dayKey] = { learnedIds: [], recordings: {}, notes: '', submittedWordIds: [], taskCompleted: false, taskAvgScore: 0 };
  db.days[dayKey].taskAvgScore = Number(avg)||0;
  writeAll(db);
}

export function recordWordLearned(kidId, wordId, dayKey=formatDateKey()){
  const day = getKidDay(kidId, dayKey);
  if(!day.learnedIds.includes(wordId)){
    day.learnedIds.push(wordId);
  }
  saveKidDay(kidId, dayKey, day);
}

export function submitWord(kidId, wordId, dayKey=formatDateKey(), kind='task'){
  const day = getKidDay(kidId, dayKey);
  if(!day.submittedWordIds) day.submittedWordIds = [];
  if(!day.submittedWordIds.includes(wordId)){
    day.submittedWordIds.push(wordId);
  }
  if(!day.learnedIds.includes(wordId)){
    day.learnedIds.push(wordId);
  }
  if(!day.submittedAtMap) day.submittedAtMap = {};
  const widKey = String(wordId);
  day.submittedAtMap[widKey] = Date.now();
  saveKidDay(kidId, dayKey, day);
}

export function saveRecording(kidId, wordId, attemptIndex, blobInfo, dayKey=formatDateKey(), kind='task'){
  const day = getKidDay(kidId, dayKey);
  const branch = kind==='learn' ? (day.learnRecordings) : (day.recordings);
  if(!branch[wordId]) branch[wordId] = [];
  branch[wordId][attemptIndex] = blobInfo; // { blobKey|url, score, ts }
  saveKidDay(kidId, dayKey, day);
}

export function deleteRecording(kidId, wordId, attemptIndex, dayKey=formatDateKey(), kind='task'){
  const day = getKidDay(kidId, dayKey);
  const branch = kind==='learn' ? (day.learnRecordings) : (day.recordings);
  if(branch[wordId]){
    branch[wordId][attemptIndex] = null;
  }
  saveKidDay(kidId, dayKey, day);
}

export async function putRecordingBlob(kidId, wordId, attemptIndex, dayKey, blob){
  const key = `${dayKey}|${kidId}|${wordId}|${attemptIndex}`;
  await idbPut(key, blob);
  return key;
}

export async function getRecordingBlobByKey(blobKey){
  try{ return await idbGet(blobKey); }catch{ return null; }
}

export async function deleteRecordingBlobByKey(blobKey){
  try{ await idbDelete(blobKey); }catch{}
}

// Persist FileSystem directory handles so用户无需每次都重新授权
export async function persistDirectoryHandle(kind, handle){
  const db = await openIdb();
  return new Promise((resolve, reject)=>{
    try{
      const tx = db.transaction(IDB_FS_STORE, 'readwrite');
      tx.oncomplete = ()=> resolve();
      tx.onerror = ()=> reject(tx.error);
      tx.objectStore(IDB_FS_STORE).put(handle, kind);
    }catch(e){ resolve(); }
  });
}

export async function loadDirectoryHandle(kind){
  const db = await openIdb();
  return new Promise((resolve, reject)=>{
    try{
      const tx = db.transaction(IDB_FS_STORE, 'readonly');
      const req = tx.objectStore(IDB_FS_STORE).get(kind);
      req.onsuccess = ()=> resolve(req.result || null);
      req.onerror = ()=> reject(req.error);
    }catch(e){ resolve(null); }
  });
}


