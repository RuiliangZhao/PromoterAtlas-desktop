import hashlib, json, sys
from pathlib import Path
import torch
import numpy as np
from pathlib import PosixPath
torch.serialization.add_safe_globals([PosixPath, np.dtype, np.core.multiarray.scalar, type(np.dtype("float64"))])
root = Path(__file__).resolve().parents[1]
records = []
for path in sorted((root/'vendor/PromoterAtlas/trained_weights').rglob('*.pt')):
    checkpoint = torch.load(path, map_location='cpu', weights_only=True)
    state = checkpoint.get('model_state_dict', checkpoint)
    records.append({'file': str(path.relative_to(root/'vendor/PromoterAtlas')), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'bytes': path.stat().st_size, 'keys': list(checkpoint)[:12], 'fc1_shape': list(state['fc1.weight'].shape) if 'fc1.weight' in state else None, 'normalization_params': checkpoint.get('normalization_params')})
print(json.dumps(records, indent=2))
(root/'models/manifest.json').write_text(json.dumps({'upstream':'https://github.com/LucasCoppens/PromoterAtlas','commit':'771d8c07bd5b9f97ada1c551371d5c11ef8d8655','weights':records},indent=2))
