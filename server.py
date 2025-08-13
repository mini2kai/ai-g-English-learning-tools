import os
import re
import argparse
from datetime import datetime
import json
import threading
import time
import secrets
import random
import string
import secrets
from flask import Flask, request, jsonify, send_from_directory, abort, redirect, url_for, make_response


ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
ASSETS_DIR = os.path.join(ROOT_DIR, 'assets')
RECORDS_DIR = os.path.join(ASSETS_DIR, 'records')
DATA_DIR = os.path.join(ROOT_DIR, 'data')
PROGRESS_FILE = os.path.join(DATA_DIR, 'progress.json')

os.makedirs(RECORDS_DIR, exist_ok=True)
os.makedirs(DATA_DIR, exist_ok=True)


def sanitize_basename(name: str) -> str:
    if not name:
        return ''
    base = re.sub(r"[^a-zA-Z0-9\-_.]", '-', name)
    return base.strip('-._')[:128]

def _tts_filename(text: str, lang: str) -> str:
    base = sanitize_basename(text.lower().replace(' ', '-')) or 'tts'
    return f"{base}.{lang}.mp3"


app = Flask(__name__, static_folder='.', static_url_path='')
_progress_lock = threading.RLock()
_recent_events = {}

# TTS mp3 缓存目录
TTS_DIR = os.path.join(ASSETS_DIR, 'tts')
os.makedirs(TTS_DIR, exist_ok=True)

# 简单的英语 26 字母与数字内置音频（可选：项目可预置静态 mp3）


AUTO_MOBILE_REDIRECT = True  # 可配置开关：True 则移动端UA自动跳转 mobile.html


def _is_mobile_ua(ua: str) -> bool:
    if not ua:
        return False
    s = ua.lower()
    keywords = ['iphone','ipod','ipad','android','mobile','windows phone','blackberry','opera mini','opera mobi','huawei','miui']
    return any(k in s for k in keywords)


@app.route('/')
def index():
    pref = request.cookies.get('ww_view','')
    if pref == 'mobile':
        return send_from_directory(ROOT_DIR, 'mobile.html')
    ua = request.headers.get('User-Agent', '')
    ref = (request.headers.get('Referer') or '').lower()
    is_wechat = 'micromessenger' in ua.lower() or 'wxwork' in ua.lower()
    http_ver = (request.environ.get('SERVER_PROTOCOL') or '').upper()
    if AUTO_MOBILE_REDIRECT and _is_mobile_ua(ua):
        # WeChat 安全扫描/HTTP/1.0/某些内嵌 WebView 对 302 兼容较差，直接 200 返回移动页
        if is_wechat or http_ver.startswith('HTTP/1.0') or 'weixin110.qq.com' in ref:
            return send_from_directory(ROOT_DIR, 'mobile.html')
        return redirect(url_for('serve_mobile'))
    return send_from_directory(ROOT_DIR, 'index.html')


@app.route('/mobile')
def serve_mobile():
    pref = request.cookies.get('ww_view','')
    if pref == 'desktop':
        return redirect(url_for('index'))
    return send_from_directory(ROOT_DIR, 'mobile.html')


@app.route('/switch-view', methods=['GET'])
def switch_view():
    view = (request.args.get('view') or '').lower()
    next_url = request.args.get('next') or '/'
    if view not in ('mobile','desktop'):
        return redirect(next_url)
    resp = make_response(redirect(next_url))
    # 记住选择 30 天
    resp.set_cookie('ww_view', view, max_age=30*24*3600, samesite='Lax')
    return resp


@app.post('/api/recordings')
def upload_recording():
    if 'audio' not in request.files:
        return jsonify({ 'ok': False, 'error': 'missing file field "audio"' }), 400
    file = request.files['audio']
    # derive safe name from form fields (word or wordId)
    raw_word = request.form.get('word') or request.form.get('wordId') or 'record'
    base = sanitize_basename(str(raw_word).lower().replace(' ', '-')) or 'record'
    ts = datetime.now().strftime('%Y%m%d_%H%M%S')
    rnd = secrets.token_hex(3)
    # default extension .webm; allow client-provided filename's extension if present
    ext = 'webm'
    if file.filename and '.' in file.filename:
        ext = sanitize_basename(file.filename.rsplit('.', 1)[-1].lower()) or 'webm'
    filename = f"{base}_{ts}_{rnd}.{ext}"
    path = os.path.join(RECORDS_DIR, filename)
    file.save(path)
    url = f"assets/records/{filename}"
    return jsonify({ 'ok': True, 'url': url, 'filename': filename })


@app.delete('/api/recordings/<path:filename>')
def delete_recording(filename: str):
    # prevent path traversal
    safe = sanitize_basename(os.path.basename(filename))
    if not safe:
        return jsonify({ 'ok': False, 'error': 'invalid filename' }), 400
    path = os.path.join(RECORDS_DIR, safe)
    if not os.path.isfile(path):
        return jsonify({ 'ok': True, 'deleted': False })
    try:
        os.remove(path)
        return jsonify({ 'ok': True, 'deleted': True })
    except OSError:
        return jsonify({ 'ok': False, 'error': 'delete_failed' }), 500


def read_progress():
    if not os.path.isfile(PROGRESS_FILE):
        return { 'days': {} }
    try:
        with _progress_lock:
            with open(PROGRESS_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
            # 兼容旧结构：将顶层字段迁移到 task 分支
            if isinstance(data, dict) and 'days' in data:
                changed = False
                for day_key, day in data['days'].items():
                    if not isinstance(day, dict):
                        continue
                    if 'task' not in day or 'learn' not in day:
                        # 初始化新结构
                        new_day = {
                            'task': {
                                'recordings': {},
                                'submittedWordIds': [],
                                'submittedAtMap': {},
                                'taskCompleted': False,
                                'taskAvgScore': 0
                            },
                            'learn': {
                                'recordings': {},
                                'submittedWordIds': [],
                                'submittedAtMap': {}
                            }
                        }
                        # 旧字段迁移到 task
                        if 'recordings' in day:
                            new_day['task']['recordings'] = day.get('recordings') or {}
                        if 'submittedWordIds' in day:
                            new_day['task']['submittedWordIds'] = day.get('submittedWordIds') or []
                        if 'submittedAtMap' in day:
                            new_day['task']['submittedAtMap'] = day.get('submittedAtMap') or {}
                        if 'taskCompleted' in day:
                            new_day['task']['taskCompleted'] = bool(day.get('taskCompleted'))
                        if 'taskAvgScore' in day:
                            try:
                                new_day['task']['taskAvgScore'] = float(day.get('taskAvgScore') or 0)
                            except Exception:
                                new_day['task']['taskAvgScore'] = 0
                        data['days'][day_key] = new_day
                        changed = True
                if changed:
                    write_progress(data)
            return data
    except Exception:
        return { 'days': {} }


def write_progress(data: dict) -> None:
    # 使用全局锁避免 Windows 下被占用导致替换失败
    with _progress_lock:
        suffix = ''.join(random.choices(string.ascii_lowercase + string.digits, k=6))
        tmp_path = f"{PROGRESS_FILE}.tmp.{suffix}"
        with open(tmp_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False)
            try:
                f.flush()
                os.fsync(f.fileno())
            except Exception:
                pass
        # 重试替换，解决 WinError 32 临时占用
        last_err = None
        for _ in range(12):
            try:
                os.replace(tmp_path, PROGRESS_FILE)
                return
            except Exception as e:
                last_err = e
                time.sleep(0.05)
        # 最后一次尝试，失败则抛出
        os.replace(tmp_path, PROGRESS_FILE)


def ensure_day(data: dict, day_key: str) -> dict:
    if 'days' not in data:
        data['days'] = {}
    if day_key not in data['days']:
        data['days'][day_key] = {
            'task': {
                'recordings': {},
                'submittedWordIds': [],
                'submittedAtMap': {},
                'taskCompleted': False,
                'taskAvgScore': 0
            },
            'learn': {
                'recordings': {},
                'submittedWordIds': [],
                'submittedAtMap': {}
            }
        }
    d = data['days'][day_key]
    # 保证新结构键存在
    d.setdefault('task', {})
    d.setdefault('learn', {})
    d['task'].setdefault('recordings', {})
    d['task'].setdefault('submittedWordIds', [])
    d['task'].setdefault('submittedAtMap', {})
    d['task'].setdefault('taskCompleted', False)
    d['task'].setdefault('taskAvgScore', 0)
    d['learn'].setdefault('recordings', {})
    d['learn'].setdefault('submittedWordIds', [])
    d['learn'].setdefault('submittedAtMap', {})
    return d


@app.get('/api/progress/<day_key>')
def get_progress(day_key: str):
    data = read_progress()
    d = ensure_day(data, day_key)
    return jsonify({ 'ok': True, 'day': d, 'dayKey': day_key })


@app.post('/api/progress/recording')
def post_progress_recording():
    payload = request.get_json(silent=True) or {}
    day_key = str(payload.get('day') or '')
    word_id = str(payload.get('wordId') or '')
    url = str(payload.get('url') or '')
    score = float(payload.get('score') or 0)
    ts = int(payload.get('ts') or 0)
    transcript = payload.get('transcript') or ''
    kind = (payload.get('kind') or 'task').strip().lower()
    if kind not in ('task', 'learn'):
        kind = 'task'
    if not day_key or not word_id or not url:
        return jsonify({ 'ok': False, 'error': 'missing_fields' }), 400
    data = read_progress()
    d = ensure_day(data, day_key)
    recs = d[kind]['recordings'].setdefault(word_id, [])
    # 去重：相同 url+ts 不重复追加
    for r in recs:
        if r and r.get('url') == url and int(r.get('ts') or 0) == int(ts):
            return jsonify({ 'ok': True, 'dedup': True })
    recs.append({ 'url': url, 'score': score, 'ts': ts, 'transcript': transcript })
    # 仅保留最近 3 条
    if len(recs) > 3:
        d[kind]['recordings'][word_id] = recs[-3:]
    write_progress(data)
    return jsonify({ 'ok': True })


@app.post('/api/progress/submit-word')
def post_progress_submit_word():
    payload = request.get_json(silent=True) or {}
    day_key = str(payload.get('day') or '')
    word_id = str(payload.get('wordId') or '')
    ts = int(payload.get('ts') or 0)
    kind = (payload.get('kind') or 'task').strip().lower()
    if kind not in ('task', 'learn'):
        kind = 'task'
    if not day_key or not word_id:
        return jsonify({ 'ok': False, 'error': 'missing_fields' }), 400
    # 限流：同一 (day, word, kind) 1 秒内重复提交忽略
    key = f"submit|{day_key}|{kind}|{word_id}"
    now = time.time()
    last = _recent_events.get(key, 0)
    if now - last < 1.0:
        return jsonify({ 'ok': True, 'throttled': True })
    _recent_events[key] = now

    data = read_progress()
    d = ensure_day(data, day_key)
    if word_id not in d[kind]['submittedWordIds']:
        d[kind]['submittedWordIds'].append(word_id)
    d[kind]['submittedAtMap'][word_id] = ts or int(datetime.now().timestamp() * 1000)
    write_progress(data)
    return jsonify({ 'ok': True })


@app.post('/api/progress/complete-task')
def post_progress_complete_task():
    payload = request.get_json(silent=True) or {}
    day_key = str(payload.get('day') or '')
    avg = float(payload.get('taskAvgScore') or 0)
    if not day_key:
        return jsonify({ 'ok': False, 'error': 'missing_day' }), 400
    data = read_progress()
    d = ensure_day(data, day_key)
    d['task']['taskCompleted'] = True
    d['task']['taskAvgScore'] = avg
    write_progress(data)
    return jsonify({ 'ok': True })


@app.get('/api/progress')
def get_all_progress():
    data = read_progress()
    # 返回所有天的进度
    return jsonify({ 'ok': True, 'days': data.get('days', {}) })


@app.get('/api/tts')
def api_tts():
    text = (request.args.get('text') or '').strip()
    lang = (request.args.get('lang') or 'en').strip()
    if not text:
        return abort(400)
    mp3_name = _tts_filename(text, lang)
    mp3_path = os.path.join(TTS_DIR, mp3_name)
    wav_name = mp3_name.replace('.mp3', '.wav')
    wav_path = os.path.join(TTS_DIR, wav_name)

    # 1) 命中缓存
    if os.path.isfile(mp3_path):
        return send_from_directory(TTS_DIR, mp3_name, mimetype='audio/mpeg', as_attachment=False)
    if os.path.isfile(wav_path):
        return send_from_directory(TTS_DIR, wav_name, mimetype='audio/wav', as_attachment=False)

    # 2) 优先 gTTS（在线）
    try:
        from gtts import gTTS
        tts = gTTS(text=text, lang=lang)
        tts.save(mp3_path)
        return send_from_directory(TTS_DIR, mp3_name, mimetype='audio/mpeg', as_attachment=False)
    except Exception:
        pass

    # 3) 回退 pyttsx3（离线，输出 wav）
    try:
        import pyttsx3
        engine = pyttsx3.init()
        try:
            # 尽量选择英语音色
            for v in engine.getProperty('voices'):
                if 'en' in (v.languages or [b'en'])[0].decode(errors='ignore') or 'en' in (v.name or '').lower():
                    engine.setProperty('voice', v.id)
                    break
        except Exception:
            pass
        engine.save_to_file(text, wav_path)
        engine.runAndWait()
        if os.path.isfile(wav_path):
            return send_from_directory(TTS_DIR, wav_name, mimetype='audio/wav', as_attachment=False)
    except Exception:
        pass

    return jsonify({'ok': False, 'error': 'tts_unavailable'}), 503


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', default=8080, type=int)
    args = parser.parse_args()
    app.run(host=args.host, port=args.port, debug=False)


if __name__ == '__main__':
    main()


