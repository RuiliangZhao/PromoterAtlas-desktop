import {describe,it,expect} from 'vitest';
import {parseDNA,rows,exportDelimited,readAnalysis,genBankRecordIds} from './data';
describe('sequence validation',()=>{
 it('rejects duplicate IDs and ambiguous bases',()=>{expect(()=>parseDNA('>a\n'+'A'.repeat(200)+'\n>a\n'+'C'.repeat(200),'annotation')).toThrow('id');expect(()=>parseDNA('R'.repeat(200),'annotation')).toThrow('characters');});
 it('enforces model length without trimming',()=>{expect(()=>parseDNA('A'.repeat(199),'annotation')).toThrow();expect(()=>parseDNA('A'.repeat(87),'expression')).toThrow();expect(parseDNA('acgtn'.repeat(40),'annotation')[0].sequence.length).toBe(200);});
 it('exports quoted fields',()=>{expect(exportDelimited([{id:'a,b',value:2}],',')).toBe('id,value\n"a,b",2');});
 it('rejects unknown file versions',async()=>{await expect(readAnalysis('{"format":"promoter-atlas-analysis","version":3}')).rejects.toThrow('fileVersion');});
});
import fixture from '../../tests/fixtures/analysis.json';
it('reopens real saved results without recomputing',async()=>{const a=await readAnalysis(JSON.stringify(fixture));expect(a.result.annotations).toEqual(fixture.result.annotations);expect(rows(a.result).length).toBe(10);});
it('rejects tampered input and model hashes',async()=>{const bad=structuredClone(fixture);bad.input=bad.input.replace('A','T');await expect(readAnalysis(JSON.stringify(bad))).rejects.toThrow('fileInvalid');const model=structuredClone(fixture);model.result.model.sha256='wrong';await expect(readAnalysis(JSON.stringify(model))).rejects.toThrow('fileModel');});
it('converts zero-based coordinates only once',()=>{expect(rows(fixture.result as never)[0].start_1based).toBe(rows(fixture.result as never)[0].abs_start+1);});
it('matches BioPython versioned IDs to GenBank records',()=>{expect(genBankRecordIds('LOCUS       NC_000913  200 bp  DNA\nACCESSION   NC_000913\nVERSION     NC_000913.1\n')).toEqual(['NC_000913','NC_000913','NC_000913.1']);});
import nativeSaved from '../../tests/artifacts/native-annotation.json';
it('reopens a file saved through the real Rust JSON bridge',async()=>{const a=await readAnalysis(JSON.stringify(nativeSaved));expect(a.result.records.length).toBe(3);});
