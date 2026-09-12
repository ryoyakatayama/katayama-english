"""Source and frozen executable smoke test with isolated temporary history."""
from datetime import date,datetime
from pathlib import Path
import json
import sys
import tempfile
import tkinter as tk

def run(report):
    from app import App
    from engine import Answer
    from unittest.mock import patch
    checks=[]
    with tempfile.TemporaryDirectory(prefix='Katayama-test-') as directory:
        # Old version settings without a daily_goal must remain readable.
        Path(directory,'settings.json').write_text(json.dumps({'levels':['upper1','upper2'],
            'mode':'due','count':10,'seconds':3}),encoding='utf-8')
        root=tk.Tk(); root.withdraw()
        app=App(root,data_dir=directory)
        assert app.daily_goal==20 and app.selected_levels()==['upper1','upper2']
        app.set_goal(3)
        app.quick_start()
        assert len(app.session.words)==3 and app.mode=='due' and app.count.get()=='10'
        assert all(w.level in ('upper1','upper2') for w in app.session.words)
        for i in range(3):
            app.answer(app.session.options.index(app.session.word))
            app.next_question()
        assert app.screen=='results'
        assert app.store.day_summary()['words']==3
        checks.append('goal starts exact count independently of regular mode; 100% progress')
        app.go_home()
        app.quick_start()
        assert all(w.key not in app.store.day_word_keys() for w in app.session.words)
        app.session.started-=5; app.session.deadline-=5
        app.tick()
        assert app.session.answers[-1].selected is None
        app.go_home()
        assert app.store.day_summary()['words']==4
        app.show_history()
        root.update()
        app.month=(2024,2); app.select_day(29)
        root.update()
        assert app.selected_day==date(2024,2,29)
        app.month=(2025,12); app.change_month(1)
        assert app.month==(2026,1)
        app.change_month(-1)
        assert app.month==(2025,12)
        checks.append('calendar leap day, empty days, previous/next month and year rollover')
        app.go_home()
        app.set_goal(2000)
        with patch('app.messagebox.showerror') as error:
            app.quick_start()
            assert error.called and app.session is None
        app.set_goal(3)
        app.close()
        root=tk.Tk(); root.withdraw()
        app=App(root,data_dir=directory)
        assert app.daily_goal==3 and app.store.day_summary()['words']==4
        assert app.store.month_summary(date.today().year,date.today().month)['unique']==4
        app.count.set('2'); app.set_mode('random'); app.start()
        assert len(app.session.words)==2
        app.go_home()
        root.geometry('380x620'); root.update(); app.render(); root.update()
        app.show_history(); root.update()
        app.close()
        checks.append('goal and history persist, legacy settings, normal quiz and minimum viewport')
    Path(report).write_text(json.dumps({'passed':True,'frozen':bool(getattr(sys,'frozen',False)),
        'executable':sys.executable,'checks':checks},ensure_ascii=False,indent=2),encoding='utf-8')
    return 0
