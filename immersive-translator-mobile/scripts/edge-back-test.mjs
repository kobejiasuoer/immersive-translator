import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const dir = await mkdtemp(join(tmpdir(), 'ita-edge-back-'));
const dom = new JSDOM('<div class="app"><div class="pane on"><h1>阅读</h1></div></div>', { url:'http://localhost', pretendToBeVisual:true });
const w=dom.window, frames=new Map(), captures=new Map(), preferenceListeners=new Set();
let rafId=0, clock=1000, reduced=false, checks=0, backs=0;
Object.assign(globalThis,{ window:w,document:w.document,Node:w.Node,Element:w.Element,HTMLElement:w.HTMLElement,HTMLButtonElement:w.HTMLButtonElement,MutationObserver:w.MutationObserver,getComputedStyle:w.getComputedStyle.bind(w) });
Object.defineProperty(w,'visualViewport',{value:{scale:1},configurable:true});
w.matchMedia=()=>({get matches(){return reduced},addEventListener(_n,fn){preferenceListeners.add(fn)},removeEventListener(_n,fn){preferenceListeners.delete(fn)}});
globalThis.requestAnimationFrame=fn=>{frames.set(++rafId,fn);return rafId}; globalThis.cancelAnimationFrame=id=>frames.delete(id);
w.HTMLElement.prototype.getBoundingClientRect=function(){const x=Number(this.style.transform.match(/translate3d\(([-.\d]+)px/)?.[1]||0);return {left:x,top:0,right:x+390,bottom:844,width:390,height:844}};
w.HTMLElement.prototype.setPointerCapture=function(id){captures.set(id,this)};
w.HTMLElement.prototype.hasPointerCapture=function(id){return captures.get(id)===this};
w.HTMLElement.prototype.releasePointerCapture=function(id){captures.delete(id)};
const app=document.querySelector('.app'), pane=document.querySelector('.pane');
let page=null,button=null,clean,lastPoint={x:8,y:200};
function setup(callback=()=>{page.classList.add('out');window.dispatchEvent(new w.Event('mobile-push-change'))}){
 clean?.();frames.clear();captures.clear();lastPoint={x:8,y:200};pane.removeAttribute('inert');app.querySelectorAll('.push,.sheet,.glass-nav').forEach(e=>e.remove());
 page=document.createElement('div');page.className='push in';page.dataset.pushId='1';page.innerHTML='<header><button aria-label="返回">返回</button></header><main><p id="prose">Readable English content.</p><input aria-label="query"><div role="tablist"><span id="segment">全部</span></div></main>';
 pane.setAttribute('inert','');app.append(page);button=page.querySelector('button');backs=0;button.onclick=()=>{backs++;callback()};clean=attach(app);return page;
}
function pointer(type,{x=lastPoint.x,y=lastPoint.y,id=1,target=page,button:btn=0,isPrimary=true,time=clock}={}){const event=new w.MouseEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:y,button:btn,detail:1});Object.defineProperties(event,{pointerId:{value:id},pointerType:{value:'mouse'},isPrimary:{value:isPrimary},timeStamp:{value:time}});lastPoint={x,y};target.dispatchEvent(event);return event;}
function touch(type,{x=lastPoint.x,y=lastPoint.y,id=1,target=page,time=clock,count=1}={}){const event=new w.Event(type,{bubbles:true,cancelable:true});const t={identifier:id,clientX:x,clientY:y};Object.defineProperties(event,{touches:{value:type==='touchend'?[]:count===1?[t]:[t,{identifier:2,clientX:20,clientY:200}]},changedTouches:{value:[t]},timeStamp:{value:time}});lastPoint={x,y};target.dispatchEvent(event);return event;}
async function frame(){clock+=16;const callbacks=[...frames.values()];frames.clear();callbacks.forEach(fn=>fn(clock));await Promise.resolve()}
async function settle(){for(let i=0;i<150&&frames.size;i++)await frame();assert.equal(frames.size,0,'motion settles and releases RAF');await Promise.resolve()}
const offset=()=>Number(page.style.transform.match(/translate3d\(([-.\d]+)px/)?.[1]||0);
const pass=label=>{checks++;console.log('PASS '+label)};
let attach;
try{
 const outfile=join(dir,'edge.mjs');await build({entryPoints:[fileURLToPath(new URL('../src/ui/edgeBack.ts',import.meta.url))],outfile,bundle:true,platform:'browser',format:'esm'});attach=(await import(pathToFileURL(outfile))).attachEdgeBack;
 setup();pointer('pointerdown');pointer('pointermove',{x:190,time:clock+400});assert.equal(offset(),182);assert.equal(captures.get(1),page);pointer('pointerup',{x:190,time:clock+550});await settle();assert.equal(backs,1);assert.equal(page.style.transform,'');assert.equal(captures.size,0);pass('left-edge drag follows the finger and invokes the actual back action once');
 setup();pointer('pointerdown');pointer('pointermove',{x:100,time:clock+400});pointer('pointerup',{time:clock+600});await settle();assert.equal(backs,0);assert.equal(offset(),0);pass('short slow drag springs back without navigation');
 setup();pointer('pointerdown');pointer('pointermove',{x:240,time:clock+400});pointer('pointermove',{x:250,time:clock+440});pointer('pointermove',{x:180,time:clock+490});pointer('pointerup',{time:clock+500});await settle();assert.equal(backs,0);pass('reversing direction cancels after a long outward drag');
 setup();pointer('pointerdown');pointer('pointermove',{x:250,time:clock+300});pointer('pointermove',{x:215,time:clock+600});pointer('pointerup',{time:clock+750});await settle();assert.equal(backs,0);pass('a slow reversal followed by a hold still cancels');
 setup();pointer('pointerdown');pointer('pointermove',{x:250,time:clock+300});pointer('pointerup',{x:180,time:clock+340});await settle();assert.equal(backs,0);pass('the final release position participates in direction cancellation');
 setup();pointer('pointerdown');pointer('pointermove',{x:78,time:clock+30});pointer('pointerup',{time:clock+35});await settle();assert.equal(backs,1);pass('a deliberate outward flick uses release velocity');
 setup();pointer('pointerdown',{x:60});pointer('pointermove',{x:290,time:clock+300});pointer('pointerup');await settle();assert.equal(backs,0);assert.equal(offset(),0);pass('gestures starting in the content never become back gestures');
 setup();pointer('pointerdown');const vertical=pointer('pointermove',{x:12,y:255});pointer('pointermove',{x:230,y:255});pointer('pointerup');await settle();assert.equal(vertical.defaultPrevented,false);assert.equal(backs,0);pass('vertical intent stays available to the native scroller');
 for(const selector of ['input','[role=tablist] span','button']){setup();pointer('pointerdown',{target:page.querySelector(selector)});pointer('pointermove',{x:260});pointer('pointerup');await settle();assert.equal(backs,0)}pass('inputs, buttons and switching controls do not initiate edge back');
 setup();const selection=w.getSelection(),range=document.createRange();range.selectNodeContents(page.querySelector('#prose'));selection.addRange(range);pointer('pointerdown');pointer('pointermove',{x:240});pointer('pointerup');await settle();assert.equal(backs,0);selection.removeAllRanges();pass('text selection is preserved');
 setup();pointer('pointerdown');pointer('pointermove',{x:170});pointer('pointercancel');await settle();assert.equal(backs,0);assert.equal(captures.size,0);pass('pointer cancellation restores the page and releases capture');
 setup();touch('touchstart');const event=touch('touchmove',{x:180,time:clock+300});assert.equal(event.defaultPrevented,true);assert.equal(offset(),172);touch('touchstart',{count:2});touch('touchend');await settle();assert.equal(backs,0);pass('touch drags claim only horizontal movement and additional fingers cancel');
 setup();touch('touchstart');touch('touchmove',{x:215,time:clock+300});touch('touchend',{time:clock+500});await settle();assert.equal(backs,1);pass('single-finger touch completion invokes back');
 setup(()=>{});pointer('pointerdown');pointer('pointermove',{x:210,time:clock+300});pointer('pointerup',{time:clock+500});await settle();assert.equal(backs,1);assert.equal(offset(),0);assert.ok(!page.classList.contains('out'));pass('a recording guard that declines navigation leaves the page in place');
 setup(()=>{const modal=document.createElement('div');modal.className='sheet on';modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');app.append(modal);page.setAttribute('inert','')});pointer('pointerdown');pointer('pointermove',{x:210,time:clock+300});pointer('pointerup',{time:clock+500});await settle();assert.equal(backs,1);assert.equal(offset(),0);assert.ok(!page.classList.contains('out'));pass('a draft confirmation is shown by the existing callback without dismissing its page');
 setup(()=>{page.querySelector('main').textContent='Editing import source'});pointer('pointerdown');pointer('pointermove',{x:210,time:clock+300});pointer('pointerup',{time:clock+500});await settle();assert.equal(backs,1);assert.equal(page.querySelector('main').textContent,'Editing import source');assert.equal(offset(),0);pass('a local preview back action changes the preview without popping the route');
 setup();const modal=document.createElement('div');modal.className='sheet on';modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');app.append(modal);pointer('pointerdown');pointer('pointermove',{x:210});pointer('pointerup');await settle();assert.equal(backs,0);pass('modal presentation blocks edge navigation even before an inert effect runs');
 setup();pointer('pointerdown');pointer('pointermove',{x:140});page.setAttribute('inert','');await Promise.resolve();await settle();assert.equal(offset(),0);assert.equal(backs,0);pass('owner deactivation or modal inert cancels an active drag');
 setup();pointer('pointerdown');pointer('pointermove',{x:100,time:clock+300});pointer('pointerup',{time:clock+500});await frame();const before=offset();pointer('pointerdown',{x:8});assert.equal(offset(),before);pointer('pointermove',{x:45,time:clock+50});assert.equal(offset(),before+37);pointer('pointercancel');await settle();pass('a settling page can be grabbed again from its presentation position');
 setup();reduced=true;preferenceListeners.forEach(fn=>fn());pointer('pointerdown');pointer('pointermove',{x:210,time:clock+300});assert.equal(offset(),0);pointer('pointerup',{time:clock+500});await settle();assert.equal(backs,1);reduced=false;preferenceListeners.forEach(fn=>fn());pass('Reduce Motion keeps the gesture but removes page travel and springs');
 const beginPending=()=>{pointer('pointerdown',{x:8,y:200});pointer('pointermove',{x:210,time:clock+300});pointer('pointerup',{time:clock+500})};
 const pending=()=>button.setAttribute('data-nav-back-pending','');
 setup(pending);beginPending();await frame();const held=offset();assert.equal(held,202);assert.equal(frames.size,0);assert(page.classList.contains('edge-back-pending'));
 for(let i=0;i<38;i++){await frame();assert.equal(offset(),held);assert.equal(frames.size,0)}
 assert.equal(backs,1);page.classList.add('out');await Promise.resolve();await frame();assert.ok(offset()>=held,'pending success continues toward the right');button.removeAttribute('data-nav-back-pending');await settle();assert.equal(backs,1);
 pass('an async back holds its released position for over 550ms without RAF work, then continues the real pop');
 setup(pending);beginPending();await frame();const beforeCommit=offset();button.removeAttribute('data-nav-back-pending');await Promise.resolve();assert.equal(offset(),beforeCommit);assert.equal(frames.size,1);
 page.classList.add('out');await Promise.resolve();await frame();assert.ok(offset()>=beforeCommit);await settle();assert.equal(backs,1);
 pass('removing pending gives React one frame to commit out without an intermediate rollback');
 setup(pending);beginPending();await frame();const beforeFailure=offset();button.removeAttribute('data-nav-back-pending');await Promise.resolve();assert.equal(offset(),beforeFailure);await frame();assert.equal(offset(),beforeFailure);await frame();assert.ok(offset()<beforeFailure);await settle();assert.equal(offset(),0);assert.equal(backs,1);
 pass('a failed or cancelled save rolls back only after its pending marker is cleared');
 setup(pending);beginPending();await frame();const beforeRepeat=offset();pointer('pointerdown',{x:8});pointer('pointermove',{x:280});pointer('pointerup');touch('touchstart',{x:8,count:2});touch('touchend');await frame();assert.equal(backs,1);assert.equal(offset(),beforeRepeat);assert.equal(frames.size,0);
 button.removeAttribute('data-nav-back-pending');await Promise.resolve();await settle();assert.equal(offset(),0);
 pass('repeated drags and additional fingers cannot invoke or cancel an already pending back');
 setup(pending);pending();pointer('pointerdown',{x:8});pointer('pointermove',{x:250});pointer('pointerup');await settle();assert.equal(backs,0);assert.equal(offset(),0);
 pass('an existing business back request also blocks new edge gestures');
 for(const cancelPending of [()=>page.setAttribute('inert',''),()=>page.setAttribute('hidden',''),()=>page.classList.add('tab-inactive'),()=>page.setAttribute('aria-hidden','true')]){
   setup(pending);beginPending();await frame();cancelPending();await Promise.resolve();assert.equal(offset(),0);assert.equal(frames.size,0);assert(!page.classList.contains('edge-back-pending'));button.removeAttribute('data-nav-back-pending');page.classList.add('out');await Promise.resolve();assert.equal(frames.size,0);assert.equal(backs,1);
 }
 pass('modal inert, hidden pages and inactive owners discard pending presentation safely');
 for(const event of ['mobile-profile-change','blur']){setup(pending);beginPending();await frame();window.dispatchEvent(new w.Event(event));assert.equal(offset(),0);assert.equal(frames.size,0);button.removeAttribute('data-nav-back-pending');await Promise.resolve();assert.equal(frames.size,0)}
 pass('profile changes and loss of focus clear pending presentation without replaying navigation');
 setup(pending);beginPending();await frame();button.remove();await Promise.resolve();assert.equal(offset(),0);assert.equal(frames.size,0);assert.equal(backs,1);
 pass('removing the originating back control releases pending presentation');
 setup(pending);beginPending();await frame();page.remove();await Promise.resolve();assert.equal(offset(),0);assert.equal(frames.size,0);assert(!page.classList.contains('edge-back-pending'));
 pass('unmounting a pending page releases its transforms and queued work');
 setup(pending);reduced=true;preferenceListeners.forEach(fn=>fn());beginPending();await frame();assert.equal(offset(),0);assert.equal(frames.size,0);assert.equal(backs,1);page.classList.add('out');await Promise.resolve();assert.equal(frames.size,0);assert.equal(offset(),0);reduced=false;preferenceListeners.forEach(fn=>fn());
 pass('Reduce Motion waits for async back and exits without travel or animation work');
 setup(pending);beginPending();await frame();reduced=true;preferenceListeners.forEach(fn=>fn());assert.equal(offset(),0);assert.equal(frames.size,0);pointer('pointerdown',{x:8});pointer('pointermove',{x:260});pointer('pointerup');assert.equal(backs,1);reduced=false;preferenceListeners.forEach(fn=>fn());
 pass('a motion preference change clears presentation while the business pending marker prevents replay');
 setup(pending);beginPending();await frame();clean();clean=null;button.removeAttribute('data-nav-back-pending');page.classList.add('out');await Promise.resolve();assert.equal(offset(),0);assert.equal(frames.size,0);assert.equal(preferenceListeners.size,0);
 pass('disposing the gesture controller while pending detaches observers and future completion cannot animate');
 setup();pointer('pointerdown');pointer('pointermove',{x:100});clean();clean=null;assert.equal(frames.size,0);assert.equal(captures.size,0);assert.equal(page.style.transform,'');assert.equal(preferenceListeners.size,0);pass('unmount cleanup removes motion, capture and preference listeners');
 console.log(`PASS: ${checks} edge-back interaction scenarios`);
}finally{clean?.();dom.window.close();await rm(dir,{recursive:true,force:true})}
