import csv,json,subprocess,sys
from pathlib import Path
import pytest
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'backend'))
from engine import run,parse_input,initialize

@pytest.mark.parametrize('text,task',[('','annotation'),('A'*199,'annotation'),('A'*87,'expression'),('A'*85,'expression'),('A'*199+'R','annotation'),('A '*200,'annotation'),('>x\n'+'A'*200+'\n>x\n'+'C'*200,'annotation'),('>\n'+'A'*200,'annotation')])
def test_validation(text,task):
    with pytest.raises(ValueError):parse_input(text,task)

def test_original_annotation():
    result=run({'operation':'annotation','input':(ROOT/'tests/fixtures/annotation.fasta').read_text()})
    assert result['windows']==json.loads((ROOT/'tests/artifacts/reference-annotation.json').read_text())
    windows=[w for w in result['windows'] if w['seq_id']=='ecoli_230']
    assert [(w['window_start'],w['window_end']) for w in windows]==[(0,200),(20,220),(30,230)]

def test_expression_original_single_batch():
    source=(ROOT/'tests/fixtures/expression.fasta').read_text()
    result=run({'operation':'expression','input':source})
    ref=list(csv.DictReader(open(ROOT/'tests/artifacts/reference-expression.csv')))
    assert [p['value'] for p in result['predictions']]==pytest.approx([float(p['predicted_level']) for p in ref],abs=1e-6)
    single=run({'operation':'expression','input':result['records'][0]['sequence']})
    assert single['predictions'][0]['value']==pytest.approx(result['predictions'][0]['value'],abs=1e-6)

@pytest.mark.parametrize('model',['lafleur2022','hossain2020','urtecho2018','yu2021','kosuri2013'])
def test_all_models(model):
    import os
    initialize()
    from promoter_atlas.prediction.expression_predictor import ExpressionPrediction
    from engine import UPSTREAM
    source=(ROOT/'tests/fixtures/expression.fasta').read_text()
    result=run({'operation':'expression','input':source,'parameters':{'model':model}})
    old=Path.cwd()
    try:
        os.chdir(UPSTREAM)
        predictor=ExpressionPrediction.load(result['model']['file'],device='cpu')
        original=predictor.predict_fasta(ROOT/'tests/fixtures/expression.fasta')
    finally:os.chdir(old)
    assert [p['value'] for p in result['predictions']]==pytest.approx(list(original.values()),abs=1e-6)

def test_merge():
    from promoter_atlas.annotation.fasta_annotator import merge_overlapping_predictions
    result=run({'operation':'annotation','input':(ROOT/'tests/fixtures/annotation.fasta').read_text(),'parameters':{'merge':True}})
    expected=merge_overlapping_predictions(result['windows'])
    actual=[]
    for r in result['annotations']:
        if r['elements']:
            actual.append({**r,'elements':[{k:v for k,v in e.items() if k!='source_windows'} for e in r['elements']]})
    assert actual==expected
    assert len(result['annotations'])==3

def test_n_and_lowercase():
    initialize()
    from promoter_atlas.utils.genomics import sequence_to_onehot
    assert sequence_to_onehot('N').sum()==0
    a=run({'operation':'annotation','input':'ACGTN'*40})
    b=run({'operation':'annotation','input':('ACGTN'*40).lower()})
    assert a['windows']==b['windows']

def test_invalid_protocol():
    p=subprocess.run([sys.executable,str(ROOT/'backend/worker.py')],input=json.dumps({'protocol':2,'job_id':'test'}),text=True,capture_output=True)
    assert p.returncode==1
    assert json.loads(p.stdout)['type']=='error'

def test_parameter_bounds():
    for step in (0,-1,201,2.5):
        with pytest.raises(ValueError):run({'operation':'annotation','input':'A'*200,'parameters':{'step':step}})

def test_real_genbank_scientific_exports_match_golden():
    result=run({
        'operation':'genome-annotation',
        'file_path':str(ROOT/'tests/fixtures/real-ecoli-nc000913.gb'),
        'parameters':{'upstream_length':200,'min_intergenic':5,'minimum':3,'cooccurrence':True},
    })
    assert result['summary']['genes_scanned']==10
    assert result['summary']['genes_in_file']==13
    assert result['summary']['element_count']==7
    assert {element['type'] for element in result['summary']['elements']}=={'RBS'}
    for extension in ('gb','gff3'):
        actual=Path(result['exports'][extension]).read_bytes()
        expected=(ROOT/f'tests/artifacts/reference-genome.{extension}').read_bytes()
        # Text exports may use CRLF on Windows; preserve all other bytes.
        assert actual.replace(b'\r\n', b'\n')==expected.replace(b'\r\n', b'\n')

    from promoter_atlas.io.genbank_io import load_genbank
    exported=load_genbank(result['exports']['gb'])
    regulatory=[feature for record in exported for feature in record.features if feature.type=='regulatory']
    assert len(regulatory)==7
    assert {feature.qualifiers['regulatory_class'][0] for feature in regulatory}=={'RBS'}
    assert all(feature.qualifiers['note'][0].startswith('Predicted by PromoterAtlas segmentation model for gene ') for feature in regulatory)
    assert {feature.qualifiers['label'][0] for feature in regulatory}=={'RBS'}
