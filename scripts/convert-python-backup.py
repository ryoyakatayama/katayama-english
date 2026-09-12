"""Offline, read-only conversion of a Python data folder to PWA backup v1."""
import argparse
import json
from pathlib import Path
import sqlite3
import time
import uuid

def convert(folder, name):
    dbpath = (folder / 'learning.sqlite3').resolve()
    if not dbpath.is_file(): raise ValueError('learning.sqlite3 が見つかりません。')
    db = sqlite3.connect(dbpath.as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    profile_id = uuid.uuid4().hex
    settings = {'levels': ['basic'], 'mode': 'random', 'count': 10, 'seconds': 15, 'dailyGoal': 50}
    config = folder / 'settings.json'
    if config.exists():
        old = json.loads(config.read_text(encoding='utf-8'))
        levels = old.get('levels', ['basic', 'advanced'] if old.get('level') == 'all' else [old.get('level', 'basic')])
        settings['levels'] = [x for x in levels if x in ('basic', 'advanced', 'upper1', 'upper2')]
        if old.get('mode') in ('random', 'weak', 'new', 'due'): settings['mode'] = old['mode']
        for source, target, low, high in [('count','count',1,2000),('seconds','seconds',3,120),('daily_goal','dailyGoal',1,2000)]:
            value = old.get(source)
            if type(value) is int and low <= value <= high: settings[target] = value
        # A pre-goal Python settings file used 20; preserve its effective original value.
        if 'daily_goal' not in old: settings['dailyGoal'] = 20
    sessions = [{'id': r['id'], 'profileId': profile_id, 'started': round(r['started']*1000),
                 'ended': round(r['ended']*1000) if r['ended'] is not None else None,
                 'scope': r['scope'], 'mode': r['mode'], 'planned': r['planned'], 'completed': bool(r['completed'])}
                for r in db.execute('SELECT * FROM sessions ORDER BY rowid')]
    attempts = [{'sessionId': r['session_id'], 'profileId': profile_id, 'question': r['question'],
                 'word': r['word'], 'selected': r['selected'], 'correct': bool(r['correct']),
                 'elapsed': r['elapsed'], 'at': round(r['at']*1000)}
                for r in db.execute('SELECT * FROM attempts ORDER BY rowid')]
    progress = {}
    for a in attempts:
        previous = progress.get(a['word'], {})
        streak = previous.get('streak', 0)+1 if a['correct'] else 0
        progress[a['word']] = {'word': a['word'], 'seen': previous.get('seen',0)+1,
            'correct': previous.get('correct',0)+int(a['correct']), 'streak': streak,
            'lastAt': a['at'], 'dueAt': a['at'] + ([1,3,7,14,30,60][min(streak-1,5)]*86400000 if a['correct'] else 600000)}
    # Check against the actual saved statistics instead of silently discarding inconsistent data.
    original = {r['word']: dict(r) for r in db.execute('SELECT * FROM progress')}
    if set(original) != set(progress): raise ValueError('元の履歴と単語別成績が一致しません。元データを確認してください。')
    for key, p in progress.items():
        old = original[key]
        if any(old[k] != p[k] for k in ('seen','correct','streak')) or abs(old['due_at']*1000-p['dueAt']) > 1:
            raise ValueError('元の成績と履歴が一致しません: ' + key)
    db.close()
    now = round(time.time()*1000)
    return {'format':'katayama-vocabulary','version':1,'exportedAt':now,'profiles':[{
        'profile':{'id':profile_id,'name':name,'created':now,'settings':settings},
        'sessions':sessions,'attempts':attempts,'progress':list(progress.values())}]}

if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('data_folder', type=Path)
    p.add_argument('--name', default='Python版の記録')
    p.add_argument('--output', type=Path, default=Path('vocabulary-backup.json'))
    args = p.parse_args()
    if not args.name.strip() or len(args.name.strip()) > 40: p.error('名前は1〜40文字です。')
    if args.output.exists(): p.error('出力先が既に存在します。別のファイル名を指定してください。')
    backup = convert(args.data_folder, args.name.strip())
    args.output.write_text(json.dumps(backup,ensure_ascii=False,indent=2),encoding='utf-8')
    print(f'変換しました: {args.output}（元のファイルは変更していません）')
