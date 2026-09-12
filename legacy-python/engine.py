"""Offline quiz rules; vocabulary and synonym groups preserved from v2."""
from dataclasses import dataclass
from pathlib import Path
import random
import time

POS={'noun':'名詞','verb':'動詞','adjective':'形容詞','adverb':'副詞'}
LEVELS={'basic':'基礎編','advanced':'応用編','upper1':'上級Ⅰ','upper2':'上級Ⅱ'}
MODES={'random':'ランダム','weak':'苦手優先','new':'未学習のみ','due':'復習日が来た単語'}

@dataclass(frozen=True)
class Word:
    english:str
    japanese:str
    level:str
    pos:str
    @property
    def key(self):
        return f'{self.english}:{self.pos}'

def load_words():
    root=Path(__file__).parent
    words=[]
    for name in ('vocabulary.txt','vocabulary_upper.txt'):
        level=pos=None
        for line in (root/name).read_text(encoding='utf-8').splitlines():
            line=line.strip()
            if not line or line.startswith('#'):
                continue
            if line.startswith('['):
                level,pos=line.strip('[]').split(',')
                if level not in LEVELS or pos not in POS:
                    raise ValueError('Invalid vocabulary section')
            else:
                english,japanese=line.split('=',1)
                if not english or not japanese or level is None:
                    raise ValueError('Invalid vocabulary row')
                words.append(Word(english,japanese,level,pos))
    if len({w.english for w in words})!=2000:
        raise ValueError('Expected 2000 unique words')
    for key in LEVELS:
        if sum(w.level==key for w in words)!=500:
            raise ValueError('Expected 500 words per course')
    return words

class QuestionFactory:
    def __init__(self,words,rng=None):
        self.words=words
        self.rng=rng or random.Random()
        self.previous={}
        self.levels=set(LEVELS)
        self.family_ids={}
        for i,line in enumerate(Path(__file__).with_name('synonyms.txt').read_text(encoding='utf-8').splitlines()):
            for english in line.split():
                self.family_ids.setdefault(english,set()).add(i)
    def compatible(self,a,b):
        return (a.pos==b.pos and a.english!=b.english
            and a.japanese not in b.japanese and b.japanese not in a.japanese
            and not self.family_ids.get(a.english,set()).intersection(self.family_ids.get(b.english,set())))
    def options(self,target):
        pool=[w for w in self.words if w.level in self.levels and self.compatible(target,w)]
        same=[w for w in pool if w.level==target.level]
        other=[w for w in pool if w.level!=target.level]
        for attempt in range(100):
            self.rng.shuffle(same)
            self.rng.shuffle(other)
            choices=[target]
            for candidate in same+other:
                if all(self.compatible(candidate,w) for w in choices):
                    choices.append(candidate)
                if len(choices)==6:
                    break
            signature=frozenset(w.key for w in choices)
            if len(choices)==6 and signature!=self.previous.get(target.key):
                self.previous[target.key]=signature
                self.rng.shuffle(choices)
                return choices
        raise ValueError('Cannot create six choices for '+target.english)

@dataclass(frozen=True)
class Answer:
    word:Word
    selected:Word|None
    elapsed:float
    @property
    def correct(self):
        return self.word==self.selected

class Session:
    def __init__(self,words,factory,seconds,clock=time.monotonic):
        if not words or not 3<=seconds<=120:
            raise ValueError('Invalid session settings')
        self.words=list(words)
        self.factory=factory
        self.seconds=seconds
        self.clock=clock
        self.index=-1
        self.answers=[]
        self.answered=True
        self.finished=False
        self.options=[]
        self.deadline=0
    def next(self):
        if not self.answered or self.finished:
            return False
        if self.index+1==len(self.words):
            self.finished=True
            return False
        self.index+=1
        self.word=self.words[self.index]
        self.options=self.factory.options(self.word)
        self.started=self.clock()
        self.deadline=self.started+self.seconds
        self.answered=False
        return True
    @property
    def remaining(self):
        return max(0,self.deadline-self.clock())
    def answer(self,index=None):
        if self.answered or self.finished or self.index<0:
            return None
        if index is not None and (type(index) is not int or not 0<=index<6):
            raise ValueError('Invalid choice')
        elapsed=max(0,self.clock()-self.started)
        selected=None if index is None or elapsed>=self.seconds else self.options[index]
        result=Answer(self.word,selected,min(self.seconds,elapsed))
        self.answers.append(result)
        self.answered=True
        return result
    @property
    def mistakes(self):
        return [a.word for a in self.answers if not a.correct]
