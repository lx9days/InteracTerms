import * as pdfjs from './pdfjs/pdf.mjs'
pdfjs.GlobalWorkerOptions.workerSrc = './pdfjs/pdf.worker.mjs'
const $ = id => document.getElementById(id)
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]))
const data = await fetch('./catalog.json').then(r=>r.json())
const noteKey = 'InteracTerms.notes.'
function readNotes() {
  const result = {}
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(noteKey)) result[key.slice(noteKey.length)] = JSON.parse(localStorage.getItem(key))
  }
  return result
}
const notes = readNotes()
const pdfFiles = window.parent === window || !document.referrer.startsWith(location.origin + '/') ? new Map() : window.parent.interacPdfFiles || new Map()
window.interacPdfFiles = pdfFiles
const caseData = await fetch('./cases.json').then(r=>r.json())
const allCases = new Map([...caseData.ambiguities,...caseData.underspecified].map(c=>[c.case_id,c]))
const records = new Map(data.terms.map(t => [t.id,t]))
const papers = new Map(data.papers.map(p => [p.id,p]))
let current, paper, doc, loading, rendering, page, revision = 0, dirty = false, anchors, anchorError
const displayStatus = value => ({'待复核':'Pending review','已核对':'Verified','存在歧义':'Ambiguous','信息缺失':'Missing information'}[value] || value)
const evidenceLabel = value => ({'术语出现':'Term occurrences','定义／解释引句':'Definition / explanation quote','用法证据':'Usage evidence','来源证据':'Source evidence','来源证据（未判定为解释）':'Source evidence (not classified as explanation)'}[value] || value)
const status = t => notes[t.id]?.status || t.status || '待复核'
const names = t => t.term.split(/\s*\/\s*|;/).map(s => s.trim().toLowerCase()).filter(Boolean)
const part = (label,value) => '<h3>'+esc(label)+'</h3><p>'+esc(value || 'Not recorded')+'</p>'
function componentsOf(t) {
  if(t.components?.length) return t.components
  return (t.classification || '').split(/\r?\n/).map(line => line.match(/^([^:：]+)[:：]\s*(.+)$/))
    .filter(Boolean).map(m => ({text:m[1].trim(),classification:m[2].trim()}))
}
function lexicalText(t) {
  return (t.lexicalComponents || []).map(c => [c.text,c.classification,c.phrase && 'Phrase '+c.phrase].filter(Boolean).join(' · ')).join('\n')
}
const categories = t => [...(t.lexicalComponents || []),...componentsOf(t)].map(c => (c.classification || c.category || '').split('(')[0].trim()).filter(Boolean)
function componentText(t) {
  return componentsOf(t).map(c => [c.text,c.classification || c.category,c.reason].filter(Boolean).join(' · ')).join('\n')
}
function evidenceOf(t) {
  const entries=[]
  const explanation=t.explanationQuote?.trim()
  const quote=t.quote?.trim()
  if(quote && quote!==explanation) {
    const definition=t.evidenceKind==='definition'
    const label=definition?'Definition / explanation quote':t.evidenceKind==='usage'?'Usage evidence':'Source evidence (not classified as explanation)'
    entries.push({quote,kind:definition?'definition':'source',label})
  }
  if(explanation) entries.push({quote:explanation,kind:'definition',label:'Definition / explanation quote'})
  return entries
}
function description(t) {
  return (t.lexicalComponents?.length ? part('Word-level classification',lexicalText(t)) : '')+part('Framework classification',t.classification)+part('Phrase components and classifications',componentText(t))+part('Meaning in context',t.usage)+
    (evidenceOf(t).map(e=>'<h3>'+e.label+'</h3><blockquote>'+esc(e.quote)+'</blockquote>').join('') || part('Source evidence','Not recorded'))+
    part('Relations, boundaries and ambiguity',t.boundary)+part('Instance scope',t.group)+part('Source location',t.location)
}
function related(t) {
  const keys = new Set(names(t))
  return data.terms.filter(other => other.paperId !== t.paperId && names(other).some(k => keys.has(k)))
}
function list() {
  const q = $('search').value.trim().toLowerCase()
  const rows = data.terms.filter(t => (!$('paperFilter').value || t.paperId === $('paperFilter').value) &&
    (!$('categoryFilter').value || categories(t).includes($('categoryFilter').value)) &&
    (!$('scopeFilter').value || t.group === $('scopeFilter').value) &&
    (!$('statusFilter').value || status(t) === $('statusFilter').value) &&
    [t.term,...(t.lexicalComponents || []).map(c=>c.text),...componentsOf(t).map(c=>c.text)].some(text=>String(text || '').toLowerCase().includes(q)))
  $('counts').textContent = 'Showing '+rows.length+' / '+data.terms.length+' usages · '+data.papers.length+' PDFs'
  $('browse').hidden = !$('paperFilter').value
  $('list').innerHTML = rows.map(t => '<tr data-id="'+esc(t.id)+'"><td><button>'+esc(t.term)+'</button></td>'+
    [t.source,t.classification,t.usage,t.location,displayStatus(status(t))].map(v => '<td>'+esc(v)+'</td>').join('')+'</tr>').join('') ||
    '<tr><td colspan="6">No terms match the filters.</td></tr>'
}
if(data.sync) {
  const date = data.sync.snapshotAt && new Date(data.sync.snapshotAt).toLocaleString('en-US')
  $('sync').textContent=['Local catalog snapshot',date && 'Local catalog updated '+date].filter(Boolean).join(' · ')
}
for(const name of [...new Set(data.terms.flatMap(categories))].sort()) $('categoryFilter').add(new Option(name,name))
for (const p of data.papers) $('paperFilter').add(new Option(p.title,p.id))
$('search').oninput = $('paperFilter').onchange = $('categoryFilter').onchange = $('scopeFilter').onchange = $('statusFilter').onchange = list
$('list').onclick = e => {const row=e.target.closest('tr[data-id]'); if(row) openRecord(records.get(row.dataset.id))}
$('browse').onclick = () => openRecord(null,$('paperFilter').value)
function canLeave() {return !dirty || confirm('You have unsaved notes. Discard changes and leave?')}
function leave() {
  if (!canLeave()) return
  dirty=false
  revision++
  rendering?.cancel()
  loading?.destroy()
  doc=null
  $('workspace').hidden=true
  $('home').hidden=false
  list()
  const row=[...$('list').rows].find(r=>r.dataset.id===current?.id)
  row?.querySelector('button')?.focus({preventScroll:true})
}
$('back').onclick=leave
async function openRecord(t, id=t.paperId) {
  if (!canLeave()) return
  dirty=false
  const run=++revision
  rendering?.cancel()
  loading?.destroy()
  doc=null
  current=t
  anchors=null;anchorError=null
  paper=papers.get(id)
  $('comparison').close()
  $('home').hidden=true
  $('workspace').hidden=false
  $('term').textContent=t?.term || 'Paper reader'
  $('paperTitle').textContent=paper?.title || t?.source || 'No linked PDF'
  $('detailBody').innerHTML=t ? description(t) : ''
  $('legend').innerHTML=t ? '<span class="word">Term occurrences</span>'+evidenceOf(t).map(e=>'<span class="'+e.kind+'">'+e.label+'</span>').join('') : ''
  $('editor').hidden=!t
  $('compare').hidden=!t || !related(t).length
  if(t) {
    $('review').value=status(t)
    $('note').value=notes[t.id]?.text || ''
    $('saved').textContent=''
  }
  $('occurrences').hidden=!t || !paper
  $('occurrences').open=false
  $('occurrenceSummary').textContent='Term occurrences across pages · Loading'
  $('occurrencePages').replaceChildren()
  $('overlay').replaceChildren()
  $('canvas').style.display='none'
  $('pages').textContent=''
  page=Math.max(1, Number(t?.page) || 1)
  $('page').value=page
  $('original').hidden=true
  $('file').value=''
  $('file').disabled=!paper
  if(!paper){$('message').textContent='No linked PDF';return}
  const url=pdfFiles.get(id)
  if(!url){$('message').textContent='Select your copy of this PDF to view the indexed evidence.';$('occurrences').hidden=true;return}
  $('original').hidden=false
  $('message').textContent='Loading PDF…'
  try {
    loading=pdfjs.getDocument({url,cMapUrl:'./pdfjs/cmaps/',cMapPacked:true,standardFontDataUrl:'./pdfjs/standard_fonts/',wasmUrl:'./pdfjs/wasm/'})
    const [loaded,stored]=await Promise.all([loading.promise,t ? fetch('./evidence/'+encodeURIComponent(id)+'.json').then(r=>r.json()).then(entries=>{
      const entry=entries[t.id]
      if(entry?.paperHash!==paper.sha256)throw Error('Matching highlight index unavailable')
      return entry
    }).catch(e=>({error:e.message})) : null])
    if(run!==revision) return
    doc=loaded
    anchors=stored?.error ? null : stored;anchorError=stored?.error
    page=Math.min(page,doc.numPages)
    draw()
    if(t) showOccurrences()
  } catch(e) {if(run===revision) $('message').textContent='PDF loading failed: '+e.message}
}
$('file').onchange=async()=>{
  const target=paper, file=$('file').files[0], run=revision
  if(!file)return
  try {
    const hash=await crypto.subtle.digest('SHA-256',await file.arrayBuffer())
    if(run!==revision)return
    if(Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('')!==target.sha256)throw Error('This file does not match the indexed edition.')
    if(!pdfFiles.has(target.id))pdfFiles.set(target.id,URL.createObjectURL(file))
    const details=$('detailBody').innerHTML
    await openRecord(current,target.id)
    if(current?.paperId===target.id)$('detailBody').innerHTML=details
  }catch(e){if(run===revision)$('message').textContent=e.message}
}
$('compare').onclick=()=>{
  $('caseSummary').hidden=true
  $('comparison').classList.remove('with-case')
  $('compareTitle').textContent=current.term+' · Usage across papers'
  if(!canLeave())return
  dirty=false
  const uses=related(current)
  const frame=(id,side)=>'<iframe title="'+side+' PDF reader" src="./?reader='+encodeURIComponent(id)+'"></iframe>'
  $('cards').innerHTML='<section class="compare-pane"><div class="pane-head">Left · '+esc(current.source)+'</div>'+frame(current.id,'Left')+'</section>'+
    '<section class="compare-pane"><div class="pane-head"><label for="compareSource">Right-hand paper usage</label><select id="compareSource">'+uses.map(t=>'<option value="'+esc(t.id)+'">'+esc(t.source+' — '+t.term)+'</option>').join('')+'</select></div>'+frame(uses[0].id,'Right')+'</section>'
  $('compareSource').onchange=()=>{
    const frame=$('cards').querySelectorAll('iframe')[1]
    if(frame.contentWindow.evidenceCanLeave && !frame.contentWindow.evidenceCanLeave()){$('compareSource').value=frame.dataset.record;return}
    frame.dataset.record=$('compareSource').value
    frame.src='./?reader='+encodeURIComponent($('compareSource').value)
  }
  $('cards').querySelectorAll('iframe')[1].dataset.record=uses[0].id
  $('comparison').showModal()
}
function closeComparison(){
  for(const frame of $('cards').querySelectorAll('iframe'))if(frame.contentWindow.evidenceCanLeave && !frame.contentWindow.evidenceCanLeave())return
  $('comparison').close();$('cards').replaceChildren()
  Promise.resolve(readNotes()).then(saved=>{Object.assign(notes,saved);if(current){$('note').value=notes[current.id]?.text||'';$('review').value=status(current)}})
}
$('close').onclick=closeComparison
$('comparison').addEventListener('cancel',e=>{e.preventDefault();closeComparison()})
window.evidenceCanLeave=canLeave

function showOccurrences(){
  if(!anchors){$('occurrenceSummary').textContent=anchorError || 'Local index not generated';return}
  const pages=Object.entries(anchors.pages).filter(([,p])=>p.words);
  for(const [number,p] of pages){const button=document.createElement('button');button.textContent='Page '+number+' pages · '+p.words+' matches';button.onclick=()=>go(Number(number));$('occurrencePages').append(button)}
  $('occurrenceSummary').textContent='Term occurrences across pages · '+pages.length+' pages / '+anchors.total+' matches · Local index';
}
function showHighlights(stored,scale){
  for(const m of [...stored.marks].sort((a,b)=>(a.kind==='word')-(b.kind==='word'))){
    const mark=document.createElement('span');mark.className='hit '+m.kind;
    mark.title=evidenceLabel(m.label)+' · '+m.text+'\n'+(current.usage || current.classification || '');
    mark.style.cssText='left:'+m.x*scale+'px;top:'+m.y*scale+'px;width:'+m.width*scale+'px;height:'+m.height*scale+'px';
    $('overlay').append(mark);
  }
}
async function draw(){
  if(!doc) return
  const run=++revision
  rendering?.cancel()
  $('overlay').replaceChildren()
  $('message').textContent='Rendering…'
  try{
    const pg=await doc.getPage(page)
    if(run!==revision)return
    const unit=pg.getViewport({scale:1})
    const scale=$('zoom').value==='fit'?Math.max(.25,($('scroll').clientWidth-48)/unit.width):Number($('zoom').value)*96/72
    const v=pg.getViewport({scale}),dpr=Math.max(2,window.devicePixelRatio || 1)
    const canvas=$('canvas')
    canvas.width=Math.ceil(v.width*dpr)
    canvas.height=Math.ceil(v.height*dpr)
    canvas.style.cssText='display:block;width:'+v.width+'px;height:'+v.height+'px'
    $('sheet').style.width=v.width+'px'
    rendering=pg.render({canvasContext:canvas.getContext('2d'),viewport:v,transform:[dpr,0,0,dpr,0,0]})
    await rendering.promise
    if(run!==revision)return
    $('page').value=page
    $('page').max=doc.numPages
    $('pages').textContent='/ '+doc.numPages
    $('original').href=pdfFiles.get(paper.id)+'#page='+page
    let message='PDF Page '+page+' pages'
    if(current){
      const stored=anchors?.pages[page];
      if(stored){
        showHighlights(stored,scale);
        const evidence=stored.evidence.map(e=>evidenceLabel(e.label)+(e.count?'Exact matches: '+e.count+' matches':'Full quote not located on this page'));
        message+=' · Term '+stored.words+' matches · '+(evidence.join(' · ') || 'No source quote recorded')+' · Local index';
      }else message+=' · '+(anchorError || 'No index for this page; rebuild the index');
    }
    $('message').textContent=message
    $('scroll').scrollTop=0
  }catch(e){if(run===revision && e.name!=='RenderingCancelledException')$('message').textContent='Page rendering failed: '+e.message}
}
function go(value){if(doc){page=Math.max(1,Math.min(doc.numPages,Math.trunc(value)||1));draw()}}
$('prev').onclick=()=>go(page-1)
$('next').onclick=()=>go(page+1)
$('page').onchange=()=>go(Number($('page').value))
$('zoom').onchange=draw
$('note').oninput=$('review').onchange=()=>{dirty=true}
$('save').onclick=async()=>{
  const id=current.id,n={id,text:$('note').value,status:$('review').value}
  $('save').disabled=true
  try{
    localStorage.setItem(noteKey+id,JSON.stringify(n))
    notes[id]=n
    if(current?.id===id){dirty=$('note').value!==n.text || $('review').value!==n.status;$('saved').textContent=dirty?'Previous version saved':'Saved locally'}
  }catch(e){$('saved').textContent='Save failed: '+e.message}
  finally{$('save').disabled=false}
}
$('export').onclick=()=>{
  const a=document.createElement('a')
  a.href=URL.createObjectURL(new Blob([JSON.stringify({exportedAt:new Date().toISOString(),notes:readNotes()},null,2)],{type:'application/json'}))
  a.download='evidence-notes.json'
  a.click()
  setTimeout(()=>URL.revokeObjectURL(a.href),1000)
}
window.onbeforeunload=e=>{if(dirty){e.preventDefault();e.returnValue=''}}
if(!new URLSearchParams(location.search).has('reader'))list()

const titleOf = id => papers.get('S'+id)?.title || id
const readable = value => Array.isArray(value) ? value.join(', ') : String(value ?? '')
const caseDetails = c => c.difference
  ? part('Meaning difference',c.difference)+part('Interpretation status',c.status.replaceAll('_',' '))+part('Boundary',c.boundary)+part('Limitations',c.limitations)
  : part('Missing name components',readable(c.missing_components))+part('Actual mechanism',c.actual_mechanism)+part('Possible misreading',c.possible_misreading)+part('Paper-level explanation gap',c.paper_unspecified===false?'No — the paper explains the mechanism':c.paper_unspecified===true?'Yes — see evidence':c.paper_unspecified)+part('Suggested wording',c.suggested_expression)+part('Limitations',c.limitations)
function caseRecord(c,side='a') {
  const source=String(c['source_'+side] ?? c.source_id)
  const candidates=c.term_ids.map(id=>records.get(id)).filter(t=>t?.paperId==='S'+source)
  const loc=String(c['location_'+side] ?? readable(c.pdf_page))
  const page=Number(loc.match(/\d+/)?.[0]) || candidates[0]?.page || 1
  return {record:candidates.find(t=>t.page===page) || candidates[side==='b'?1:0] || candidates[0],page}
}
function openCase(c) {
  if(!canLeave())return
  if(c.difference){
    const frame=side=>{
      const {record,page}=caseRecord(c,side)
      return '<section class="compare-pane"><div class="pane-head">'+esc(titleOf(c['source_'+side]))+' · '+esc(c['location_'+side])+'</div><iframe title="'+side.toUpperCase()+' case evidence" src="./?reader='+encodeURIComponent(record.id)+'&case='+encodeURIComponent(c.case_id)+'&side='+side+'&page='+page+'"></iframe></section>'
    }
    $('compareTitle').textContent=c.term+' · Evidence comparison'
    $('caseSummary').innerHTML=caseDetails(c)
    $('caseSummary').hidden=false
    $('comparison').classList.add('with-case')
    $('cards').innerHTML=frame('a')+frame('b')
    $('comparison').showModal()
  }else{
    const {record,page}=caseRecord(c)
    openRecord({...record,page}).then(()=>{
      $('detailBody').insertAdjacentHTML('afterbegin',caseDetails(c)+part('Case evidence',c.evidence))
    })
  }
}
function showTab(tab){
  document.querySelectorAll('[data-tab]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.tab===tab)))
  $('termPanel').hidden=tab!=='terms';$('casePanel').hidden=tab==='terms'
  if(tab==='terms')return
  const ambiguity=tab==='ambiguities',rows=caseData[tab]
  $('caseHeading').textContent=(ambiguity?'Ambiguities':'Underspecified expressions')+' · '+rows.length
  $('caseIntro').textContent=ambiguity?'Context-dependent meanings and documented mode differences. Open a case to compare its two source passages.':'Name-level omissions do not necessarily indicate missing explanations in the paper. Open a case to inspect the source.'
  const headers=ambiguity?['Expression','Source A','Source B','Meaning difference','Case status']:['Expression','Source','Missing name components','Actual mechanism','Paper-level explanation gap']
  $('caseHead').innerHTML='<tr>'+headers.map(h=>'<th>'+esc(h)+'</th>').join('')+'</tr>'
  $('caseList').innerHTML=rows.map(c=>'<tr><td><button data-case="'+esc(c.case_id)+'">'+esc(c.term)+'</button></td>'+ (ambiguity?[titleOf(c.source_a)+' · '+c.location_a,titleOf(c.source_b)+' · '+c.location_b,c.difference,c.status.replaceAll('_',' ')]:[c.title,readable(c.missing_components),c.actual_mechanism,c.paper_unspecified===false?'No — explained in paper':c.paper_unspecified===true?'Yes':'See case']).map(v=>'<td>'+esc(v)+'</td>').join('')+'</tr>').join('')
}
document.querySelectorAll('[data-tab]').forEach(b=>{
 b.textContent+=' ('+(b.dataset.tab==='terms'?data.terms.length:caseData[b.dataset.tab].length)+')'
 b.onclick=()=>showTab(b.dataset.tab)
})
$('caseList').onclick=e=>{const b=e.target.closest('[data-case]');if(b)openCase(allCases.get(b.dataset.case))}
const params=new URLSearchParams(location.search),readerId=params.get('reader')
if(readerId){
 document.body.classList.add('embedded-reader')
 const record=records.get(readerId),c=allCases.get(params.get('case')),side=params.get('side') || 'a'
 if(record)await openRecord({...record,page:Number(params.get('page')) || record.page})
 if(c)$('detailBody').insertAdjacentHTML('afterbegin',part('Case meaning',c['meaning_'+side])+part('Case evidence',c['evidence_'+side])+part('Case location',c['location_'+side]))
}
