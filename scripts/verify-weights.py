"""Verify every bundled model file against the pinned manifest."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / 'models/manifest.json').read_text())
weights_root = root / 'vendor/PromoterAtlas'

for weight in manifest['weights']:
    path = weights_root / weight['file']
    if not path.is_file():
        raise SystemExit(f'Missing model weight: {path}')
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != weight['sha256']:
        raise SystemExit(f'Checksum mismatch: {path}')

print(f"Verified {len(manifest['weights'])} model weights from {manifest['commit']}")
