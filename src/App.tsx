import {useEffect,useMemo,useRef,useState} from 'react';
import {useTranslation} from 'react-i18next';
import {invoke,listen} from './tauri-shim';
import {Analysis,APP_VERSION,GenomeResult,Parameters,Result,Task,parseDNA,readAnalysis,rows,exportDelimited} from './lib/data';
import examples from './examples.json';
const colors=['#87929a','#0b8d8e','#2667bf','#4d8cda','#ab7126','#d09f40','#8a5ab4','#b48bd6','#bf5771','#df8da1','#4e8667','#83ad84'];
const BASE_COLOR:Record<string,string>={A:'#4caf50',T:'#f44336',G:'#ff9800',C:'#2196f3'};
const AXIS_Y=160;

export default function App(){
 const {t,i18n}=useTranslation();
 const [name,setName]=useState('');
 const [task,setTask]=useState<Task>('annotation');
 const [input,setInput]=useState('');
 const [gbkPath,setGbkPath]=useState<string|null>(null);
 const [gbkName,setGbkName]=useState('');
 const [params,setParams]=useState<Parameters>({model:'lafleur2022',step:20,minimum:3,merge:false,cooccurrence:true,reverse_complement:false,upstream_length:200,min_intergenic:5});
 const [analysis,setAnalysis]=useState<Analysis|null>(null);
 const [genomeResult,setGenomeResult]=useState<GenomeResult|null>(null);
 const [busy,setBusy]=useState(false);
 const [status,setStatus]=useState('');
 const [error,setError]=useState('');
 const [progress,setProgress]=useState(0);
 const [about,setAbout]=useState(false);
 const [sequence,setSequence]=useState('');
 const [filter,setFilter]=useState('');
 const [sort,setSort]=useState<'start'|'type'>('start');
 const [selected,setSelected]=useState(-1);
 const [from,setFrom]=useState(1);
 const [to,setTo]=useState(200);
 const [format,setFormat]=useState('tsv');
 const [scope,setScope]=useState('all');
 const [dragging,setDragging]=useState(false);
 const active=useRef<string|null>(null);
 const pending=useRef<Omit<Analysis,'result'>|null>(null);
 const pendingTask=useRef<Task|null>(null);
 const svg=useRef<SVGSVGElement>(null);
 const dragRef=useRef<{x:number;from:number;to:number}|null>(null);
 const wheelHandlerRef=useRef<((e:WheelEvent)=>void)|null>(null);
 const result=analysis?.result;

 function accept(a:Analysis){setFormat('tsv');setAnalysis(a);setGenomeResult(null);setSequence(a.result.records[0].id);setFrom(1);setTo(a.result.records[0].sequence.length);setSelected(-1);setFilter('');}

 useEffect(()=>{
  let disposed=false;let unlisten:(()=>void)|undefined;
  void listen<{job_id:string;type:string;done:number;total:number;stage:string;message:string;result:Result&GenomeResult}>('backend-message',event=>{
   const m=event.payload;
   if(m.job_id!==active.current)return;
   if(m.type==='progress'){setStatus(m.stage);setProgress(m.done/m.total);}
   if(m.type==='result'){
    if(pendingTask.current==='genome-annotation'){
     setGenomeResult(m.result as unknown as GenomeResult);
     setAnalysis(null);
     setFormat('gb');
    } else if(pending.current){
     accept({...pending.current,result:m.result});
    }
    active.current=null;pendingTask.current=null;setBusy(false);setProgress(1);setStatus('complete');
   }
   if(m.type==='error'){active.current=null;pendingTask.current=null;setBusy(false);setStatus('failed');setError(m.message);}
  }).then(f=>{if(disposed)f();else unlisten=f;}).catch(e=>setError(String(e)));
  return()=>{disposed=true;unlisten?.();};
 },[]);

 const stats=useMemo(()=>{try{return parseDNA(input,task);}catch{return[];}},[input,task]);
 const current=result?.records.find(r=>r.id===sequence);
 const elements=useMemo(()=>result?rows(result,sequence).filter(e=>e.type.toLowerCase().includes(filter.toLowerCase())).sort((a,b)=>sort==='start'?a.abs_start-b.abs_start:a.type.localeCompare(b.type)):[],[result,sequence,filter,sort]);
 const start=Math.max(1,Math.min(from,current?.sequence.length??200));
 const end=Math.max(start,Math.min(to,current?.sequence.length??200));
 const length=end-start+1;
 const visible=elements.map((e,index)=>({...e,key:index})).filter(e=>e.abs_start<end&&e.abs_end>=start);
 const chosen=elements[selected];

 function param<K extends keyof Parameters>(key:K,value:Parameters[K]){setParams(p=>({...p,[key]:value}));}
 async function safe(fn:()=>Promise<void>){setError('');try{await fn();}catch(e){const msg=e instanceof Error?e.message:String(e);setError(i18n.exists(msg)?t(msg):msg);}}

 async function run(){
  await safe(async()=>{
   if(task==='genome-annotation'){
    if(!gbkPath)throw Error('errNoFile');
    const id=crypto.randomUUID();
    pending.current=null;pendingTask.current='genome-annotation';active.current=id;
    setBusy(true);setProgress(0);setStatus('loading');
    try{await invoke('start_job',{request:{protocol:1,job_id:id,operation:'genome-annotation',file_path:gbkPath,parameters:{upstream_length:params.upstream_length??200,min_intergenic:params.min_intergenic??5,minimum:params.minimum,cooccurrence:params.cooccurrence}}});}
    catch(e){active.current=null;pendingTask.current=null;setBusy(false);throw e;}
   } else {
    parseDNA(input,task);
    if(!Number.isInteger(params.step)||params.step<1||params.step>200||!Number.isInteger(params.minimum)||params.minimum<1||params.minimum>200)throw Error('paramRange');
    const id=crypto.randomUUID();
    pending.current={format:'promoter-atlas-analysis',version:1,app_version:APP_VERSION,name,input,task,parameters:{...params}};
    pendingTask.current=task;active.current=id;
    setBusy(true);setProgress(0);setStatus('loading');
    try{await invoke('start_job',{request:{protocol:1,job_id:id,operation:task,input,parameters:params}});}
    catch(e){active.current=null;pendingTask.current=null;setBusy(false);throw e;}
   }
  });
 }

 async function cancel(){await safe(async()=>{active.current=null;pendingTask.current=null;await invoke('cancel_job');setBusy(false);setStatus('cancelled');});}

 async function open(kind:string){
  await safe(async()=>{
   const text=await invoke<string|null>('open_document',{kind});
   if(text===null)return;
   if(kind==='analysis'){
    const a=await readAnalysis(text);
    accept(a);setName(a.name);setInput(a.input);setTask(a.task);setParams(a.parameters);setStatus('complete');
   } else if(kind==='genbank'){
    setGbkPath(text);setGbkName(text.split('/').pop()||text);
   } else {
    setInput(text);
   }
  });
 }

 async function save(){await safe(async()=>{if(!analysis)throw Error('noResult');if(await invoke('save_document',{name:analysis.name||'analysis',extension:'json',content:JSON.stringify(analysis,null,2)}))setStatus('saved');});}

 async function exportResult(){
  await safe(async()=>{
   if(genomeResult){
    const els=genomeResult.summary.elements;
    if(format==='gb'){
     await invoke('save_generated_document',{sourcePath:genomeResult.exports.gb,name:(name||'genome-annotation')+'_annotated',extension:'gb'});
    } else if(format==='gff3'){
     await invoke('save_generated_document',{sourcePath:genomeResult.exports.gff3,name:name||'genome-annotation',extension:'gff3'});
    } else {
     await invoke('save_document',{name:name||'genome-annotation',extension:'csv',content:exportDelimited(els as unknown as Record<string,unknown>[],',',['gene','locus_tag','strand','record_id','genomic_start','genomic_end','type'])});
    }
    return;
   }
   if(!result||!analysis)return;
   let content='';
   if(format==='svg'){
    if(!svg.current)return;
    const clone=svg.current.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns','http://www.w3.org/2000/svg');
    content=new XMLSerializer().serializeToString(clone);
   } else {
    if(result.task==='expression'){
     const preds=(result.predictions??[]).filter(p=>scope==='all'||p.sequence_id===sequence).map(p=>({sequence_id:p.sequence_id,predicted_level:p.value}));
     if(format==='json')content=JSON.stringify({format:'promoter-atlas-export',version:1,model:result.model,parameters:result.parameters,data:preds},null,2);
     else content=exportDelimited(preds as unknown as Record<string,unknown>[],format==='csv'?',':'\t',['sequence_id','predicted_level']);
    } else {
     const data=rows(result,scope==='current'?sequence:undefined);
     if(format==='json')content=JSON.stringify({format:'promoter-atlas-export',version:1,model:result.model,parameters:result.parameters,coordinate_system:'1-based inclusive in start_1based/end_1based; abs_start/abs_end are 0-based half-open',data},null,2);
     else content=exportDelimited(data as unknown as Record<string,unknown>[],format==='csv'?',':'\t',['sequence_id','element_type','strand','start_1based','end_1based','window_start_0based','window_end_0based']);
    }
   }
   await invoke('save_document',{name:analysis.name||'analysis',extension:format,content});
  });
 }

 function zoomBy(dir:number,cx?:number,factor=0.15){
  if(!current)return;
  const rect=svg.current?.getBoundingClientRect();
  // Use actual rendered width to map cursor → viewBox fraction (viewBox: 28–772 = 744 of 800)
  const drawWidth=rect?rect.width*744/800:744;
  const offsetX=rect?rect.width*28/800:28;
  const fraction=cx!=null&&rect?Math.max(0,Math.min(1,(cx-rect.left-offsetX)/drawWidth)):0.5;
  const center=Math.round(start+fraction*(end-start));
  const range=end-start+1;
  const newRange=Math.max(20,Math.min(current.sequence.length,Math.round(range*(1+dir*factor))));
  const half=Math.floor(newRange/2);
  const newFrom=Math.max(1,center-half);
  const newTo=Math.min(current.sequence.length,newFrom+newRange-1);
  setFrom(newFrom);setTo(newTo);
 }

 useEffect(()=>{
  wheelHandlerRef.current=(e:WheelEvent)=>{
   if(!e.ctrlKey&&!e.metaKey)return;
   e.preventDefault();
   // Normalize deltaY across deltaMode (LINE≈16px, PAGE≈400px)
   const px=e.deltaMode===1?e.deltaY*16:e.deltaMode===2?e.deltaY*400:e.deltaY;
   const factor=Math.max(0.03,Math.min(0.25,Math.abs(px)/300));
   zoomBy(px>0?1:-1,e.clientX,factor);
  };
 },[current,start,end]);

 useEffect(()=>{
  const el=svg.current;
  if(!el)return;
  const handler=(e:WheelEvent)=>wheelHandlerRef.current?.(e);
  el.addEventListener('wheel',handler,{passive:false});
  return()=>el.removeEventListener('wheel',handler);
 },[result]);

 function handleMouseDown(e:React.MouseEvent<SVGSVGElement>){
  if(!current)return;
  e.preventDefault();
  dragRef.current={x:e.clientX,from,to};
  setDragging(true);
 }
 function handleMouseMove(e:React.MouseEvent<SVGSVGElement>){
  if(!dragRef.current||!current)return;
  const dx=e.clientX-dragRef.current.x;
  const span=dragRef.current.to-dragRef.current.from;
  const bpPerPx=span/744;
  const shift=Math.round(-dx*bpPerPx);
  const newFrom=Math.max(1,dragRef.current.from+shift);
  const newTo=Math.min(current.sequence.length,newFrom+span);
  const adjFrom=Math.max(1,newTo-span);
  setFrom(adjFrom);setTo(newTo);
 }
 function handleMouseUp(){dragRef.current=null;setDragging(false);}

 const svgH=length<=90?320:305;

 const genomeTypeMap=useMemo(()=>{
  if(!genomeResult)return new Map<string,number>();
  const m=new Map<string,number>();
  for(const e of genomeResult.summary.elements){m.set(e.type,(m.get(e.type)??0)+1);}
  return m;
 },[genomeResult]);

 return <div className="app">
 <header>
  <div className="brand"><div><strong>PromoterAtlas Desktop {APP_VERSION}</strong><span style={{fontSize:'11px',color:'#9aaa9e',marginLeft:'8px'}}>{t('internalUse')}</span></div></div>
  <nav>
   <button disabled={busy} onClick={()=>open('analysis')}>{t('open')}</button>
   <button disabled={!analysis||busy} onClick={save}>{t('save')}</button>
   <button onClick={()=>setAbout(true)}>{t('about')}</button>
   <select aria-label="Language" value={i18n.language} onChange={e=>{void i18n.changeLanguage(e.target.value);localStorage.setItem('language',e.target.value);document.documentElement.lang=e.target.value;}}>
    <option value="zh-CN">中文</option><option value="en">English</option>
   </select>
  </nav>
 </header>
 <main>
  <section className="panel input-panel">
<label>{t('name')}<input value={name} onChange={e=>setName(e.target.value)} disabled={busy}/></label>
   <label>{t('task')}
    <select value={task} onChange={e=>{setTask(e.target.value as Task);setAnalysis(null);setGenomeResult(null);setFormat('tsv');setStatus('');setError('');setInput('');setGbkPath(null);setGbkName('');}} disabled={busy}>
     <option value="annotation">{t('annotation')}</option>
     <option value="genome-annotation">{t('genomeAnnotation')}</option>
     <option value="expression">{t('expression')}</option>
    </select>
   </label>
   {task==='genome-annotation'
    ? <>
       <div className="input-note">{t('hintGenomeAnnotation')}</div>
       <div className="genbank-drop">
        <button disabled={busy} onClick={()=>open('genbank')}>{t('importGenBank')}</button>
        <span className="genbank-name">{gbkName||t('noFile')}</span>
       </div>
      </>
    : <>
       <div className="input-note">{t(task==='annotation'?'hintSequenceAnnotation':'hintExpression')}</div>
       <textarea aria-label="DNA / FASTA" value={input} onChange={e=>setInput(e.target.value)} disabled={busy} spellCheck={false} placeholder="FASTA / DNA"/>
       {task==='annotation'&&<div><label className="check"><input disabled={busy} type="checkbox" checked={params.reverse_complement??false} onChange={e=>param('reverse_complement',e.target.checked)}/>{t('reverseComplement')}</label></div>}
       <div className="input-actions">
        <button disabled={busy} onClick={()=>open('fasta')}>{t('import')}</button>
        <button disabled={busy} onClick={()=>setInput(examples[task as 'annotation'|'expression']??'')}>{t('example')}</button>
        <button disabled={busy||!input} onClick={()=>setInput('')}>{t('clear')}</button>
        <span>{stats.length} {t('count')} · {stats.reduce((n,r)=>n+r.sequence.length,0).toLocaleString()} {t('bases')}</span>
       </div>
      </>
   }
   <div className="run-row">
    <button className="primary" disabled={busy} onClick={run}>{busy?t('running'):t('run')} <span>→</span></button>
    {busy&&<button onClick={cancel}>{t('cancel')}</button>}
   </div>
   {status&&<div role="status" className="status">{t(status)}{busy&&<progress value={progress} max={1}/>}</div>}
   {error&&<div role="alert" className="error">{error}</div>}
   <details className="params-details">
    <summary>{t('parameters')}</summary>
    {task==='expression'
     ? <label>{t('model')}
        <select disabled={busy} value={params.model} onChange={e=>param('model',e.target.value)}>
         {['lafleur2022','hossain2020','urtecho2018','yu2021','kosuri2013'].map(m=><option key={m} value={m}>{m==='kosuri2013'?t('translation'):t('transcription')} · {m}</option>)}
        </select>
       </label>
     : task==='genome-annotation'
     ? <>
        <label>{t('upstreamLength')}<input disabled={busy} type="number" min={50} max={500} value={params.upstream_length??200} onChange={e=>param('upstream_length',Number(e.target.value))}/></label>
        <label>{t('minIntergenic')}<input disabled={busy} type="number" min={1} max={200} value={params.min_intergenic??5} onChange={e=>param('min_intergenic',Number(e.target.value))}/></label>
        <details><summary>{t('advanced')}</summary>
         <label>{t('minimum')}<input disabled={busy} type="number" min={1} max={200} value={params.minimum} onChange={e=>param('minimum',Number(e.target.value))}/></label>
         <label className="check"><input disabled={busy} type="checkbox" checked={params.cooccurrence} onChange={e=>param('cooccurrence',e.target.checked)}/>{t('cooccurrence')}</label>
        </details>
       </>
     : <>
        <label>{t('step')}<input disabled={busy} type="number" min={1} max={200} value={params.step} onChange={e=>param('step',Number(e.target.value))}/></label>
        <label className="check"><input disabled={busy} type="checkbox" checked={params.merge} onChange={e=>param('merge',e.target.checked)}/>{t('merge')}</label>
        <details><summary>{t('advanced')}</summary>
         <label>{t('minimum')}<input disabled={busy} type="number" min={1} max={200} value={params.minimum} onChange={e=>param('minimum',Number(e.target.value))}/></label>
         <label className="check"><input disabled={busy} type="checkbox" checked={params.cooccurrence} onChange={e=>param('cooccurrence',e.target.checked)}/>{t('cooccurrence')}</label>
        </details>
       </>
    }
   </details>
  </section>

  {/* ── Results area ── */}
  <article>
   {!genomeResult&&!result&&<div className="empty-hint"><p>{t('firstRunHint')}</p></div>}
   {/* Genome annotation results */}
   {genomeResult&&<>
    <div className="metrics">
     <div><small>{t('genesScanned')}</small><strong>{genomeResult.summary.genes_scanned}</strong></div>
     <div><small>{t('genesInFile')}</small><strong>{genomeResult.summary.genes_in_file}</strong></div>
     <div><small>{t('elementCount')}</small><strong>{genomeResult.summary.element_count}</strong></div>
     <div><small>{t('time')}</small><strong>{genomeResult.elapsed_seconds.toFixed(2)}<em> s</em></strong></div>
    </div>
    <section className="panel result-panel">
     <div className="genome-type-breakdown">
      {[...genomeTypeMap.entries()].sort((a,b)=>b[1]-a[1]).map(([type,count])=><div key={type} className="type-row"><span>{type}</span><strong>{count}</strong></div>)}
     </div>
     <div className="export-row">
      <select aria-label="Export format" value={format} onChange={e=>setFormat(e.target.value)}>
       <option value="gb">GenBank</option>
       <option value="gff3">{t('gff3Export')}</option>
       <option value="csv">{t('csvExport')}</option>
      </select>
      <button disabled={busy} onClick={exportResult}>{t('export')} ↓</button>
     </div>
    </section>
   </>}

   {/* Sequence / expression results */}
   {!genomeResult&&result&&<>
    <div className="metrics">
     <div><small>{t('sequence')}</small><strong>{result.records.length}</strong></div>
     {result.task!=='annotation'&&<div><small>{t('model')}</small><strong className="model-name">{result.model.id}</strong></div>}
     <div><small>{result.task==='annotation'?t('elements'):t('count')}</small><strong>{result.task==='annotation'?rows(result).length:result.predictions?.length}</strong></div>
     <div><small>{t('time')}</small><strong>{result.elapsed_seconds.toFixed(2)}<em> s</em></strong></div>
    </div>
    <section className="panel result-panel">
     <div className="result-controls">
      <label>{t('sequence')}
       <select value={sequence} onChange={e=>{setSequence(e.target.value);setFrom(1);setTo(result.records.find(r=>r.id===e.target.value)?.sequence.length??to);setSelected(-1);}}>
        {result.records.map(r=><option key={r.id} value={r.id}>{r.id} · {r.sequence.length} bp</option>)}
       </select>
      </label>
      {result.task==='annotation'&&<div className="range">
       <span>{t('view')}</span>
       <input aria-label={t('from')} type="number" min={1} max={current?.sequence.length} value={from} onChange={e=>setFrom(Number(e.target.value)||1)}/>
       <span>—</span>
       <input aria-label={t('to')} type="number" min={1} max={current?.sequence.length} value={to} onChange={e=>setTo(Number(e.target.value)||1)}/>
      </div>}
     </div>

     {result.task==='annotation'
      ? <>
         <p className="small muted">{t('zoomHint')}</p>
         <div className="track">
          <div className="zoom-btns">
           <button onClick={()=>zoomBy(1)} title="Zoom out">−</button>
           <button onClick={()=>zoomBy(-1)} title="Zoom in">+</button>
          </div>
          <svg ref={svg} viewBox={`0 0 800 ${svgH}`} role="img" aria-label={t('annotation')}
           onMouseDown={handleMouseDown}
           onMouseMove={handleMouseMove}
           onMouseUp={handleMouseUp}
           onMouseLeave={handleMouseUp}
           style={{cursor:dragging?'grabbing':'grab',userSelect:'none'}}>
           <defs>
            <pattern id="hatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
             <line x1="0" y1="0" x2="0" y2="6" stroke="#555" strokeWidth="1.5" strokeOpacity="0.5"/>
            </pattern>
           </defs>
           <rect width="800" height={svgH} fill="#fff"/>
           {/* Header */}
           <text x="28" y="20" fill="#476565" fontSize="12">{sequence} · {start}–{end} bp</text>
           {/* Strand labels */}
           <text x="16" y="100" fontSize="10" fill="#8aaba5" textAnchor="middle">+</text>
           <text x="16" y="223" fontSize="10" fill="#8aaba5" textAnchor="middle">−</text>
           {/* Center axis */}
           <line x1="28" y1={AXIS_Y} x2="772" y2={AXIS_Y} stroke="#bdcdcc" strokeWidth="1.5"/>
           {/* Vertical grid + tick labels */}
           {Array.from({length:6},(_,i)=>{const x=28+i*744/5;return <g key={i}><line x1={x} y1="30" x2={x} y2="284" stroke="#e6eeed"/><text x={x} y="295" fontSize="11" fill="#697c7c" textAnchor="middle">{Math.round(start+i*(length-1)/5)}</text></g>;})}
           {/* Elements: forward above axis, reverse below */}
           {visible.map((e,i)=>{
            const left=Math.max(e.abs_start,start-1),right=Math.min(e.abs_end,end);
            const isRev=e.strand==='-';
            const rx=28+(left-start+1)/length*744;
            const rw=Math.max(3,(right-left)/length*744);
            const ry=isRev?AXIS_Y+6+(e.label%6)*20:AXIS_Y-20-(e.label%6)*20;
            return <g key={`${e.key}-${i}`} onClick={()=>setSelected(e.key)} style={{cursor:'pointer'}}>
             <rect x={rx} y={ry} width={rw} height="14" rx="3" fill={isRev?`url(#hatch)`:colors[e.label]} stroke={selected===e.key?'#102e36':isRev?colors[e.label]:'none'} strokeWidth={selected===e.key?2:isRev?1.5:0}><title>{e.type}{isRev?' (−)':' (+)'}: {e.abs_start+1}–{e.abs_end}</title></rect>
             {isRev&&<rect x={rx} y={ry} width={rw} height="14" rx="3" fill={colors[e.label]} fillOpacity="0.25"/>}
            </g>;
           })}
           {/* Base letters when zoomed ≤90 bp */}
           {length<=90&&current&&Array.from({length},(_,i)=>{
            const pos=start+i-1;
            const base=current.sequence[pos]?.toUpperCase()||'';
            return <text key={i} x={28+(i+0.5)/length*744} y="310" fontSize="10" textAnchor="middle" fill={BASE_COLOR[base]||'#9e9e9e'}>{base}</text>;
           })}
          </svg>
         </div>
         <div className="legend">
          {[...new Map(elements.map(e=>[e.label,e.type])).entries()].map(([label,type])=><span key={label}><i style={{background:colors[label]}}/>{type}</span>)}
          {elements.some(e=>e.strand==='-')&&<span><i style={{background:'repeating-linear-gradient(45deg,#555 0,#555 1.5px,transparent 0,transparent 4.5px)'}}/>{t('strandReverse')}</span>}
         </div>
         {!elements.length&&<p>{t('noElements')}</p>}
         <p className="small muted">{t('background')}</p>
         {chosen&&<div className="detail">
          <strong>{t('details')}: {chosen.type}</strong>
          <span>{chosen.abs_start+1}–{chosen.abs_end} bp · {chosen.abs_end-chosen.abs_start} bp · {chosen.strand==='-'?t('strandReverse'):t('strandForward')}</span>
          <code>{current?.sequence.slice(chosen.abs_start,chosen.abs_end)}</code>
          {chosen.source_windows&&<span>{t('window')}: {chosen.source_windows.join(', ')}</span>}
         </div>}
         <div className="table-tools">
          <input placeholder={t('filter')} value={filter} onChange={e=>{setFilter(e.target.value);setSelected(-1);}}/>
          <select aria-label="Sort" value={sort} onChange={e=>{setSort(e.target.value as 'start'|'type');setSelected(-1);}}>
           <option value="start">{t('start')} ↑</option>
           <option value="type">{t('type')} A–Z</option>
          </select>
         </div>
         <div className="table-scroll">
          <table><thead><tr><th>{t('type')}</th><th>{t('start')}</th><th>{t('end')}</th><th>±</th><th>{t('window')}</th></tr></thead>
          <tbody>{elements.map((e,i)=><tr key={i} className={selected===i?'selected':''} onClick={()=>setSelected(i)}>
           <td><i className="dot" style={{background:colors[e.label]}}/>{e.type}</td>
           <td>{e.abs_start+1}</td><td>{e.abs_end}</td>
           <td>{e.strand==='-'?'−':'+'}</td>
           <td>{e.window_start_0based!==''?`${Number(e.window_start_0based)+1}–${e.window_end_0based}`:'—'}</td>
          </tr>)}</tbody></table>
         </div>
        </>
      : <>
         <div className="notice">{t('scale')}</div>
         {(()=>{const vals=(result.predictions??[]).map(p=>p.value).sort((a,b)=>a-b);if(vals.length<2)return null;const mid=vals.length/2;const median=vals.length%2?vals[Math.floor(mid)]:(vals[mid-1]+vals[mid])/2;const mean=vals.reduce((s,v)=>s+v,0)/vals.length;return <div className="metrics" style={{marginBottom:14}}><div><small>{t('min')}</small><strong className="model-name">{vals[0].toPrecision(4)}</strong></div><div><small>{t('max')}</small><strong className="model-name">{vals[vals.length-1].toPrecision(4)}</strong></div><div><small>{t('mean')}</small><strong className="model-name">{mean.toPrecision(4)}</strong></div><div><small>{t('median')}</small><strong className="model-name">{median.toPrecision(4)}</strong></div></div>;})()}
         <table><thead><tr><th>{t('sequence')}</th><th>{t('expression')}</th></tr></thead>
         <tbody>{result.predictions?.map(p=><tr key={p.sequence_id}><td>{p.sequence_id}</td><td className="value">{p.value.toPrecision(8)}</td></tr>)}</tbody></table>
        </>
     }

     <div className="export-row">
      <select aria-label="Export format" value={format} onChange={e=>setFormat(e.target.value)}>
       <option value="tsv">TSV</option>
       <option value="json">JSON</option>
       {result.task==='expression'?<option value="csv">CSV</option>:<option value="svg">SVG</option>}
      </select>
      <select aria-label="Export scope" value={scope} disabled={format==='svg'} onChange={e=>setScope(e.target.value)}>
       <option value="all">{t('all')}</option>
       <option value="current">{t('current')}</option>
      </select>
      <button disabled={busy} onClick={exportResult}>{t('export')} ↓</button>
     </div>
    </section>
   </>}
  </article>
 </main>
 {about&&<div className="modal-backdrop" onClick={()=>setAbout(false)}>
  <section className="modal" role="dialog" aria-modal="true" aria-label={t('about')} onClick={e=>e.stopPropagation()}>
   <h2>{t('about')}</h2>
   <p className="small muted">{t('cpuOnly')}</p>
   <p className="small muted">{t('citationHint')}</p>
   <code className="citation-block">{t('citation')}</code>
<div>
    <button onClick={()=>safe(async()=>{await invoke('open_paper');})}>{t('paper')} ↗</button>
    <button onClick={()=>safe(async()=>{await invoke('open_source');})}>{t('source')} ↗</button>
    <button onClick={()=>safe(async()=>{await invoke('open_licenses');})}>{t('licenses')}</button>
    <button className="primary" onClick={()=>setAbout(false)}>{t('close')}</button>
   </div>
  </section>
 </div>}
 </div>;
}
