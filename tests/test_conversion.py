from pathlib import Path
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'legacy-python'))
from engine import Answer, load_words
from progress import StudyStore
spec = importlib.util.spec_from_file_location('converter', ROOT / 'scripts/convert-python-backup.py')
converter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(converter)

class ConversionTests(unittest.TestCase):
    def test_existing_history_and_settings_convert_without_modifying_original(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            store = StudyStore(folder / 'learning.sqlite3')
            word = load_words()[0]
            sid = store.begin('基礎編', 'ランダム', 3, now=1700000000)
            for i, correct in enumerate([True, False, True]):
                store.record(sid, i, Answer(word, word if correct else None, 1.25), now=1700000001+i)
            store.finish(sid, True)
            store.close()
            (folder / 'settings.json').write_text(json.dumps({'levels':['upper1','upper2'], 'daily_goal':35,'mode':'weak','seconds':12,'count':7}),encoding='utf8')
            before = (folder / 'learning.sqlite3').read_bytes()
            backup = converter.convert(folder, '元の記録')
            self.assertEqual((folder / 'learning.sqlite3').read_bytes(), before)
            self.assertEqual(backup['profiles'][0]['profile']['settings']['dailyGoal'], 35)
            self.assertEqual(backup['profiles'][0]['progress'][0]['streak'], 1)
            self.assertEqual(len(backup['profiles'][0]['attempts']), 3)
            # Validate through the actual TypeScript port, not only the Python converter.
            script = "import {readFileSync} from 'node:fs'; import {validateBackup} from './.build/backup.js'; const v=JSON.parse(readFileSync('dist/data/vocabulary.json','utf8'));validateBackup(JSON.parse(readFileSync(0,'utf8')),v.words);"
            subprocess.run(['node','--input-type=module','-e',script],input=json.dumps(backup),text=True,check=True,cwd=ROOT)

if __name__ == '__main__': unittest.main()
