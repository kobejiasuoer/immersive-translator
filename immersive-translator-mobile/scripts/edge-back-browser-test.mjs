import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium, devices } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out=process.env.UI_SHOTS_DIR;if(out)await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'});
const context=await browser.newContext({...devices['iPhone 13'],deviceScaleFactor:1,viewport:{width:390,height:844}});
const page=await context.newPage(),cdp=await context.newCDPSession(page),errors=[];page.on('pageerror',error=>errors.push(error.message));
const push=name=>page.locator(`.push[data-view="${name}"]:not(.tab-inactive)`);
const touch=(type,x=8,y=360)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'||type==='touchCancel'?[]:[{x,y,id:1,radiusX:1,radiusY:1}]});
const capture=async name=>{if(out)await page.screenshot({path:`${out}/${name}.png`})};
async function start(x=8,y=360){await touch('touchStart',x,y)}
async function move(x,y=360){await touch('touchMove',x,y);await page.waitForTimeout(30)}
async function release(){await page.waitForTimeout(120);await touch('touchEnd');await page.waitForTimeout(420)}
async function swipe(end=236,begin=8,y=360){await start(begin,y);for(let i=1;i<=8;i++)await move(begin+(end-begin)*i/8,y);await release()}
async function samePage(locator){assert.equal(await locator.isVisible(),true);await page.waitForFunction(()=>![...document.querySelectorAll('.edge-back-dragging,.edge-back-settling')].length)}
// The browser profile and repository are isolated to this acceptance run. Only the
// specific paused-task commit is delayed; all real IndexedDB writes still execute.
async function gatePracticeSave(){
 return page.evaluate(async()=>{
  const {getState,flushPersist,activeRepository}=await import('/src/store.ts');await flushPersist();
  const task=getState().tasks.find(t=>t.draft==='I enjoy a quiet morning.');if(!task)throw Error('Expected current practice draft');
  const repo=activeRepository(),commit=repo.commit.bind(repo);let release;const gate=new Promise(resolve=>{release=resolve});
  window.__edgeCommitGate={entered:false,release,restore:()=>{repo.commit=commit}};
  repo.commit=async input=>{
   if(!window.__edgeCommitGate.entered&&document.querySelector('[data-nav-back-pending]')&&input.state?.tasks?.some(t=>t.id===task.id&&t.status==='paused')){
    window.__edgeCommitGate.entered=true;await gate;
   }
   return commit(input);
  };
  return task.id;
 });
}
async function traceSurface(locator){
 await locator.evaluate(element=>{
  const frames=[];let frame=0,active=true;
  const tick=()=>{frames.push({at:performance.now(),connected:element.isConnected,x:element.isConnected?new DOMMatrixReadOnly(getComputedStyle(element).transform).m41:null});if(active&&element.isConnected)frame=requestAnimationFrame(tick)};
  tick();window.__edgeBackTrace={frames,stop:()=>{active=false;cancelAnimationFrame(frame);return frames}};
 });
}
async function releaseWhileSaving(locator){
 await start();for(let i=1;i<=8;i++)await move(8+(236-8)*i/8);await page.waitForTimeout(120);
 const releaseX=await locator.evaluate(element=>new DOMMatrixReadOnly(getComputedStyle(element).transform).m41);assert.ok(releaseX>200,'page follows the real touch before release');
 await traceSurface(locator);await touch('touchEnd');await page.waitForFunction(()=>window.__edgeCommitGate.entered);
 await page.waitForTimeout(600);
 assert.equal(await locator.isVisible(),true);assert.equal(await locator.locator('[data-nav-back-pending]').count(),1);
 const held=await page.evaluate(()=>window.__edgeBackTrace.frames.filter(frame=>frame.connected));
 assert.ok(held.length>5,'recorded multiple display frames during the delayed save');
 assert.ok(held.every(frame=>Math.abs(frame.x-releaseX)<2),`pending save must hold release position instead of rebounding: ${JSON.stringify(held.map(frame=>frame.x))}`);
 await capture('practice-edge-save-pending');return releaseX;
}
try{
 await page.goto(process.env.UI_BASE_URL||'http://127.0.0.1:5182');await page.getByRole('button',{name:'先体验一篇短文',exact:true}).click();await page.getByRole('button',{name:'开始读第一篇',exact:true}).click();
 await swipe();assert.equal(await page.locator('.push[data-push-id]').count(),0);console.log('PASS root learning page has no implicit back action');
 await page.locator('.pane.on').getByRole('button',{name:'开始阅读',exact:true}).click();const reader=push('reader');await reader.waitFor({state:'visible'});await page.waitForTimeout(400);const readerId=await reader.getAttribute('data-push-id');
 await start();await move(80);await release();await samePage(reader);assert.equal(await reader.getAttribute('data-push-id'),readerId);console.log('PASS a short real touch drag cancels and restores the reader');
 await start();await move(100);await move(210);await move(240);await move(165);await touch('touchEnd');await page.waitForTimeout(420);await samePage(reader);console.log('PASS reversing a real touch drag cancels the pending return');
 await swipe(290,60);await samePage(reader);console.log('PASS swiping article content away from the edge preserves reading');
 await start();await move(90);await move(180);assert.ok(await reader.evaluate(element=>Number(element.style.transform.match(/translate3d\(([-.\d]+)px/)?.[1]||0))>150);await capture('reader-edge-drag');await move(250);await release();await reader.waitFor({state:'detached'});await page.waitForTimeout(360);await capture('reader-edge-returned');
 assert.equal(await page.evaluate(async()=>{const{getState}=await import('/src/store.ts');return getState().readingArticleId}),null);console.log('PASS successful reader edge drag executes its stop/clear/back action');
 await page.getByRole('button',{name:'搜索学习内容',exact:true}).click();const search=push('learningSearch');await search.waitFor({state:'visible'});await page.waitForTimeout(400);await search.getByRole('searchbox',{name:'搜索学习内容',exact:true}).fill('break');await swipe();await search.waitFor({state:'detached'});console.log('PASS search returns by edge drag with its existing back action');
 await page.getByRole('button',{name:'导入阅读内容',exact:true}).click();const importer=push('learningImport');await importer.waitFor({state:'visible'});await importer.locator('#import-text').fill('The quiet morning helps me think. I take a short break and return to work.');await importer.getByRole('button',{name:'预览正文',exact:true}).click();await importer.getByRole('heading',{name:'确认正文',exact:true}).waitFor();await swipe();await importer.getByRole('heading',{name:'导入自己的内容',exact:true}).waitFor();assert.match(await importer.locator('#import-text').inputValue(),/quiet morning/);await samePage(importer);await swipe();await importer.waitFor({state:'detached'});console.log('PASS first import swipe exits only preview; second exits with its draft preserved');
 await page.locator('.glass-nav .tab').nth(1).click();await page.getByRole('button',{name:/寒暄/}).click();const practice=push('learningPractice');await practice.waitFor({state:'visible'});await page.getByRole('button',{name:'文字回答',exact:true}).click();await practice.locator('#practice-answer').fill('I enjoy a quiet morning.');await gatePracticeSave();
 const releaseX=await releaseWhileSaving(practice);
 await page.evaluate(()=>window.__edgeCommitGate.release());await practice.waitFor({state:'detached'});
 const finishing=await page.evaluate(()=>window.__edgeBackTrace.stop().filter(frame=>frame.connected));
 assert.ok(finishing.every(frame=>frame.x>=releaseX-2),'saved return must never jump back to zero before completing');
 assert.ok(finishing.some(frame=>frame.x>releaseX+20),'saved return continues sliding right from its held position');
 await page.evaluate(()=>window.__edgeCommitGate.restore());assert.equal(await page.getByRole('dialog',{name:'退出练习',exact:true}).count(),0);
 console.log('PASS delayed practice persistence holds the released page for 600ms, then continues outward without a rebound');
 const kept=await page.evaluate(async()=>{const{getState,flushPersist,activeRepository}=await import('/src/store.ts');await flushPersist();const task=getState().tasks.find(t=>t.draft==='I enjoy a quiet morning.');return {task,saved:(await activeRepository().loadSnapshot()).state.tasks.find(t=>t.id===task.id)};});
 assert.equal(kept.task.status,'paused');assert.equal(kept.saved.status,'paused');assert.equal(kept.saved.draft,'I enjoy a quiet morning.');await capture('practice-edge-returned');
 await page.getByRole('button',{name:/继续上次练习：/}).click();await practice.waitFor({state:'visible'});await practice.getByRole('button',{name:'文字回答',exact:true}).click();assert.equal(await practice.locator('#practice-answer').inputValue(),'I enjoy a quiet morning.');
 await practice.getByRole('button',{name:'返回',exact:true}).click();await practice.waitFor({state:'detached'});
 console.log('PASS practice swipe and back return directly; reopening restores the saved answer draft');
 await page.getByRole('button',{name:'查看全部',exact:true}).first().click();const history=page.getByRole('heading',{name:'练习记录',exact:true});await history.waitFor({state:'visible'});await swipe();await history.waitFor({state:'hidden'});console.log('PASS in-pane practice history returns without inventing a navigation entry');
 await page.getByRole('button',{name:/自由练习/}).click();const sheet=page.getByRole('dialog',{name:'创建我的场景',exact:true});await sheet.waitFor({state:'visible'});await swipe();await sheet.waitFor({state:'visible'});assert.equal(await page.locator('.push[data-push-id]').count(),0);await sheet.getByRole('button',{name:'关闭当前面板',exact:true}).click();console.log('PASS a modal sheet retains ownership of edge input');
 await page.locator('.glass-nav .tab').nth(0).click();await page.getByRole('button',{name:'搜索学习内容',exact:true}).click();await search.waitFor({state:'visible'});await page.emulateMedia({reducedMotion:'reduce'});await start();await move(180);assert.equal(await search.evaluate(element=>element.style.transform),'');await move(245);await release();await search.waitFor({state:'detached'});console.log('PASS Reduce Motion supports the same return without translating the page');
 assert.deepEqual(errors,[]);console.log('PASS: edge-back browser acceptance using real touch input');
}finally{await browser.close()}
