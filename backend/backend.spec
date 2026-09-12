from pathlib import Path
import sys

root = Path(SPECPATH).parent
weights = root/'vendor/PromoterAtlas/trained_weights'

a = Analysis(
    [str(root/'backend/worker.py')],
    pathex=[str(root/'backend'), str(root/'vendor/PromoterAtlas/src')],
    binaries=[],
    datas=[
        (str(weights), 'vendor/PromoterAtlas/trained_weights'),
        (str(root/'models/manifest.json'), 'models'),
    ],
    hiddenimports=[
        'promoter_atlas.models.promoter_segmenter',
        'promoter_atlas.prediction.expression_predictor',
        'promoter_atlas.models.expression_predictor',
        'promoter_atlas.io.fasta_io',
        'promoter_atlas.io.genbank_io',
        'promoter_atlas.io.gff_io',
        'promoter_atlas.annotation.annotator',
        'promoter_atlas.annotation.fasta_annotator',
        'BCBio.GFF',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'matplotlib', 'pandas', 'h5py', 'logomaker', 'pytest', 'tkinter', 'IPython', 'tensorboard',
        'caffe2',
    ],
    noarchive=False,
)
pyz = PYZ(a.pure)

mac_only = dict(
    target_arch='arm64',
    codesign_identity='-',
    entitlements_file=str(root/'backend/entitlements.plist'),
) if sys.platform == 'darwin' else {}
strip_binaries = sys.platform == 'darwin'

exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name='promoter-atlas-worker',
    debug=False,
    bootloader_ignore_signals=False,
    strip=strip_binaries,
    upx=False,
    console=True,
    **mac_only,
)
coll = COLLECT(exe, a.binaries, a.datas, strip=strip_binaries, upx=False, name='backend')
