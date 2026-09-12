import importlib.metadata as metadata
import json
from pathlib import Path
root=Path(__file__).resolve().parents[1]
blocks=['Third-party licenses and notices\nGenerated from locally installed, locked dependencies. Includes build-time dependencies.']
for distribution in sorted(metadata.distributions(), key=lambda d:d.metadata.get('Name','')):
    blocks.append('\n\n===== PYTHON '+distribution.metadata.get('Name','')+' '+distribution.version+' =====\n')
    blocks.append('License: '+str(distribution.metadata.get('License-Expression') or distribution.metadata.get('License','See notices below'))+'\n')
    for f in distribution.files or []:
        if ('license' in str(f).lower() or 'copying' in str(f).lower() or 'notice' in str(f).lower()) and str(f).lower().endswith(('.txt','.md','license','copying','notice')):
            p=distribution.locate_file(f)
            if p.is_file():
                blocks.append('\n--- '+str(f)+' ---\n'+p.read_text(errors='replace'))
for location,kind in [(root/'node_modules/.pnpm','NPM'),(root/'.tools/cargo/registry/src','RUST')]:
    for p in sorted(location.rglob('*')):
        if p.is_file() and p.name.lower().startswith(('license','copying','notice')) and p.stat().st_size<2_000_000:
            blocks.append('\n\n===== '+kind+' '+str(p.relative_to(location))+' =====\n'+p.read_text(errors='replace'))
python_license=Path(__import__('sys').base_prefix)/'lib/python3.11/LICENSE.txt'
if python_license.exists():blocks.append('\n===== PYTHON RUNTIME =====\n'+python_license.read_text())
(root/'licenses/THIRD_PARTY_NOTICES.txt').write_text('\n'.join(blocks))
print('License notices:',(root/'licenses/THIRD_PARTY_NOTICES.txt').stat().st_size)
