import { climbAt } from './climb.ts';

/** The climb's drawing in the browser (SPEC-VISTA-ESCALADA §8): plain JS, shared by the Observatory and by an exported
    climb. It uses the page's helpers - el, button, metric, $, data, inspect, api, error, notify, fix, render, tab,
    snapshot, selected - which an export defines for itself; `climbStatic` says there is no server behind it. */
export const CLIMB_JS = String.raw`/* The climb (SPEC-VISTA-ESCALADA): each researcher a climber, the world's metric its mountain, improving going up.
   One panel per group of comparable runs and per metric, never two mountains on one axis; the axis as the server oriented
   it, its labels the metric's real values. Paths are what each climber's verdicts said, the crest the best of the group up
   to each moment, a star where the protocol accepted, a shaded band where a climber did not improve; the climber's icon
   says what it was doing. Ropes join climbers where a delivery is in the record, at the moment it was delivered - that
   something arrived, never that it influenced; events are bands in time, by where they came from. A replay is the climb
   at an instant by the server's own function (climbAt), so it shows what a cut there holds. */
let climbCache=null,climbBusy=false,climbWanted=null,replayT=null,replayTimer=null,replaySpeed='20s';const climbOpen=new Set();
const STATE_GLYPH={'observa':'o','actúa':'A','espera':'…','delega':'⑂','propone':'P','comprueba':'✓','cierra ronda':'■','parado':'✕'};
const ROPE={message:['mensaje','#1f7a8c'],material:['material','#7a5bb5'],board:['tablón','#b5862a'],directive:['directiva del senior','#c0392b'],advice:['consejo de la política','#8e44ad'],branch_opened:['abre una rama','#6b7f7a'],branch_result:['resultado de una rama','#2a6fb5'],adoption:['adopta un candidato','#2a9d6f'],announcement:['anuncio del operador','#c0392b']};
const ORIGIN={world:['mundo','#3f8f7a'],operator:['operador','#c0392b'],harness:['arnés','#6b7f7a']};
const reducedMotion=()=>window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
function who(x,g){const c=g.climbers.find(c=>c.id===x);if(c)return c.label;return x==='senior'?'senior':x==='research-policy'?'política de investigación':x==='operator'?'operador':x.startsWith('branch:')?'rama '+x.slice(7):x.startsWith('evolve')?'búsqueda evolutiva':x}
function hue(id){let h=2166136261;for(let i=0;i<id.length;i++){h^=id.charCodeAt(i);h=Math.imul(h,16777619)>>>0}return h%360}
const climberColor=id=>'hsl('+hue(id)+' 60% 42%)';
function span(s){s=Math.max(0,Math.round(s));const h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;return h?h+'h '+String(m).padStart(2,'0')+'m':m?m+'m '+String(x).padStart(2,'0')+'s':x+'s'}
function climbNum(m,v){return m.unit==='proporción'?(Math.round(v*1000)/10)+' %':String(Number(v.toPrecision(3)))}
function climbValue(m,v){if(v===null||v===undefined)return 'desconocido';return climbNum(m,v)+(m.unit==='proporción'?'':' '+m.unit)}
function climbElev(axis,v){const f=axis.scale==='log'?Math.log:(x=>x);const d=f(axis.top)-f(axis.bottom);return d===0?0:(f(v)-f(axis.bottom))/d}
function axisValue(axis,e){if(axis.scale==='log')return Math.exp(Math.log(axis.bottom)+e*(Math.log(axis.top)-Math.log(axis.bottom)));return axis.bottom+e*(axis.top-axis.bottom)}
async function openRef(ref,entity,extra){if(String(ref).startsWith('world:'))return inspect({type:'registro del mundo',entity:'mundo vivo',id:ref,at:null,data:extra||{}});const local=data().events.find(e=>e.id===ref);if(local)return inspect(local);const e=snapshot?await api('snapshots/'+snapshot.id+'/event?id='+encodeURIComponent(ref)):await api('climb-event?entity='+encodeURIComponent(entity)+'&ref='+encodeURIComponent(ref)+'&profile='+$('profile').value);return inspect(e,snapshot?.id)}
/* Drawn at once from the last reading; a new one is read in the background, one at a time, and drawn when it changed. */
function drawClimb(v){const still=!!window.CLIMB_STATIC;const q=still?'':snapshot?'snapshot='+snapshot.id+'&profile='+snapshot.profile:'entities='+encodeURIComponent(JSON.stringify([...selected]))+'&profile='+$('profile').value;
const c=climbCache&&climbCache.q===q?climbCache.v:null;
climbWanted=q;
/* When a reading ends and what is wanted changed meanwhile (another selection, a cut fixed), the next one is asked at once. */
if(!still&&!climbBusy){climbBusy=true;const since=c?'&since='+c.cursor:'';api('climb?'+q+since).then(r=>{climbBusy=false;if(!r.unchanged){climbCache={q,v:r};if(replayT!==null&&replayT>r.clock)replayT=null}if(tab==='climb'&&(!r.unchanged||climbWanted!==q))render()}).catch(e=>{climbBusy=false;if(tab==='climb'){error(e);if(climbWanted!==q)render()}})}
const bar=el('div',undefined,'row toolbar replay');v.append(bar);const box=el('div');box.id='climbContent';v.append(box);
if(!c){box.append(el('p','Leyendo los registros…','muted'));return}
const play=button(replayTimer?'Pausa':'Reproducir',()=>{replayTimer?stopReplay():startReplay()});
const speed=el('select');speed.setAttribute('aria-label','Velocidad');for(const [k,t] of [['1','1×'],['10','10×'],['60','60×'],['600','600×'],['20s','toda en 20 s']]){const o=el('option',t);o.value=k;speed.append(o)}speed.value=replaySpeed;speed.onchange=()=>{replaySpeed=speed.value};
const range=el('input');range.type='range';range.id='replayRange';range.min='0';range.max=String(Math.max(1,Math.ceil(c.clock)));range.step='1';range.value=String(replayT===null?c.clock:replayT);range.setAttribute('aria-label','Instante de la reproducción');range.oninput=()=>{stopReplay();replayT=Math.min(c.clock,Number(range.value));if(replayT>=c.clock)replayT=null;paintClimb()};
const label=el('span',undefined,'time');label.id='replayLabel';
bar.append(play,button('◀',()=>stepReplay(-1)),button('▶',()=>stepReplay(1)),range,label,speed,button(still?'Final':'En vivo',()=>{stopReplay();replayT=null;paintClimb()}));
if(!still)bar.append(button('Fijar corte aquí',fixAt),button('Exportar escalada',()=>window.open('/api/research/climb-export?'+q,'_blank','noopener')));
bar.append(button('SVG del instante',downloadSvg));
paintClimb()}
function climbTimes(c){const ts=new Set();for(const g of c.groups){for(const x of g.climbers){for(const s of x.samples)ts.add(s.t);ts.add(x.joined_at)}for(const r of g.ropes)ts.add(r.t);for(const e of g.events)ts.add(e.t)}return [...ts].sort((a,b)=>a-b)}
function stepReplay(d){stopReplay();const c=climbCache?.v;if(!c)return;const now=replayT===null?c.clock:replayT,ts=climbTimes(c);const next=d>0?ts.find(t=>t>now):[...ts].reverse().find(t=>t<now);replayT=next===undefined?(d>0?null:0):next;if(replayT!==null&&replayT>=c.clock)replayT=null;paintClimb()}
function startReplay(){const c=climbCache?.v;if(!c)return;if(replayT===null)replayT=0;let last=performance.now();
replayTimer=setInterval(()=>{const now=performance.now(),dt=(now-last)/1000;last=now;if(reducedMotion()){const ts=climbTimes(c),n=ts.find(t=>t>replayT);replayT=n===undefined?c.clock:n}else replayT+=dt*(replaySpeed==='20s'?c.clock/20:Number(replaySpeed));if(replayT>=c.clock){replayT=null;stopReplay()}paintClimb()},reducedMotion()?700:100);paintClimb()}
function stopReplay(){if(replayTimer){clearInterval(replayTimer);replayTimer=null}}
/* A replay's instant as a cut of the Observatory: how many events of each climber had been written by then. */
async function fixAt(){const c=climbCache?.v;if(!c)throw Error('Sin escalada leída');const T=replayT===null?c.clock:replayT,positions={},ids=[];for(const g of c.groups)for(const x of g.climbers){ids.push(x.id);positions[x.id]=x.positions.filter(p=>p[0]<=T).reduce((n,p)=>Math.max(n,p[1]),0)}stopReplay();replayT=null;snapshot=await api('snapshots',{entities:ids,profile:c.profile,positions});await fix();render();notify('Corte fijado en '+span(T)+' de investigación.')}
function paintClimb(){const box=$('climbContent');if(!box||!climbCache)return;const full=climbCache.v,c=replayT===null?full:climbAt(full,replayT),T=replayT===null?full.clock:replayT;
const play=document.querySelector('.replay button');if(play)play.textContent=replayTimer?'Pausa':'Reproducir';if($('replayRange'))$('replayRange').value=String(T);if($('replayLabel'))$('replayLabel').textContent=(replayT===null?(window.CLIMB_STATIC?'final · ':snapshot?'corte · ':'en vivo · '):'reproducción · ')+span(T)+' de '+span(full.clock);
box.replaceChildren();for(const n of c.notes||[])box.append(el('p',n,'notice'));
if(!c.groups.length){box.append(el('div','Ningún run seleccionado: sólo los investigadores del mundo escalan.','empty'));return}
full.groups.forEach((g,i)=>climbGroup(box,c,c.groups[i]||{...g,climbers:[],ropes:[],events:[],metrics:g.metrics.map(m=>({...m,crest:[],summit:null}))},g,T))}
function climbGroup(box,c,g,full,T){const card=el('section',undefined,'rounds climb');const k=g.key;card.append(el('h3',(k.condition||'Sin condición declarada')));
card.append(el('small',k.world+' · código '+(k.code_version||'no registrado')+' · generador '+k.generator+(k.world_condition?' · mundo '+k.world_condition+(k.adapted?' · adaptado':''):'')));
const t0=Math.min(...full.climbers.map(x=>x.joined_at)),t1=Math.max(t0+1,...full.climbers.flatMap(x=>[x.joined_at,...x.samples.map(s=>s.t),...x.states.map(s=>s.t)]));
/* Header: the group's summit on each metric, its research clock, a bar of resources per climber. */
const head=el('div',undefined,'metrics');for(const m of g.metrics.filter(m=>m.summit))head.append(metric('Cumbre · '+m.label,climbValue(m,m.summit.value)));head.append(metric('Reloj de investigación',span(Math.max(0,Math.min(T,t1)-t0))));card.append(head);
const bars=el('div',undefined,'climbbars');for(const x of g.climbers){const row=el('div',undefined,'climbbar');const st=x.states[x.states.length-1];const name=el('span',x.label+(x.kind==='branch'?' (rama)':'')+(st?' · '+st.state:''));name.style.color=climberColor(x.id);row.append(name);const u=x.budget.tokens_used,l=x.budget.tokens_limit;const track=el('span',undefined,'track');const fill=el('span',undefined,'fill');fill.style.background=climberColor(x.id);fill.style.width=(u!==null&&l?Math.min(100,u/l*100):0)+'%';track.append(fill);row.append(track,el('small',(u===null?'gasto desconocido'+(replayT!==null?' en este instante':''):u.toLocaleString()+' tokens')+' / '+(l===null?'límite desconocido':l.toLocaleString())));bars.append(row)}card.append(bars);
for(const m of g.metrics.filter(m=>m.axis))climbPanel(card,g,m,t0,t1,T);
const none=g.metrics.filter(m=>!m.axis);if(none.length)card.append(el('p','Sin muestras en este grupo: '+none.map(m=>m.label).join(' · ')+'.','muted'));
const untimed=g.climbers.reduce((n,x)=>n+x.untimed,0);if(untimed)card.append(el('p',untimed+' veredictos sin hora registrada: no se colocan en el eje.','muted'));
climbStrip(card,g,t0,t1);
const lg=el('div',undefined,'legend');const sw=(color,t)=>{const s=el('span');const b=el('span',undefined,'sw');b.style.background=color;s.append(b,document.createTextNode(t));return s};for(const k in ROPE)lg.append(sw(ROPE[k][1],ROPE[k][0]));lg.append(el('span','Estados: '+Object.entries(STATE_GLYPH).map(([s,gl])=>gl+' '+s).join(' · ')+' · anillo discontinuo: directiva reciente del senior · ★ aceptado · ○ validación o confirmación ciega'));card.append(lg);
const id=JSON.stringify(k),det=el('details');det.open=climbOpen.has(id);det.ontoggle=()=>{det.open?climbOpen.add(id):climbOpen.delete(id)};det.append(el('summary','Tablas accesibles: muestras, cuerdas y acontecimientos'));
const t=el('table'),hd=el('tr');for(const h of ['Escalador','Métrica','Tipo','Ronda','Tiempo','Valor','Evento'])hd.append(el('th',h));t.append(hd);
for(const x of g.climbers)for(const s of x.samples){const m=g.metrics.find(m=>m.id===s.metric),row=el('tr');for(const cell of [x.label,m.label,s.kind+(s.accepted?' · aceptado':''),s.round??'—',span(s.t-t0),climbValue(m,s.value)])row.append(el('td',String(cell)));const td=el('td');td.append(button('abrir',()=>openRef(s.ref,x.id),'ref'));row.append(td);t.append(row)}
const t2=el('table'),h2=el('tr');for(const h of ['Tiempo','Cuerda o acontecimiento','De','A','Detalle','Evento'])h2.append(el('th',h));t2.append(h2);
for(const r of g.ropes){const row=el('tr');for(const cell of [span(r.t-t0),ROPE[r.kind][0],who(r.from,g),who(r.to,g),r.label||''])row.append(el('td',cell));const td=el('td');td.append(button('abrir',()=>openRef(r.ref,r.to),'ref'));row.append(td);t2.append(row)}
for(const e of g.events){const row=el('tr');for(const cell of [span(e.t-t0),ORIGIN[e.origin][0]+': '+e.kind,e.origin,e.climber?who(e.climber,g):'todos',e.label])row.append(el('td',cell));const td=el('td');td.append(button('abrir',()=>openRef(e.ref,e.climber,e.data),'ref'));row.append(td);t2.append(row)}
det.append(t,el('h3','Cuerdas y acontecimientos'),t2);card.append(det);box.append(card)}
/* The events of a group in three lanes by where they came from: the world, the operator, the harness. */
function climbStrip(card,g,t0,t1){if(!g.events.length)return;const ns='http://www.w3.org/2000/svg',W=760,L=70,R=150,pw=W-L-R,H=3*18+8;const mk=(tag,attrs,text)=>{const n=document.createElementNS(ns,tag);for(const k in attrs)n.setAttribute(k,String(attrs[k]));if(text!==undefined)n.textContent=text;return n};
const svg=mk('svg',{viewBox:'0 0 '+W+' '+H,role:'img','aria-label':'Acontecimientos del mundo, del operador y del arnés; la tabla accesible tiene los mismos datos'});svg.style.width='100%';svg.style.maxWidth=W+'px';const X=t=>L+(t-t0)/(t1-t0)*pw;
['world','operator','harness'].forEach((o,i)=>{const y=12+i*18;svg.append(mk('text',{x:L-6,y:y+4,'text-anchor':'end',class:'chartlabel'},ORIGIN[o][0]),mk('line',{x1:L,x2:L+pw,y1:y,y2:y,style:'stroke:var(--border)'}));
for(const e of g.events.filter(e=>e.origin===o)){const d=mk(e.to!==undefined?'rect':'circle',e.to!==undefined?{x:X(e.t),y:y-4,width:Math.max(3,X(e.to)-X(e.t)),height:8,tabindex:0}:{cx:X(e.t),cy:y,r:4,tabindex:0});d.setAttribute('style','cursor:pointer;fill:'+ORIGIN[o][1]+';opacity:.85');d.append(mk('title',{},span(e.t-t0)+' · '+e.label+(e.climber?' · '+who(e.climber,g):'')));const open=()=>openRef(e.ref,e.climber,e.data).catch(error);d.addEventListener('click',open);d.addEventListener('keydown',ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();open()}});svg.append(d)}});
const wrap=el('div');wrap.append(el('h3','Acontecimientos'),svg);card.append(wrap)}
function climbPanel(card,g,m,t0,t1,T){const ns='http://www.w3.org/2000/svg',W=760,H=230,L=70,R=150,TOP=14,B=26,pw=W-L-R,ph=H-TOP-B;const mk=(tag,attrs,text)=>{const n=document.createElementNS(ns,tag);for(const k in attrs)n.setAttribute(k,String(attrs[k]));if(text!==undefined)n.textContent=text;return n};
const svg=mk('svg',{viewBox:'0 0 '+W+' '+H,role:'img','aria-label':m.label+': escalada de '+g.climbers.length+' escaladores; la tabla accesible tiene los mismos datos'});svg.style.width='100%';svg.style.maxWidth=W+'px';
const X=t=>L+(t-t0)/(t1-t0)*pw,Y=v=>TOP+(1-climbElev(m.axis,v))*ph;
const at=(id,t)=>{const x=g.climbers.find(c=>c.id===id);if(!x)return null;const s=x.samples.filter(s=>s.metric===m.id&&s.t<=t);return s.length?Y(s[s.length-1].value):TOP+ph};
for(let i=0;i<=4;i++){const e=i/4,y=TOP+(1-e)*ph;svg.append(mk('line',{x1:L,x2:L+pw,y1:y,y2:y,style:'stroke:var(--border)'}));svg.append(mk('text',{x:L-6,y:y+4,'text-anchor':'end',class:'chartlabel'},climbNum(m,axisValue(m.axis,e))))}
svg.append(mk('text',{x:L,y:H-6,class:'chartlabel'},'0'),mk('text',{x:L+pw,y:H-6,'text-anchor':'end',class:'chartlabel'},span(t1-t0)),mk('text',{x:L+pw/2,y:H-6,'text-anchor':'middle',class:'chartlabel'},m.direction==='lower'?'mejorar es bajar el valor: el eje está invertido':'tiempo de investigación'));
/* Events as faint bands under everything, then plateaus. */
for(const e of g.events)svg.append(mk('line',{x1:X(e.t),x2:X(e.t),y1:TOP,y2:TOP+ph,style:'stroke:'+ORIGIN[e.origin][1]+';stroke-dasharray:1 3;opacity:.45'}));
if(replayT!==null)svg.append(mk('line',{x1:X(T),x2:X(T),y1:TOP-6,y2:TOP+ph,style:'stroke:var(--ink);stroke-width:1.5;opacity:.6'}));
for(const x of g.climbers)for(const p of x.plateaus.filter(p=>p.metric===m.id)){const best=x.samples.find(s=>s.metric===m.id&&s.t===p.from);if(!best)continue;const r=mk('rect',{x:X(p.from),y:Y(best.value)-5,width:Math.max(2,X(p.to)-X(p.from)),height:10,rx:3,style:'fill:'+climberColor(x.id)+';opacity:.16'});r.append(mk('title',{},x.label+': meseta de '+p.samples+' veredictos sin mejorar ('+span(p.to-p.from)+')'));svg.append(r)}
const cr=m.crest;if(cr.length){let d='M'+X(cr[0].t)+' '+Y(cr[0].value);for(let i=1;i<cr.length;i++)d+=' H'+X(cr[i].t)+' V'+Y(cr[i].value);d+=' H'+X(Math.min(T,t1));svg.append(mk('path',{d,style:'fill:none;stroke:var(--ink);stroke-width:3;opacity:.35'}))}
for(const x of g.climbers){const ss=x.samples.filter(s=>s.metric===m.id).sort((a,b)=>a.t-b.t);const color=climberColor(x.id);
if(x.kind==='branch')svg.append(mk('line',{x1:X(x.joined_at),x2:X(x.joined_at),y1:TOP,y2:TOP+ph,style:'stroke:'+color+';stroke-dasharray:2 4;opacity:.6'}));
if(!ss.length)continue;let d='M'+X(ss[0].t)+' '+Y(ss[0].value);for(let i=1;i<ss.length;i++)d+=' H'+X(ss[i].t)+' V'+Y(ss[i].value);svg.append(mk('path',{d,style:'fill:none;stroke:'+color+';stroke-width:1.5'}));
for(const s of ss){const dot=mk('circle',{cx:X(s.t),cy:Y(s.value),r:s.kind==='check'||s.kind==='artifact'?3.5:2.5,tabindex:0,style:'cursor:pointer;fill:'+(s.kind==='validation'||s.kind==='blind'?'var(--surface)':color)+';stroke:'+color+';stroke-width:1.5'});dot.append(mk('title',{},x.label+' · '+s.kind+' · ronda '+(s.round??'—')+' · '+climbValue(m,s.value)+' · '+span(s.t-t0)));const open=()=>openRef(s.ref,x.id).catch(error);dot.addEventListener('click',open);dot.addEventListener('keydown',ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();open()}});svg.append(dot);
if(s.accepted)svg.append(mk('text',{x:X(s.t),y:Y(s.value)-7,'text-anchor':'middle','font-size':13,style:'fill:'+color},'★'))}}
/* Ropes, at the moment of delivery: from the sender's height then (or from the top, for who does not climb) to the receiver's. */
for(const r of g.ropes){const y1=at(r.to,r.t);if(y1===null)continue;const y0=at(r.from,r.t),color=ROPE[r.kind][1],x=X(r.t),top=y0===null;const line=mk('line',{x1:x,x2:x,y1:top?TOP:y0,y2:y1,style:'stroke:'+color+';stroke-width:1.5;opacity:.8'+(top?';stroke-dasharray:3 2':'')});const head=mk('path',{d:'M'+(x-4)+' '+(y1+(y1>(top?TOP:y0)?-7:7))+' L'+x+' '+y1+' L'+(x+4)+' '+(y1+(y1>(top?TOP:y0)?-7:7)),style:'fill:none;stroke:'+color+';stroke-width:1.5'});const hit=mk('g',{tabindex:0,style:'cursor:pointer'});hit.append(line,head,mk('title',{},ROPE[r.kind][0]+': '+who(r.from,g)+' → '+who(r.to,g)+' · '+span(r.t-t0)+(r.label?' · '+r.label:'')));if(top)hit.append(mk('text',{x,y:TOP-3,'text-anchor':'middle','font-size':9,style:'fill:'+color},r.kind==='directive'?'S':r.kind==='advice'?'P':r.kind==='announcement'?'Op':r.kind==='adoption'?'E':'⑂'));const open=()=>openRef(r.ref,r.to).catch(error);hit.addEventListener('click',open);hit.addEventListener('keydown',ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();open()}});svg.append(hit)}
/* Each climber where its last verdict left it, with what it was doing then, and its name: colour is never the only clue. */
for(const x of g.climbers){const ss=x.samples.filter(s=>s.metric===m.id);const color=climberColor(x.id),st=x.states[x.states.length-1];const last=ss[ss.length-1];const cx=last?X(last.t):X(x.joined_at),cy=last?Y(last.value):TOP+ph;
if(!last&&!st)continue;
const recent=g.ropes.some(r=>r.kind==='directive'&&r.to===x.id&&r.t<=T&&T-r.t<=(t1-t0)*0.03);if(recent)svg.append(mk('circle',{cx,cy,r:12,style:'fill:none;stroke:'+ROPE.directive[1]+';stroke-width:1.5;stroke-dasharray:3 2'}));
const icon=mk('g');icon.append(mk('circle',{cx,cy,r:8,style:'fill:'+color+';stroke:var(--surface);stroke-width:2'}),mk('text',{x:cx,y:cy+3.5,'text-anchor':'middle','font-size':9,style:'fill:#fff;font-weight:700'},st?STATE_GLYPH[st.state]||'·':'·'),mk('title',{},x.label+(st?' · '+st.state:'')));svg.append(icon);
svg.append(mk('text',{x:L+pw+8,y:cy+4,'font-size':11,style:'fill:'+color},x.label.split('/').pop().slice(0,20)+(x.kind==='branch'?' ↳':'')+(st?' · '+st.state:'')))}
const wrap=el('div');wrap.append(el('h3',m.label+' ('+m.unit+') · '+(m.direction==='higher'?'más alto es mejor':'más bajo es mejor')),svg);card.append(wrap)}
/* The panels at the instant shown, as one SVG file of their own (VE6): every colour the theme gave them resolved, every
   label's style written in, so that it reads the same outside this page. */
function downloadSvg(){const panels=[...document.querySelectorAll('#climbContent .climb')];if(!panels.length)throw Error('Nada que exportar');const ns='http://www.w3.org/2000/svg',W=760,root=getComputedStyle(document.documentElement);
const resolve=t=>String(t).replace(/var\((--[a-z]+)\)/g,(m,v)=>root.getPropertyValue(v).trim()||'#888');const out=document.createElementNS(ns,'svg');out.setAttribute('xmlns',ns);let y=0;const parts=[];
const text=(str,size,weight)=>{const n=document.createElementNS(ns,'text');n.setAttribute('x','8');n.setAttribute('y',String(y+size+4));n.setAttribute('style','font:'+(weight||400)+' '+size+'px system-ui,sans-serif;fill:'+resolve('var(--ink)'));n.textContent=str;parts.push(n);y+=size+10};
text('Escalada · '+($('replayLabel')?.textContent||''),15,600);
for(const card of panels){text(card.querySelector('h3')?.textContent||'',13,600);for(const wrap of card.querySelectorAll('svg')){const h=wrap.parentElement.querySelector('h3');if(h&&h!==card.querySelector('h3'))text(h.textContent,12,500);const vb=(wrap.getAttribute('viewBox')||'0 0 760 230').split(' ').map(Number);const g=wrap.cloneNode(true);g.removeAttribute('style');g.setAttribute('x','0');g.setAttribute('y',String(y));g.setAttribute('width',String(vb[2]));g.setAttribute('height',String(vb[3]));
for(const n of [g,...g.querySelectorAll('*')]){if(n.getAttribute('style'))n.setAttribute('style',resolve(n.getAttribute('style')));if(n.getAttribute('class')==='chartlabel')n.setAttribute('style','font:11px system-ui,sans-serif;fill:'+resolve('var(--muted)'));n.removeAttribute('tabindex')}parts.push(g);y+=vb[3]+8}}
const bg=document.createElementNS(ns,'rect');bg.setAttribute('width',String(W));bg.setAttribute('height',String(y));bg.setAttribute('fill',resolve('var(--surface)'));out.setAttribute('viewBox','0 0 '+W+' '+y);out.setAttribute('width',String(W));out.setAttribute('height',String(y));out.append(bg,...parts);
const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(out)],{type:'image/svg+xml'}));a.download='escalada.svg';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
/* The climb at an instant: the server's own function (console/climb.ts). */
const climbAt=${climbAt.toString()};
`;

/** A climb exported whole (SPEC-VISTA-ESCALADA §8, VE6): one HTML file with its data and the events it cites inside, that
    replays the climb with no server and nothing from outside - the Observatory's styles, the same drawing, an inspector
    of its own. `css`: the Observatory's stylesheet. */
export function exportClimb(view: { profile: string; origin: string | null; cursor: string }, events: readonly unknown[], css: string): string {
  const json = (v: unknown): string => JSON.stringify(v).replace(/</g, '\u003c').replace(/\u2028/g, '\u2028').replace(/\u2029/g, '\u2029');
  const page = [
    '<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Escalada exportada</title>',
    '<style>' + css + '.export{display:grid;grid-template-columns:minmax(0,1fr) 340px;min-height:calc(100vh - 80px)}.export main{padding:22px;min-width:0}@media(max-width:900px){.export{display:block}.export .inspector{border-left:0;border-top:1px solid var(--border)}}</style></head><body>',
    '<header><div><small>OBSERVATORIO · EXPORTACIÓN SIN SERVIDOR</small><h1>Escalada</h1></div><small id="about"></small></header>',
    '<div class="export"><main><div id="feedback" role="status"></div><div id="view"></div></main><aside class="inspector"><h2>Inspector</h2><div id="detail" class="muted">Pulsa una muestra, una cuerda o un acontecimiento para abrir su evento.</div></aside></div>',
    '<script>',
    "(()=>{'use strict';window.CLIMB_STATIC=true;",
    'const DATA=' + json(view) + ';const EVENTS=' + json(events) + ';',
    "const $=id=>document.getElementById(id);let tab='climb',snapshot=null;const selected=new Set();",
    "const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e};",
    "function error(e){$('feedback').replaceChildren(el('p',e.message||String(e),'notice error'))}function notify(t){$('feedback').replaceChildren(el('p',t,'notice'))}",
    "const button=(text,fn,cls)=>{const e=el('button',text,cls);e.onclick=()=>Promise.resolve().then(fn).catch(error);return e};",
    "function metric(label,value){const e=el('div',undefined,'metric');e.append(el('small',label),el('strong',String(value)));return e}",
    "const date=t=>t?new Date(t).toLocaleString():'Hora no registrada';const data=()=>({events:EVENTS});",
    "async function api(){throw Error('Exportación sin servidor: sólo lo que se exportó')}async function fix(){throw Error('Exportación sin servidor')}",
    "async function inspect(e){$('detail').replaceChildren(el('strong',e.type),el('p',e.entity+' · '+e.id),el('small',date(e.at)),el('pre',JSON.stringify(e.data,null,2)))}",
    "function render(){const v=$('view');v.replaceChildren();drawClimb(v)}",
    CLIMB_JS,
    "climbCache={q:'',v:DATA};$('about').textContent='Perfil '+DATA.profile+' · inicio '+date(DATA.origin)+' · '+DATA.cursor;render();",
    '})();',
    '</script></body></html>'
  ];
  return page.join('\n');
}
