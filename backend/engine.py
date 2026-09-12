"""Thin, CPU-only adapter over pinned PromoterAtlas. No architecture changes."""
import hashlib
import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path, PosixPath, WindowsPath

ROOT = Path(getattr(sys, '_MEIPASS', Path(__file__).resolve().parents[1]))
UPSTREAM = ROOT / 'vendor/PromoterAtlas'
sys.path.insert(0, str(UPSTREAM / 'src'))


def parse_input(text, task):
    if not isinstance(text, str) or len(text) > 250_000:
        raise ValueError('Input limit: 250,000 characters')
    text = text.strip()
    if not text:
        raise ValueError('Enter DNA or FASTA')
    records = []
    if text.startswith('>'):
        identifier, parts = None, []
        for line in text.splitlines():
            line = line.strip()
            if line.startswith('>'):
                if identifier is not None:
                    records.append({'id': identifier, 'sequence': ''.join(parts)})
                header = line[1:].split()
                if not header:
                    raise ValueError('Empty FASTA ID')
                identifier, parts = header[0], []
            elif line:
                parts.append(line)
        records.append({'id': identifier, 'sequence': ''.join(parts)})
    else:
        records = [{'id': 'sequence_1', 'sequence': ''.join(text.splitlines())}]
    if len(records) > 100:
        raise ValueError('Maximum 100 records')
    ids = set()
    for record in records:
        seq, identifier = record['sequence'], record['id']
        if identifier in ids or len(identifier) > 120:
            raise ValueError('Duplicate or excessive ID: ' + identifier)
        ids.add(identifier)
        if task == 'annotation' and len(seq) < 200:
            raise ValueError('Annotation requires ≥200 bp: ' + identifier)
        if task == 'annotation' and len(seq) > 50000:
            raise ValueError('Sequence exceeds 50 kb; use Genome Regulatory Annotation for full genomes: ' + identifier)
        if task == 'expression' and len(seq) != 86:
            raise ValueError('Expression requires exactly 86 bp; no automatic padding or trimming: ' + identifier)
        if not re.fullmatch(r'[ACGTN]+', seq, re.IGNORECASE):
            raise ValueError('DNA may contain only A/C/G/T/N: ' + identifier)
        record['sha256'] = hashlib.sha256(seq.encode()).hexdigest()
    return records


def initialize():
    import numpy as np
    import torch
    torch.set_num_threads(2)
    # The pinned upstream expression checkpoints were created on POSIX and
    # contain a serialized pathlib.PosixPath. Reconstruct it as WindowsPath
    # on Windows without changing the checkpoint bytes or model parameters.
    checkpoint_path = (WindowsPath, 'pathlib.PosixPath') if os.name == 'nt' else PosixPath
    torch.serialization.add_safe_globals([
        checkpoint_path,
        np.dtype,
        np.core.multiarray.scalar,
        type(np.dtype('float64')),
    ])
    return torch


def run(request, progress=lambda *_: None):
    started = time.perf_counter()
    task = request.get('operation')
    if task not in ('annotation', 'expression', 'genome-annotation'):
        raise ValueError('Unknown operation')
    params = request.get('parameters', {})
    torch = initialize()
    manifest = json.loads((ROOT / 'models/manifest.json').read_text())

    model_id = 'annotation' if task in ('annotation', 'genome-annotation') else params.get('model', 'lafleur2022')
    if model_id not in ('annotation', 'lafleur2022', 'hossain2020', 'urtecho2018', 'yu2021', 'kosuri2013'):
        raise ValueError('Unknown model')
    weight = next(w for w in manifest['weights'] if model_id in w['file'])
    path = UPSTREAM / weight['file']
    if hashlib.sha256(path.read_bytes()).hexdigest() != weight['sha256']:
        raise ValueError('Model checksum mismatch')
    progress(0, 1, 'loading')

    if task == 'genome-annotation':
        from promoter_atlas.io.genbank_io import load_genbank, extract_promoter_regions_genbank
        from promoter_atlas.io.genbank_io import save_genbank
        from promoter_atlas.io.gff_io import save_gff3
        from promoter_atlas.models.promoter_segmenter import PromoterSegmenter
        from promoter_atlas.annotation.annotator import annotate_records, LABEL_MAP
        file_path = request.get('file_path')
        if not file_path:
            raise ValueError('GenBank file path required')
        upstream_length = int(params.get('upstream_length', 200))
        min_intergenic = int(params.get('min_intergenic', 5))
        minimum = int(params.get('minimum', 3))
        cooccurrence = bool(params.get('cooccurrence', True))
        if not 1 <= upstream_length <= 2000:
            raise ValueError('upstream_length must be between 1 and 2000')
        if not 1 <= min_intergenic <= 200:
            raise ValueError('min_intergenic must be between 1 and 200')
        if not 1 <= minimum <= 200:
            raise ValueError('minimum must be between 1 and 200')
        gb_records = load_genbank(file_path)
        genes_in_file = sum(1 for r in gb_records for f in r.features if f.type == 'CDS')
        promoter_regions = extract_promoter_regions_genbank(gb_records, upstream_length, min_intergenic)
        model = PromoterSegmenter.from_pretrained(path).to('cpu').eval()
        total = len(promoter_regions)
        original_features = {id(feature) for record in gb_records for feature in record.features}
        gb_records, feature_count = annotate_records(
            gb_records,
            promoter_regions,
            model,
            device='cpu',
            min_segment_length=minimum,
            apply_cooccurrence=cooccurrence,
        )
        progress(total, total or 1, 'inference')

        # Derive the compact UI table from the exact features appended by upstream.
        label_by_name = {name: label for label, name in LABEL_MAP.items()}
        promoter_by_locus = {
            (promoter.get('record_id', gb_records[0].id), promoter['locus_tag']): promoter
            for promoter in promoter_regions
        }
        elements = []
        for record in gb_records:
            for feature in record.features:
                if id(feature) in original_features:
                    continue
                regulatory_value = feature.qualifiers.get('regulatory_class', 'unknown')
                note_value = feature.qualifiers.get('note', '')
                regulatory_class = regulatory_value[0] if isinstance(regulatory_value, list) else regulatory_value
                note = note_value[0] if isinstance(note_value, list) else note_value
                locus_tag = note.rsplit(' for gene ', 1)[-1] if ' for gene ' in note else ''
                promoter = promoter_by_locus.get((record.id, locus_tag), {})
                elements.append({
                    'gene': promoter.get('gene') or locus_tag,
                    'locus_tag': locus_tag,
                    'strand': '+' if feature.location.strand == 1 else '-',
                    'record_id': record.id,
                    'genomic_start': int(feature.location.start),
                    'genomic_end': int(feature.location.end),
                    'type': regulatory_class,
                    'label': label_by_name.get(regulatory_class, 0),
                })

        # Keep large scientific files out of the JSON bridge. These files are
        # byte-for-byte products of the pinned upstream serializers.
        export_dir = Path(tempfile.mkdtemp(prefix='promoter-atlas-desktop-'))
        genbank_path = export_dir / 'annotated.gb'
        gff3_path = export_dir / 'annotated.gff3'
        save_gff3(gb_records, gff3_path, include_fasta=False)
        for record in gb_records:
            for feature in record.features:
                if id(feature) not in original_features:
                    feature.qualifiers['label'] = feature.qualifiers['regulatory_class']
        save_genbank(gb_records, genbank_path)
        result = {
            'task': 'genome-annotation',
            'model': {'id': model_id, 'commit': manifest['commit'], 'file': weight['file'], 'sha256': weight['sha256']},
            'summary': {
                'genes_scanned': total,
                'genes_in_file': genes_in_file,
                'element_count': feature_count,
                'elements': elements,
            },
            'exports': {'gb': str(genbank_path), 'gff3': str(gff3_path)},
            'elapsed_seconds': time.perf_counter() - started,
        }
        return result

    records = parse_input(request.get('input'), task)
    result = {
        'task': task,
        'records': records,
        'model': {'id': model_id, 'commit': manifest['commit'], 'file': weight['file'], 'sha256': weight['sha256'], 'normalization_params': weight.get('normalization_params')},
        'parameters': params,
        'device': 'cpu',
        'torch': torch.__version__,
        'coordinate_system': '0-based half-open',
        'strand': 'input direction only',
        'preprocessing': 'Uppercase; non-ACGT encodes as all-zero vector (same as N)',
    }

    if task == 'annotation':
        from promoter_atlas.models.promoter_segmenter import PromoterSegmenter
        from promoter_atlas.io.fasta_io import create_sliding_windows
        from promoter_atlas.annotation.fasta_annotator import annotate_fasta_windows, merge_overlapping_predictions
        step = params.get('step', 20)
        minimum = params.get('minimum', 3)
        if type(step) is not int or not 1 <= step <= 200 or type(minimum) is not int or not 1 <= minimum <= 200:
            raise ValueError('Step/minimum must be integers from 1 to 200')
        windows = []
        for record in records:
            windows.extend(create_sliding_windows(record['sequence'].upper(), record['id'], step_size=step)[0])
        model = PromoterSegmenter.from_pretrained(path).to('cpu').eval()

        # Pre-collect RC windows so the total window count is known before forward inference,
        # preventing the progress bar from jumping back when the RC pass begins.
        rc_windows = []
        if params.get('reverse_complement', False):
            from Bio.Seq import Seq
            for record in records:
                rc_seq = str(Seq(record['sequence'].upper()).reverse_complement())
                rc_wins, _ = create_sliding_windows(rc_seq, record['id'], step_size=step)
                rc_windows.extend(rc_wins)
        total_wins = len(windows) + len(rc_windows)

        raw = []
        for index, window in enumerate(windows):
            raw.extend(annotate_fasta_windows([window], model, min_segment_length=minimum, apply_cooccurrence=params.get('cooccurrence', True)))
            progress(index + 1, total_wins, 'inference')
        result['windows'] = raw
        if params.get('merge', False):
            merged = {r['seq_id']: r for r in merge_overlapping_predictions(raw)}
            result['annotations'] = [merged.get(r['id'], {'seq_id': r['id'], 'sequence_length': len(r['sequence']), 'elements': []}) for r in records]
            for item in result['annotations']:
                for element in item['elements']:
                    element['source_windows'] = [i for i, w in enumerate(raw) if w['seq_id'] == item['seq_id'] and any(e['label'] == element['label'] and e['abs_start'] < element['abs_end'] and e['abs_end'] > element['abs_start'] for e in w['elements'])]
        else:
            result['annotations'] = raw

        # Reverse complement scan (uses pre-collected rc_windows)
        if rc_windows:
            rc_raw = []
            n_fwd = len(windows)
            for index, window in enumerate(rc_windows):
                rc_raw.extend(annotate_fasta_windows([window], model, min_segment_length=minimum, apply_cooccurrence=params.get('cooccurrence', True)))
                progress(n_fwd + index + 1, total_wins, 'inference')
            # Convert RC coords to original sequence coords
            seq_lens = {r['id']: len(r['sequence']) for r in records}
            for ann in rc_raw:
                seq_len = seq_lens.get(ann['seq_id'], 0)
                for e in ann['elements']:
                    orig_start = seq_len - e['abs_end']
                    orig_end = seq_len - e['abs_start']
                    e['abs_start'] = orig_start
                    e['abs_end'] = orig_end
                if ann.get('window_start') is not None and ann.get('window_end') is not None:
                    seq_len = seq_lens.get(ann['seq_id'], 0)
                    orig_ws = seq_len - ann['window_end']
                    orig_we = seq_len - ann['window_start']
                    ann['window_start'] = orig_ws
                    ann['window_end'] = orig_we
            result['rev_comp_annotations'] = rc_raw

        result['coverage'] = [{'seq_id': r['id'], 'start': 0, 'end': len(r['sequence'])} for r in records]
        result['scores'] = 'Upstream argmax over 12 logits; labels only, not probabilities'

    else:
        import numpy as np
        from promoter_atlas.prediction.expression_predictor import ExpressionPrediction
        base = next(w for w in manifest['weights'] if 'base_model/' in w['file'])
        if hashlib.sha256((UPSTREAM / base['file']).read_bytes()).hexdigest() != base['sha256']:
            raise ValueError('Base model checksum mismatch')
        old = Path.cwd()
        try:
            os.chdir(UPSTREAM)
            predictor = ExpressionPrediction.load(str(path), device='cpu')
        finally:
            os.chdir(old)
        values = []
        for i in range(0, len(records), 32):
            chunk = records[i:i + 32]
            values.extend(float(v) for v in np.atleast_1d(predictor.predict([r['sequence'].upper() for r in chunk])))
            progress(min(i + 32, len(records)), len(records), 'inference')
        if not all(np.isfinite(values)):
            raise ValueError('Nonfinite prediction')
        result['predictions'] = [{'sequence_id': r['id'], 'value': v} for r, v in zip(records, values)]
        result['scale'] = 'Dataset-specific upstream denormalized output; not au; models are not directly comparable'

    result['elapsed_seconds'] = time.perf_counter() - started
    return result
