"""Generate deterministic fixtures from the preserved implementation, not a reimplementation."""
import hashlib
import json
from pathlib import Path
import sys
import os
import time
from datetime import date, datetime

ROOT = Path(__file__).resolve().parents[1]
os.environ['TZ'] = 'Asia/Tokyo'
if hasattr(time, 'tzset'): time.tzset()
sys.path.insert(0, str(ROOT / 'legacy-python'))
from engine import load_words, QuestionFactory, Answer
from progress import StudyStore, eligible_words, select_words, goal_words

words = load_words()
factory = QuestionFactory(words)
digest = hashlib.sha256()
for a in words:
    digest.update(bytes(int(factory.compatible(a, b)) for b in words))

class IdentityRandom:
    def sample(self, pool, count): return list(pool)[:count]
    def shuffle(self, pool): pass

pool = words[:8]
p = {
    pool[0].key: {'seen': 8, 'correct': 7, 'streak': 3, 'due_at': 200},
    pool[1].key: {'seen': 8, 'correct': 2, 'streak': 0, 'due_at': 100},
    pool[2].key: {'seen': 8, 'correct': 3, 'streak': 1, 'due_at': 100},
    pool[3].key: {'seen': 8, 'correct': 4, 'streak': 0, 'due_at': 101},
    pool[4].key: {'seen': 1, 'correct': 1, 'streak': 1, 'due_at': 102},
}
selection = {mode: [w.key for w in select_words(pool, 5, mode, p, IdentityRandom())]
             for mode in ['random', 'weak', 'new', 'due']}
eligibility = {mode: [w.key for w in eligible_words(pool, ['basic'], mode, p, now=100)]
               for mode in ['random', 'weak', 'new', 'due']}
store = StudyStore(':memory:')
updates = []
for i, correct in enumerate([True, True, True, True, True, True, True, False, True, False]):
    now = 1700000000 + i
    sid = store.begin('基礎編', 'test', 1, now=now)
    store.record(sid, 0, Answer(words[0], words[0] if correct else None, 1), now=now)
    value = store.snapshot()[words[0].key]
    updates.append({'correct': correct, 'at': now*1000, 'expected': {
        'word': value['word'], 'seen': value['seen'], 'correct': value['correct'],
        'streak': value['streak'], 'lastAt': value['last_at']*1000, 'dueAt': value['due_at']*1000}})
store.close()
store = StudyStore(':memory:')
rows = []
for i, (day, wi, correct) in enumerate([
    ('2024-02-29', 0, True), ('2024-02-29', 0, False), ('2024-02-29', 1, True),
    ('2024-03-01', 0, True), ('2025-12-31', 0, True), ('2026-01-01', 0, False),
    ('2026-09-11', 0, True), ('2026-09-12', 0, True), ('2026-09-12', 1, False),
    ('2026-09-13', 0, True)]):
    stamp = datetime.fromisoformat(day + 'T12:00:00').timestamp()
    sid = store.begin('基礎編', 'test', 1, now=stamp)
    store.record(sid, 0, Answer(words[wi], words[wi] if correct else None, 1), now=stamp)
    rows.append({'sessionId': sid, 'profileId': 'fixture', 'question': 0,
                 'word': words[wi].key, 'selected': words[wi].key if correct else None,
                 'correct': correct, 'elapsed': 1, 'at': stamp*1000})
days = {day: store.day_summary(date.fromisoformat(day)) for day in ['2024-02-29','2024-03-01','2025-12-31','2026-01-01','2026-09-12']}
months = {f'{year}-{month}': store.month_summary(year, month) for year,month in [(2024,2),(2024,3),(2025,12),(2026,1),(2026,9)]}
fixture = {'compatibilityHash': digest.hexdigest(), 'pool': [w.key for w in pool], 'progress': p,
           'selection': selection, 'eligibility': eligibility,
           'goal': [w.key for w in goal_words(pool, 7, {w.key for w in pool[:3]}, IdentityRandom())],
           'updates': updates, 'attempts': rows, 'days': days, 'months': months,
           'streak': {d: store.streak(date.fromisoformat(d)) for d in ['2026-09-12','2026-09-13','2026-09-14','2026-09-15']}}
target = ROOT / 'tests' / 'python-fixtures.json'
target.parent.mkdir(exist_ok=True)
target.write_text(json.dumps(fixture, ensure_ascii=False, indent=2), encoding='utf8')
print('Python parity fixtures generated: all 4,000,000 word pairs, selection, progress, calendar')
