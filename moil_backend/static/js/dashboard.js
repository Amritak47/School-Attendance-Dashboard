/*
 * dashboard.js
 * Client-side logic for the Attendly attendance dashboard.
 *
 * Sections:
 *   UTILITIES        — formatting helpers, toast, risk classification
 *   RENDERING        — student cards, case cards, overview, all-students table
 *   CASE STATUS      — status buttons, contact modal, contact history timeline
 *   NOTES            — note log rendering, add / save notes
 *   CASE PLAN        — open / close / load / save / print the per-period case plan modal
 *   TREND CHARTS     — per-student attendance trend (lazy-loaded Chart.js line chart)
 *   TABS & NAVIGATION — layer (tab) switching, sidebar tab links, init / DOMContentLoaded
 *   PRINCIPAL REPORT — summary KPIs, form bar chart, unactioned list, accountability table
 *   DAY ANALYSIS     — day-of-week absentee upload, chart, findings, student table
 *
 * Globals injected by the inline <script> in dashboard.html (available before this file loads):
 *   STUDENTS, SCHOOL_NAME, SCHOOL_LOGO, CP_TEMPLATE, UPLOAD, CURRENT_USER_NAME, FORM_FILTER
 */

// ══ CASE PLAN TEMPLATE APPLICATION ══
// Applies CP_TEMPLATE labels/placeholders to the case plan modal fields.
function applyCpTemplate() {
  const t = CP_TEMPLATE || {};
  // Section titles
  Object.entries(t.sections || {}).forEach(([key, title]) => {
    const el = document.getElementById('cp-sec-' + key);
    if (el) el.textContent = title;
  });
  // Field labels and placeholders (skip checkboxes — handled by cbMap below)
  Object.entries(t.fields || {}).forEach(([id, cfg]) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.type === 'checkbox' || el.type === 'radio') return;
    if (cfg.placeholder !== undefined) el.placeholder = cfg.placeholder;
    const wrap = el.closest('.cp-field') || el.closest('div');
    const lbl  = wrap && wrap.querySelector('label:first-child');
    if (lbl && cfg.label && lbl.firstChild) lbl.firstChild.textContent = cfg.label;
  });
  // Checkbox labels (no .cp-field wrapper)
  const cbMap = {
    'cp-sup-curriculum': 'cp-lbl-curriculum', 'cp-sup-career':   'cp-lbl-career',
    'cp-sup-basicneeds': 'cp-lbl-basicneeds', 'cp-sup-mental':   'cp-lbl-mental',
    'cp-sup-behaviour':  'cp-lbl-behaviour',  'cp-sup-social':   'cp-lbl-social',
  };
  Object.entries(cbMap).forEach(([fid, lid]) => {
    const cfg = (t.fields || {})[fid];
    const lbl = document.getElementById(lid);
    if (cfg && cfg.label && lbl) lbl.textContent = cfg.label;
  });
}


let CASE_FILTER = '';

// ── UTILS ──────────────────────────────────────
function fmtD(s){const d=s/2;return d%1===0?String(d):d.toFixed(1);}
function pct2risk(p){return p===0?'zero':p<50?'critical':p<80?'concern':p<90?'watch':'good';}
function pct2col(p){return p===0?'var(--red)':p<50?'var(--amber)':p<80?'var(--gold)':'var(--green)';}
function pct2txt(p){return{zero:'Zero',critical:'Critical',concern:'Concern',watch:'Watch',good:'Good'}[pct2risk(p)];}
function pct2badge(p){const m={zero:'b-red',critical:'b-amber',concern:'b-gold',watch:'b-blue',good:'b-green'};return`<span class="badge ${m[pct2risk(p)]}">${pct2txt(p)}</span>`;}
function avCls(p){return{zero:'av-r',critical:'av-a',concern:'av-g',watch:'av-b',good:'av-gr'}[pct2risk(p)];}
function lcCls(p){return{zero:'lc-red',critical:'lc-amber',concern:'lc-gold',watch:'lc-blue',good:'lc-green'}[pct2risk(p)];}
function initials(n){const[l='',f='']=n.split(',');return((f.trim()[0]||'')+(l.trim()[0]||'')).toUpperCase();}
function formatName(n){if(!n)return'';const i=n.indexOf(',');if(i===-1)return n;const last=n.substring(0,i).trim();const first=n.substring(i+1).trim();return first?first+' '+last:last;}
function toast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500);}
function showUndoToast(message, undoFn) {
  const t = document.getElementById('toast');
  t.innerHTML = `${message} <button onclick="undoStatusChange()" style="margin-left:10px;background:rgba(255,255,255,0.25);border:none;color:white;padding:3px 10px;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;">Undo</button>`;
  t.classList.add('show');
  clearTimeout(showUndoToast._timer);
  showUndoToast._undoFn = undoFn;
  showUndoToast._timer = setTimeout(() => { t.classList.remove('show'); t.innerHTML=''; }, 5000);
}
function undoStatusChange() {
  if (showUndoToast._undoFn) { showUndoToast._undoFn(); showUndoToast._undoFn = null; }
  const t = document.getElementById('toast'); t.classList.remove('show'); t.innerHTML='';
}
function statusLabel(s){return{pending:'Pending',contacted:'Contacted',meeting:'Meeting',welfare:'Welfare',referred:'Referred',agency:'Multi-Agency',resolved:'Resolved',watchlist:'Watchlist'}[s]||'Pending';}

// ── SAVE ───────────────────────────────────────
let timers={};
function saveCase(ref,status,notes,name,form,contactMethod,contactOutcome){
  // Update in-memory IMMEDIATELY so filters reflect the change at once
  const s=STUDENTS.find(x=>x.ref===ref);
  if(s){
    if(status!==undefined)s.status=status;
    if(notes!==undefined)s.notes=notes;
  }
  refreshCaseCounts();
  // Debounce the actual server save
  setSave('saving');clearTimeout(timers[ref]);
  timers[ref]=setTimeout(async()=>{
    try{
      const body={student_ref:ref,student_name:name,form,status,notes,
        updated_by:CURRENT_USER_NAME||'Attendance Officer'};
      if(contactMethod)body.contact_method=contactMethod;
      if(contactOutcome)body.contact_outcome=contactOutcome;
      const res=await fetch('/api/case/update',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify(body)});
      if(!res.ok)throw new Error('Server error '+res.status);
      setSave('saved');
    }catch(e){
      console.error('Save failed:',e);
      setSave('error');
    }
  },500);
}
function setSave(st){
  const d=document.getElementById('save-dot'),l=document.getElementById('save-txt');
  if(st==='saving'){d.classList.add('saving');l.textContent='Saving…';}
  else if(st==='saved'){d.classList.remove('saving');d.style.background='#4CAF50';l.textContent='Saved';}
  else{d.style.background='#F44336';l.textContent='Error';}
}

// ── STATUS BUTTONS ─────────────────────────────
// _clog holds context for the contact modal while it is open
let _clog={};
function clickStatus(ref,newSt,name,form){
  const s=STUDENTS.find(x=>x.ref===ref);if(!s)return;
  const final=s.status===newSt?'pending':newSt;
  if(final==='pending'){
    // Toggling off — reset immediately, no modal needed
    applyStatus(ref,'pending',name,form,'','');
  } else {
    openContactModal(ref,final,name,form);
  }
}
function applyStatus(ref,status,name,form,contactMethod,contactOutcome){
  const s=STUDENTS.find(x=>x.ref===ref);if(!s)return;
  const prevStatus=s.status||'pending';
  s.status=status;
  saveCase(ref,status,undefined,name,form,contactMethod,contactOutcome);
  document.querySelectorAll(`.sb-${ref} .a-btn`).forEach(b=>{
    b.classList.toggle('on',b.dataset.st===status&&status!=='pending');
  });
  const dot=document.querySelector(`#cc-dot-${ref}`);
  if(dot){dot.className=`cc-status-dot dot-${status||'pending'}`;}
  refreshCaseCounts();
  const msg=status==='pending'?'Reset to pending':'Saved: '+statusLabel(status);
  showUndoToast(msg,()=>{
    s.status=prevStatus;
    saveCase(ref,prevStatus,undefined,name,form,'','');
    document.querySelectorAll(`.sb-${ref} .a-btn`).forEach(b=>{
      b.classList.toggle('on',b.dataset.st===prevStatus&&prevStatus!=='pending');
    });
    const d=document.querySelector(`#cc-dot-${ref}`);
    if(d){d.className=`cc-status-dot dot-${prevStatus||'pending'}`;}
    refreshCaseCounts();
    toast('Status restored to '+statusLabel(prevStatus));
  });
  // Refresh history timeline if card is open
  const chEl=document.getElementById(`ch-${ref}`);
  if(chEl&&chEl.closest('.open'))loadContactHistory(ref);
}
// ── NOTE LOG HELPERS ──────────────────────────────
function parseNoteEntries(raw){
  if(!raw||!raw.trim()) return [];
  // Split on lines that start with [DD Mon YYYY] timestamp pattern
  const lines=raw.split('\n');
  const entries=[];
  let cur=null;
  for(const line of lines){
    const m=line.match(/^\[(\d{1,2}\s+\w{3}\s+\d{4}(?:\s+\d{1,2}:\d{2})?)\]\s*(.*)/);
    if(m){if(cur)entries.push(cur);cur={date:m[1],text:m[2]};}
    else if(cur){cur.text+=(cur.text?'\n':'')+line;}
    else{cur={date:'',text:line};}
  }
  if(cur)entries.push(cur);
  return entries.reverse(); // newest first
}

function noteLogHtml(ref, raw, nm, form){
  const entries=parseNoteEntries(raw);
  const history=entries.length?entries.map(e=>`
    <div style="padding:8px 10px;background:#f8fafc;border-radius:6px;border-left:3px solid var(--school-green);margin-bottom:6px;">
      ${e.date?`<div style="font-size:10px;font-weight:700;color:#64748b;margin-bottom:3px;">${e.date}</div>`:''}
      <div style="font-size:12.5px;color:#1e293b;white-space:pre-wrap;">${e.text.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
    </div>`).join('')
    :'<div style="font-size:12px;color:#94a3b8;padding:6px 0;">No notes yet.</div>';
  return`<div class="note-log" id="nl-${ref}">
    <div id="nl-history-${ref}" style="max-height:180px;overflow-y:auto;margin-bottom:8px;">${history}</div>
    <div style="display:flex;gap:6px;align-items:flex-end;">
      <textarea rows="2" placeholder="Add a note…" style="flex:1;padding:8px 10px;border:1.5px solid #e2e8f0;border-radius:7px;font-size:12.5px;font-family:Inter,sans-serif;resize:vertical;"></textarea>
      <button onclick="addNote(${ref},'${nm}','${form}',this)" style="padding:8px 14px;background:var(--school-green);color:white;border:none;border-radius:7px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;height:fit-content;">Add Note</button>
    </div>
  </div>`;
}

function renderNoteHistory(histEl, merged){
  const entries=parseNoteEntries(merged);
  histEl.innerHTML=entries.length?entries.map(e=>`
    <div style="padding:8px 10px;background:#f8fafc;border-radius:6px;border-left:3px solid var(--school-green);margin-bottom:6px;">
      ${e.date?`<div style="font-size:10px;font-weight:700;color:#64748b;margin-bottom:3px;">${e.date}</div>`:''}
      <div style="font-size:12.5px;color:#1e293b;white-space:pre-wrap;">${e.text.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
    </div>`).join('')
    :'<div style="font-size:12px;color:#94a3b8;padding:6px 0;">No notes yet.</div>';
}

function addNote(ref, name, form, btnEl){
  // Find textarea and history relative to the button to avoid duplicate-ID issues
  const noteLog = btnEl ? btnEl.closest('.note-log') : null;
  const ta = noteLog ? noteLog.querySelector('textarea') : null;
  if(!ta) return;
  const newText=ta.value.trim();
  if(!newText) return;
  const s=STUDENTS.find(x=>x.ref===ref);
  const existing=(s&&s.notes)||'';
  const datestamp=new Date().toLocaleDateString('en-AU',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
  const entry=`[${datestamp}] ${newText}`;
  const merged=existing?`${existing}\n${entry}`:entry;
  if(s)s.notes=merged;
  ta.value='';
  // Refresh all history displays for this student (may appear in multiple tabs)
  document.querySelectorAll(`.note-log[id="nl-${ref}"] [id="nl-history-${ref}"]`).forEach(h=>renderNoteHistory(h,merged));
  if(noteLog){const h=noteLog.querySelector('[id^="nl-history-"]');if(h)renderNoteHistory(h,merged);}
  fetch(`/api/notes/${UPLOAD.id}/${ref}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({notes:merged})});
  toast('Note saved');
}

function changeNotes(ref,val,name,form){
  const s=STUDENTS.find(x=>x.ref===ref);if(s)s.notes=val;
  clearTimeout(changeNotes._t);
  changeNotes._t=setTimeout(()=>{
    fetch(`/api/notes/${UPLOAD.id}/${ref}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({notes:val})});
  },800);
}

// ── CONTACT LOG MODAL ──────────────────────────
function openContactModal(ref,status,name,form){
  _clog={ref,status,name,form};
  document.getElementById('clog-title').textContent=`${name} → ${statusLabel(status)}`;
  document.getElementById('clog-notes').value='';
  document.getElementById('clog-outcome').value='';
  document.querySelectorAll('.clog-method-btn').forEach(b=>b.classList.remove('selected'));
  document.getElementById('contact-modal').style.display='block';
}
function closeContactModal(){document.getElementById('contact-modal').style.display='none';}
document.getElementById('contact-modal').addEventListener('click',e=>{if(e.target===e.currentTarget)closeContactModal();});
document.getElementById('term-modal').addEventListener('click',e=>{if(e.target===e.currentTarget)closeTermModal();});
function selectMethod(btn){
  document.querySelectorAll('.clog-method-btn').forEach(b=>b.classList.remove('selected'));
  btn.classList.add('selected');
}
function confirmContact(){
  const methodBtn=document.querySelector('.clog-method-btn.selected');
  const method=methodBtn?methodBtn.dataset.val:'';
  const outcome=document.getElementById('clog-outcome').value;
  const notes=document.getElementById('clog-notes').value.trim();
  const {ref,status,name,form}=_clog;
  closeContactModal();
  // Merge modal notes into the student's existing notes as a timestamped entry if provided
  if(notes){
    const s=STUDENTS.find(x=>x.ref===ref);
    const existing=(s&&s.notes)||'';
    const datestamp=new Date().toLocaleDateString('en-AU',{day:'2-digit',month:'short',year:'numeric'});
    const entry=`[${datestamp}] ${notes}`;
    const merged=existing?`${existing}\n${entry}`:entry;
    if(s)s.notes=merged;
    saveCase(ref,status,undefined,name,form,method,outcome);
    fetch(`/api/notes/${UPLOAD.id}/${ref}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({notes:merged})});
    // Refresh note history display in all card instances for this student
    document.querySelectorAll(`[id="nl-history-${ref}"]`).forEach(h=>renderNoteHistory(h,merged));
  } else {
    saveCase(ref,status,undefined,name,form,method,outcome);
  }
  // Apply UI changes immediately
  document.querySelectorAll(`.sb-${ref} .a-btn`).forEach(b=>{
    b.classList.toggle('on',b.dataset.st===status&&status!=='pending');
  });
  const dot=document.querySelector(`#cc-dot-${ref}`);
  if(dot){dot.className=`cc-status-dot dot-${status||'pending'}`;}
  const s=STUDENTS.find(x=>x.ref===ref);if(s)s.status=status;
  refreshCaseCounts();
  toast('Saved: '+statusLabel(status));
  const chEl=document.getElementById(`ch-${ref}`);
  if(chEl&&chEl.closest('.open'))loadContactHistory(ref);
}

// ── CONTACT HISTORY TIMELINE ────────────────────
const METHOD_LABELS={phone:'📞 Phone',email:'📧 Email',sms:'💬 SMS',meeting:'🤝 Meeting',letter:'✉️ Letter',none:'','':''};
const OUTCOME_LABELS={spoke_to_parent:'Spoke to parent/guardian',left_voicemail:'Left voicemail',no_answer:'No answer',parent_informed:'Parent informed',meeting_arranged:'Meeting arranged',meeting_held:'Meeting held',referred_welfare:'Referred to welfare',referred_principal:'Referred to principal',agency_involved:'Multi-agency initiated',resolved:'Matter resolved',other:'Other'};
async function loadContactHistory(ref){
  const el=document.getElementById(`ch-${ref}`);if(!el)return;
  el.innerHTML='<div style="font-size:11px;color:#94a3b8;padding:4px 0;">Loading history…</div>';
  try{
    const data=await fetch(`/api/case/${ref}`).then(r=>r.json());
    const history=data.history||[];
    if(!history.length){el.innerHTML='<div class="ch-timeline-title">Contact History</div><div style="font-size:11px;color:#94a3b8;padding:4px 0;">No contact history yet.</div>';return;}
    let html='<div class="ch-timeline"><div class="ch-timeline-title">Contact History</div>';
    history.forEach(h=>{
      const ts=(h.timestamp||'').replace('T',' ');
      const date=ts.slice(0,16);
      const method=METHOD_LABELS[h.contact_method]||'';
      const outcome=OUTCOME_LABELS[h.contact_outcome]||h.contact_outcome||'';
      const notes=h.notes||'';
      html+=`<div class="ch-entry">
        <div class="ch-dot ch-dot-${h.new_status||'pending'}"></div>
        <div class="ch-content">
          <div class="ch-header">
            <span class="ch-badge">${statusLabel(h.new_status)}</span>
            ${method?`<span class="ch-method">${method}</span>`:''}
            <span class="ch-date">${date}</span>
          </div>
          ${outcome?`<div class="ch-outcome">${outcome}</div>`:''}
          ${notes?`<div class="ch-notes">${notes}</div>`:''}
          <div class="ch-by">by ${h.updated_by||'Officer'}</div>
        </div>
      </div>`;
    });
    html+='</div>';
    el.innerHTML=html;
  }catch(e){el.innerHTML='<div style="font-size:11px;color:#ef4444;">Could not load history.</div>';}
}

// ── TERM HISTORY MODAL ─────────────────────────
function closeTermModal(){document.getElementById('term-modal').style.display='none';}
async function openTermHistory(ref,name){
  document.getElementById('term-modal-title').textContent=name;
  document.getElementById('term-modal-body').innerHTML='<div style="text-align:center;color:#94a3b8;padding:32px;">Loading…</div>';
  document.getElementById('term-modal').style.display='block';
  try{
    const data=await fetch(`/api/trend/${ref}`).then(r=>r.json());
    const trend=data.trend||[];
    if(!trend.length){document.getElementById('term-modal-body').innerHTML='<p style="color:#94a3b8;text-align:center;">No historical data available.</p>';return;}
    let html='';
    trend.forEach(t=>{
      const col=t.pct===0?'#ef4444':t.pct<50?'#f59e0b':t.pct<80?'#eab308':t.pct<90?'#3b82f6':'#22c55e';
      html+=`<div class="term-row">
        <div class="term-label">${t.label||t.upload_date}</div>
        <div class="term-bar-wrap"><div class="term-bar" style="width:${t.pct}%;background:${col}"></div></div>
        <div class="term-pct" style="color:${col}">${t.pct}%</div>
        <div class="term-abs">${t.days_absent}d absent</div>
      </div>`;
    });
    document.getElementById('term-modal-body').innerHTML=html;
  }catch(e){document.getElementById('term-modal-body').innerHTML='<p style="color:#ef4444;">Error loading data.</p>';}
}

function toggleCard(ref, el){
  if(!el) return;
  const card = el.closest('.s-card, .cc');
  if(!card) return;
  const isOpening = !card.classList.contains('open');
  // Accordion: close siblings in the same grid container
  const grid = card.closest('.s-grid, .cc-grid, [id^="tier-"], .today-action-card');
  if(isOpening && grid){
    grid.querySelectorAll('.s-card.open, .cc.open').forEach(sibling => {
      if(sibling !== card) sibling.classList.remove('open');
    });
  }
  card.classList.toggle('open');
  // Load trend chart and contact history when card is expanded (lazy load)
  if(card.classList.contains('open')){
    const isCase = card.classList.contains('cc');
    const containerId = isCase ? `trend-cc-${ref}` : `trend-${ref}`;
    loadTrend(ref, containerId);
    loadContactHistory(ref);
  }
}

// ── SHARED EXTRA BUTTONS ─────────────────────────
function casePlanBtnHtml(ref, hasPlan){
  if(!UPLOAD) return '';
  return hasPlan
    ? `<button id="cpbtn-${ref}" onclick="openCasePlan(${ref})" style="width:100%;padding:9px 14px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;border:2px solid var(--school-green);color:white;background:var(--school-green);font-family:Inter,sans-serif;display:inline-flex;align-items:center;justify-content:center;gap:6px;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" style="width:13px;height:13px"><polyline points="20 6 9 17 4 12"/></svg> Open Case Plan</button>`
    : `<button id="cpbtn-${ref}" onclick="openCasePlan(${ref})" style="width:100%;padding:9px 14px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;border:2px dashed var(--school-green);color:var(--school-green);background:#f0fdf4;font-family:Inter,sans-serif;display:inline-flex;align-items:center;justify-content:center;gap:6px;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:13px;height:13px"><path d="M12 5v14M5 12h14"/></svg> Create Case Plan</button>`;
}
function extraBtns(ref,name){
  const nm=name.replace(/'/g,"\\'");
  return`<button onclick="openTermHistory(${ref},'${nm}')" style="padding:6px 12px;border-radius:20px;font-size:11px;font-weight:700;cursor:pointer;border:2px solid #3b82f6;color:#3b82f6;background:white;font-family:Inter,sans-serif;">Term History</button>
<a href="/api/export/student/${ref}" download style="padding:6px 12px;border-radius:20px;font-size:11px;font-weight:700;cursor:pointer;border:2px solid #64748b;color:#64748b;background:white;font-family:Inter,sans-serif;text-decoration:none;">Export CSV</a>`;
}

// ── BUILD STUDENT CARD (targeted view) ──────────
function buildCard(s){
  const nm=s.name.replace(/'/g,"\\'");
  const col=pct2col(s.pct);
  const btns=[['contacted','Called','ab-call'],['meeting','Meeting','ab-meeting'],
    ['welfare','Welfare','ab-welfare'],['referred','Principal','ab-referred'],
    ['agency','Multi-Agency','ab-agency'],['resolved','Resolved','ab-resolved'],['watchlist','Watchlist','ab-watchlist']]
    .map(([st,lb,cls])=>`<button class="a-btn ${cls}${s.status===st?' on':''}" data-st="${st}"
      onclick="clickStatus(${s.ref},'${st}','${nm}','${s.form}')">${lb}</button>`).join('');
  const hasNote=(s.notes||'').trim().length>0;
  return`<div class="s-card ${lcCls(s.pct)}" data-card="${s.ref}" id="sc-${s.ref}${s.status&&s.status!=='pending'?' open':''}">
  <div class="s-top" onclick="toggleCard(${s.ref}, this)">
    <div class="s-av ${avCls(s.pct)}">${initials(s.name)}</div>
    <div class="s-info">
      <div class="s-name">${formatName(s.name)}</div>
      <div class="s-meta">${s.form} &nbsp;·&nbsp; Year ${s.year}</div>
      <div class="s-pbar-wrap"><div class="s-pbar" style="width:${s.pct}%;background:${col}"></div></div>
    </div>
    <div class="s-pct"><div class="s-pct-big" style="color:${col}">${s.pct}%</div><div class="s-pct-days">${fmtD(s.absences)}d absent</div></div>
    <div class="s-chevron">⌄</div>
  </div>
  <div class="s-body">
    <div class="s-stats">
      <div class="ss-item"><div class="ss-val" style="color:${col}">${fmtD(s.attended)}</div><div class="ss-lbl">Days In</div></div>
      <div class="ss-item"><div class="ss-val">${fmtD(s.sessions)}</div><div class="ss-lbl">School Days</div></div>
      <div class="ss-item"><div class="ss-val" style="color:var(--red)">${fmtD(s.absences)}</div><div class="ss-lbl">Days Out</div></div>
      <div class="ss-item"><div class="ss-val">${s.ref}</div><div class="ss-lbl">Ref #</div></div>
    </div>
    <div class="s-actions sb-${s.ref}" style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;">${btns}</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin:8px 0 4px;">${extraBtns(s.ref,s.name)}</div>
    ${casePlanBtnHtml(s.ref,s.has_case_plan)?`<div style="margin:6px 0 4px;">${casePlanBtnHtml(s.ref,s.has_case_plan)}</div>`:''}
    <div class="notes-lbl" style="margin-top:10px;"><span>Case Notes</span>${hasNote?'<span style="color:var(--gold);font-size:10px;">● Has notes</span>':''}</div>
    ${noteLogHtml(s.ref, s.notes, nm, s.form)}
    <div id="ch-${s.ref}"></div>
    <div class="trend-container" id="trend-${s.ref}">
      <div class="trend-loading">Click to load attendance trend…</div>
    </div>
  </div>
</div>`;
}

// ── BUILD CASE CARD (case management view) ──────
function buildCaseCard(s){
  const nm=s.name.replace(/'/g,"\\'");
  const col=pct2col(s.pct);
  const st=s.status||'pending';
  const btns=[['contacted','Called','ab-call'],['meeting','Meeting','ab-meeting'],
    ['welfare','Welfare','ab-welfare'],['referred','Principal','ab-referred'],
    ['agency','Multi-Agency','ab-agency'],['resolved','Resolved','ab-resolved']]
    .map(([bst,lb,cls])=>`<button class="a-btn ${cls}${st===bst?' on':''}" data-st="${bst}"
      onclick="clickStatus(${s.ref},'${bst}','${nm}','${s.form}')">${lb}</button>`).join('');
  const hasNote=(s.notes||'').trim().length>0;
  return`<div class="cc" data-card="${s.ref}" id="cc-${s.ref}${st!=='pending'?' open':''}">
  <div class="cc-top" onclick="toggleCard(${s.ref}, this)">
    <div class="cc-avatar ${avCls(s.pct)}">
      ${initials(s.name)}
      <div class="cc-status-dot dot-${st}" id="cc-dot-${s.ref}"></div>
    </div>
    <div class="cc-info">
      <div class="cc-name">${formatName(s.name)}</div>
      <div class="cc-sub">${s.form} &nbsp;·&nbsp; Year ${s.year} &nbsp;·&nbsp; Ref: ${s.ref}</div>
      <div class="cc-badges">
        ${pct2badge(s.pct)}
        <span class="badge b-blue">${statusLabel(st)}</span>
        ${hasNote?'<span class="badge b-gold">Has Notes</span>':''}
      </div>
    </div>
    <div class="cc-right">
      <div class="cc-pct" style="color:${col}">${s.pct}%</div>
      <div class="cc-days">${fmtD(s.absences)} days absent</div>
    </div>
    <div style="font-size:18px;color:var(--muted);transition:transform 0.2s;padding:0 4px;" class="s-chevron">⌄</div>
  </div>
  <div class="cc-body">
    <div class="cc-detail-grid">
      <div class="cc-d"><div class="cc-d-val" style="color:${col}">${fmtD(s.attended)}</div><div class="cc-d-lbl">Days Attended</div></div>
      <div class="cc-d"><div class="cc-d-val">${fmtD(s.sessions)}</div><div class="cc-d-lbl">School Days</div></div>
      <div class="cc-d"><div class="cc-d-val" style="color:var(--red)">${fmtD(s.absences)}</div><div class="cc-d-lbl">Days Absent</div></div>
      <div class="cc-d"><div class="cc-d-val">${s.pct}%</div><div class="cc-d-lbl">Attendance Rate</div></div>
    </div>
    <div class="s-actions sb-${s.ref}" style="margin-bottom:8px;display:flex;align-items:center;flex-wrap:wrap;gap:6px;">${btns}</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">${extraBtns(s.ref,s.name)}</div>
    ${casePlanBtnHtml(s.ref,s.has_case_plan)?`<div style="margin-bottom:12px;">${casePlanBtnHtml(s.ref,s.has_case_plan)}</div>`:''}
    <div class="notes-lbl"><span>Case Notes</span>${hasNote?'<span style="color:var(--gold);font-size:10px;">● Recorded</span>':''}</div>
    ${noteLogHtml(s.ref, s.notes, nm, s.form)}
    <div id="ch-${s.ref}"></div>
    <div class="trend-container" id="trend-cc-${s.ref}">
      <div class="trend-loading">Click to load attendance trend…</div>
    </div>
  </div>
</div>`;
}

// ── RENDER TARGETED ────────────────────────────
function renderTargeted(){
  const q=document.getElementById('t-search').value.toLowerCase();
  const form=document.getElementById('t-form').value;
  const sort=document.getElementById('t-sort').value;
  let data=STUDENTS.filter(s=>s.pct<90);
  if(q)data=data.filter(s=>s.name.toLowerCase().includes(q)||s.form.toLowerCase().includes(q));
  if(form)data=data.filter(s=>s.form===form);
  if(sort==='abs')data.sort((a,b)=>b.absences-a.absences);
  else if(sort==='name')data.sort((a,b)=>a.name.localeCompare(b.name));
  else data.sort((a,b)=>a.pct-b.pct);
  const crit=data.filter(s=>s.pct<50);
  const concern=data.filter(s=>s.pct>=50&&s.pct<80);
  const watch=data.filter(s=>s.pct>=80&&s.pct<90);
  document.getElementById('t-count').textContent=`${data.length} students`;
  document.getElementById('tier-critical-n').textContent=crit.length;
  document.getElementById('tier-concern-n').textContent=concern.length;
  document.getElementById('tier-watch-n').textContent=watch.length;
  const emptyTargeted=`<div style="text-align:center;padding:60px 20px;color:#94a3b8;">
  <div style="font-size:40px;margin-bottom:12px;">🎉</div>
  <div style="font-size:15px;font-weight:700;color:#64748b;margin-bottom:6px;">No students need follow-up</div>
  <div style="font-size:13px;">Students below 90% attendance will appear here for action.</div>
</div>`;
  document.getElementById('tier-critical').innerHTML=crit.length?crit.map(buildCard).join(''):emptyTargeted;
  document.getElementById('tier-concern').innerHTML=concern.length?concern.map(buildCard).join(''):emptyTargeted;
  document.getElementById('tier-watch').innerHTML=watch.length?watch.map(buildCard).join(''):emptyTargeted;
  // Update tab badge
  document.getElementById('badge-targeted').textContent=crit.length+concern.length;
}

// ── RENDER CASES ───────────────────────────────
let caseFilter='';
function setCaseFilter(f,el){
  caseFilter=f;
  document.querySelectorAll('.csl-item').forEach(i=>i.classList.remove('on'));
  el.classList.add('on');
  const labelMap={contacted:'Contacted',meeting:'Meeting Arranged',welfare:'Welfare Referral',referred:'Principal Referral',agency:'Multi-Agency',resolved:'Resolved',watchlist:'Watchlist',has_case_plan:'Has Case Plan',has_notes:'Has Notes'};
  document.getElementById('case-list-title').textContent=f?(labelMap[f]||f):'All Active Cases';
  renderCases();
}
const hasNote = s => (s.notes||'').trim().length > 0;
function renderCases(){
  const q=document.getElementById('case-search').value.toLowerCase();
  // Include students below 80%, active status, case plan, or case notes
  const caseloadStudents=STUDENTS.filter(s=>s.pct<80||(s.status&&s.status!=='pending')||s.has_case_plan||hasNote(s));
  let data=[...caseloadStudents];
  if(caseFilter==='has_case_plan')data=data.filter(s=>s.has_case_plan);
  else if(caseFilter==='has_notes')data=data.filter(s=>hasNote(s));
  else if(caseFilter)data=data.filter(s=>(s.status||'pending')===caseFilter);
  if(q)data=data.filter(s=>s.name.toLowerCase().includes(q)||s.form.toLowerCase().includes(q));
  data.sort((a,b)=>a.pct-b.pct);
  let emptyHtml;
  if(caseloadStudents.length===0){
    emptyHtml=`<div style="text-align:center;padding:60px 20px;color:#94a3b8;">
  <div style="font-size:40px;margin-bottom:12px;">✅</div>
  <div style="font-size:15px;font-weight:700;color:#64748b;margin-bottom:6px;">No students on caseload</div>
  <div style="font-size:13px;">Students below 80% attendance, with an active case status, a case plan, or a note will appear here.</div>
</div>`;
  } else {
    emptyHtml=`<div style="text-align:center;padding:60px 20px;color:#94a3b8;">
  <div style="font-size:40px;margin-bottom:12px;">📋</div>
  <div style="font-size:15px;font-weight:700;color:#64748b;margin-bottom:6px;">No cases match this filter</div>
  <div style="font-size:13px;">Try selecting a different status from the sidebar, or clear the search.</div>
</div>`;
  }
  document.getElementById('case-cards').innerHTML=data.length?data.map(buildCaseCard).join(''):emptyHtml;
  document.getElementById('badge-cases').textContent=STUDENTS.filter(s=>(s.status&&s.status!=='pending')||s.has_case_plan||hasNote(s)).length;
  document.getElementById('cn-case-plan').textContent=STUDENTS.filter(s=>s.has_case_plan).length;
  document.getElementById('cn-has-notes').textContent=STUDENTS.filter(s=>hasNote(s)).length;
}
function refreshCaseCounts(){
  // Caseload: below 80%, active status, case plan, or has notes
  const caseloadStudents=STUDENTS.filter(s=>s.pct<80||(s.status&&s.status!=='pending')||s.has_case_plan||hasNote(s));
  const cts={contacted:0,meeting:0,welfare:0,referred:0,agency:0,resolved:0,watchlist:0,pending:0};
  caseloadStudents.forEach(s=>{ const k=s.status||'pending'; cts[k]=(cts[k]||0)+1; });
  Object.entries(cts).forEach(([k,v])=>{const el=document.getElementById('cn-'+k);if(el)el.textContent=v;});
  document.getElementById('cn-all').textContent=caseloadStudents.length;
  document.getElementById('cn-case-plan').textContent=STUDENTS.filter(s=>s.has_case_plan).length;
  document.getElementById('cn-has-notes').textContent=STUDENTS.filter(s=>hasNote(s)).length;
  document.getElementById('badge-cases').textContent=STUDENTS.filter(s=>(s.status&&s.status!=='pending')||s.has_case_plan||hasNote(s)).length;
  // Caseload summary — use caseloadStudents (not the old below80 variable)
  const active=caseloadStudents.filter(s=>s.status&&s.status!=='pending').length;
  const urgent=caseloadStudents.filter(s=>s.pct<50).length;
  const el=document.getElementById('caseload-summary');
  if(el) el.innerHTML=`
    <div style="display:flex;justify-content:space-between;"><span>Total on caseload</span><strong>${caseloadStudents.length}</strong></div>
    <div style="display:flex;justify-content:space-between;"><span>Actively managed</span><strong style="color:var(--blue)">${active}</strong></div>
    <div style="display:flex;justify-content:space-between;"><span>Urgent (below 50%)</span><strong style="color:var(--red)">${urgent}</strong></div>
    <div style="display:flex;justify-content:space-between;"><span>Pending action</span><strong style="color:var(--amber)">${cts.pending}</strong></div>
    <div style="display:flex;justify-content:space-between;"><span>Multi-Agency</span><strong style="color:var(--teal)">${cts.agency}</strong></div>
    <div style="display:flex;justify-content:space-between;"><span>Resolved</span><strong style="color:var(--green)">${cts.resolved}</strong></div>
    <div style="display:flex;justify-content:space-between;"><span>Watchlist</span><strong style="color:#4F46E5">${cts.watchlist}</strong></div>`;
}

// ── RENDER OVERVIEW ────────────────────────────
function renderOverview(gridId){
  const total=STUDENTS.length,zero=STUDENTS.filter(s=>s.pct===0).length;
  const crit=STUDENTS.filter(s=>s.pct<50).length,b80=STUDENTS.filter(s=>s.pct<80).length;
  const avg=total>0?(STUDENTS.reduce((a,s)=>a+s.pct,0)/total).toFixed(1):'0';
  const totalSessions=STUDENTS.reduce((a,s)=>a+(s.sessions||0),0);
  const schoolPct=totalSessions>0?(STUDENTS.reduce((a,s)=>a+s.attended,0)/totalSessions*100).toFixed(1):'0';
  const actioned=STUDENTS.filter(s=>s.status&&s.status!=='pending').length;
  const svgZero=`<svg viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>`;
  const svgCrit=`<svg viewBox="0 0 24 24" fill="none" stroke="var(--amber)" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
  const svgB80=`<svg viewBox="0 0 24 24" fill="none" stroke="var(--gold)" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`;
  const svgTotal=`<svg viewBox="0 0 24 24" fill="none" stroke="var(--blue)" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;
  const svgAvg=`<svg viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>`;
  const cards=[
    {c:'c-red',icon:svgZero,val:zero,lbl:'Zero Attendance',sub:'Never attended'},
    {c:'c-amber',icon:svgCrit,val:crit,lbl:'Critical (<50%)',sub:'Urgent action needed'},
    {c:'c-gold',icon:svgB80,val:b80,lbl:'Below 80%',sub:'Follow-up required'},
    {c:'c-blue',icon:svgTotal,val:total,lbl:'Total Students',sub:'Active enrolments'},
    {c:'c-green',icon:svgAvg,val:schoolPct+'%',lbl:'School Attendance',sub:'Total sessions attended'},
  ];
  const el=document.getElementById(gridId);
  if(el)el.innerHTML=cards.map(x=>`<div class="ov-card ${x.c}"><div class="ov-icon">${x.icon}</div><div class="ov-val">${x.val}</div><div class="ov-lbl">${x.lbl}</div><div class="ov-sub">${x.sub}</div></div>`).join('');
}

// ── RENDER BY FORM ─────────────────────────────
let formCharts={};
function mkChart(id,cfg){if(formCharts[id])formCharts[id].destroy();formCharts[id]=new Chart(document.getElementById(id),cfg);}
function renderForms(tbodyId){
  const m={};
  STUDENTS.forEach(s=>{if(!m[s.form])m[s.form]=[];m[s.form].push(s);});
  const fs=Object.entries(m).map(([form,arr])=>({form,n:arr.length,
    avg:+(arr.reduce((a,s)=>a+s.attended,0)/Math.max(arr.reduce((a,s)=>a+s.sessions,0),1)*100).toFixed(1),
    zero:arr.filter(s=>s.pct===0).length,b50:arr.filter(s=>s.pct<50).length,b80:arr.filter(s=>s.pct<80).length,
  })).sort((a,b)=>a.avg-b.avg);
  const tb=document.getElementById(tbodyId);
  if(!tb)return fs;
  tb.innerHTML='';
  fs.forEach(f=>{
    const c=f.avg<50?'var(--red)':f.avg<80?'var(--amber)':'var(--green)';
    const act=f.avg<50?'<span class="badge b-red">Immediate</span>':f.avg<80?'<span class="badge b-amber">Follow Up</span>':'<span class="badge b-green">Monitor</span>';
    tb.insertAdjacentHTML('beforeend',`<tr>
      <td><strong>${f.form}</strong></td><td>${f.n}</td>
      <td><strong style="color:${c}">${f.avg}%</strong></td>
      <td><div style="background:#EAECF0;border-radius:4px;height:7px;width:120px;overflow:hidden"><div style="height:100%;width:${f.avg}%;background:${c};border-radius:4px"></div></div></td>
      <td>${f.zero>0?`<strong style="color:var(--red)">${f.zero}</strong>`:'—'}</td>
      <td>${f.b50>0?`<strong style="color:var(--amber)">${f.b50}</strong>`:'—'}</td>
      <td>${f.b80}</td>
      <td>${act}</td></tr>`);
  });
  return fs;
}
const ttDefaults={
  backgroundColor:'#0D1117',titleColor:'#fff',
  bodyColor:'rgba(255,255,255,0.8)',padding:10,cornerRadius:8,
  borderColor:'rgba(74,222,128,0.15)',borderWidth:1,
  displayColors:false
};

function renderCharts(fs){
  // ── Modern gradient helper ──────────────────────────────────────────
  function grad(canvasId,c1,c2){
    const cv=document.getElementById(canvasId);
    if(!cv)return c1;
    const g=cv.getContext('2d').createLinearGradient(0,0,0,260);
    g.addColorStop(0,c1);g.addColorStop(1,c2);return g;
  }

  // ── Distribution bar chart ──────────────────────────────────────────
  const distData=[
    STUDENTS.filter(s=>s.pct===0).length,
    STUDENTS.filter(s=>s.pct>0&&s.pct<50).length,
    STUDENTS.filter(s=>s.pct>=50&&s.pct<80).length,
    STUDENTS.filter(s=>s.pct>=80&&s.pct<90).length,
    STUDENTS.filter(s=>s.pct>=90).length];
  const distGrads=[
    ['#FF6B6B','#C0392B'],['#FF9240','#D35400'],
    ['#FFD166','#B7950B'],['#63B3ED','#1A4F7A'],['#52D68A','#1A7A3C']];
  mkChart('dist-chart',{type:'bar',
    data:{labels:['0%','1–49%','50–79%','80–89%','90–100%'],
      datasets:[{label:'Students',data:distData,
        backgroundColor:distGrads.map(([c1,c2])=>grad('dist-chart',c1,c2)),
        borderRadius:10,borderSkipped:false,borderWidth:0}]},
    options:{responsive:true,maintainAspectRatio:false,
      animation:{duration:700,easing:'easeOutQuart'},
      plugins:{legend:{display:false},tooltip:{...ttDefaults,
        callbacks:{
          title:items=>{const l=['Zero','Critical','Concern','Watch','Good'];return l[items[0].dataIndex]||items[0].label;},
          label:item=>` ${item.raw} student${item.raw!==1?'s':''}`}}},
      scales:{
        x:{grid:{display:false},border:{display:false},
           ticks:{color:'#64748B',font:{size:11}}},
        y:{beginAtZero:true,border:{display:false,dash:[4,4]},
           grid:{color:'rgba(100,116,139,0.08)'},
           ticks:{color:'#64748B',font:{size:11},stepSize:Math.ceil(Math.max(...distData)/6)||1}}}}});

  // ── Form horizontal bar chart ────────────────────────────────────────
  mkChart('form-chart',{type:'bar',
    data:{labels:fs.map(f=>f.form),datasets:[{label:'Avg %',data:fs.map(f=>f.avg),
      backgroundColor:fs.map(f=>f.avg<50?'rgba(192,57,43,0.9)':f.avg<80?'rgba(211,84,0,0.85)':f.avg<90?'rgba(43,108,176,0.85)':'rgba(39,103,73,0.85)'),
      borderRadius:{topRight:4,bottomRight:4},borderSkipped:false}]},
    options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,
      animation:{duration:700,easing:'easeOutQuart'},
      plugins:{legend:{display:false},tooltip:{...ttDefaults,
        callbacks:{label:item=>` ${item.raw.toFixed(1)}% attendance`}}},
      scales:{
        x:{beginAtZero:true,max:100,border:{display:false},
           grid:{color:'rgba(100,116,139,0.08)'},
           ticks:{callback:v=>v+'%',color:'#64748B',font:{size:11}}},
        y:{grid:{display:false},border:{display:false},
           ticks:{color:'#475569',font:{size:11,weight:'600'}}}}}});
}

// ── PRINCIPAL REPORT ───────────────────────────
function prRiskPill(pct){
  if(pct===0)return`<span class="pr-risk-pill critical">&#9679; Zero</span>`;
  if(pct<50)return`<span class="pr-risk-pill critical">&#9650; Critical</span>`;
  if(pct<80)return`<span class="pr-risk-pill concern">&#9650; Concern</span>`;
  return`<span class="pr-risk-pill watch">&#9670; Watch</span>`;
}
function renderPrincipal(){
  // ── data cuts ──
  const total=STUDENTS.length;
  const below80=STUDENTS.filter(s=>s.pct<80).sort((a,b)=>a.pct-b.pct);
  const below50=STUDENTS.filter(s=>s.pct<50);
  const watch80=STUDENTS.filter(s=>s.pct>=80&&s.pct<90).sort((a,b)=>a.pct-b.pct);
  const good=STUDENTS.filter(s=>s.pct>=90);
  const unactioned=below80.filter(s=>!s.status||s.status==='pending');
  const inProgress=STUDENTS.filter(s=>s.status&&s.status!=='pending'&&s.status!=='resolved');
  const resolved=STUDENTS.filter(s=>s.status==='resolved');
  const contacted=STUDENTS.filter(s=>s.status==='contacted');
  const meeting=STUDENTS.filter(s=>s.status==='meeting');
  const welfare=STUDENTS.filter(s=>s.status==='welfare');
  const referred=STUDENTS.filter(s=>s.status==='referred'||s.status==='agency');
  const totalSesAll=STUDENTS.reduce((a,s)=>a+(s.sessions||0),0);
  const avgPct=totalSesAll>0?Math.round(STUDENTS.reduce((a,s)=>a+s.attended,0)/totalSesAll*100):0;

  // ── KPI overview strip ──
  renderOverview('p-ov-grid');

  // ── Form Average Bar Chart ──
  const chartForms=[...new Set(STUDENTS.map(s=>s.form))].sort();
  const formAvgs=chartForms.map(f=>{
    const fs=STUDENTS.filter(s=>s.form===f);
    const ses=fs.reduce((a,s)=>a+s.sessions,0);
    return ses?Math.round(fs.reduce((a,s)=>a+s.attended,0)/ses*100):0;
  });
  function prBarGrad(canvasId,avgs){
    const cv=document.getElementById(canvasId);
    if(!cv)return avgs.map(a=>a<50?'#EF4444':a<80?'#F59E0B':'#22C55E');
    return avgs.map(a=>{
      const g=cv.getContext('2d').createLinearGradient(0,0,0,260);
      if(a<50){g.addColorStop(0,'#FF6B6B');g.addColorStop(1,'#C0392B');}
      else if(a<80){g.addColorStop(0,'#FFB347');g.addColorStop(1,'#D35400');}
      else{g.addColorStop(0,'#4ADE80');g.addColorStop(1,'#15803D');}
      return g;
    });
  }
  mkChart('p-form-chart-pr',{
    type:'bar',
    data:{
      labels:chartForms,
      datasets:[{
        label:'Avg Attendance %',
        data:formAvgs,
        backgroundColor:prBarGrad('p-form-chart-pr',formAvgs),
        borderRadius:8,
        borderSkipped:false,
        barThickness:32
      }]
    },
    options:{
      responsive:true,
      maintainAspectRatio:false,
      plugins:{
        legend:{display:false},
        tooltip:{
          ...ttDefaults,
          callbacks:{
            label:c=>`${c.raw}% attendance`,
            title:items=>items[0].label
          }
        }
      },
      scales:{
        y:{min:0,max:100,border:{display:false,dash:[4,4]},
           ticks:{callback:v=>v+'%',font:{size:11},color:'#64748B'},
           grid:{color:'rgba(100,116,139,0.08)'}},
        x:{grid:{display:false},border:{display:false},
           ticks:{font:{size:11,weight:'600'},color:'#374151'}}
      },
      animation:{duration:600,easing:'easeOutQuart'}
    }
  });
  const chartSub=document.getElementById('p-chart-subtitle');
  if(chartSub)chartSub.textContent=`${chartForms.length} classes · school avg ${avgPct}%`;

  // ── 1. Unactioned alert panel ──
  const uCount=document.getElementById('p-unactioned-count');
  if(uCount)uCount.textContent=unactioned.length
    ?`${unactioned.length} student${unactioned.length>1?'s':''} — no staff action yet`
    :'All cases actioned ✓';
  const uList=document.getElementById('p-unactioned-list');
  if(uList){
    if(unactioned.length===0){
      uList.innerHTML=`<div style="padding:20px 20px;text-align:center;color:var(--green);font-size:13px;font-weight:600;">
        ✓ All students below 80% have a case action recorded — great work!</div>`;
    } else {
      uList.innerHTML=unactioned.map(s=>{
        const col=s.pct===0?'#DC2626':s.pct<50?'#EA580C':'#D97706';
        return`<div class="pr-unaction-row">
          <div style="flex:1;min-width:0;">
            <div class="pr-unaction-name">${formatName(s.name)}</div>
            <div class="pr-unaction-meta">${s.form} &nbsp;·&nbsp; ${fmtD(s.absences)} days absent &nbsp;·&nbsp; No action recorded</div>
          </div>
          <span style="font-size:11px;background:var(--red-bg);color:var(--red);border:1px solid var(--red-b);padding:2px 8px;border-radius:20px;font-weight:700;flex-shrink:0;">No Action</span>
          <div class="pr-unaction-pct" style="color:${col}">${s.pct}%</div>
        </div>`;
      }).join('');
    }
  }

  // ── 2. Watch list (80-89%) ──
  const wCount=document.getElementById('p-watch-count');
  if(wCount)wCount.textContent=`${watch80.length} students`;
  const wList=document.getElementById('p-watch-list');
  if(wList){
    if(watch80.length===0){
      wList.innerHTML=`<div style="padding:20px;text-align:center;color:var(--muted);font-size:12px;">No students in the 80–89% watch band</div>`;
    } else {
      wList.innerHTML=watch80.map(s=>`<div class="pr-watch-row">
        <div style="flex:1;min-width:0;">
          <div style="font-size:12.5px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${formatName(s.name)}</div>
          <div style="font-size:11px;color:var(--muted);">${s.form} &nbsp;·&nbsp; ${fmtD(s.absences)} days absent</div>
        </div>
        ${s.status&&s.status!=='pending'?`<span class="badge b-blue" style="font-size:10px;flex-shrink:0;">${statusLabel(s.status)}</span>`:''}
        <span style="font-size:16px;font-weight:800;color:var(--amber);flex-shrink:0;width:46px;text-align:right;">${s.pct}%</span>
      </div>`).join('');
    }
  }

  // ── 3. Case Progress panel ──
  const cProg=document.getElementById('p-case-progress');
  if(cProg){
    const totalBelow80=below80.length;
    const rows=[
      {label:'Contacted',count:contacted.length,col:'#1D4ED8',bg:'var(--blue-bg)'},
      {label:'Meeting scheduled',count:meeting.length,col:'#7C3AED',bg:'var(--purple-bg)'},
      {label:'Welfare referral',count:welfare.length,col:'#D97706',bg:'var(--amber-bg)'},
      {label:'Referred / Agency',count:referred.length,col:'#DC2626',bg:'var(--red-bg)'},
      {label:'Resolved',count:resolved.length,col:'#16A34A',bg:'var(--green-bg)'},
      {label:'No action yet',count:unactioned.length,col:'#94A3B8',bg:'#F8FAFC'},
    ];
    const maxC=Math.max(1,...rows.map(r=>r.count));
    cProg.innerHTML=`<div style="padding:14px 0 6px;">
      ${rows.map(r=>`<div class="pr-prog-item">
        <div style="width:110px;font-size:12px;font-weight:600;color:var(--text);flex-shrink:0;">${r.label}</div>
        <div class="pr-prog-bar-wrap">
          <div class="pr-prog-bar" style="width:${r.count?Math.round(r.count/maxC*100):0}%;background:${r.col};"></div>
        </div>
        <div style="width:28px;text-align:right;font-size:13px;font-weight:700;color:${r.col};flex-shrink:0;">${r.count}</div>
      </div>`).join('')}
      <div style="padding:10px 16px 4px;font-size:11px;color:var(--muted);">
        Total requiring action: <strong style="color:var(--text)">${totalBelow80}</strong> students
      </div>
    </div>`;
  }

  // ── 4. Form spotlight (form accountability) ──
  const forms=[...new Set(STUDENTS.map(s=>s.form))].sort();
  const formSpotEl=document.getElementById('p-form-spotlight');
  if(formSpotEl){
    const fData=forms.map(f=>{
      const fs=STUDENTS.filter(s=>s.form===f);
      const fBelow80=fs.filter(s=>s.pct<80);
      const fUnact=fBelow80.filter(s=>!s.status||s.status==='pending');
      const fSes=fs.reduce((a,s)=>a+s.sessions,0);
      const fAvg=fSes?Math.round(fs.reduce((a,s)=>a+s.attended,0)/fSes*100):0;
      return{form:f,total:fs.length,below80:fBelow80.length,unact:fUnact.length,avg:fAvg};
    }).sort((a,b)=>b.unact-a.unact||a.avg-b.avg);
    formSpotEl.innerHTML=fData.map(f=>{
      const urgCls=f.unact>0?'color:#DC2626;font-weight:800':'color:var(--green);font-weight:700';
      return`<div class="pr-watch-row" style="${f.unact>0?'background:#FEF2F2;':''}">
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:700;color:var(--text);">${f.form}</div>
          <div style="font-size:11px;color:var(--muted);">${f.total} students &nbsp;·&nbsp; avg ${f.avg}%</div>
        </div>
        <div style="text-align:right;flex-shrink:0;">
          <div style="font-size:12px;${urgCls}">${f.unact} unactioned</div>
          <div style="font-size:11px;color:var(--muted);">${f.below80} below 80%</div>
        </div>
      </div>`;
    }).join('');
  }

  // ── 7. Form accountability table ──
  const formTbody=document.getElementById('p-form-tbody');
  if(formTbody){
    const fRows=forms.map(f=>{
      const fs=STUDENTS.filter(s=>s.form===f);
      const fBelow80=fs.filter(s=>s.pct<80);
      const fUnact=fBelow80.filter(s=>!s.status||s.status==='pending');
      const fZero=fs.filter(s=>s.pct===0);
      const fSes2=fs.reduce((a,s)=>a+s.sessions,0);
      const fAvg=fSes2?Math.round(fs.reduce((a,s)=>a+s.attended,0)/fSes2*100):0;
      const barW=Math.max(2,fAvg);
      const barCol=fAvg<50?'#DC2626':fAvg<80?'#D97706':'#16A34A';
      return{form:f,total:fs.length,avg:fAvg,barW,barCol,
             below80:fBelow80.length,unact:fUnact.length,zero:fZero.length};
    }).sort((a,b)=>a.avg-b.avg);
    formTbody.innerHTML=fRows.map(f=>`<tr>
      <td><strong>${f.form}</strong></td>
      <td>${f.total}</td>
      <td>
        <div style="display:flex;align-items:center;gap:8px;">
          <div style="width:56px;height:5px;background:#E2E8F0;border-radius:3px;overflow:hidden;flex-shrink:0;">
            <div style="width:${f.barW}%;height:100%;background:${f.barCol};border-radius:3px;"></div>
          </div>
          <strong style="color:${pct2col(f.avg)}">${f.avg}%</strong>
        </div>
      </td>
      <td>
        <div style="background:#E2E8F0;border-radius:4px;height:6px;width:80px;overflow:hidden;">
          <div style="width:${Math.max(2,f.avg)}%;height:100%;background:${f.barCol};border-radius:4px;"></div>
        </div>
      </td>
      <td>${f.below80>0?`<span style="font-weight:700;color:var(--amber)">${f.below80}</span>`:'<span style="color:var(--green)">0</span>'}</td>
      <td>${f.unact>0?`<span style="font-weight:800;color:var(--red)">${f.unact}</span>`:'<span style="color:var(--green)">0</span>'}</td>
      <td>${f.zero>0?`<span style="font-weight:800;color:var(--red)">${f.zero}</span>`:'<span style="color:var(--green)">0</span>'}</td>
    </tr>`).join('');
  }

  // ── Set print dates ──
  const d=new Date().toLocaleDateString('en-AU',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
  const rdEl=document.getElementById('report-date');if(rdEl)rdEl.textContent=d;
  const rpEl=document.getElementById('report-date-print');if(rpEl)rpEl.textContent=d;
}
// ── ALL STUDENTS ───────────────────────────────
function getFilteredStudents(){
  const q=document.getElementById('al-search').value.toLowerCase();
  const form=document.getElementById('al-form').value;
  const risk=document.getElementById('al-risk').value;
  const sort=document.getElementById('al-sort').value;
  let data=[...STUDENTS];
  if(q)data=data.filter(s=>s.name.toLowerCase().includes(q)||s.form.toLowerCase().includes(q));
  if(form)data=data.filter(s=>s.form===form);
  if(risk)data=data.filter(s=>pct2risk(s.pct)===risk);
  if(sort==='pct-desc')data.sort((a,b)=>b.pct-a.pct);
  else if(sort==='name')data.sort((a,b)=>a.name.localeCompare(b.name));
  else if(sort==='form')data.sort((a,b)=>a.form.localeCompare(b.form));
  else data.sort((a,b)=>a.pct-b.pct);
  return data;
}
function updateAttendanceAlert(){
  const all = window.allStudents || [];
  const below80  = all.filter(s => s.pct < 80 && s.pct > 0).length;
  const below50  = all.filter(s => s.pct < 50 && s.pct > 0).length;
  const zero     = all.filter(s => s.pct === 0).length;
  const banner   = document.getElementById('attendance-alert-banner');
  const alertTxt = document.getElementById('attendance-alert-text');
  if (below80 > 0) {
    let msg = `${below80} student${below80!==1?'s':''} below 80% attendance`;
    const extras = [];
    if (below50 > 0) extras.push(`${below50} critical (<50%)`);
    if (zero    > 0) extras.push(`${zero} with zero attendance`);
    if (extras.length) msg += ` — including ${extras.join(', ')}`;
    alertTxt.textContent = msg;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}

function renderAll(){
  const data=getFilteredStudents();
  document.getElementById('al-count').textContent=`${data.length} student${data.length!==1?'s':''}`;
  updateAttendanceAlert();
  document.getElementById('al-tbody').innerHTML=data.map((s,i)=>`<tr>
    <td style="color:var(--muted);font-size:11px">${i+1}</td>
    <td><strong>${formatName(s.name)}</strong></td><td style="font-size:12px">${s.form}</td><td>${s.year}</td>
    <td>${fmtD(s.attended)}</td><td>${fmtD(s.sessions)}</td>
    <td style="font-weight:${s.absences>20?700:400};color:${s.absences>20?'var(--red)':s.absences>10?'var(--amber)':'inherit'}">${fmtD(s.absences)}</td>
    <td><strong style="color:${pct2col(s.pct)}">${s.pct}%</strong></td>
    <td>${pct2badge(s.pct)}</td>
    <td>${s.status&&s.status!=='pending'?`<span class="badge b-blue" style="font-size:10px">${statusLabel(s.status)}</span>`:'—'}</td>
  </tr>`).join('');
}

function downloadAllCSV(){
  const data = getFilteredStudents();
  const riskEl = document.getElementById('al-risk');
  const formEl = document.getElementById('al-form');
  const dateStr = new Date().toISOString().slice(0,10);
  const filename = `students_${riskEl.value||'all'}_${formEl.value||'all'}_${dateStr}.xlsx`;

  const wb = XLSX.utils.book_new();
  const ws = {};

  // ── colour palette ──────────────────────────────────────────────────
  const FILL = {
    header : {patternType:'solid', fgColor:{rgb:'1E293B'}},
    school : {patternType:'solid', fgColor:{rgb:'15803D'}},
    subhdr : {patternType:'solid', fgColor:{rgb:'DCFCE7'}},
    zero   : {patternType:'solid', fgColor:{rgb:'FEE2E2'}},
    critical:{patternType:'solid', fgColor:{rgb:'FEE2E2'}},
    concern: {patternType:'solid', fgColor:{rgb:'FEF9C3'}},
    watch  : {patternType:'solid', fgColor:{rgb:'DBEAFE'}},
    good   : {patternType:'solid', fgColor:{rgb:'DCFCE7'}},
    footer : {patternType:'solid', fgColor:{rgb:'F1F5F9'}},
  };
  const WHITE  = {rgb:'FFFFFF'};
  const DARK   = {rgb:'1E293B'};
  const CENTER = {horizontal:'center', vertical:'center', wrapText:true};
  const LEFT   = {horizontal:'left',   vertical:'center'};

  const thinBorder = {style:'thin', color:{rgb:'CBD5E1'}};
  const TB = {top:thinBorder, bottom:thinBorder, left:thinBorder, right:thinBorder};

  function cell(v, fill, font, alignment, numFmt, border){
    const c = {v, t: typeof v==='number'?'n':'s',
               s:{fill, font:font||{color:DARK,sz:10}, alignment:alignment||LEFT,
                  border: border||TB}};
    if(numFmt) c.s.numFmt = numFmt;
    return c;
  }

  // ── row 1: school title ─────────────────────────────────────────────
  ws['A1'] = {v:'🏫  ' + SCHOOL_NAME + ' — Attendance Export', t:'s',
               s:{fill:FILL.school, font:{bold:true,color:WHITE,sz:14},
                  alignment:{horizontal:'center',vertical:'center'},
                  border:{bottom:{style:'medium',color:{rgb:'166534'}}}}};
  'BCDEFGHIJ'.split('').forEach(c=>{
    ws[c+'1']={v:'',t:'s',s:{fill:FILL.school,
      border:{bottom:{style:'medium',color:{rgb:'166534'}}}}};
  });

  // ── row 2: sub-header ───────────────────────────────────────────────
  const riskLabel = riskEl.options[riskEl.selectedIndex].text;
  const formLabel = formEl.value || 'All Forms';
  ws['A2'] = {v:`Filter: ${riskLabel}   ·   ${formLabel}   ·   Exported ${dateStr}`, t:'s',
               s:{fill:FILL.subhdr,
                  font:{italic:true,color:{rgb:'15803D'},sz:9},
                  alignment:{horizontal:'center',vertical:'center'},
                  border:{bottom:{style:'medium',color:{rgb:'86EFAC'}}}}};
  'BCDEFGHIJ'.split('').forEach(c=>{
    ws[c+'2']={v:'',t:'s',s:{fill:FILL.subhdr,
      border:{bottom:{style:'medium',color:{rgb:'86EFAC'}}}}};
  });

  // ── row 3: column headers ───────────────────────────────────────────
  const COLS = ['#','Student','Form','Year','Days Attended','School Days','Days Absent','Term %','Risk','Status'];
  const COL_LETTERS = 'ABCDEFGHIJ'.split('');
  const hdrBorder = {top:{style:'medium',color:{rgb:'334155'}},
                     bottom:{style:'medium',color:{rgb:'334155'}},
                     left:thinBorder, right:thinBorder};
  COLS.forEach((h,i)=>{
    ws[COL_LETTERS[i]+'3'] = cell(h, FILL.header,
      {bold:true,color:WHITE,sz:10}, CENTER, undefined, hdrBorder);
  });

  // ── data rows ───────────────────────────────────────────────────────
  function riskFill(pct){
    if(pct===0)   return FILL.zero;
    if(pct<50)    return FILL.critical;
    if(pct<80)    return FILL.concern;
    if(pct<90)    return FILL.watch;
    return FILL.good;
  }

  data.forEach((s,i)=>{
    const row   = i + 4;
    const pct   = parseFloat(s.pct)||0;
    const fill  = riskFill(pct);
    const risk  = pct===0?'Zero':pct<50?'Critical':pct<80?'Concern':pct<90?'Watch':'Good';
    const status= s.status&&s.status!=='pending'?statusLabel(s.status):'Pending';
    const vals  = [i+1, s.name, s.form, s.year||'',
                   s.attended, s.sessions, s.absences, pct/100, risk, status];
    vals.forEach((v,ci)=>{
      const fmt = ci===7 ? '0.0%' : undefined;
      ws[COL_LETTERS[ci]+row] = cell(v, fill, null, ci===1?LEFT:CENTER, fmt);
    });
  });

  // ── footer ──────────────────────────────────────────────────────────
  const footerRow = data.length + 4;
  const footerBorder = {top:{style:'medium',color:{rgb:'94A3B8'}}};
  ws['A'+footerRow] = {v:`Total students: ${data.length}   ·   Generated by Attendly`, t:'s',
    s:{fill:FILL.footer, font:{italic:true,color:{rgb:'64748B'},sz:9},
       alignment:{horizontal:'center',vertical:'center'}, border:footerBorder}};
  'BCDEFGHIJ'.split('').forEach(c=>{
    ws[c+footerRow]={v:'',t:'s',s:{fill:FILL.footer,border:footerBorder}};
  });

  // ── sheet range, merges, column widths, row heights ─────────────────
  ws['!ref'] = `A1:J${footerRow}`;
  ws['!merges'] = [
    {s:{r:0,c:0},e:{r:0,c:9}},
    {s:{r:1,c:0},e:{r:1,c:9}},
    {s:{r:footerRow-1,c:0},e:{r:footerRow-1,c:9}},
  ];
  ws['!cols'] = [5,28,8,6,14,13,13,8,10,12].map(w=>({wch:w}));
  ws['!rows'] = [{hpt:24},{hpt:18},{hpt:20}];  // title, subhdr, col-headers
  ws['!freeze'] = {xSplit:0, ySplit:3};

  XLSX.utils.book_append_sheet(wb, ws, 'Attendance');
  XLSX.writeFile(wb, filename);
}

// ── PRINT ──────────────────────────────────────
// ── DAY ANALYSIS UPLOAD ────────────────────────
function dowSel(mode){
  document.getElementById('dow-period').value = mode;
  const on='flex:1;border:2px solid var(--blue);background:var(--blue-bg);border-radius:8px;padding:10px 12px;cursor:pointer;text-align:center;font-size:13px;font-weight:700;color:var(--blue);';
  const off='flex:1;border:2px solid var(--border);background:white;border-radius:8px;padding:10px 12px;cursor:pointer;text-align:center;font-size:13px;font-weight:600;color:var(--muted);';
  document.getElementById('dow-bt').style.cssText=mode==='term'?on:off;
  document.getElementById('dow-bw').style.cssText=mode==='week'?on:off;
}
async function doDowUpload(){
  const file = document.getElementById('dow-file').files[0];
  if(!file){ toast('Select a file first'); return; }
  const uploadId = UPLOAD ? UPLOAD.id : '';
  if(!uploadId){ toast('No upload selected'); return; }
  const period = document.getElementById('dow-period').value;
  const fd = new FormData();
  fd.append('file', file);
  fd.append('period', period);
  document.getElementById('dow-prog').style.display='block';
  let w=0;
  const iv=setInterval(()=>{ w=Math.min(w+12,88); document.getElementById('dow-prog-bar').style.width=w+'%'; },300);
  try{
    const res = await fetch('/dayanalysis/'+uploadId, {method:'POST', body:fd});
    clearInterval(iv);
    document.getElementById('dow-prog-bar').style.width='100%';
    if(res.ok){
      setTimeout(()=>{
        document.getElementById('dow-empty').style.display='none';
        const iframe=document.getElementById('dow-iframe');
        iframe.src='/dayanalysis/'+uploadId;
        iframe.style.display='block';
      },400);
    } else { toast('Upload failed — check file format'); document.getElementById('dow-prog').style.display='none'; }
  }catch(e){ clearInterval(iv); toast('Upload error: '+e.message); document.getElementById('dow-prog').style.display='none'; }
}

function doPrint(){
  // Switch to principal tab (this triggers lazy render via showLayer)
  const principalTab=document.querySelector('.layer-tab:nth-child(4)');
  showLayer('principal',principalTab);
  const dateStr=new Date().toLocaleDateString('en-AU',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
  document.getElementById('report-date').textContent=dateStr;
  const printDateEl=document.getElementById('report-date-print');
  if(printDateEl)printDateEl.textContent=dateStr;
  // Give charts time to render before printing
  setTimeout(()=>window.print(),600);
}

// ── LAYERS ─────────────────────────────────────
function showLayer(id,el){
  document.querySelectorAll('.layer').forEach(l=>l.classList.remove('active'));
  document.querySelectorAll('.layer-tab').forEach(t=>t.classList.remove('active'));
  document.getElementById('layer-'+id).classList.add('active');
  if(el)el.classList.add('active');
  // Lazy-render principal when tab becomes visible — avoids hidden canvas bug
  if(id==='today'){
    initTodayActions();
  }
  if(id==='universal'){
    // Destroy old chart instances before re-rendering
    ['dist-chart','form-chart'].forEach(cid=>{
      if(formCharts[cid]){formCharts[cid].destroy();delete formCharts[cid];}
    });
    renderOverview('ov-grid');
    const fs2=renderForms('form-tbody');
    renderCharts(fs2);
  }
  if(id==='dayofweek'){
    const uploadId = UPLOAD ? UPLOAD.id : '';
    if(!uploadId) return;
    // Only fetch once — if iframe already loaded, skip
    const iframe = document.getElementById('dow-iframe');
    if(iframe.src.includes('dayanalysis')) return;
    // Show loading, check if data exists
    document.getElementById('dow-loading').style.display='block';
    document.getElementById('dow-empty').style.display='none';
    fetch('/api/dayofweek/'+uploadId)
      .then(r=>r.json())
      .then(d=>{
        document.getElementById('dow-loading').style.display='none';
        if(d.data){
          iframe.src='/dayanalysis/'+uploadId;
          iframe.style.display='block';
        } else {
          document.getElementById('dow-empty').style.display='block';
        }
      })
      .catch(()=>{
        document.getElementById('dow-loading').style.display='none';
        document.getElementById('dow-empty').style.display='block';
      });
  }
  if(id==='caseload'){
    // Re-render case list whenever tab is opened so it reflects latest statuses
    renderCases();
    refreshCaseCounts();
  }
  if(id==='principal'){
    // Destroy existing charts to avoid "canvas already in use" error
    ['p-dist','p-form-chart','p-form-chart-pr'].forEach(cid=>{
      if(formCharts[cid]){formCharts[cid].destroy();delete formCharts[cid];}
    });
    // Clear tables/summary so rows don't duplicate on re-visit
    ['p-form-tbody'].forEach(tid=>{
      const el=document.getElementById(tid);if(el)el.innerHTML='';
    });
    const ps=document.getElementById('p-summary');if(ps)ps.innerHTML='';
    const po=document.getElementById('p-ov-grid');if(po)po.innerHTML='';
    renderPrincipal();
  }
}

// ── INIT ───────────────────────────────────────
async function initDashboard(){
  // Update title with student count to confirm data loaded
  document.title = SCHOOL_NAME + ' — Attendly Dashboard';
  
  // Set date
  const rd = document.getElementById('report-date');
  if(rd) rd.textContent = new Date().toLocaleDateString('en-AU',{weekday:'long',year:'numeric',month:'long',day:'numeric'});

  // Load case statuses from server
  try{
    const res = await fetch('/api/cases/all');
    if(res.ok){
      const data = await res.json();
      STUDENTS.forEach(s=>{
        const c = data[s.ref] || data[String(s.ref)];
        if(c && c.status && c.status !== 'pending'){
          s.status = c.status;
          s.notes  = c.notes || '';
        }
      });
    }
  }catch(e){}

  // Populate form dropdowns
  const forms=[...new Set(STUDENTS.map(s=>s.form))].sort();
  ['t-form','al-form'].forEach(id=>{
    const el=document.getElementById(id);
    if(el)el.innerHTML='<option value="">All Forms</option>'+forms.map(f=>`<option>${f}</option>`).join('');
  });

  // Render all sections
  renderOverview('ov-grid');
  renderForms('form-tbody');
  renderTargeted();
  renderCases();
  refreshCaseCounts();
  renderAll();
  if(typeof initTodayActions === 'function') initTodayActions();
  
  // Charts after short delay
  setTimeout(()=>{
    try{ renderCharts(renderForms('form-tbody')); }catch(e){}
  }, 200);
}
document.addEventListener('DOMContentLoaded', initDashboard);

// Day Analysis button — wired after DOM ready, guaranteed to work
document.addEventListener('DOMContentLoaded', function() {
  var btn = document.getElementById('dow-btn');
  var fi = document.getElementById('dow-file');
  
  if (fi) {
    fi.addEventListener('change', function() {
      var sel = document.getElementById('dow-selected');
      if (sel && fi.files[0]) sel.textContent = fi.files[0].name;
    });
  }
  
  if (btn) {
    btn.addEventListener('click', function() {
      if (!fi || !fi.files || !fi.files.length) {
        alert('Please select a file first using the Choose File button');
        return;
      }
      btn.textContent = 'Parsing… please wait';
      btn.disabled = true;
      
      var status = document.getElementById('dow-status');
      if (status) { status.style.display='block'; status.textContent = 'Uploading to server…'; }
      
      var fd = new FormData();
      fd.append('file', fi.files[0]);
      fd.append('upload_id', UPLOAD ? UPLOAD.id : '');
      fd.append('period', DOW_PERIOD || 'term');
      
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload/absentee', true);
      
      xhr.onload = function() {
        if (xhr.status === 200) {
          try {
            var data = JSON.parse(xhr.responseText);
            if (data.success) {
              DOW_DATA = data.data;
              var days = ['Mon','Tue','Wed','Thu','Fri'];
              var dt = {};
              days.forEach(function(d) {
                dt[d] = Object.values(DOW_DATA).reduce(function(s,x){ return s+(x[d]||0); }, 0);
              });
              var worst = days.reduce(function(a,b){ return dt[a]>dt[b]?a:b; });
              renderDowResults(dt, worst, Object.keys(DOW_DATA).length);
              document.getElementById('dow-results').style.display = 'block';
              if (status) { status.textContent = 'Parsed ' + data.students + ' students!'; }
              btn.textContent = 'Done — Analyse Again';
              btn.disabled = false;
            } else {
              alert('Parse error: ' + (data.error || 'Unknown'));
              btn.textContent = 'Analyse Day of Week Patterns';
              btn.disabled = false;
            }
          } catch(e) {
            alert('Parse response error: ' + e.message + '\n\nServer said: ' + xhr.responseText.substring(0,200));
            btn.textContent = 'Analyse Day of Week Patterns';
            btn.disabled = false;
          }
        } else {
          alert('Server error ' + xhr.status + ': ' + xhr.responseText.substring(0,300));
          btn.textContent = 'Analyse Day of Week Patterns';
          btn.disabled = false;
        }
      };
      
      xhr.onerror = function() {
        alert('Network error!\nStatus: ' + xhr.status + '\nURL tried: ' + window.location.protocol + '//' + window.location.host + '/api/upload/absentee\nreadyState: ' + xhr.readyState);
        btn.textContent = 'Analyse Day of Week Patterns';
        btn.disabled = false;
      };
      
      xhr.ontimeout = function() {
        alert('Request timed out after 30 seconds');
        btn.textContent = 'Analyse Day of Week Patterns';
        btn.disabled = false;
      };
      
      xhr.upload.onprogress = function(e) {
        if (e.lengthComputable) {
          var pct = Math.round(e.loaded/e.total*100);
          if (status) status.textContent = 'Uploading: ' + pct + '%';
        }
      };
      
      xhr.timeout = 60000; // 60 second timeout
      xhr.send(fd);
      if (status) status.textContent = 'Uploading... (file: ' + fi.files[0].size + ' bytes)';
    });
  }
});

// ── CASE PLAN ─────────────────────────────────
let CP_REF        = null;
let CP_PERIOD_KEY = (UPLOAD && UPLOAD.period_key) ? UPLOAD.period_key : 'legacy';
let CP_SAVE_TIMER = null;
let CP_DIRTY      = false;

function openCasePlan(ref) {
  const s = STUDENTS.find(x => x.ref === ref);
  if (!s) return;
  CP_REF = ref;
  CP_DIRTY = false;
  applyCpTemplate();

  // Pre-fill student info
  document.getElementById('cp-name').value = formatName(s.name);
  document.getElementById('cp-year').value = 'Year ' + s.year;
  document.getElementById('cp-form').value = s.form;
  document.getElementById('cp-ref').value = s.ref;

  // Pre-fill attendance data
  function fmtD(n) { const d = n/2; return d%1===0 ? String(d) : d.toFixed(1); }
  document.getElementById('cp-pct').textContent = s.pct + '%';
  document.getElementById('cp-days-absent').textContent = fmtD(s.absences) + ' days';
  document.getElementById('cp-days-attended').textContent = fmtD(s.attended) + ' days';
  document.getElementById('cp-school-days').textContent = fmtD(s.sessions) + ' days';

  // Set default plan date to today (text format dd/mm/yyyy)
  const today = new Date();
  const todayStr = today.getDate().toString().padStart(2,'0') + '/' + 
    (today.getMonth()+1).toString().padStart(2,'0') + '/' + today.getFullYear();
  document.getElementById('cp-date').value = todayStr;

  // Load saved plan data from server
  loadCasePlanData(ref);

  document.getElementById('case-plan-overlay').style.display = 'block';
  document.body.style.overflow = 'hidden';
}

function closeCasePlan() {
  if (CP_DIRTY) {
    if (!confirm('You have unsaved changes. Close without saving?')) return;
  }
  document.getElementById('case-plan-overlay').style.display = 'none';
  document.body.style.overflow = '';
  CP_REF = null;
  CP_DIRTY = false;
}

// Close on overlay click
document.getElementById('case-plan-overlay').addEventListener('click', function(e) {
  if (e.target === this) closeCasePlan();
});

function clearCasePlanFields() {
  const fields = ['dob','gender','casemanager','checkin','goal','strengths','classes',
    'learning','barriers','success','rewards','strategies','fu-notes','agency1','agency2',
    'sig-parent','sig-cm','review-date'];
  fields.forEach(id => { const el=document.getElementById('cp-'+id); if(el) el.value=''; });
  const gp=document.getElementById('cp-gender-print'); if(gp) gp.textContent='';
  ['curriculum','career','basicneeds','mental','behaviour','social'].forEach(id=>{
    const el=document.getElementById('cp-sup-'+id); if(el) el.checked=false;
  });
  ['phone','email','sms','homevisit','parentconf','letter'].forEach(id=>{
    const cb=document.getElementById('fu-'+id); if(cb) cb.checked=false;
    const nb=document.getElementById('fu-'+id+'-n'); if(nb) nb.value='';
  });
  ['atsi','disability','eald','clontarf','ucom','review'].forEach(name=>{
    document.querySelectorAll(`input[name="${name}"]`).forEach(el=>el.checked=false);
  });
}


function applyPlanToFields(p) {
  const fields = ['dob','gender','casemanager','checkin','goal','strengths','classes',
    'learning','barriers','success','rewards','strategies','fu-notes','agency1','agency2',
    'sig-parent','sig-cm','review-date'];
  fields.forEach(id => {
    const el = document.getElementById('cp-' + id);
    if (el && p[id] !== undefined) el.value = p[id];
  });
  const gp = document.getElementById('cp-gender-print');
  if (gp && p['gender']) gp.textContent = p['gender'];
  ['curriculum','career','basicneeds','mental','behaviour','social'].forEach(id => {
    const el = document.getElementById('cp-sup-' + id);
    if (el && p['sup_' + id] !== undefined) el.checked = !!p['sup_' + id];
  });
  ['phone','email','sms','homevisit','parentconf','letter'].forEach(id => {
    const cb = document.getElementById('fu-' + id);
    const nb = document.getElementById('fu-' + id + '-n');
    if (cb && p['fu_' + id] !== undefined) cb.checked = !!p['fu_' + id];
    if (nb && p['fu_' + id + '_n'] !== undefined) nb.value = p['fu_' + id + '_n'];
  });
  ['atsi','disability','eald','clontarf','ucom'].forEach(name => {
    if (p[name]) {
      const el = document.querySelector(`input[name="${name}"][value="${p[name]}"]`);
      if (el) el.checked = true;
    }
  });
  if (p.review) {
    const el = document.querySelector(`input[name="review"][value="${p.review}"]`);
    if (el) el.checked = true;
  }
  if (p.date) document.getElementById('cp-date').value = p.date;
}

async function loadCasePlanData(ref) {
  clearCasePlanFields();
  const periodLbl = document.getElementById('cp-period-label');
  if (periodLbl) periodLbl.textContent = CP_PERIOD_KEY !== 'legacy' ? CP_PERIOD_KEY : '';
  try {
    const res = await fetch('/api/caseplan/' + ref + '?period_key=' + encodeURIComponent(CP_PERIOD_KEY));
    if (!res.ok) return;
    const data = await res.json();
    if (!data.plan || data.plan_period !== CP_PERIOD_KEY) return;
    applyPlanToFields(data.plan);
    document.getElementById('cp-save-txt').textContent = 'Loaded from database';
  } catch(e) {
    console.log('No existing plan:', e);
  }
}


function saveCpField() {
  CP_DIRTY = true;
  if (!CP_REF) return;
  clearTimeout(CP_SAVE_TIMER);
  document.getElementById('cp-save-dot').style.background = '#FFC107';
  document.getElementById('cp-save-txt').textContent = 'Saving…';

  CP_SAVE_TIMER = setTimeout(async () => {
    try {
      await fetch('/api/caseplan/' + CP_REF, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ plan: collectCasePlan(), period_key: CP_PERIOD_KEY })
      });
      document.getElementById('cp-save-dot').style.background = '#4CAF50';
      document.getElementById('cp-save-txt').textContent = 'All changes saved to database';
      CP_DIRTY = false;
    } catch(e) {
      document.getElementById('cp-save-dot').style.background = '#F44336';
      document.getElementById('cp-save-txt').textContent = 'Save error';
    }
  }, 800);
}

function collectCasePlan() {
  const plan = {};
  ['dob','gender','casemanager','checkin','goal','date','strengths','classes',
   'learning','barriers','success','rewards','strategies','fu-notes','agency1','agency2',
   'sig-parent','sig-cm','review-date'].forEach(id => {
    const el = document.getElementById('cp-' + id);
    if (el) plan[id] = el.value;
  });
  ['curriculum','career','basicneeds','mental','behaviour','social'].forEach(id => {
    const el = document.getElementById('cp-sup-' + id);
    if (el) plan['sup_' + id] = el.checked;
  });
  ['phone','email','sms','homevisit','parentconf','letter'].forEach(id => {
    const cb = document.getElementById('fu-' + id);
    const nb = document.getElementById('fu-' + id + '-n');
    if (cb) plan['fu_' + id] = cb.checked;
    if (nb) plan['fu_' + id + '_n'] = nb.value;
  });
  ['atsi','disability','eald','clontarf','ucom','review'].forEach(name => {
    const el = document.querySelector(`input[name="${name}"]:checked`);
    if (el) plan[name] = el.value;
  });
  return plan;
}

async function saveCasePlanNow() {
  if (!CP_REF) return;
  clearTimeout(CP_SAVE_TIMER);
  const btn = document.getElementById('cp-save-btn');
  if (btn) { btn.textContent = 'Saving…'; btn.disabled = true; }
  document.getElementById('cp-save-dot').style.background = '#FFC107';
  document.getElementById('cp-save-txt').textContent = 'Saving…';
  try {
    await fetch('/api/caseplan/' + CP_REF, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ plan: collectCasePlan(), period_key: CP_PERIOD_KEY })
    });
    document.getElementById('cp-save-dot').style.background = '#4CAF50';
    document.getElementById('cp-save-txt').textContent = 'All changes saved to database';
    if (btn) { btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:13px;height:13px"><polyline points="20 6 9 17 4 12"/></svg> Saved!'; btn.disabled = false; setTimeout(()=>{btn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:13px;height:13px"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save Plan';},2000); }
    // Mark the card's Case Plan button as filled now that a plan exists
    const cardBtn=document.getElementById('cpbtn-'+CP_REF);
    if(cardBtn){ cardBtn.style.background='var(--school-green)'; cardBtn.style.color='white'; cardBtn.style.border='2px solid var(--school-green)'; cardBtn.style.borderStyle='solid'; cardBtn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" style="width:13px;height:13px"><polyline points="20 6 9 17 4 12"/></svg> Open Case Plan'; }
    const s=STUDENTS.find(x=>x.ref===CP_REF); if(s) s.has_case_plan=true;
    CP_DIRTY = false;
  } catch(e) {
    document.getElementById('cp-save-dot').style.background = '#F44336';
    document.getElementById('cp-save-txt').textContent = 'Save error — try again';
    if (btn) { btn.textContent = 'Save Plan'; btn.disabled = false; }
  }
}

async function printCasePlan() {
  await saveCasePlanNow();
  document.body.classList.add('printing-case-plan');
  setTimeout(() => {
    window.print();
    setTimeout(() => document.body.classList.remove('printing-case-plan'), 500);
  }, 150);
}


// ══════════════════════════════════════════════════════════
// TODAY'S ACTIONS — Daily Follow-Up Reminder
// ══════════════════════════════════════════════════════════

const CHECKLIST_KEY = 'checklist_' + new Date().toDateString();

function resetChecklist() {
  try { localStorage.removeItem(CHECKLIST_KEY); } catch(e) {}
  var container = document.getElementById('today-checklist');
  var rows = container.getElementsByClassName('ta-cl-row');
  for (var i = 0; i < rows.length; i++) {
    rows[i].className = 'ta-cl-row';
    var spans = rows[i].getElementsByTagName('span');
    var lastSpan = spans[spans.length - 1];
    if (lastSpan) {
      var rpct = parseFloat(rows[i].getAttribute('data-pct'));
      var rstatus = rows[i].getAttribute('data-status');
      lastSpan.textContent = rstatus === 'contacted' ? 'Follow up on previous contact' :
        rpct < 20 ? 'Call + welfare referral' :
        rpct < 50 ? 'Phone call home today' : 'Early engagement call';
    }
  }
  document.getElementById('today-checklist-progress').textContent = '0 of ' + rows.length + ' actioned today';
  document.getElementById('today-cl-bar').style.width = '0%';
}

function initTodayActions() {
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  document.getElementById('today-greeting').textContent = greeting + ', ' + CURRENT_USER_NAME + '!';
  document.getElementById('today-date').textContent =
    new Date().toLocaleDateString('en-AU', {weekday:'long', day:'numeric', month:'long', year:'numeric'});

  const urgent = STUDENTS.filter(s => s.pct < 50 && (!s.status || s.status === 'pending'))
    .sort((a,b) => a.pct - b.pct);
  const overdue = STUDENTS.filter(s => s.pct < 80 && s.status === 'contacted')
    .sort((a,b) => a.pct - b.pct);
  const watch = STUDENTS.filter(s =>
    s.pct >= 80 && s.pct < 85 && (!s.status || s.status === 'pending')
  ).sort((a,b) => a.pct - b.pct);
  const good = STUDENTS.filter(s => s.status === 'resolved')
    .sort((a,b) => a.pct - b.pct);

  document.getElementById('today-count-urgent').textContent = urgent.length;
  document.getElementById('today-count-overdue').textContent = overdue.length;
  document.getElementById('today-count-watch').textContent = watch.length;
  document.getElementById('today-count-good').textContent = good.length;

  const totalAction = urgent.length + overdue.length + watch.length;
  document.getElementById('today-total-count').textContent = totalAction;
  document.getElementById('badge-today').textContent = totalAction;

  renderTodayList('today-urgent-list', urgent, '#EF4444', 'Call immediately or escalate to Principal');
  renderTodayList('today-overdue-list', overdue, '#F59E0B', 'Follow up on previous contact');
  renderTodayList('today-watch-list', watch, '#3B82F6', 'Early engagement call recommended');
  renderTodayList('today-good-list', good, '#22C55E', 'Monitor for sustained improvement');

  renderChecklist([...urgent, ...overdue, ...watch]);
}

function renderTodayList(containerId, students, color, action) {
  const el = document.getElementById(containerId);
  if (!students.length) {
    el.innerHTML = `<div class="ta-section-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>All clear</div>`;
    return;
  }
  el.innerHTML = students.map(s => `
    <div class="ta-row">
      <div class="ta-av" style="background:${color}">${initials(s.name)}</div>
      <div class="ta-info">
        <div class="ta-name">${formatName(s.name)}</div>
        <div class="ta-meta">${s.form} · Year ${s.year} · ${action}</div>
      </div>
      <div class="ta-pct" style="color:${color}">${s.pct}%</div>
    </div>
  `).join('');
}

function renderChecklist(students) {
  var container = document.getElementById('today-checklist');

  var state = {};
  try { state = JSON.parse(localStorage.getItem(CHECKLIST_KEY) || '{}'); } catch(e) {}

  var html = '';
  students.forEach(function(s) {
    var isDone = state[s.ref] === true;
    var col = s.pct === 0 ? '#EF4444' : s.pct < 50 ? '#F59E0B' : s.pct < 80 ? '#EAB308' : '#3B82F6';
    var at = s.status === 'contacted' ? 'Follow up on previous contact' :
             s.pct < 20 ? 'Call + welfare referral' :
             s.pct < 50 ? 'Phone call home today' : 'Early engagement call';
    html += '<div class="ta-cl-row' + (isDone ? ' ta-cl-done' : '') + '"' +
      ' data-ref="' + s.ref + '" data-pct="' + s.pct + '" data-status="' + (s.status || '') + '">' +
      '<div class="ta-cl-box" style="pointer-events:none">' +
        '<svg viewBox="0 0 12 12" fill="none" stroke="white" stroke-width="2.5" style="pointer-events:none"><polyline points="1.5,6 4.5,9 10.5,3"/></svg>' +
      '</div>' +
      '<span class="ta-cl-name" style="pointer-events:none">' + formatName(s.name) + '</span>' +
      '<span class="ta-cl-form" style="pointer-events:none">' + s.form + '</span>' +
      '<span class="ta-cl-pct" style="color:' + col + ';pointer-events:none">' + s.pct + '%</span>' +
      '<span class="ta-cl-action" style="pointer-events:none">' + (isDone ? 'Done for today ✓' : at) + '</span>' +
      '<button class="ta-cl-undo-btn" data-ref="' + s.ref + '">✕ Undo</button>' +
      '</div>';
  });
  container.innerHTML = html;

  function applyToggle(ref, nowDone) {
    var st = {};
    try { st = JSON.parse(localStorage.getItem(CHECKLIST_KEY) || '{}'); } catch(ex) {}
    if (nowDone) st[ref] = true; else delete st[ref];
    try { localStorage.setItem(CHECKLIST_KEY, JSON.stringify(st)); } catch(ex) {}

    var row = container.querySelector('.ta-cl-row[data-ref="' + ref + '"]');
    if (row) {
      row.className = 'ta-cl-row' + (nowDone ? ' ta-cl-done' : '');
      var spans = row.getElementsByTagName('span');
      var actionSpan = spans[spans.length - 1];
      if (actionSpan) {
        var rpct = parseFloat(row.getAttribute('data-pct'));
        var rstatus = row.getAttribute('data-status');
        var at2 = rstatus === 'contacted' ? 'Follow up on previous contact' :
                  rpct < 20 ? 'Call + welfare referral' :
                  rpct < 50 ? 'Phone call home today' : 'Early engagement call';
        actionSpan.textContent = nowDone ? 'Done for today ✓' : at2;
      }
    }

    var allRows = container.getElementsByClassName('ta-cl-row');
    var d = 0;
    for (var j = 0; j < allRows.length; j++) {
      if (allRows[j].className.indexOf('ta-cl-done') !== -1) d++;
    }
    var t = allRows.length;
    var p = t > 0 ? Math.round(d / t * 100) : 0;
    document.getElementById('today-checklist-progress').textContent = d + ' of ' + t + ' actioned today';
    document.getElementById('today-cl-bar').style.width = p + '%';
    if (d === t && t > 0) toast('All done for today — great work!');
  }

  // Row click = mark as done (tick)
  var rows = container.getElementsByClassName('ta-cl-row');
  for (var i = 0; i < rows.length; i++) {
    rows[i].onclick = function(e) {
      if (e.target.className === 'ta-cl-undo-btn') return;
      if (this.className.indexOf('ta-cl-done') !== -1) return;
      applyToggle(this.getAttribute('data-ref'), true);
    };
  }

  // Undo button click = remove tick
  var undoBtns = container.getElementsByClassName('ta-cl-undo-btn');
  for (var k = 0; k < undoBtns.length; k++) {
    undoBtns[k].onclick = function(e) {
      e.stopPropagation();
      applyToggle(this.getAttribute('data-ref'), false);
    };
  }

  // Wire reset button
  var resetBtn = document.getElementById('cl-reset-btn');
  if (resetBtn) resetBtn.onclick = function() { resetChecklist(); };

  // Update counter display
  var done = 0;
  for (var m in state) { if (state[m] === true) done++; }
  var total = students.length;
  var pct = total > 0 ? Math.round(done / total * 100) : 0;
  document.getElementById('today-checklist-progress').textContent = done + ' of ' + total + ' actioned today';
  document.getElementById('today-cl-bar').style.width = pct + '%';
}



// ══════════════════════════════════════════════════════════
// WEEKLY TREND GRAPH — per student attendance history
// ══════════════════════════════════════════════════════════

// Cache loaded trend data so we don't re-fetch on every expand
const trendCache = {};
// Track Chart.js instances so we can destroy before re-creating
const trendCharts = {};

async function loadTrend(ref, containerId) {
  const getEl = () => document.getElementById(containerId);
  if (!getEl()) return;

  // Show loading state
  getEl().innerHTML = '<div class="trend-loading">Loading attendance history…</div>';

  // Use cache if available
  if (trendCache[ref]) {
    renderTrendChart(ref, trendCache[ref], containerId);
    return;
  }

  try {
    const res = await fetch(`/api/trend/${ref}`);
    if (!res.ok) throw new Error('Failed to load');
    const data = await res.json();
    trendCache[ref] = data.trend;
    renderTrendChart(ref, data.trend, containerId);
  } catch(e) {
    const el = getEl();
    if (el) el.innerHTML = '<div class="trend-loading">Could not load</div>';
  }
}

function renderTrendChart(ref, trend, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  // Only 1 data point — can't draw a meaningful trend
  if (!trend || trend.length < 2) {
    const pct = (trend && trend.length === 1) ? trend[0].pct + '%' : '—';
    container.innerHTML = `<div class="trend-only1" style="padding:18px 16px;display:flex;align-items:center;gap:12px;">
      <div style="width:36px;height:36px;border-radius:8px;background:var(--blue-bg);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
        <svg viewBox="0 0 24 24" fill="none" stroke="var(--blue)" stroke-width="2" style="width:18px;height:18px;"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
      </div>
      <div>
        <div style="font-size:12.5px;font-weight:600;color:var(--text);margin-bottom:2px;">Current attendance: ${pct}</div>
        <div style="font-size:11.5px;color:var(--muted);">Upload a second week to see the attendance trend over time.</div>
      </div>
    </div>`;
    return;
  }

  // Calculate trend direction
  const first = trend[0].pct;
  const last  = trend[trend.length - 1].pct;
  const diff  = Math.round((last - first) * 10) / 10;
  const trendDir  = diff > 2 ? '↑ Improving' : diff < -2 ? '↓ Declining' : '→ Stable';
  const trendCol  = diff > 2 ? 'var(--green)' : diff < -2 ? 'var(--red)' : 'var(--amber)';
  const trendBg   = diff > 2 ? 'var(--green-bg)' : diff < -2 ? 'var(--red-bg)' : 'var(--amber-bg)';

  // Build chart HTML
  const canvasId = `trend-chart-${ref}`;
  container.innerHTML = `
    <div class="trend-header">
      <span class="trend-title">Attendance Trend — ${trend.length} uploads</span>
      <span class="trend-badge" style="background:${trendBg};color:${trendCol};">
        ${trendDir} (${diff > 0 ? '+' : ''}${diff}%)
      </span>
    </div>
    <div style="height:140px;position:relative;">
      <canvas id="${canvasId}"></canvas>
    </div>
    <div class="trend-stats">
      <div class="trend-stat">
        <div class="trend-stat-val" style="color:${trendCol}">${last}%</div>
        <div class="trend-stat-lbl">Current</div>
      </div>
      <div class="trend-stat">
        <div class="trend-stat-val">${Math.min(...trend.map(t=>t.pct))}%</div>
        <div class="trend-stat-lbl">Lowest</div>
      </div>
      <div class="trend-stat">
        <div class="trend-stat-val">${Math.max(...trend.map(t=>t.pct))}%</div>
        <div class="trend-stat-lbl">Highest</div>
      </div>
    </div>`;

  // Destroy previous chart instance if exists (avoids "canvas in use" error)
  if (trendCharts[ref]) {
    trendCharts[ref].destroy();
    delete trendCharts[ref];
  }

  // Draw the Chart.js line chart
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;

  // Colour each data point by risk level
  const pointColors = trend.map(t =>
    t.pct === 0 ? '#C0392B' :
    t.pct < 50  ? '#D35400' :
    t.pct < 80  ? '#B7950B' : '#1A7A3C'
  );

  trendCharts[ref] = new Chart(ctx, {
    type: 'line',
    data: {
      labels: trend.map(t => t.label),
      datasets: [{
        label: 'Attendance %',
        data: trend.map(t => t.pct),
        borderColor: trendCol,
        backgroundColor: trendCol + '18',
        borderWidth: 2.5,
        pointBackgroundColor: pointColors,
        pointBorderColor: pointColors,
        pointRadius: 5,
        pointHoverRadius: 7,
        fill: true,
        tension: 0.3,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.raw}% attendance`,
            afterLabel: ctx => {
              const t = trend[ctx.dataIndex];
              return ` ${t.days_absent} days absent`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { size: 10, family: 'Inter' }, maxRotation: 30 }
        },
        y: {
          beginAtZero: false,
          min: Math.max(0, Math.min(...trend.map(t=>t.pct)) - 10),
          max: 100,
          grid: { color: '#F0F2F5' },
          ticks: {
            font: { size: 10, family: 'Inter' },
            callback: v => v + '%'
          }
        }
      }
    }
  });
}


// ══════════════════════════════════════════════════════════
// DAY OF WEEK ANALYSIS
// ══════════════════════════════════════════════════════════

let DOW_DATA = null;
let DOW_PERIOD = 'term';
let dowChart = null;

async function loadExistingDowData(uploadId) {
  try {
    const res = await fetch('/api/dayofweek/' + uploadId);
    if (!res.ok) return;
    const json = await res.json();
    if (!json.data) return;
    DOW_DATA = json.data;
    // Show results section, hide upload panel
    document.getElementById('dow-upload-panel').style.display = 'none';
    document.getElementById('dow-results-container').style.display = 'block';
    // Calculate totals and render
    const days = ['Mon','Tue','Wed','Thu','Fri'];
    const dt = {};
    days.forEach(d => { dt[d] = Object.values(DOW_DATA).reduce((s,x) => s+(x[d]||0), 0); });
    const worst = days.reduce((a,b) => dt[a]>dt[b]?a:b);
    // Render chart
    setTimeout(() => { renderDowChart(dt, worst); renderDowFindings(dt, worst); renderDowTable(); }, 100);
  } catch(e) {
    // No existing data — show upload panel
  }
}

function renderDowChart(dt, worst) {
  const days = ['Mon','Tue','Wed','Thu','Fri'];
  const dayFull = {Mon:'Monday',Tue:'Tuesday',Wed:'Wednesday',Thu:'Thursday',Fri:'Friday'};
  const colors = {Mon:'#1A4F7A',Tue:'#2E7D32',Wed:'#6B2FAA',Thu:'#D35400',Fri:'#C0392B'};
  if(dowChart) dowChart.destroy();
  const ctx = document.getElementById('dow-bar');
  if(!ctx) return;
  dowChart = new Chart(ctx, {
    type:'bar',
    data:{
      labels: days.map(d=>dayFull[d]),
      datasets:[{
        label:'Absent Sessions',
        data: days.map(d=>dt[d]||0),
        backgroundColor: days.map(d => colors[d] + (d===worst?'FF':'99')),
        borderRadius:6
      }]
    },
    options:{
      responsive:true, maintainAspectRatio:false,
      plugins:{legend:{display:false}},
      scales:{x:{grid:{display:false}}, y:{beginAtZero:true}}
    }
  });
}

function renderDowFindings(dt, worst) {
  const days = ['Mon','Tue','Wed','Thu','Fri'];
  const dayFull = {Mon:'Monday',Tue:'Tuesday',Wed:'Wednesday',Thu:'Thursday',Fri:'Friday'};
  const best = days.slice().sort((a,b)=>(dt[a]||0)-(dt[b]||0))[0];
  const friFans = Object.values(DOW_DATA||{}).filter(s=>(s.Fri||0)>=3).length;
  const monFans = Object.values(DOW_DATA||{}).filter(s=>(s.Mon||0)>=3).length;
  const friMon = (dt['Fri']||0)+(dt['Mon']||0);
  const midweek = (dt['Tue']||0)+(dt['Wed']||0)+(dt['Thu']||0);
  const students = Object.keys(DOW_DATA||{}).length;
  const el = document.getElementById('dow-findings');
  if(!el) return;
  el.innerHTML = `
    <div style="padding:12px;background:var(--red-bg);border-radius:9px;border-left:4px solid var(--red);">
      <strong>${dayFull[worst]}</strong> is the worst day — <strong>${dt[worst]} absent sessions</strong> this term
    </div>
    <div style="padding:12px;background:var(--green-bg);border-radius:9px;border-left:4px solid var(--green);">
      <strong>${dayFull[best]}</strong> is the best day — only <strong>${dt[best]} absent sessions</strong>
    </div>
    <div style="padding:12px;background:var(--amber-bg);border-radius:9px;border-left:4px solid var(--amber);">
      ⚠️ <strong>${friFans} students</strong> missed Friday 3+ times — long weekend pattern likely
    </div>
    <div style="padding:12px;background:var(--blue-bg);border-radius:9px;border-left:4px solid var(--blue);">
      <strong>${monFans} students</strong> missed Monday 3+ times — weekend recovery pattern?
    </div>
    <div style="padding:12px;background:#F3E5F5;border-radius:9px;border-left:4px solid #6B2FAA;">
      Fri+Mon = <strong>${friMon}</strong> vs mid-week = <strong>${midweek}</strong>
      ${friMon > midweek ? ' — <strong>start/end of week problem</strong>' : ' — fairly spread'}
    </div>
    <div style="padding:12px;background:var(--bg);border-radius:9px;border:1px solid var(--border);">
      <strong>${students}</strong> students analysed across the term
    </div>`;
}

function dowInit(){
  // Wire file input
  const fi = document.getElementById('dow-file');
  if(fi && !fi._w){ fi._w=1; fi.onchange=function(){ const s=document.getElementById('dow-selected'); if(s) s.textContent=fi.files[0]?fi.files[0].name:''; }; }
  // Wire analyse button  
  const btn = document.getElementById('dow-analyse-btn');
  if(btn && !btn._w){ btn._w=1; btn.onclick=dowAnalyse; }
  // Wire period buttons
  const t=document.getElementById('dow-opt-term'), w=document.getElementById('dow-opt-week');
  if(t && !t._w){ t._w=1; t.onclick=function(){ dowSetPeriod('term'); }; }
  if(w && !w._w){ w._w=1; w.onclick=function(){ dowSetPeriod('week'); }; }
  if(DOW_DATA) renderDowTable();
}

function dowSetPeriod(type){
  DOW_PERIOD=type;
  const t=document.getElementById('dow-opt-term'), w=document.getElementById('dow-opt-week'), n=document.getElementById('dow-period-note');
  if(type==='term'){
    if(t){t.style.border='2px solid var(--school-green)';t.style.background='var(--green-bg)';t.style.opacity='1';}
    if(w){w.style.border='2px solid var(--border)';w.style.background='white';w.style.opacity='0.7';}
    if(n){n.style.color='var(--school-green)';n.style.background='var(--green-bg)';n.textContent='📆 Whole Term mode: Replaces current analysis with full term data.';}
  } else {
    if(w){w.style.border='2px solid var(--blue)';w.style.background='var(--blue-bg)';w.style.opacity='1';}
    if(t){t.style.border='2px solid var(--border)';t.style.background='white';t.style.opacity='0.7';}
    if(n){n.style.color='var(--blue)';n.style.background='var(--blue-bg)';n.textContent="Weekly mode: Adds this week to existing analysis.";}
  }
}

async function dowAnalyse(){
  const fi=document.getElementById('dow-file');
  if(!fi||!fi.files||!fi.files.length){ toast('⚠️ Please select a file first'); return; }
  const btn=document.getElementById('dow-analyse-btn');
  if(btn){ btn.textContent='Parsing… please wait'; btn.style.background='#666'; }
  const fd=new FormData();
  fd.append('file',fi.files[0]);
  fd.append('upload_id',UPLOAD.id||'');
  fd.append('period',DOW_PERIOD||'term');
  if(DOW_PERIOD==='week'&&DOW_DATA) fd.append('existing_data',JSON.stringify(DOW_DATA));
  try{
    const apiUrl = window.location.protocol + '//' + window.location.host + '/api/upload/absentee';
    alert('Sending to: ' + apiUrl + '\nFile size: ' + fi.files[0].size + ' bytes');
    const res=await fetch(apiUrl,{method:'POST',body:fd});
    if(!res.ok){ 
      const t=await res.text(); 
      alert('Server error '+res.status+': '+t.substring(0,300));
      if(btn){btn.textContent='Analyse Day of Week Patterns';btn.style.background='var(--navy)';} 
      return; 
    }
    const data=await res.json();
    if(!data.success){ 
      alert('Parse failed: '+(data.error||'Unknown'));
      if(btn){btn.textContent='Analyse Day of Week Patterns';btn.style.background='var(--navy)';} 
      return; 
    }
    DOW_DATA=data.data;
    const days=['Mon','Tue','Wed','Thu','Fri'];
    const dt={};
    days.forEach(d=>{ dt[d]=Object.values(DOW_DATA).reduce((s,x)=>s+(x[d]||0),0); });
    const worst=days.reduce((a,b)=>dt[a]>dt[b]?a:b);
    renderDowResults(dt,worst,Object.keys(DOW_DATA).length);
    document.getElementById('dow-results').style.display='block';
    toast('Parsed '+data.students+' students!');
    if(btn){btn.textContent='Done — Analyse Again';btn.style.background='var(--green)';}
  }catch(e){
    alert('Network/fetch error: '+e.message+'\n\nThis usually means the server is not running or the file is too large.');
    if(btn){btn.textContent='Analyse Day of Week Patterns';btn.style.background='var(--navy)';}
  }
}

function renderDowResults(dayTotals,worstDay,studentCount){
  const days=['Mon','Tue','Wed','Thu','Fri'];
  const dayFull={Mon:'Monday',Tue:'Tuesday',Wed:'Wednesday',Thu:'Thursday',Fri:'Friday'};
  const colors={Mon:'#1A4F7A',Tue:'#2E7D32',Wed:'#6B2FAA',Thu:'#D35400',Fri:'#C0392B'};
  if(dowChart) dowChart.destroy();
  const ctx=document.getElementById('dow-bar');
  if(ctx) dowChart=new Chart(ctx,{type:'bar',data:{labels:days.map(d=>dayFull[d]),datasets:[{label:'Absent Sessions',data:days.map(d=>dayTotals[d]||0),backgroundColor:days.map(d=>colors[d]+(d===worstDay?'FF':'AA')),borderRadius:6}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{grid:{display:false}},y:{beginAtZero:true}}}});
  const friFans=Object.values(DOW_DATA).filter(s=>(s.Fri||0)>=3).length;
  const monFans=Object.values(DOW_DATA).filter(s=>(s.Mon||0)>=3).length;
  const best=days.slice().sort((a,b)=>(dayTotals[a]||0)-(dayTotals[b]||0))[0];
  const f=document.getElementById('dow-findings');
  if(f) f.innerHTML=`
    <div style="padding:12px;background:var(--red-bg);border-radius:9px;border-left:4px solid var(--red);"><strong>${dayFull[worstDay]}</strong> is the worst day — <strong>${dayTotals[worstDay]} absent sessions</strong></div>
    <div style="padding:12px;background:var(--green-bg);border-radius:9px;border-left:4px solid var(--green);"><strong>${dayFull[best]}</strong> is the best day — only <strong>${dayTotals[best]} absent sessions</strong></div>
    <div style="padding:12px;background:var(--amber-bg);border-radius:9px;border-left:4px solid var(--amber);">⚠️ <strong>${friFans} students</strong> missed Friday 3+ times — long weekend pattern?</div>
    <div style="padding:12px;background:var(--blue-bg);border-radius:9px;border-left:4px solid var(--blue);"><strong>${monFans} students</strong> missed Monday 3+ times — weekend recovery pattern?</div>`;
  renderDowTable();
}

function renderDowTable(){
  if(!DOW_DATA) return;
  const dayFilter=document.getElementById('dow-day-filter');
  const fv=dayFilter?dayFilter.value:'';
  const days=['Mon','Tue','Wed','Thu','Fri'];
  const colors={Mon:'#1A4F7A',Tue:'#2E7D32',Wed:'#6B2FAA',Thu:'#D35400',Fri:'#C0392B'};
  let rows=Object.entries(DOW_DATA).map(([name,d])=>({name,...d}));
  if(fv) rows=rows.filter(r=>(r[fv]||0)>=2).sort((a,b)=>(b[fv]||0)-(a[fv]||0));
  else rows=rows.filter(r=>r.total>=2).sort((a,b)=>b.total-a.total);
  const tbody=document.getElementById('dow-tbody');
  if(!tbody) return;
  tbody.innerHTML=rows.slice(0,50).map(r=>{
    const maxDay=days.reduce((a,b)=>(r[a]||0)>(r[b]||0)?a:b);
    const mc=r[maxDay]||0;
    const pat=mc>=5?'Always misses '+maxDay+'s':mc>=3?'Often misses '+maxDay+'s':'Spread evenly';
    const dc=d=>{const n=r[d]||0;const bg=n>=5?colors[d]:n>=3?colors[d]+'88':n>=1?colors[d]+'33':'#EAECF0';const c=n>=3?'white':n>=1?colors[d]:'#aaa';return`<td style="text-align:center"><div style="display:inline-flex;align-items:center;justify-content:center;width:36px;height:24px;border-radius:5px;font-size:11px;font-weight:700;background:${bg};color:${c}">${n||'—'}</div></td>`;};
    return`<tr><td><strong>${r.name}</strong></td><td style="font-size:12px">${r.form||'—'}</td><td style="text-align:center;font-weight:700">${r.total||0}</td>${days.map(dc).join('')}<td style="font-size:12px">${pat}</td></tr>`;
  }).join('')||'<tr><td colspan="9" style="text-align:center;padding:20px;color:var(--muted)">No students match</td></tr>';
  if(dayFilter && !dayFilter._w){ dayFilter._w=1; dayFilter.onchange=renderDowTable; }
}


// ══════════════════════════════════════════════════════════
// DAY OF WEEK ANALYSIS
// ══════════════════════════════════════════════════════════

let DOW_FILE = null;

async function runDayAnalysis() {
  const fi = document.getElementById('dow-file');
  if (!fi || !fi.files || !fi.files.length) {
    alert('Please choose a file first');
    return;
  }
  const file = fi.files[0];
  
  const fd = new FormData();
  fd.append('file', file);
  fd.append('upload_id', UPLOAD.id || '');
  fd.append('period', DOW_PERIOD || 'term');
  
  // Show loading state
  const btn = document.getElementById('dow-analyse-btn');
  if(btn) { btn.textContent = 'Parsing… please wait'; btn.disabled = true; }
  toast('Parsing ' + file.name + '… please wait');
  
  try {
    const res = await fetch('/api/upload/absentee', { method: 'POST', body: fd });
    if(!res.ok) {
      const txt = await res.text();
      alert('Server returned error ' + res.status + ': ' + txt.substring(0,200));
      if(btn){ btn.textContent='Analyse Day of Week Patterns'; btn.disabled=false; }
      return;
    }
    const data = await res.json();
    if (!data.success) {
      alert('Parse failed: ' + (data.error || 'Unknown error'));
      if(btn){ btn.textContent='Analyse Day of Week Patterns'; btn.disabled=false; }
      return;
    }
    
    DOW_DATA = data.data;
    const days = ['Mon','Tue','Wed','Thu','Fri'];
    const dayTotals = {};
    days.forEach(d => { dayTotals[d] = Object.values(DOW_DATA).reduce((sum,s) => sum+(s[d]||0), 0); });
    const worstDay = days.reduce((a,b) => dayTotals[a]>dayTotals[b]?a:b);
    
    renderDowResults(dayTotals, worstDay, Object.keys(DOW_DATA).length);
    document.getElementById('dow-results').style.display = 'block';
    toast('Parsed ' + data.students + ' students! Friday: ' + dayTotals["Fri"] + ' absences');
    if(btn){ btn.textContent='Analysis Complete — Upload Again'; btn.disabled=false; }
  } catch(e) {
    alert('Network error: ' + e.message + '\n\nCheck that the server is running.');
    if(btn){ btn.textContent='Analyse Day of Week Patterns'; btn.disabled=false; }
  }
} // 'term' or 'week'

function selectDowPeriod(type) {
  DOW_PERIOD = type;
  const termEl = document.getElementById('dow-opt-term');
  const weekEl = document.getElementById('dow-opt-week');
  const noteEl = document.getElementById('dow-period-note');
  if (!termEl || !weekEl) return;
  if (type === 'term') {
    termEl.style.border = '2px solid var(--school-green)';
    termEl.style.background = 'var(--green-bg)';
    termEl.style.opacity = '1';
    weekEl.style.border = '2px solid var(--border)';
    weekEl.style.background = 'white';
    weekEl.style.opacity = '0.6';
    if(noteEl){noteEl.style.color='var(--school-green)';noteEl.style.background='var(--green-bg)';noteEl.innerHTML='📆 <strong>Whole Term mode:</strong> This will replace your current day analysis with the full term data.';}
  } else {
    weekEl.style.border = '2px solid var(--blue)';
    weekEl.style.background = 'var(--blue-bg)';
    weekEl.style.opacity = '1';
    termEl.style.border = '2px solid var(--border)';
    termEl.style.background = 'white';
    termEl.style.opacity = '0.6';
    if(noteEl){noteEl.style.color='var(--blue)';noteEl.style.background='var(--blue-bg)';noteEl.innerHTML="<strong>Weekly mode:</strong> This week's absences will be <strong>added</strong> to your existing analysis.";}
  }
}

function dowFileSelected(input) {
  DOW_FILE = input.files[0];
  if (DOW_FILE) {
    document.getElementById('dow-selected').textContent = DOW_FILE.name;
  }
}

// Drag and drop
// Set up drag-drop for day analysis upload (called when tab opens)
function initDowDragDrop() {
  const dz = document.getElementById('dow-drop');
  if (!dz || dz._ddInit) return;
  dz._ddInit = true;
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.style.borderColor = 'var(--blue)'; });
  dz.addEventListener('dragleave', () => { dz.style.borderColor = 'var(--border)'; });
  dz.addEventListener('drop', e => {
    e.preventDefault();
    dz.style.borderColor = 'var(--border)';
    DOW_FILE = e.dataTransfer.files[0];
    if (DOW_FILE) document.getElementById('dow-selected').textContent = DOW_FILE.name;
  });
}

async function uploadAbsentee() {
  if (!DOW_FILE) { toast('⚠️ Please select the Individual Absentee Report first'); return; }

  toast('Parsing file… please wait');

  const fd = new FormData();
  fd.append('file', DOW_FILE);
  fd.append('upload_id', UPLOAD.id || '');
  fd.append('period', DOW_PERIOD);

  // If weekly mode and we already have data — send existing data to merge on server
  if (DOW_PERIOD === 'week' && DOW_DATA) {
    fd.append('existing_data', JSON.stringify(DOW_DATA));
  }

  try {
    const res = await fetch('/api/upload/absentee', { method: 'POST', body: fd });
    const data = await res.json();
    if (!data.success) { toast('❌ ' + (data.error || 'Could not parse file')); return; }

    DOW_DATA = data.data;

    // Recalculate day totals from merged data
    const days = ['Mon','Tue','Wed','Thu','Fri'];
    const dayTotals = {};
    days.forEach(d => {
      dayTotals[d] = Object.values(DOW_DATA).reduce((sum, s) => sum + (s[d] || 0), 0);
    });
    const worstDay = days.reduce((a,b) => dayTotals[a] > dayTotals[b] ? a : b);

    renderDowResults(dayTotals, worstDay, Object.keys(DOW_DATA).length);
    document.getElementById('dow-results').style.display = 'block';

    const modeMsg = DOW_PERIOD === 'week' ? 'Week added to analysis!' : 'Term analysis complete!';
    toast(`${modeMsg} ${Object.keys(DOW_DATA).length} students`);
  } catch(e) {
    toast('❌ Upload failed: ' + e.message);
  }
}

function renderDowResults(dayTotals, worstDay, studentCount) {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  const dayFull = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday' };
  const colors = { Mon: '#1A4F7A', Tue: '#2E7D32', Wed: '#6B2FAA', Thu: '#D35400', Fri: '#C0392B' };
  const max = Math.max(...days.map(d => dayTotals[d] || 0));

  // Bar chart
  if (dowChart) dowChart.destroy();
  dowChart = new Chart(document.getElementById('dow-bar'), {
    type: 'bar',
    data: {
      labels: days.map(d => dayFull[d]),
      datasets: [{
        label: 'Absent Sessions',
        data: days.map(d => dayTotals[d] || 0),
        backgroundColor: days.map(d => colors[d] + (d === worstDay ? 'FF' : 'AA')),
        borderRadius: 6,
        borderSkipped: false,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { family: 'Inter', size: 13, weight: '600' } } },
        y: { beginAtZero: true, grid: { color: '#F0F2F5' }, ticks: { font: { size: 11 } } }
      }
    }
  });

  // Key findings
  const sorted = days.slice().sort((a, b) => (dayTotals[b] || 0) - (dayTotals[a] || 0));
  const worst = sorted[0];
  const best = sorted[sorted.length - 1];
  const friMon = ((dayTotals['Fri'] || 0) + (dayTotals['Mon'] || 0));
  const midweek = ((dayTotals['Tue'] || 0) + (dayTotals['Wed'] || 0) + (dayTotals['Thu'] || 0));

  // Count students who consistently miss Fridays (3+ times)
  const friFans = Object.values(DOW_DATA || {}).filter(s => (s.Fri || 0) >= 3).length;
  const monFans = Object.values(DOW_DATA || {}).filter(s => (s.Mon || 0) >= 3).length;

  document.getElementById('dow-findings').innerHTML = `
    <div style="padding:12px;background:var(--red-bg);border-radius:9px;border-left:4px solid var(--red);">
      <strong>${dayFull[worst]}</strong> is the worst day — <strong>${dayTotals[worst]} absent sessions</strong> this term
    </div>
    <div style="padding:12px;background:var(--green-bg);border-radius:9px;border-left:4px solid var(--green);">
      <strong>${dayFull[best]}</strong> is the best day — only <strong>${dayTotals[best]} absent sessions</strong>
    </div>
    <div style="padding:12px;background:var(--amber-bg);border-radius:9px;border-left:4px solid var(--amber);">
      ⚠️ <strong>${friFans} students</strong> missed Friday 3 or more times — long weekend pattern?
    </div>
    <div style="padding:12px;background:var(--blue-bg);border-radius:9px;border-left:4px solid var(--blue);">
      <strong>${monFans} students</strong> missed Monday 3 or more times — weekend recovery pattern?
    </div>
    <div style="padding:12px;background:#F3E5F5;border-radius:9px;border-left:4px solid #6B2FAA;">
      Friday+Monday absences = <strong>${friMon}</strong> vs mid-week = <strong>${midweek}</strong>
      ${friMon > midweek ? ' — <strong>start/end of week problem</strong>' : ' — fairly spread across week'}
    </div>`;

  renderDowTable();
}

function renderDowTable() {
  if (!DOW_DATA) return;
  const dayFilter = document.getElementById('dow-day-filter').value;
  const minFilter = parseInt(document.getElementById('dow-min-filter').value) || 2;
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  const colors = { Mon: '#1A4F7A', Tue: '#2E7D32', Wed: '#6B2FAA', Thu: '#D35400', Fri: '#C0392B' };

  let rows = Object.entries(DOW_DATA).map(([name, d]) => ({ name, ...d }));

  // Filter by selected day
  if (dayFilter) {
    rows = rows.filter(r => (r[dayFilter] || 0) >= minFilter);
    rows.sort((a, b) => (b[dayFilter] || 0) - (a[dayFilter] || 0));
  } else {
    rows = rows.filter(r => r.total >= 2);
    rows.sort((a, b) => b.total - a.total);
  }

  document.getElementById('dow-tbody').innerHTML = rows.slice(0, 50).map(r => {
    // Detect pattern — which day is highest
    const maxDay = days.reduce((a, b) => (r[a] || 0) > (r[b] || 0) ? a : b);
    const maxCount = r[maxDay] || 0;
    const pattern = maxCount >= 5 ? `Always misses ${maxDay}s` :
                    maxCount >= 3 ? `Often misses ${maxDay}s` :
                    maxCount >= 2 ? `Sometimes misses ${maxDay}s` : 'Spread evenly';

    const dayCell = (d) => {
      const n = r[d] || 0;
      const bg = n >= 5 ? colors[d] : n >= 3 ? colors[d] + '88' : n >= 1 ? colors[d] + '44' : '#EAECF0';
      const col = n >= 3 ? 'white' : n >= 1 ? colors[d] : '#aaa';
      return `<td style="text-align:center;"><div class="dow-day-pill" style="background:${bg};color:${col};">${n || '—'}</div></td>`;
    };

    return `<tr>
      <td><strong>${r.name}</strong></td>
      <td style="font-size:12px">${r.form || '—'}</td>
      <td style="font-weight:700;text-align:center;">${r.total || 0}</td>
      ${days.map(dayCell).join('')}
      <td style="font-size:12px;">${pattern}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="9" style="text-align:center;padding:20px;color:var(--muted);">No students match this filter</td></tr>';
}


// ══ TABS & NAVIGATION (sidebar) ══
// Sidebar tab navigation
document.querySelectorAll('.sidebar-tab-link').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    const layerId = link.dataset.layer;
    const tab = document.querySelector(`.layer-tab[onclick*="'${layerId}'"]`);
    showLayer(layerId, tab);
    document.querySelectorAll('.sidebar-tab-link').forEach(l => l.classList.remove('active'));
    link.classList.add('active');
  });
});
