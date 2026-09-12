"""片山英単語: calendar, daily goals and an offline 2000-word quiz."""
import calendar
from datetime import date,datetime
import json
import math
import os
from pathlib import Path
import random
import sqlite3
import sys
import tkinter as tk
from tkinter import messagebox,simpledialog
from engine import LEVELS,MODES,POS,QuestionFactory,Session,load_words
from progress import StudyStore,eligible_words,select_words,goal_words

BG='#F3F5FA'; INK='#19223B'; MUTED='#626D85'; BLUE='#4561EC'
LINE='#E0E5F0'; WHITE='#FFFFFF'; LIME='#D6F88C'; GREEN='#176447'; RED='#B3314D'

class App:
    def __init__(self,root,data_dir=None):
        self.root=root
        root.title('片山英単語 | 毎日の学習とカレンダー')
        root.geometry('460x860')
        root.minsize(380,620)
        root.configure(bg=BG)
        self.words=load_words()
        self.factory=QuestionFactory(self.words)
        self.rng=random.Random()
        self.level_vars={k:tk.BooleanVar(value=k=='basic') for k in LEVELS}
        self.mode='random'
        self.count=tk.StringVar(value='10')
        self.seconds=tk.StringVar(value='15')
        self.daily_goal=20
        base=Path(sys.executable).parent if getattr(sys,'frozen',False) else Path(__file__).parent
        self.data_dir=Path(data_dir) if data_dir is not None else base/'data'
        self.config_path=self.data_dir/'settings.json'
        self.legacy_config=base/'settings.json'
        self.storage_notice=''
        try:
            self.store=StudyStore(self.data_dir/'learning.sqlite3')
        except (OSError,sqlite3.Error):
            self.store=StudyStore(':memory:')
            self.storage_notice='保存先を開けないため、履歴は今回の起動中のみ保持します。'
        self.load_settings()
        self.session=None
        self.session_id=None
        self.screen='home'
        self.reviewing=False
        self.result_page=0
        self.timer_job=None
        self.resize_job=None
        self.widgets=[]
        self.today=date.today()
        self.selected_day=self.today
        self.month=(self.today.year,self.today.month)
        self.canvas=tk.Canvas(root,bg=BG,highlightthickness=0)
        self.scroll=tk.Scrollbar(root,command=self.canvas.yview)
        self.canvas.configure(yscrollcommand=self.scroll.set)
        self.canvas.pack(side='left',fill='both',expand=True)
        self.scroll.pack(side='right',fill='y')
        self.canvas.bind('<Configure>',self.resize)
        root.bind('<MouseWheel>',lambda e:self.canvas.yview_scroll(-int(e.delta/120),'units'))
        root.bind('<Button-4>',lambda e:self.canvas.yview_scroll(-2,'units'))
        root.bind('<Button-5>',lambda e:self.canvas.yview_scroll(2,'units'))
        for n in range(1,7):
            root.bind(str(n),lambda e,i=n-1:self.key_answer(e,i))
            root.bind(f'<KP_{n}>',lambda e,i=n-1:self.key_answer(e,i))
        root.bind('<Return>',self.enter)
        root.protocol('WM_DELETE_WINDOW',self.close)
        self.s=1
        self.ox=0
        self.render()
        self.day_job=root.after(30000,self.check_day)

    def selected_levels(self):
        return [k for k,v in self.level_vars.items() if v.get()]

    def load_settings(self):
        try:
            path=self.config_path if self.config_path.exists() else self.legacy_config
            data=json.loads(path.read_text(encoding='utf-8'))
            levels=data.get('levels')
            if levels is None:
                levels=list(LEVELS)[:2] if data.get('level')=='all' else [data.get('level','basic')]
            if isinstance(levels,list) and any(isinstance(k,str) and k in LEVELS for k in levels):
                for key,var in self.level_vars.items():
                    var.set(key in levels)
            if data.get('mode') in MODES:
                self.mode=data['mode']
            for key,var,lo,hi in [('count',self.count,1,2000),('seconds',self.seconds,3,120)]:
                value=data.get(key)
                if type(value) is int and lo<=value<=hi:
                    var.set(str(value))
            goal=data.get('daily_goal',20)
            if type(goal) is int and 1<=goal<=2000:
                self.daily_goal=goal
        except (OSError,ValueError,TypeError,AttributeError):
            pass

    def save_settings(self):
        try:
            count=int(self.count.get()); seconds=int(self.seconds.get())
            data={'levels':self.selected_levels(),'mode':self.mode,
                  'count':count if 1<=count<=2000 else 10,
                  'seconds':seconds if 3<=seconds<=120 else 15,'daily_goal':self.daily_goal}
        except ValueError:
            data={'levels':self.selected_levels(),'mode':self.mode,'count':10,'seconds':15,'daily_goal':self.daily_goal}
        try:
            self.data_dir.mkdir(parents=True,exist_ok=True)
            tmp=self.config_path.with_suffix('.tmp')
            tmp.write_text(json.dumps(data,ensure_ascii=False),encoding='utf-8')
            os.replace(tmp,self.config_path)
        except OSError:
            self.storage_notice='設定を保存できません。書き込み可能な場所で使ってください。'

    def set_goal(self,value=None):
        if value is None:
            value=simpledialog.askinteger('1日の目標','1日に取り組む単語数（1〜2,000語）',
                initialvalue=self.daily_goal,minvalue=1,maxvalue=2000,parent=self.root)
        if value is None:
            return
        if type(value) is not int or not 1<=value<=2000:
            raise ValueError('目標は1〜2,000語です。')
        self.daily_goal=value
        self.save_settings()
        self.render()

    def resize(self,event):
        if self.resize_job:
            self.root.after_cancel(self.resize_job)
        self.resize_job=self.root.after(100,self.render)

    def check_day(self):
        current=date.today()
        if self.today!=current:
            self.today=current
            if self.screen in ('home','history'):
                self.render()
        self.day_job=self.root.after(30000,self.check_day)

    def x(self,v): return self.ox+v*self.s
    def y(self,v): return v*self.s

    def text(self,x,y,label,size=14,color=INK,bold=False,anchor='nw',width=None,tags=()):
        return self.canvas.create_text(self.x(x),self.y(y),text=label,fill=color,
            font=('Yu Gothic UI',-round(size*self.s),'bold' if bold else 'normal'),anchor=anchor,
            width=width*self.s if width else 0,tags=tags)

    def box(self,x,y,w,h,fill=WHITE,radius=16,outline='',tags=()):
        x1,y1,x2,y2=self.x(x),self.y(y),self.x(x+w),self.y(y+h)
        r=min(radius,h/2,w/2)*self.s
        points=[x1+r,y1,x2-r,y1,x2,y1,x2,y1+r,x2,y2-r,x2,y2,x2-r,y2,
                x1+r,y2,x1,y2,x1,y2-r,x1,y1+r,x1,y1]
        return self.canvas.create_polygon(points,smooth=True,splinesteps=24,fill=fill,
            outline=outline or fill,width=1.5*self.s,tags=tags)

    def button(self,x,y,w,h,label,command,fill=WHITE,color=INK,size=15,outline='',bold=True):
        tag=f'button_{len(self.widgets)}'
        self.box(x,y,w,h,fill,12,outline,tags=(tag,))
        b=tk.Button(self.canvas,text=label,command=command,bg=fill,fg=color,
            activebackground=fill,activeforeground=color,relief='flat',bd=0,
            highlightthickness=1,highlightbackground=fill,highlightcolor=BLUE,
            font=('Yu Gothic UI',-round(size*self.s),'bold' if bold else 'normal'),
            cursor='hand2',takefocus=True)
        b.bind('<Return>',lambda e:(command(),'break')[-1])
        self.canvas.create_window(self.x(x+w/2),self.y(y+h/2),window=b,
            width=max(8,(w-12)*self.s),height=(h-6)*self.s)
        self.canvas.tag_bind(tag,'<Button-1>',lambda e:command())
        self.widgets.append(b)
        return b

    def badge(self,x,y,label,fill='#E9EDFF',color=BLUE,w=68):
        self.box(x,y,w,26,fill,9)
        self.text(x+w/2,y+13,label,12,color,True,anchor='center')

    def render(self):
        if self.resize_job:
            self.root.after_cancel(self.resize_job)
            self.resize_job=None
        focus=self.root.focus_get()
        focused_var=focus.cget('textvariable') if isinstance(focus,tk.Entry) else None
        for widget in self.widgets:
            widget.destroy()
        self.widgets=[]
        self.canvas.delete('all')
        width=max(360,self.canvas.winfo_width())
        self.s=min(1.35,width/440)
        self.ox=max(0,(width-440*self.s)/2)
        self.canvas.configure(scrollregion=(0,0,width,830*self.s))
        {'home':self.home,'quiz':self.quiz,'results':self.results,'history':self.history}[self.screen]()
        if focused_var:
            for widget in self.widgets:
                if isinstance(widget,tk.Entry) and widget.cget('textvariable')==focused_var:
                    widget.focus_set()
        if self.screen=='quiz' and not self.session.answered:
            self.paint_timer()

    def header(self,action=None):
        self.box(26,24,34,34,BLUE,10)
        self.text(43,41,'片',20,WHITE,True,anchor='center')
        self.text(70,27,'片山英単語',21,INK,True)
        if action=='history':
            self.button(306,25,110,34,'学習記録 →',self.show_history,BG,BLUE,13)
        elif action=='home':
            self.button(306,25,110,34,'← ホーム',self.go_home,BG,BLUE,13)
        else:
            self.text(414,40,'2,000 WORDS',12,MUTED,anchor='e')

    def home(self):
        self.header('history')
        summary=self.store.day_summary()
        done=summary['words']
        percent=min(100,math.floor(done/self.daily_goal*100))
        achieved=done>=self.daily_goal
        self.box(24,82,392,226,INK,24)
        self.text(43,99,'TODAY  /  今日の学習',12,LIME,True)
        self.button(290,95,109,30,'目標を変更',self.set_goal,'#35425D',WHITE,12)
        self.text(43,134,f'{done:,}',42,WHITE,True)
        self.text(169,155,f'/ {self.daily_goal:,} 語',19,'#D6DEEF')
        self.text(397,157,f'{percent}%',21,LIME,True,anchor='e')
        self.box(44,195,352,8,'#35425D',4)
        if done:
            self.box(44,195,352*min(1,done/self.daily_goal),8,LIME,4)
        line='今日の目標達成！ よく頑張りました。' if achieved else f'あと {self.daily_goal-done:,} 語で今日の目標達成'
        self.text(44,214,line,14,LIME if achieved else WHITE,True)
        self.button(42,245,356,44,f'目標の {self.daily_goal:,} 問をはじめる  →',self.quick_start,BLUE,WHITE,15)
        self.text(24,322,f'連続 {self.store.streak()} 日  ·  今日の回答 {summary["answers"]} 回',12,MUTED)
        self.text(24,351,'01  出題範囲',16,INK,True)
        self.button(294,346,122,31,'すべて選択',self.select_all,BG,BLUE,12)
        for i,(key,title) in enumerate(LEVELS.items()):
            xx,yy=24+(i%2)*202,388+(i//2)*53
            selected=self.level_vars[key].get()
            fill='#E9EDFF' if selected else WHITE
            self.box(xx,yy,190,44,fill,13,BLUE if selected else LINE)
            b=tk.Checkbutton(self.canvas,text=f'{title}  500語',variable=self.level_vars[key],
                command=self.scope_changed,bg=fill,fg=BLUE if selected else INK,
                activebackground=fill,selectcolor=WHITE,highlightthickness=1,
                highlightbackground=fill,highlightcolor=BLUE,takefocus=True,
                font=('Yu Gothic UI',-round(14*self.s),'bold'),cursor='hand2')
            self.canvas.create_window(self.x(xx+95),self.y(yy+22),window=b,width=178*self.s,height=34*self.s)
            self.widgets.append(b)
        self.text(27,497,'目標コースは選択範囲内の「今日未回答」を優先',12,MUTED)
        self.text(24,528,'02  通常トレーニング',16,INK,True)
        for i,(key,title) in enumerate(MODES.items()):
            self.button(24+(i%2)*202,563+(i//2)*39,190,32,title,
                lambda m=key:self.set_mode(m),BLUE if self.mode==key else WHITE,
                WHITE if self.mode==key else MUTED,12)
        self.setting(24,646,190,'問題数',self.count,1,2000,'問')
        self.setting(226,646,190,'1問の時間',self.seconds,3,120,'秒')
        pool=eligible_words(self.words,self.selected_levels(),self.mode,self.store.snapshot())
        self.text(26,733,f'通常コースの対象：{len(pool):,}語  /  時間 3〜120秒',12,MUTED)
        self.button(24,759,392,44,'通常トレーニングをはじめる  →',self.start,WHITE,BLUE,15,LINE)
        self.text(220,820,self.storage_notice or '同じ日の同じ単語は1語として集計します',12,
            RED if self.storage_notice else MUTED,anchor='center',width=400)

    def setting(self,x,y,w,label,var,lo,hi,unit):
        self.box(x,y,w,76,WHITE,15,LINE)
        self.text(x+13,y+7,label,12,MUTED)
        self.button(x+9,y+33,34,33,'−',lambda:self.step(var,-1,lo,hi),BG,INK,17)
        entry=tk.Entry(self.canvas,textvariable=var,justify='center',bg=WHITE,fg=INK,bd=0,
            highlightthickness=1,highlightbackground=LINE,highlightcolor=BLUE,
            font=('Yu Gothic UI',-round(22*self.s),'bold'))
        self.canvas.create_window(self.x(x+87),self.y(y+49),window=entry,width=67*self.s,height=32*self.s)
        self.widgets.append(entry)
        self.text(x+127,y+49,unit,12,MUTED,anchor='center')
        self.button(x+w-43,y+33,34,33,'+',lambda:self.step(var,1,lo,hi),BG,INK,17)

    def step(self,var,delta,lo,hi):
        if var is self.count:
            hi=max(1,len(eligible_words(self.words,self.selected_levels(),self.mode,self.store.snapshot())))
        try: value=int(var.get())
        except ValueError: value=lo
        var.set(str(max(lo,min(hi,value+delta))))

    def scope_changed(self):
        maximum=len(eligible_words(self.words,self.selected_levels(),self.mode,self.store.snapshot()))
        try:
            if maximum and int(self.count.get())>maximum:
                self.count.set(str(maximum))
        except ValueError: pass
        self.save_settings()
        self.render()

    def select_all(self):
        for var in self.level_vars.values(): var.set(True)
        self.scope_changed()

    def set_mode(self,mode):
        self.mode=mode
        self.scope_changed()

    def quick_start(self):
        self.start(goal=True)

    def start(self,review_words=None,goal=False):
        try:
            seconds=int(self.seconds.get())
            if not 3<=seconds<=120: raise ValueError('制限時間は3〜120秒にしてください。')
            levels=self.selected_levels()
            if not levels: raise ValueError('出題範囲を1つ以上選択してください。')
            progress=self.store.snapshot()
            if review_words is not None:
                chosen=list(review_words)
                self.rng.shuffle(chosen)
                label='まちがい復習'
            elif goal:
                pool=[w for w in self.words if w.level in levels]
                chosen=goal_words(pool,self.daily_goal,self.store.day_word_keys(),self.rng)
                label='今日の目標コース'
            else:
                count=int(self.count.get())
                pool=eligible_words(self.words,levels,self.mode,progress)
                if not pool: raise ValueError('この条件では出題できません。範囲やモードを変えてください。')
                if not 1<=count<=len(pool): raise ValueError(f'問題数は1〜{len(pool)}問にしてください。')
                chosen=select_words(pool,count,self.mode,progress,self.rng)
                label=MODES[self.mode]
        except ValueError as error:
            text=str(error)
            if 'invalid literal' in text: text='問題数と時間には整数を入力してください。'
            messagebox.showerror('設定を確認してください',text,parent=self.root)
            return
        if not chosen: return
        self.cancel_timer()
        self.save_settings()
        self.finish_record(False)
        self.factory.levels=set(levels)
        self.session_scope='・'.join(LEVELS[k] for k in levels)
        self.session_label=label
        self.reviewing=review_words is not None
        self.goal_session=goal
        try:
            self.session_id=self.store.begin(self.session_scope,label,len(chosen))
        except sqlite3.Error as error:
            messagebox.showerror('履歴を保存できません',str(error),parent=self.root)
            return
        self.session=Session(chosen,self.factory,seconds)
        self.next_question()

    def next_question(self):
        if not self.session or not self.session.answered: return
        self.cancel_timer()
        if self.session.next():
            self.screen='quiz'
            self.render()
            self.canvas.yview_moveto(0)
            self.tick()
        elif self.session.finished:
            self.finish_record(True)
            self.screen='results'
            self.result_page=0
            self.render()
            self.canvas.yview_moveto(0)

    def quiz(self):
        s=self.session
        self.button(24,22,75,36,'終了',self.exit_quiz,BG,MUTED,13)
        self.text(220,40,self.session_label,14,INK,True,anchor='center')
        self.text(414,40,f'{s.index+1} / {len(s.words)}',14,MUTED,anchor='e')
        self.box(24,76,392,6,LINE,3)
        self.box(24,76,392*(s.index+1)/len(s.words),6,BLUE,3)
        self.badge(24,105,POS[s.word.pos],w=62)
        self.text(100,117,'日本語の意味を選ぼう',14,MUTED,anchor='w')
        self.box(24,151,392,164,INK,24)
        self.text(44,171,'WORD',12,LIME,True)
        size=min(42,550/max(1,len(s.word.english)))
        self.text(220,230,s.word.english,size,WHITE,True,anchor='center')
        self.text(220,282,f'{LEVELS[s.word.level]}  ·  基本的な意味を1つ選択',12,'#C1CBE0',anchor='center')
        for i,word in enumerate(s.options):
            fill,color,outline,prefix=WHITE,INK,LINE,str(i+1)
            if s.answered:
                if word==s.word: fill,color,outline,prefix='#E3F4EA',GREEN,'#8BCDA9','✓'
                elif word==s.answers[-1].selected: fill,color,outline,prefix='#FCE9ED',RED,'#EAB2BF','×'
            button=self.button(24,335+i*55,392,47,f'{prefix}   {word.japanese}',
                lambda n=i:self.answer(n),fill,color,15,outline)
            if s.answered: button.configure(state='disabled',disabledforeground=color,takefocus=False)
        if s.answered:
            a=s.answers[-1]
            status='正解！' if a.correct else ('時間切れ' if a.selected is None else 'もう一度、覚えよう')
            self.text(24,678,status,16,GREEN if a.correct else RED,True)
            self.text(24,708,f'{a.word.english} = {a.word.japanese}',14,INK,width=390)
            self.button(24,752,392,53,'結果を見る →' if s.index+1==len(s.words) else '次の単語へ →',
                self.next_question,BLUE,WHITE,16)
        else:
            done=self.store.day_summary()['words']
            self.text(220,707,f'今日 {done:,} / {self.daily_goal:,}語  ·  数字キー 1〜6 で回答',12,MUTED,anchor='center')

    def paint_timer(self):
        self.canvas.delete('timer')
        remain=self.session.remaining
        color=RED if remain<=3 else BLUE
        self.text(412,117,f'{math.ceil(remain):02d} s',19,color,True,anchor='e',tags=('timer',))
        if remain>0: self.box(24,321,392*remain/self.session.seconds,4,color,2,tags=('timer',))

    def tick(self):
        self.timer_job=None
        if self.screen!='quiz' or self.session.answered: return
        if self.session.remaining<=0:
            self.answer(None)
            return
        self.paint_timer()
        self.timer_job=self.root.after(50,self.tick)

    def cancel_timer(self):
        if self.timer_job:
            self.root.after_cancel(self.timer_job)
            self.timer_job=None

    def answer(self,index):
        if self.screen!='quiz' or self.session.answered: return
        answer=self.session.answer(index)
        if answer:
            self.cancel_timer()
            try: self.store.record(self.session_id,self.session.index,answer)
            except sqlite3.Error as error:
                messagebox.showerror('この回答を保存できませんでした',str(error),parent=self.root)
            self.render()
            self.canvas.yview_moveto(1)

    def key_answer(self,event,index):
        if self.screen=='quiz' and not isinstance(event.widget,tk.Entry):
            self.answer(index)
            return 'break'

    def enter(self,event):
        if isinstance(event.widget,(tk.Button,tk.Checkbutton)): return
        if self.screen=='quiz' and self.session.answered: self.next_question()
        elif self.screen=='home': self.start()

    def results(self):
        s=self.session
        self.header()
        correct=sum(a.correct for a in s.answers)
        total=len(s.answers)
        self.text(220,99,'トレーニング完了',21,INK,True,anchor='center')
        self.box(24,128,392,181,INK,24)
        self.text(220,152,'ACCURACY',12,LIME,True,anchor='center')
        self.text(220,203,f'{round(correct/total*100)}%',58,WHITE,True,anchor='center')
        self.text(220,261,f'正解 {correct}/{total}問  ·  回答時間 {sum(a.elapsed for a in s.answers):.0f}秒',14,'#D6DEEF',anchor='center')
        done=self.store.day_summary()['words']
        line=f'今日 {done:,}/{self.daily_goal:,}語' if done<self.daily_goal else '今日の目標達成！ この積み重ねが力になる。'
        self.text(220,330,line,14,GREEN,True,anchor='center')
        self.text(24,364,'今回の単語',17,INK,True)
        pages=max(1,math.ceil(total/4))
        self.text(414,374,f'{self.result_page+1}/{pages}',13,MUTED,anchor='e')
        for i,a in enumerate(s.answers[self.result_page*4:self.result_page*4+4]):
            yy=399+i*61
            self.box(24,yy,392,54,WHITE,13,LINE)
            self.text(40,yy+27,'✓' if a.correct else '×',20,GREEN if a.correct else RED,True,anchor='w')
            self.text(70,yy+5,a.word.english,16,INK,True)
            self.text(70,yy+31,a.word.japanese,13,MUTED,width=325)
        if self.result_page>0: self.button(24,651,91,34,'← 前',lambda:self.page(-1),BG,MUTED,13)
        if self.result_page+1<pages: self.button(325,651,91,34,'次 →',lambda:self.page(1),BG,MUTED,13)
        if s.mistakes:
            self.button(24,702,392,49,f'まちがえた {len(s.mistakes)}語を復習 ↻',lambda:self.start(s.mistakes),BLUE,WHITE,16)
        else:
            self.box(24,702,392,49,'#E3F4EA',14)
            self.text(220,726,'全問正解！',16,GREEN,True,anchor='center')
        self.button(24,766,190,40,'ホームへ',self.go_home,BG,MUTED,14)
        self.button(226,766,190,40,'カレンダーを見る',self.show_history,BG,BLUE,14)

    def page(self,delta):
        self.result_page+=delta
        self.render()

    def show_history(self):
        self.cancel_timer()
        self.finish_record(False)
        self.screen='history'
        self.selected_day=date.today()
        self.month=(self.selected_day.year,self.selected_day.month)
        self.render()
        self.canvas.yview_moveto(0)

    def change_month(self,delta):
        year,month=self.month
        ordinal=year*12+month-1+delta
        year,month=ordinal//12,ordinal%12+1
        if not 1970<=year<=9998: return
        self.month=(year,month)
        today=date.today()
        self.selected_day=today if (year,month)==(today.year,today.month) else date(year,month,1)
        self.render()

    def select_day(self,day):
        self.selected_day=date(*self.month,day)
        self.render()

    def history(self):
        self.header('home')
        year,month=self.month
        stats=self.store.month_summary(year,month)
        self.button(24,82,52,35,'‹',lambda:self.change_month(-1),WHITE,BLUE,23)
        self.text(220,101,f'{year}年 {month}月',22,INK,True,anchor='center')
        self.button(364,82,52,35,'›',lambda:self.change_month(1),WHITE,BLUE,23)
        self.box(24,132,392,110,INK,20)
        self.text(43,146,'月の学習語数（日別の合計）',12,LIME,True)
        self.text(43,172,f'{stats["total"]:,} 語',34,WHITE,True)
        self.text(272,160,f'学習 {stats["active_days"]} 日',15,WHITE,True)
        self.text(272,190,f'{stats["answers"]:,} 回回答',13,'#D6DEEF')
        self.text(43,217,f'月内の重複を除くと {stats["unique"]:,} 語',12,'#D6DEEF')
        self.button(325,250,91,28,'今月へ',self.show_history,BG,BLUE,12)
        today=date.today()
        for col,weekday in enumerate('月火水木金土日'):
            color=RED if col==6 else (BLUE if col==5 else MUTED)
            self.text(49+col*56,288,weekday,13,color,True,anchor='center')
        weeks=calendar.Calendar(firstweekday=0).monthdayscalendar(year,month)
        for row,week in enumerate(weeks):
            for col,day in enumerate(week):
                if not day: continue
                dt=date(year,month,day)
                count=stats['days'].get(dt.isoformat(),{}).get('words',0)
                active=count>0
                selected=dt==self.selected_day
                fill=BLUE if selected else ('#E4EAFE' if active else WHITE)
                color=WHITE if selected else (BLUE if active else MUTED)
                outline=BLUE if dt==today else LINE
                self.button(24+col*56,309+row*52,50,47,f'{day}\n{count}語',
                    lambda d=day:self.select_day(d),fill,color,12,outline,bold=active or selected)
        # Fixed six-week area prevents layout jumps between months.
        detail=self.store.day_summary(self.selected_day)
        self.box(24,633,392,86,WHITE,17,LINE)
        label=self.selected_day.strftime('%m月%d日')
        if self.selected_day==today: label+='（今日）'
        self.text(41,645,label,15,INK,True)
        self.text(41,674,f'{detail["words"]:,} 語に取り組みました',18,BLUE,True)
        accuracy=f'{round(detail["correct"]/detail["answers"]*100)}%' if detail['answers'] else '—'
        self.text(399,656,f'{detail["answers"]} 回回答',12,MUTED,anchor='e')
        self.text(399,686,f'正答率 {accuracy}',12,MUTED,anchor='e')
        self.text(25,735,'日付を押すと詳細を表示。青い枠は今日です。',12,MUTED)
        self.text(25,758,'同じ日の同じ単語は1語。別の日は再び1語と数えます。',12,MUTED)
        self.text(24,803,'コース別の学習状況',17,INK,True)
        progress=self.store.snapshot()
        for i,(key,title) in enumerate(LEVELS.items()):
            pool=[w for w in self.words if w.level==key]
            learned=sum(w.key in progress for w in pool)
            mastered=sum(progress.get(w.key,{}).get('streak',0)>=3 for w in pool)
            yy=841+i*51
            self.text(26,yy,f'{title}  {learned}/500語',14,INK,True)
            self.text(414,yy+8,f'3連続正解 {mastered}語',12,MUTED,anchor='e')
            self.box(26,yy+29,388,5,LINE,2)
            if learned: self.box(26,yy+29,388*learned/500,5,BLUE,2)
        self.text(24,1066,'最近のトレーニング',17,INK,True)
        records=self.store.recent_sessions(10)
        if not records: self.text(24,1110,'学習すると履歴がここに残ります。',14,MUTED)
        for i,r in enumerate(records):
            yy=1106+i*67
            self.box(24,yy,392,58,WHITE,13,LINE)
            stamp=datetime.fromtimestamp(r['started']).strftime('%m/%d %H:%M')
            status='完了' if r['completed'] else '途中まで'
            self.text(38,yy+8,f'{stamp}  ·  {r["mode"]}  ·  {status}',13,INK,True)
            self.text(38,yy+33,f'{r["scope"]}  正解 {r["correct"]}/{r["answered"]}問',12,MUTED,width=360)
        height=max(1160,1125+len(records)*67)
        self.canvas.configure(scrollregion=(0,0,self.canvas.winfo_width(),height*self.s))

    def finish_record(self,completed):
        try: self.store.finish(self.session_id,completed)
        except sqlite3.Error as error: messagebox.showerror('履歴の更新に失敗しました',str(error),parent=self.root)
        self.session_id=None

    def exit_quiz(self):
        if messagebox.askyesno('トレーニングを終了','回答済みの履歴は保存されます。ホームへ戻りますか？',parent=self.root):
            self.go_home()

    def go_home(self):
        self.cancel_timer()
        self.finish_record(False)
        self.session=None
        self.screen='home'
        self.render()
        self.canvas.yview_moveto(0)

    def close(self):
        self.cancel_timer()
        self.finish_record(False)
        self.save_settings()
        self.store.close()
        if self.resize_job: self.root.after_cancel(self.resize_job)
        if self.day_job: self.root.after_cancel(self.day_job)
        self.root.destroy()

def main():
    root=tk.Tk()
    try: App(root)
    except (OSError,ValueError,sqlite3.Error) as error:
        messagebox.showerror('片山英単語',f'起動できませんでした。\n{error}',parent=root)
        root.destroy()
        return 1
    root.mainloop()
    return 0

if __name__=='__main__':
    if len(sys.argv)==3 and sys.argv[1]=='--self-test':
        from selftest import run
        sys.exit(run(sys.argv[2]))
    sys.exit(main())
