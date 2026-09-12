"""Exercise a packaged worker from an isolated temporary working directory."""
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from Bio import SeqIO

root = Path(__file__).resolve().parents[1]
default_name = 'promoter-atlas-worker.exe' if os.name == 'nt' else 'promoter-atlas-worker'
worker = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root / 'src-tauri/resources/backend' / default_name
artifacts = root / 'tests/artifacts'
temporary = Path(tempfile.gettempdir())
command = [str(worker)]
if '--deny-network' in sys.argv:
    if sys.platform != 'darwin':
        raise RuntimeError('--deny-network is supported only on macOS')
    command = ['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)(deny network*)', str(worker)]

environment = os.environ.copy()
environment.update({'HOME': str(temporary), 'TMPDIR': str(temporary), 'TEMP': str(temporary), 'TMP': str(temporary), 'OMP_NUM_THREADS': '2', 'PYTHONNOUSERSITE': '1'})


def invoke(request, timeout=180):
    process = subprocess.run(command, input=json.dumps(request) + '\n', text=True, capture_output=True, cwd=temporary, env=environment, timeout=timeout)
    messages = [json.loads(line) for line in process.stdout.splitlines()]
    if process.returncode or not messages or messages[-1]['type'] != 'result':
        raise RuntimeError(f"{request['operation']}: {process.returncode}: {process.stdout[-1000:]} {process.stderr[-3000:]}")
    return messages, messages[-1]['result']


reports = []
for task in ('annotation', 'expression'):
    request = {'protocol': 1, 'job_id': f'packaged-{task}', 'operation': task, 'input': (root / f'tests/fixtures/{task}.fasta').read_text(), 'parameters': {}}
    started = time.perf_counter()
    messages, result = invoke(request)
    (artifacts / f'frozen-{task}.json').write_text(json.dumps(messages, indent=2))
    reference = json.loads((artifacts / 'adapter-reference.json').read_text())[task]
    if task == 'annotation':
        assert result['windows'] == reference['windows']
    else:
        assert all(abs(a['value'] - b['value']) < 1e-6 for a, b in zip(result['predictions'], reference['predictions']))
    reports.append({'task': task, 'seconds': time.perf_counter() - started, 'reference_match': True})

genome_request = {
    'protocol': 1,
    'job_id': 'packaged-genome',
    'operation': 'genome-annotation',
    'file_path': str(root / 'tests/fixtures/real-ecoli-nc000913.gb'),
    'parameters': {'upstream_length': 200, 'min_intergenic': 5, 'minimum': 3, 'cooccurrence': True},
}
started = time.perf_counter()
_, genome = invoke(genome_request)
assert genome['summary']['element_count'] == 7
assert Path(genome['exports']['gb']).read_bytes().replace(b'\r\n', b'\n') == (artifacts / 'reference-genome.gb').read_bytes().replace(b'\r\n', b'\n')
assert Path(genome['exports']['gff3']).read_bytes().replace(b'\r\n', b'\n') == (artifacts / 'reference-genome.gff3').read_bytes().replace(b'\r\n', b'\n')
features = [feature for record in SeqIO.parse(genome['exports']['gb'], 'genbank') for feature in record.features if feature.type == 'regulatory']
assert len(features) == 7
assert {feature.qualifiers['label'][0] for feature in features} == {'RBS'}
reports.append({'task': 'genome-annotation', 'seconds': time.perf_counter() - started, 'reference_match': True})

cancel_request = {'protocol': 1, 'job_id': 'cancel-test', 'operation': 'annotation', 'input': 'ACGT' * 20000, 'parameters': {}}
process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, cwd=temporary, env=environment)
process.stdin.write(json.dumps(cancel_request) + '\n')
process.stdin.close()
assert json.loads(process.stdout.readline())['type'] == 'ready'
process.kill()
process.wait(timeout=10)
invoke({'protocol': 1, 'job_id': 'rerun', 'operation': 'expression', 'input': 'ACGT' * 21 + 'AC'})
reports.append({'cancellation_reaped': True, 'rerun': True})

(artifacts / 'frozen-validation.json').write_text(json.dumps(reports, indent=2))
print(json.dumps(reports, indent=2))
