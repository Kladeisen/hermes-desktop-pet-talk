"""Create a code/assets-only Desktop-pet-talk distributable, without private data."""
import hashlib
import json
from pathlib import Path
import sys
import tarfile

root=Path(__file__).resolve().parents[1]
out=Path(sys.argv[1]).expanduser().resolve()
out.parent.mkdir(parents=True,exist_ok=True)
allowed_dirs={'desktop','dashboard','companion','docs','tests','tools','bot-alerts'}
allowed_roots={'plugin.yaml','attention.py','__init__.py','discord_live.py','discord_audio.py','language_directive.txt','LICENSE','NOTICE.md','README.md','settings.example.json'}
files=sorted(p for p in root.rglob('*') if p.is_file() and not p.is_symlink() and '__pycache__' not in p.parts and p.suffix!='.pyc' and ((p.relative_to(root).parts[0] in allowed_dirs) or p.relative_to(root).as_posix() in allowed_roots))
manifest={p.relative_to(root).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
with tarfile.open(out,'w:gz') as archive:
    for path in files:archive.add(path,arcname='talk-desktop/'+path.relative_to(root).as_posix(),recursive=False)
with tarfile.open(out,'r:gz') as archive:
    members=archive.getmembers()
    assert len(members)==len(files)
    for member in members:
        assert member.isfile() and not any(part in {'.env','data','__pycache__','.pytest_cache','.git'} for part in Path(member.name).parts)
        assert hashlib.sha256(archive.extractfile(member).read()).hexdigest()==manifest[member.name.removeprefix('talk-desktop/')]
receipt={'archive':str(out),'files':len(files),'sha256':hashlib.sha256(out.read_bytes()).hexdigest(),'contents':manifest}
out.with_suffix(out.suffix+'.manifest.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({k:receipt[k] for k in ('archive','files','sha256')},indent=2))
