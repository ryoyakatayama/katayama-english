from datetime import date,datetime,timedelta
from pathlib import Path
import calendar
import random
import sqlite3
import tempfile
import unittest
from engine import Answer,LEVELS,POS,QuestionFactory,Session,load_words
from progress import StudyStore,day_bounds,goal_words,eligible_words,select_words

def stamp(day,hour=12): return datetime.combine(day,datetime.min.time()).replace(hour=hour).timestamp()

class StudyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.words=load_words()
    def setUp(self): self.store=StudyStore(':memory:')
    def tearDown(self): self.store.close()
    def record(self,word,at,correct=True):
        sid=self.store.begin('基礎編','test',1,now=at)
        a=Answer(word,word if correct else None,1)
        self.store.record(sid,0,a,now=at)
        return sid,a
    def test_calendar_distinct_days_months_and_accuracy(self):
        a,b=self.words[:2]
        day=date(2026,9,12)
        self.record(a,stamp(day))
        self.record(a,stamp(day,13),False)
        self.record(b,stamp(day,14))
        self.record(a,stamp(day+timedelta(days=1)))
        self.record(a,stamp(date(2026,10,1)))
        self.assertEqual(self.store.day_summary(day),{'words':2,'answers':3,'correct':2})
        stats=self.store.month_summary(2026,9)
        self.assertEqual((stats['total'],stats['unique'],stats['answers'],stats['active_days']),(3,2,4,2))
        self.assertEqual(self.store.day_summary(day-timedelta(days=1))['words'],0)
        self.assertEqual(self.store.day_word_keys(day),{a.key,b.key})
    def test_midnight_year_boundary_and_leap_day(self):
        a=self.words[0]
        start,end=day_bounds(date(2025,12,31))
        self.record(a,end-0.001)
        self.record(a,end)
        self.assertEqual(self.store.month_summary(2025,12)['answers'],1)
        self.assertEqual(self.store.month_summary(2026,1)['answers'],1)
        self.record(a,stamp(date(2024,2,29)))
        self.assertEqual(self.store.month_summary(2024,2)['total'],1)
        self.assertEqual(self.store.month_summary(2026,2)['total'],0)
        self.assertEqual(calendar.monthrange(2024,2)[1],29)
    def test_goal_exact_count_priority_and_repeats(self):
        pool=self.words[:25]
        keys={w.key for w in pool[:10]}
        chosen=goal_words(pool,12,keys,random.Random(1))
        self.assertEqual(len(chosen),12)
        self.assertEqual(len(set(chosen)),12)
        self.assertFalse(any(w.key in keys for w in chosen))
        self.assertEqual(len(goal_words(pool,25,keys)),25)
        with self.assertRaises(ValueError): goal_words(pool,26,keys)
        with self.assertRaises(ValueError): goal_words([],1,set())
    def test_streak_and_deduplicated_write(self):
        a=self.words[0]; day=date(2026,9,12)
        for delta in (-2,-1): self.record(a,stamp(day+timedelta(days=delta)))
        self.assertEqual(self.store.streak(day),2)
        sid,answer=self.record(a,stamp(day))
        self.assertFalse(self.store.record(sid,0,answer,now=stamp(day)))
        self.assertEqual(self.store.streak(day),3)
        self.assertEqual(self.store.streak(day+timedelta(days=2)),0)
        self.assertEqual(self.store.day_summary(day)['answers'],1)
    def test_existing_database_schema_retained(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'learning.sqlite3'
            old=StudyStore(path)
            sid=old.begin('上級Ⅰ','ランダム',1,now=stamp(date(2026,8,2)))
            word=self.words[0]
            old.record(sid,0,Answer(word,word,1),now=stamp(date(2026,8,2)))
            old.close()
            fresh=StudyStore(path)
            self.assertEqual(fresh.month_summary(2026,8)['unique'],1)
            self.assertEqual(fresh.snapshot()[word.key]['seen'],1)
            fresh.close()
    def test_every_word_options_and_changed_choices(self):
        self.assertEqual(len(self.words),2000)
        factory=QuestionFactory(self.words,random.Random(831))
        for word in self.words:
            factory.levels={word.level}
            choices=factory.options(word)
            self.assertEqual(len(choices),6)
            self.assertEqual(len({w.japanese for w in choices}),6)
            self.assertIn(word,choices)
            self.assertTrue(all(w.pos==word.pos and w.level==word.level for w in choices))
            self.assertNotEqual(set(choices),set(factory.options(word)))
    def test_all_scopes_and_original_modes(self):
        from itertools import combinations
        for size in range(1,5):
            for scope in combinations(LEVELS,size):
                pool=eligible_words(self.words,scope,'random',{})
                self.assertEqual(len(pool),500*size)
                self.assertEqual(len(set(goal_words(pool,len(pool),set()))),len(pool))
        a=self.words[0]
        p={a.key:{'seen':1,'correct':0,'streak':0,'due_at':100}}
        self.assertEqual(select_words(self.words[:10],1,'weak',p),[a])
        self.assertNotIn(a,eligible_words(self.words,['basic'],'new',p))
        self.assertEqual(eligible_words(self.words,['basic'],'due',p,now=100),[a])
    def test_timer_and_review(self):
        now=[100.0]
        s=Session(self.words[:2],QuestionFactory(self.words),3,clock=lambda:now[0])
        s.next()
        now[0]+=3
        self.assertFalse(s.answer(s.options.index(s.word)).correct)
        self.assertIsNone(s.answer(0))
        s.next()
        self.assertTrue(s.answer(s.options.index(s.word)).correct)
        s.next()
        self.assertTrue(s.finished)
        self.assertEqual(s.mistakes,[self.words[0]])

if __name__=='__main__': unittest.main()
