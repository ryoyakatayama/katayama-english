"""Run using the Windows build environment's Python."""
from pathlib import Path
import shutil
import subprocess
import sys
root=Path(__file__).resolve().parent
command=[sys.executable,'-m','PyInstaller','--noconfirm','--onedir','--windowed','--name','片山英単語']
for name in ('vocabulary.txt','vocabulary_upper.txt','synonyms.txt'):
    command.extend(['--add-data',str(root/name)+':.'])
command.append(str(root/'app.py'))
subprocess.run(command,cwd=root,check=True)
target=root/'dist'/'片山英単語'
shutil.copy2(root/'README.md',target/'README.md')
if (root/'licenses').exists():
    shutil.copytree(root/'licenses',target/'licenses',dirs_exist_ok=True)
