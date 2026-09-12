export type Task = 'annotation'|'expression'|'genome-annotation';
export interface Parameters {model:string;step:number;minimum:number;merge:boolean;cooccurrence:boolean;reverse_complement?:boolean;upstream_length?:number;min_intergenic?:number}
export interface Element {type:string;label:number;abs_start:number;abs_end:number;strand?:string;source_windows?:number[]}
export interface Annotation {seq_id:string;window_start?:number;window_end?:number;elements:Element[]}
export interface Result {task:Task;records:{id:string;sequence:string;sha256:string}[];model:{id:string;commit:string;sha256:string;file:string};parameters:Parameters;elapsed_seconds:number;annotations?:Annotation[];windows?:Annotation[];rev_comp_annotations?:Annotation[];predictions?:{sequence_id:string;value:number}[]}
export interface Analysis {format:'promoter-atlas-analysis';version:1;app_version:string;name:string;input:string;task:Task;parameters:Parameters;result:Result}
export interface GenomeElement {gene:string;locus_tag:string;strand:string;record_id:string;genomic_start:number;genomic_end:number;type:string;label:number}
export interface GenomeSummary {genes_scanned:number;genes_in_file:number;element_count:number;elements:GenomeElement[]}
export interface GenomeResult {task:'genome-annotation';summary:GenomeSummary;exports:{gb:string;gff3:string};elapsed_seconds:number;model:{id:string;commit:string;sha256:string;file:string}}
export function genBankRecordIds(record:string){return [/^LOCUS\s+(\S+)/m,/^ACCESSION\s+(\S+)/m,/^VERSION\s+(\S+)/m].map(pattern=>(record.match(pattern)||[])[1]).filter((value):value is string=>Boolean(value));}
export const APP_VERSION='0.7.1';
export const COMMIT='771d8c07bd5b9f97ada1c551371d5c11ef8d8655';
export const MODEL_HASHES:Record<string,string>={annotation:'4a35073fac78f5fad430698490bdeb614c1202e31ee600a3e6fa1c153d756ca7',lafleur2022:'cbd8c226c753f54b63c0bfc9470e87422958133129ca04a20e9ffdbf85e179be',hossain2020:'31af6913670eb25066c4a3d9aff21832da26c2a6e57f2067ed36e167fdcfba11',urtecho2018:'65d9182631d85fbb0de5d1512a0ad0c39386b1652a473c318a6525bbc91bbd8c',yu2021:'b4b9f5420c98ad56e67486b1fcac874bd85c2bd4b16533564a293ff44ceaa934',kosuri2013:'d91213184696fd1ca6f4275c9dc1a927223f52c0c9af543bf6aa1ace8490e716'};
export function parseDNA(input:string,task:Task,strict=true){
 if(task==='genome-annotation')return[];
 const text=input.trim(); if(!text)throw Error('empty'); if(text.length>250000)throw Error('limit');
 const records:{id:string;sequence:string}[]=[];
 if(text.startsWith('>')){for(const line of text.split(/\r?\n/).map(s=>s.trim())){if(line.startsWith('>')){const id=line.slice(1).trim().split(/\s+/)[0];if(!id)throw Error('id');records.push({id,sequence:''});}else if(line){records[records.length-1].sequence+=line;}}}
 else records.push({id:'sequence_1',sequence:text.split(/\r?\n/).join('')});
 if(records.length>100)throw Error('limit'); const ids=new Set<string>();
 for(const r of records){if(!r.id||ids.has(r.id)||r.id.length>120)throw Error('id');ids.add(r.id);if(task==='annotation'&&r.sequence.length<200)throw Error('annotationLength');if(strict&&task==='annotation'&&r.sequence.length>50000)throw Error('sequenceTooLong');if(task==='expression'&&r.sequence.length!==86)throw Error('expressionLength');if(!/^[ACGTN]+$/i.test(r.sequence))throw Error('characters');}
 return records;
}
export async function readAnalysis(text:string):Promise<Analysis>{
 const a=JSON.parse(text) as Analysis;
 if(a.format!=='promoter-atlas-analysis'||a.version!==1)throw Error('fileVersion');
 if(!a.result||!['annotation','expression'].includes(a.task)||a.result.task!==a.task||typeof a.name!=='string'||!a.parameters)throw Error('fileInvalid');
 if(a.result.model.commit!==COMMIT||MODEL_HASHES[a.result.model.id]!==a.result.model.sha256)throw Error('fileModel');
 if(!a.result.parameters||(['model','step','minimum','merge','cooccurrence'] as const).some(k=>a.parameters[k]!==a.result.parameters[k])||!a.result.model||!a.result.records||!Number.isFinite(a.result.elapsed_seconds))throw Error('fileInvalid');
 if(a.task==='annotation'&&a.result.model.id!=='annotation'||a.task==='expression'&&a.result.model.id==='annotation')throw Error('fileModel');
 if(!Number.isInteger(a.parameters.step)||a.parameters.step<1||a.parameters.step>200||!Number.isInteger(a.parameters.minimum)||a.parameters.minimum<1||a.parameters.minimum>200||typeof a.parameters.merge!=='boolean'||typeof a.parameters.cooccurrence!=='boolean'||!MODEL_HASHES[a.parameters.model])throw Error('fileInvalid');
 const records=parseDNA(a.input,a.task,false);
 if(records.length!==a.result.records.length)throw Error('fileInvalid');
 for(let i=0;i<records.length;i++){const r=records[i], stored=a.result.records[i];const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(r.sequence))),v=>v.toString(16).padStart(2,'0')).join('');if(r.id!==stored.id||r.sequence!==stored.sequence||hash!==stored.sha256)throw Error('fileInvalid');}
 if(a.task==='annotation'){
 if(!Array.isArray(a.result.annotations)||!Array.isArray(a.result.windows))throw Error('fileInvalid');
 const validateAnns=(anns:typeof a.result.annotations)=>{for(const w of anns??[]){const r=records.find(r=>r.id===w.seq_id);if(!r||!Array.isArray(w.elements))throw Error('fileInvalid');for(const e of w.elements)if(!Number.isInteger(e.abs_start)||!Number.isInteger(e.abs_end)||e.abs_start<0||e.abs_end>r.sequence.length||e.abs_end<=e.abs_start||e.label<1||e.label>11||typeof e.type!=='string')throw Error('fileInvalid');}};
 validateAnns(a.result.annotations);validateAnns(a.result.windows);
 if(a.result.rev_comp_annotations!==undefined){if(!Array.isArray(a.result.rev_comp_annotations))throw Error('fileInvalid');validateAnns(a.result.rev_comp_annotations);}
 }else if(!Array.isArray(a.result.predictions)||a.result.predictions.length!==records.length||a.result.predictions.some((p,i)=>p.sequence_id!==records[i].id||!Number.isFinite(p.value)))throw Error('fileInvalid');
 return a;
}
export function rows(result:Result,sequence?:string){
 const fwd=(result.annotations??[]).flatMap((w,index)=>w.elements.map(e=>({sequence_id:w.seq_id,element_type:e.type,start_1based:e.abs_start+1,end_1based:e.abs_end,window_start_0based:w.window_start??'',window_end_0based:w.window_end??'',index,...e,strand:e.strand??'+'})));
 const rev=(result.rev_comp_annotations??[]).flatMap((w,index)=>w.elements.map(e=>({sequence_id:w.seq_id,element_type:e.type,start_1based:e.abs_start+1,end_1based:e.abs_end,window_start_0based:w.window_start??'',window_end_0based:w.window_end??'',index,...e,strand:'-'})));
 return [...fwd,...rev].filter(e=>!sequence||e.sequence_id===sequence);
}
export function exportDelimited(data:Record<string,unknown>[],delimiter:string,headers?:string[]){const keys=headers??Object.keys(data[0]??{});const quote=(v:unknown)=>{const s=String(v??'');return /["\n\r,\t]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;};return [keys.join(delimiter),...data.map(r=>keys.map(k=>quote(r[k])).join(delimiter))].join('\n');}
