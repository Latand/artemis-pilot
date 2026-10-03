// Run after timing/physics tests: a paused browser clock keeps genuine toast()
// notifications alive while inspecting the actual app, even on slow CI renderers.
export async function verifyShipHudLayout(page, { check, out, frames, report }) {
 // Keep the capture harness's desktop viewport. The app enters fullscreen on
 // pointer input, so a late browser-window resize can fail before layout QA.
 // The exploration suite separately covers the original 1200x800 view. Here,
 // record and verify 1280x820 without changing any populated-HUD assertions.
 await page.clock.install({ time: new Date('2026-10-02T12:00:00Z') });
 await page.clock.pauseAt(new Date('2026-10-02T12:00:01Z'));
 const settle=()=>page.clock.runFor(350);
 report.hudLayouts=[];
 const inspect=async(name,enabled,count)=>{
  await settle();
  // Finish entry animations before reading bounds/opacity, and retain a frame
  // even when the following assertions expose a regression.
  await page.screenshot({animations:'disabled',path:`${out}/${name}.png`,timeout:180000});
  const layout=await page.evaluate(()=>{
   const read=e=>{
    const r=e.getBoundingClientRect();let opacity=1,visible=true;
    for(let a=e;a;a=a.parentElement){const s=getComputedStyle(a);opacity*=Number(s.opacity);visible&&=s.display!=='none'&&s.visibility==='visible';}
    return {id:e.id||e.className,text:e.textContent,visible:visible&&opacity>.4&&r.width>0&&r.height>0,
     inside:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,
     rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
   };
   const control=document.querySelector('#shipVisualControls button'),r=control.getBoundingClientRect();
   const hits=[[.5,.5],[.2,.5],[.8,.5]].map(([x,y])=>{
    const hit=document.elementFromPoint(r.left+r.width*x,r.top+r.height*y);return hit===control||control.contains(hit);
   });
   return {viewport:{width:innerWidth,height:innerHeight},control:read(control),note:read(document.getElementById('dWarpVisualNote')),
    mobileNote:read(document.getElementById('warpVisualNote')),hits,
    objectives:[...document.querySelectorAll('#objList li')].filter(e=>read(e).visible).length,
    obstacles:[...document.querySelectorAll('#objPanel,#bhPlacer,#toasts .toast,#navBall,#timeDock')].map(read).filter(e=>e.visible),
    toastCount:document.querySelectorAll('#toasts .toast').length,
    pressed:[...document.querySelectorAll('[data-warp-visual]')].map(e=>e.getAttribute('aria-pressed')),
    notesHidden:[...document.querySelectorAll('[data-warp-note]')].map(e=>e.hidden),
    parents:['shipVisualControls','dWarpVisualNote','toasts'].map(id=>document.getElementById(id).parentElement.id),
    positions:['shipVisualControls','dWarpVisualNote'].map(id=>getComputedStyle(document.getElementById(id)).position)};
  });
  report.hudLayouts.push({name,enabled,...layout});
  check(layout.viewport.width===1280&&layout.viewport.height===820,`${name}: actual desktop viewport remains 1280x820`);
  check(layout.toastCount===count&&layout.obstacles.filter(e=>e.id==='toast').length===count&&layout.objectives>0&&layout.obstacles.some(e=>e.id==='objPanel'),`${name}: populated objective panel and ${count} visible live notifications`);
  check(layout.control.visible&&layout.control.inside&&layout.hits.every(Boolean),`${name}: desktop control visible, in viewport and hit-testable at three points`);
  check(layout.note.visible===enabled&&!layout.mobileNote.visible&&(!enabled||layout.note.inside),`${name}: only the desktop speculative annotation appears when enabled`);
  check(layout.pressed.every(v=>v===String(enabled))&&layout.notesHidden.every(v=>v===!enabled),`${name}: both buttons and annotations share one opt-in state`);
  check(layout.parents.every(id=>id==='hudTR')&&layout.positions.every(p=>p==='static'),`${name}: desktop controls, annotation and toasts use normal HUD flow`);
  const separate=(a,b)=>a.right<=b.left||a.left>=b.right||a.bottom<=b.top||a.top>=b.bottom;
  const subjects=[layout.control,...(enabled?[layout.note]:[])];
  check(subjects.every(a=>layout.obstacles.every(b=>separate(a.rect,b.rect)))&&(!enabled||separate(layout.control.rect,layout.note.rect)),`${name}: control and annotation clear objectives, create panel, every toast, attitude and time dock`);
  return layout;
 };
 const notifications=async count=>{
  await page.evaluate(async count=>{
   document.getElementById('toasts').replaceChildren();
   // The real quicksave toast reproduces the reported exploration collision.
   await (await import('/src/saves.js')).saveState();
   const {toast}=await import('/src/achievements.js');
   if(count>1)toast('HYG destination focused · a long catalog destination name · 123.45 light years from the current ship position');
   if(count>2)toast('PILOT - you have the stick · use the flight controls to continue exploring the retained planetary system');
  },count);
 };
 const setEnabled=async enabled=>{
  if((await page.locator('#shipVisualControls button').getAttribute('aria-pressed'))!==String(enabled))await page.locator('#shipVisualControls button').click();
 };
 for(const objectives of ['full','reduced']){
  if(objectives==='reduced')await page.evaluate(async()=>{
   const {ACH,award}=await import('/src/achievements.js');for(const a of ACH.slice(0,-2))award(a.id);
  });
  let firstLayout;
  for(const enabled of [false,true]){
   await setEnabled(enabled);
   for(const count of [1,2,3]){
    await notifications(count);
    const layout=await inspect(`12-hud-${objectives}-${enabled?'on':'off'}-${count}-toasts`,enabled,count);
    firstLayout??=layout;
   }
  }
  if(objectives==='full')report.hudFullObjectiveHeight=firstLayout.obstacles.find(e=>e.id==='objPanel').rect.height;
  else check(firstLayout.objectives===2&&firstLayout.obstacles.find(e=>e.id==='objPanel').rect.height<report.hudFullObjectiveHeight,'Reduced objectives really shrink the live panel');
 }
 const hidden=async name=>check(await page.evaluate(()=>
  ['shipVisualControls','dWarpVisualNote','warpVisualNote'].every(id=>document.getElementById(id).getClientRects().length===0)),`${name}: both desktop and mobile warp overlays are hidden`);
 for(const mode of ['direct','observe']){
  await page.locator(`[data-ui-mode="${mode}"]`).click();await frames(2);await settle();
  await hidden(mode);
  if(mode==='direct')check(await page.locator('#bhPlacer').isVisible(),'Create panel is genuinely visible while warp overlays are hidden');
  await page.locator('[data-ui-mode="pilot"]').click();await frames(2);
  // Preserve the real mode-transition toasts; top up via the real producer.
  await page.evaluate(async()=>{const {toast}=await import('/src/achievements.js');while(document.querySelectorAll('#toasts .toast').length<3)toast('PILOT - you have the stick');});
  await inspect(`13-hud-pilot-after-${mode}`,true,3);
 }
 await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press('j');await frames(2);await hidden('Cabin');
 await page.keyboard.press('j');await frames(2);
 await page.evaluate(async()=>{(await import('/src/cinematic.js')).setCleanRender(true);});await hidden('Clean render');
 await page.evaluate(async()=>{(await import('/src/cinematic.js')).setCleanRender(false);});
 await notifications(3);await inspect('14-hud-returned-to-pilot',true,3);
}
