"""Backwards compatible SQLite history, daily counts and calendar summaries."""
from datetime import date,datetime,timedelta
from pathlib import Path
import random
import sqlite3
import time
import uuid

INTERVAL_DAYS=(1,3,7,14,30,60)

def day_bounds(day):
    # Local midnights, not midnight+86400: also correct across DST transitions.
    return (datetime.combine(day,datetime.min.time()).timestamp(),
            datetime.combine(day+timedelta(days=1),datetime.min.time()).timestamp())

def month_bounds(year,month):
    start=date(year,month,1)
    end=date(year+1,1,1) if month==12 else date(year,month+1,1)
    return day_bounds(start)[0],day_bounds(end)[0]

class StudyStore:
    def __init__(self,path):
        if str(path)!=':memory:':
            Path(path).parent.mkdir(parents=True,exist_ok=True)
        self.db=sqlite3.connect(str(path),timeout=5)
        self.db.row_factory=sqlite3.Row
        try:
            self.db.executescript('''
                CREATE TABLE IF NOT EXISTS sessions(
                    id TEXT PRIMARY KEY,started REAL NOT NULL,scope TEXT NOT NULL,
                    mode TEXT NOT NULL,planned INTEGER NOT NULL,ended REAL,
                    completed INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS attempts(
                    session_id TEXT NOT NULL,question INTEGER NOT NULL,word TEXT NOT NULL,
                    selected TEXT,correct INTEGER NOT NULL,elapsed REAL NOT NULL,at REAL NOT NULL,
                    PRIMARY KEY(session_id,question));
                CREATE TABLE IF NOT EXISTS progress(
                    word TEXT PRIMARY KEY,seen INTEGER NOT NULL,correct INTEGER NOT NULL,
                    streak INTEGER NOT NULL,last_at REAL NOT NULL,due_at REAL NOT NULL);
                CREATE INDEX IF NOT EXISTS attempts_at ON attempts(at);
            ''')
        except sqlite3.Error:
            self.db.close()
            raise
    def snapshot(self):
        return {r['word']:dict(r) for r in self.db.execute('SELECT * FROM progress')}
    def begin(self,scope,mode,total,now=None):
        sid=uuid.uuid4().hex
        with self.db:
            self.db.execute('INSERT INTO sessions(id,started,scope,mode,planned) VALUES(?,?,?,?,?)',
                (sid,time.time() if now is None else now,scope,mode,total))
        return sid
    def record(self,sid,index,answer,now=None):
        now=time.time() if now is None else now
        key=answer.word.key
        with self.db:
            cursor=self.db.execute('INSERT OR IGNORE INTO attempts VALUES(?,?,?,?,?,?,?)',
                (sid,index,key,answer.selected.key if answer.selected else None,int(answer.correct),answer.elapsed,now))
            if not cursor.rowcount:
                return False
            old=self.db.execute('SELECT * FROM progress WHERE word=?',(key,)).fetchone()
            seen=(old['seen'] if old else 0)+1
            correct=(old['correct'] if old else 0)+int(answer.correct)
            streak=(old['streak'] if old else 0)+1 if answer.correct else 0
            interval=INTERVAL_DAYS[min(streak-1,len(INTERVAL_DAYS)-1)]*86400 if answer.correct else 600
            self.db.execute('INSERT OR REPLACE INTO progress VALUES(?,?,?,?,?,?)',
                (key,seen,correct,streak,now,now+interval))
        return True
    def finish(self,sid,completed=False):
        if sid:
            with self.db:
                self.db.execute('UPDATE sessions SET ended=?,completed=? WHERE id=? AND ended IS NULL',
                    (time.time(),int(completed),sid))
    def recent_sessions(self,limit=10):
        return [dict(r) for r in self.db.execute('''
            SELECT s.*,count(a.word) AS answered,coalesce(sum(a.correct),0) AS correct
            FROM sessions s JOIN attempts a ON s.id=a.session_id
            GROUP BY s.id ORDER BY s.started DESC LIMIT ?''',(limit,))]
    def day_summary(self,day=None):
        start,end=day_bounds(day or date.today())
        r=self.db.execute('''SELECT count(DISTINCT word) AS words,count(*) AS answers,
            coalesce(sum(correct),0) AS correct FROM attempts WHERE at>=? AND at<?''',(start,end)).fetchone()
        return dict(r)
    def today_count(self):
        return self.day_summary()['answers']
    def day_word_keys(self,day=None):
        start,end=day_bounds(day or date.today())
        return {r[0] for r in self.db.execute('SELECT DISTINCT word FROM attempts WHERE at>=? AND at<?',(start,end))}
    def month_summary(self,year,month):
        start,end=month_bounds(year,month)
        rows=self.db.execute('''SELECT date(at,'unixepoch','localtime') AS day,
            count(DISTINCT word) AS words,count(*) AS answers,coalesce(sum(correct),0) AS correct
            FROM attempts WHERE at>=? AND at<? GROUP BY day''',(start,end))
        days={r['day']:dict(r) for r in rows}
        unique=self.db.execute('SELECT count(DISTINCT word) FROM attempts WHERE at>=? AND at<?',(start,end)).fetchone()[0]
        return {'days':days,'total':sum(r['words'] for r in days.values()),'unique':unique,
                'answers':sum(r['answers'] for r in days.values()),'active_days':len(days)}
    def streak(self,today=None):
        today=today or date.today()
        active={date.fromisoformat(r[0]) for r in self.db.execute("SELECT DISTINCT date(at,'unixepoch','localtime') FROM attempts")}
        day=today if today in active else today-timedelta(days=1)
        count=0
        while day in active:
            count+=1
            day-=timedelta(days=1)
        return count
    def close(self):
        self.db.close()

def eligible_words(words,levels,mode,progress,now=None):
    now=time.time() if now is None else now
    pool=[w for w in words if w.level in levels]
    if mode=='new':
        pool=[w for w in pool if w.key not in progress]
    elif mode=='due':
        pool=[w for w in pool if w.key in progress and progress[w.key]['due_at']<=now]
    return pool

def select_words(pool,count,mode,progress,rng=None):
    if not 1<=count<=len(pool):
        raise ValueError('出題できる単語数を超えています。')
    rng=rng or random.Random()
    if mode!='weak':
        return rng.sample(pool,count)
    def priority(w):
        p=progress.get(w.key)
        if p and p['seen']>p['correct'] and p['streak']<3:
            return (0,p['streak'],p['correct']/p['seen'])
        return (1 if p is None else 2,0,0)
    chosen=sorted(rng.sample(pool,len(pool)),key=priority)[:count]
    rng.shuffle(chosen)
    return chosen

def goal_words(pool,target,today_keys,rng=None):
    if not 1<=target<=len(pool):
        raise ValueError(f'目標は{target}語ですが、選択範囲は{len(pool)}語です。範囲を増やすか目標を下げてください。')
    rng=rng or random.Random()
    new=[w for w in pool if w.key not in today_keys]
    done=[w for w in pool if w.key in today_keys]
    chosen=rng.sample(new,min(target,len(new)))
    chosen+=rng.sample(done,target-len(chosen))
    rng.shuffle(chosen)
    return chosen
