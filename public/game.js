const $ = id => document.getElementById(id);
let gameData = null;
let currentStage = null;
let currentIndex = 0;
let score = 0;
let attempts = [];
let stream = null;
let hands = null;
let raf = null;
let handPoint = null;
let fist = false;
let lastFistState = false;
let fistSince = 0;
let selectedCandidate = -1;
let fistProgress = 0;
let answerObjects = [];
  // สถานะการแสดงผลคำตอบของข้อปัจจุบัน: correct / wrong / null
let answerResultStates = new Map();
let lastFrame = performance.now();
let readyToCapture = false;
let hoverLostAt = 0; // เวลาที่จุดมือ "หลุด" ออกจากกล่องคำตอบล่าสุด (สำหรับกันสั่น)
let handsBusy = false; // กันไม่ให้ยิง hands.send() ซ้อนกันจนคิวค้าง
const HOVER_GRACE_MS = 220; // ยอมให้จุดมือหลุดออกจากกล่องได้ไม่เกินนี้ก่อนยกเลิกการเลือก

const canvas = $('arCanvas');
const ctx = canvas.getContext('2d');
const video = $('camera');

function showScreen(id){ document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active')); $(id).classList.add('active'); }
function showModal(id){ $(id).classList.remove('hidden'); }
function hideModal(id){ $(id).classList.add('hidden'); }
function setStatus(text){ $('statusPill').textContent=text; }
function escapeHtml(s){return String(s).replace(/[&<>\"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\\':'&#92;'}[m]));}

async function loadGame(){
  const r=await fetch('/api/game'); if(!r.ok) throw new Error('โหลดข้อมูลเกมไม่ได้');
  gameData=await r.json();
  $('siteName').textContent=gameData.site.name;
  $('siteSubtitle').textContent=gameData.site.subtitle;
  renderStages();
}
function renderStages(){
  $('stageCountLabel').textContent=`${gameData.stages.length} ด่าน • ด่านละ 10 ข้อ`;
  $('stageGrid').innerHTML=gameData.stages.map(s=>{
    const qs=gameData.questions.filter(q=>q.level===s.id).length;
    return `<button class="stage-card" data-stage="${s.id}">
      <div class="stage-number">STAGE ${String(s.id).padStart(2,'0')}</div>
      <div class="stage-title">${escapeHtml(s.title)}</div>
      <div class="stage-description">${escapeHtml(s.description)}</div>
      <div class="stage-meta">${qs} ข้อ • คะแนนเต็ม ${Math.min(10,qs)}</div>
    </button>`;
  }).join('');
  document.querySelectorAll('.stage-card').forEach(b=>b.addEventListener('click',()=>prepareStage(Number(b.dataset.stage))));
}
async function prepareStage(stageId){
  const stage=gameData.stages.find(s=>s.id===stageId); if(!stage) return;
  currentStage=stage; currentIndex=0; score=0; attempts=[];
  $('cameraError').textContent='';

  // ถ้ามี stream อยู่แล้ว แปลว่าสิทธิ์กล้องถูกใช้งานอยู่ ไม่ต้องเปิดหน้าต่าง/ขอสิทธิ์ซ้ำ
  if(stream && stream.getTracks().some(t=>t.readyState==='live')){
    showScreen('gameScreen');
    setStatus('AR กำลังทำงาน');
    return;
  }

  const permission = await getCameraPermissionState();
  if(permission === 'granted'){
    // เคยอนุญาตกล้องแล้ว -> เริ่มเกมทันที ไม่แสดง Camera Access modal
    startCamera();
  }else{
    // ยังไม่เคยอนุญาต หรือเบราว์เซอร์ไม่รองรับ Permissions API -> แสดงหน้าต่างขอเปิดกล้อง
    showModal('cameraModal');
    if(permission === 'denied'){
      $('cameraError').textContent='กล้องถูกปฏิเสธไว้ กรุณาอนุญาตการใช้กล้องจากการตั้งค่าเว็บไซต์ของเบราว์เซอร์';
    }
  }
}

async function getCameraPermissionState(){
  try{
    if(!navigator.permissions?.query) return 'prompt';
    const result = await navigator.permissions.query({name:'camera'});
    return result.state;
  }catch(_){
    // เบราว์เซอร์บางรุ่นไม่อนุญาตให้ query permission โดยตรง
    return 'prompt';
  }
}

async function startCamera(){
  $('cameraError').textContent='';
  try{
    if(stream && stream.getTracks().some(t=>t.readyState==='live')){
      hideModal('cameraModal');
      showScreen('gameScreen');
      setStatus('AR กำลังทำงาน');
      return;
    }
    if(!navigator.mediaDevices?.getUserMedia) throw new Error('เบราว์เซอร์นี้ไม่รองรับการเปิดกล้อง');
    // ลดความละเอียดกล้องจาก 1280x720 ลงมา — โมเดล MediaPipe ย่อภาพลงไปประมวลผลอยู่แล้วภายใน
    // ความละเอียดสูงกว่านี้ไม่ได้แม่นขึ้น แต่เพิ่มภาระถอดรหัส/คัดลอกเฟรมทุกครั้งโดยไม่จำเป็น
    stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user',width:{ideal:960},height:{ideal:540}},audio:false});
    video.srcObject=stream; await video.play();
    hideModal('cameraModal'); showScreen('gameScreen'); setStatus('AR กำลังทำงาน');
    await setupHands(); resizeCanvas(); loadQuestion(); startLoop();
  }catch(e){ $('cameraError').textContent=e.message||'ไม่สามารถเปิดกล้องได้'; }
}
async function waitForHandsLib(timeoutMs=8000){
  const step=200; let waited=0;
  while(!window.Hands && waited<timeoutMs){ await new Promise(r=>setTimeout(r,step)); waited+=step; }
  return !!window.Hands;
}
async function setupHands(){
  if(!window.Hands){
    const ok=await waitForHandsLib();
    if(!ok) throw new Error('ระบบตรวจจับมือโหลดไม่สำเร็จ กรุณาเชื่อมต่ออินเทอร์เน็ตแล้วรีโหลดหน้า');
  }
  hands=new Hands({locateFile:file=>`https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`});
  // modelComplexity:0 คือโมเดลรุ่นเบา ประมวลผลไวกว่ารุ่นเต็ม (1) มาก แลกกับความแม่นยำที่ลดลงเล็กน้อย
  // ซึ่งคุ้มมากสำหรับเกมเรียลไทม์บนคอมพิวเตอร์ห้องเรียนทั่วไปที่ไม่ได้แรงมาก
  hands.setOptions({maxNumHands:1,modelComplexity:0,minDetectionConfidence:.62,minTrackingConfidence:.62});
  hands.onResults(onHandResults);
}
function resizeCanvas(){
  const dpr=Math.min(2,window.devicePixelRatio||1), rect=canvas.getBoundingClientRect();
  canvas.width=Math.max(1,Math.floor(rect.width*dpr)); canvas.height=Math.max(1,Math.floor(rect.height*dpr));
  ctx.setTransform(dpr,0,0,dpr,0,0);
}
window.addEventListener('resize',resizeCanvas);
window.addEventListener('orientationchange',()=>setTimeout(resizeCanvas,120));
if(window.visualViewport) window.visualViewport.addEventListener('resize',resizeCanvas);

function currentQuestion(){
  const ids=currentStage?.questions||[];
  const qid=ids[currentIndex]; return gameData.questions.find(q=>q.id===qid);
}
function loadQuestion(){
  const q=currentQuestion(); if(!q){endStage();return;}
  $('stageLabel').textContent=`ด่าน ${currentStage.id}`;
  $('questionLabel').textContent=`ข้อ ${currentIndex+1} / ${currentStage.questions.length}`;
  $('scoreLabel').textContent=`คะแนน ${score}`;
  $('questionMeta').textContent=`ด่านที่ ${currentStage.id} • ข้อที่ ${currentIndex+1}`;
  $('questionText').textContent=q.prompt;
  selectedCandidate=-1; readyToCapture=false; hoverLostAt=0; answerResultStates=new Map();
  setTimeout(()=>{readyToCapture=true},650);
  spawnAnswers(q.choices);
}
function measureTextWidth(text){ctx.font='800 15px Inter, system-ui, sans-serif';return ctx.measureText(text).width}
function spawnAnswers(choices){
  const rect=canvas.getBoundingClientRect(); const w=rect.width,h=rect.height;
  const cols=choices.length<=4?2:3;
  const positions=[];
  for(let i=0;i<choices.length;i++){
    let tries=0,p=null;
    while(tries++<300){
      const boxW=Math.min(205,Math.max(132,measureTextWidth(choices[i])+48));
      const boxH=52;
      const x=26+Math.random()*Math.max(1,w-boxW-52);
      const y=Math.min(h-105,165+Math.random()*Math.max(1,h-300));
      p={x,y,w:boxW,h:boxH,vx:(Math.random()-.5)*0.18,vy:(Math.random()-.5)*0.14,phase:Math.random()*Math.PI*2,label:choices[i],index:i};
      if(!positions.some(o=>overlap(o,p,32)))break;
    }
    positions.push(p);
  }
  answerObjects=positions;
}
function overlap(a,b,pad=0){return !(a.x+a.w+pad<b.x||a.x>b.x+b.w+pad||a.y+a.h+pad<b.y||a.y>b.y+b.h+pad)}
function clampToBounds(o,w,h){
  if(o.x<18||o.x+o.w>w-18)o.vx*=-1;
  if(o.y<155||o.y+o.h>h-72)o.vy*=-1;
  o.x=Math.max(18,Math.min(w-o.w-18,o.x)); o.y=Math.max(155,Math.min(h-o.h-72,o.y));
}
function separateAnswers(){
  const GAP=10; // ระยะห่างขั้นต่ำที่ต้องการให้เหลือระหว่างกล่องหลัง "ชน" กัน
  const PASSES=4; // ทำหลายรอบต่อเฟรม เผื่อมีมากกว่า 2 กล่องชนกันพร้อมกัน จะได้แยกออกจากกันหมดในเฟรมเดียว
  for(let pass=0;pass<PASSES;pass++){
    let anyOverlap=false;
    for(let i=0;i<answerObjects.length;i++){
      for(let j=i+1;j<answerObjects.length;j++){
        const a=answerObjects[i],b=answerObjects[j];
        const overlapX=Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x);
        const overlapY=Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y);
        if(overlapX<=0||overlapY<=0)continue; // ไม่ได้ชนกันจริง ข้าม
        anyOverlap=true;
        // ดัน "เต็มระยะ" ที่ทับซ้อนออกจากกันตามแกนที่ทับซ้อนน้อยกว่า (minimum translation vector)
        // แทนการขยับทีละ ~1px แบบเดิม ซึ่งตามการชนไม่ทันเมื่อกล่องวิ่งเข้าหากันต่อเนื่อง
        if(overlapX<overlapY){
          const push=(overlapX+GAP)/2;
          const aIsLeft=(a.x+a.w/2)<(b.x+b.w/2);
          a.x+=aIsLeft?-push:push; b.x+=aIsLeft?push:-push;
          const spd=Math.max(Math.abs(a.vx),Math.abs(b.vx),.05);
          a.vx=aIsLeft?-spd:spd; b.vx=aIsLeft?spd:-spd;
        }else{
          const push=(overlapY+GAP)/2;
          const aIsAbove=(a.y+a.h/2)<(b.y+b.h/2);
          a.y+=aIsAbove?-push:push; b.y+=aIsAbove?push:-push;
          const spd=Math.max(Math.abs(a.vy),Math.abs(b.vy),.04);
          a.vy=aIsAbove?-spd:spd; b.vy=aIsAbove?spd:-spd;
        }
      }
    }
    if(!anyOverlap)break; // แยกกันหมดแล้ว ไม่ต้องเสีย CPU ทำรอบที่เหลือ
  }
}
function updateAnswers(dt){
  const rect=canvas.getBoundingClientRect(),w=rect.width,h=rect.height;
  answerObjects.forEach(o=>{
    o.phase+=dt*.0011;
    o.x+=o.vx*dt; o.y+=o.vy*dt;
    o.x+=Math.cos(o.phase)*.025; o.y+=Math.sin(o.phase*1.4)*.02;
    clampToBounds(o,w,h);
  });
  separateAnswers();
  answerObjects.forEach(o=>clampToBounds(o,w,h)); // กันไม่ให้แรงผลักจากการชนดันกล่องออกนอกจอ
}
function draw(){
  const rect=canvas.getBoundingClientRect(),w=rect.width,h=rect.height;
  ctx.clearRect(0,0,w,h);
  let hoveredThisFrame=-1;
  answerObjects.forEach(o=>{
    const isTarget=pointInside(handPoint,o);
    if(isTarget) hoveredThisFrame=o.index;
    const isSelected=selectedCandidate===o.index;
    const resultState=answerResultStates.get(o.index) || null;
    const lift=isTarget?4:0;
    ctx.save(); ctx.translate(o.x,o.y-lift);
    ctx.shadowColor='rgba(0,0,0,.30)';ctx.shadowBlur=18;ctx.shadowOffsetY=7;

    // สีเฉลยใช้ความโปร่งใสระดับกลาง เพื่อให้ตัวเลือกยังอ่านได้ชัด
    let fillStyle;
    let strokeStyle;
    if(resultState==='correct'){
      fillStyle='rgba(76, 196, 132, .26)';
      strokeStyle='rgba(76, 196, 132, .78)';
    }else if(resultState==='wrong'){
      fillStyle='rgba(235, 92, 106, .26)';
      strokeStyle='rgba(235, 92, 106, .80)';
    }else{
      const g=ctx.createLinearGradient(0,0,o.w,o.h);
      g.addColorStop(0,'rgba(19,39,63,.94)');g.addColorStop(1,'rgba(9,20,34,.92)');
      fillStyle=g;
      strokeStyle=isTarget?'rgba(100,243,196,.95)':'rgba(255,255,255,.18)';
    }

    roundRect(ctx,0,0,o.w,o.h,16);
    ctx.fillStyle=fillStyle;
    ctx.fill();
    ctx.shadowColor='transparent';
    ctx.lineWidth=(resultState||isTarget)?2:1;
    ctx.strokeStyle=strokeStyle;
    ctx.stroke();

    ctx.fillStyle='#f7fbff';
    ctx.font='800 15px Inter, system-ui, sans-serif';
    ctx.textAlign='center';ctx.textBaseline='middle';
    wrapCenterText(o.label,o.w/2,o.h/2,o.w-24,17);
    ctx.restore();
    if(isSelected && fist && fistProgress>0){
      const cx=o.x+o.w/2, cy=o.y-lift+o.h/2;
      const r=Math.hypot(o.w/2,o.h/2)+16;
      ctx.save();
      ctx.beginPath();
      ctx.lineWidth=5;
      ctx.strokeStyle='rgba(100,243,196,.28)';
      ctx.arc(cx,cy,r,0,Math.PI*2);
      ctx.stroke();
      ctx.beginPath();
      ctx.lineWidth=5;
      ctx.lineCap='round';
      ctx.strokeStyle='rgba(100,243,196,.98)';
      ctx.shadowColor='rgba(100,243,196,.85)';ctx.shadowBlur=14;
      const start=-Math.PI/2;
      ctx.arc(cx,cy,r,start,start+Math.PI*2*fistProgress);
      ctx.stroke();
      ctx.restore();
    }
  });
  // เดิม selectedCandidate ถูก "set แล้วไม่เคยรีเซ็ต" เมื่อจุดมือเลื่อนหลุดออกจากกล่อง
  // ทำให้กำมือที่ไหนก็ได้ (แม้ไม่ได้ชี้คำตอบอยู่แล้ว) ไปยืนยันคำตอบเก่าที่เคยชี้ไว้ก่อนหน้า
  // ตรงนี้แก้ให้ต้อง "ชี้อยู่จริง" ถึงจะนับเป็นคำตอบที่เลือก โดยยอมหลุดได้สั้นๆ (HOVER_GRACE_MS)
  // เผื่อสัญญาณสั่นตอนกำมือ (นิ้วงอทำให้จุดกึ่งกลางฝ่ามือขยับเล็กน้อย) ไม่ให้ยกเลิกการค้างกำมือทันที
  if(hoveredThisFrame>=0){
    selectedCandidate=hoveredThisFrame; hoverLostAt=0;
  }else if(selectedCandidate>=0){
    if(!hoverLostAt) hoverLostAt=performance.now();
    if(performance.now()-hoverLostAt>HOVER_GRACE_MS) selectedCandidate=-1;
  }
  if(handPoint){
    ctx.save();ctx.beginPath();ctx.arc(handPoint.x,handPoint.y,10,0,Math.PI*2);ctx.fillStyle=fist?'rgba(255,123,143,.98)':'rgba(100,243,196,.98)';ctx.shadowColor=fist?'rgba(255,123,143,.85)':'rgba(100,243,196,.85)';ctx.shadowBlur=20;ctx.fill();ctx.lineWidth=3;ctx.strokeStyle='rgba(255,255,255,.9)';ctx.stroke();ctx.restore();
  }
}
function roundRect(c,x,y,w,h,r){c.beginPath();c.moveTo(x+r,y);c.arcTo(x+w,y,x+w,y+h,r);c.arcTo(x+w,y+h,x,y+h,r);c.arcTo(x,y+h,x,y,r);c.arcTo(x,y,x+w,y,r);c.closePath()}
function wrapCenterText(text,cx,cy,maxW,lineH){
  const words=text.split(' '),lines=[];let line='';
  for(const word of words){const t=line?line+' '+word:word;if(ctx.measureText(t).width<=maxW)line=t;else{if(line)lines.push(line);line=word}}
  if(line)lines.push(line); const start=cy-(lines.length-1)*lineH/2; lines.forEach((l,i)=>ctx.fillText(l,cx,start+i*lineH));
}
function pointInside(p,o){return p && p.x>=o.x && p.x<=o.x+o.w && p.y>=o.y && p.y<=o.y+o.h}
function onHandResults(results){
  try{
    const hand=results.multiHandLandmarks?.[0];
    if(!hand){handPoint=null;fist=false;return;}
    const rect=canvas.getBoundingClientRect();
    const palm=[hand[0],hand[5],hand[9],hand[13],hand[17]]; const avg=palm.reduce((a,l)=>({x:a.x+l.x,y:a.y+l.y}),{x:0,y:0}); avg.x/=palm.length;avg.y/=palm.length;
    const rawPoint={x:(1-avg.x)*rect.width,y:avg.y*rect.height};
    // ปรับให้จุดมือค่อยๆ ขยับตามจุดจริง (EMA) แทนการกระโดดไปตามพิกัดดิบทุกเฟรม
    // ช่วยลดอาการ "กระตุก" ของจุดชี้และลดโอกาสที่จะหลุดออกจากกรอบคำตอบเพราะสัญญาณสั่นเล็กน้อย
    handPoint = handPoint
      ? {x:handPoint.x+(rawPoint.x-handPoint.x)*.5, y:handPoint.y+(rawPoint.y-handPoint.y)*.5}
      : rawPoint;
    const wrist=hand[0], middleMcp=hand[9]; const scale=Math.hypot(wrist.x-middleMcp.x,wrist.y-middleMcp.y)||.15;
    const tips=[8,12,16,20], ratios=tips.map(i=>Math.hypot(hand[i].x-avg.x,hand[i].y-avg.y)/scale);
    // ต้อง "งอครบทุกนิ้ว" ถึงจะนับเป็นกำมือจริง (กันกรณีแค่ชี้นิ้วเดียวแล้วถูกตีความว่ากำมือ)
    // ใช้เกณฑ์ต่างกันตอนเข้า/ออกสถานะ (hysteresis) เพื่อกันการกระพริบ
    const curledThreshold = fist ? 1.35 : 1.15;
    const curledCount = ratios.filter(r=>r<curledThreshold).length;
    fist = curledCount>=4;
  }catch(err){
    console.warn('onHandResults skipped a malformed frame:', err);
  }
}
function startLoop(){
  if(raf)cancelAnimationFrame(raf);
  lastFrame=performance.now();
  const loop=now=>{
    const dt=Math.min(40,now-lastFrame);lastFrame=now;
    updateAnswers(dt);handleFist(now);draw();
    // เดิมโค้ด await hands.send() ก่อนขอเฟรมถัดไป ทำให้แอนิเมชันทั้งหมด (การลอยของกล่องคำตอบ,
    // จุดชี้มือ, วงแหวนนับเวลา) ถูกหน่วงตามความเร็วของโมเดลตรวจจับมือ ซึ่งช้ากว่า 60fps มาก
    // นี่คือสาเหตุหลักของอาการ "กระตุก หน่วง" ทั้งเกม ไม่ใช่แค่ตอนเลือกคำตอบ
    // แก้โดยแยกลูปเรนเดอร์ (ทำงานทุกเฟรมเสมอ) ออกจากลูปตรวจจับมือ (ทำงานเท่าที่โมเดลจะไหว
    // และห้ามยิงคำขอซ้อนกันด้วย handsBusy)
    if(video.readyState>=2 && hands && !handsBusy){
      handsBusy=true;
      hands.send({image:video})
        .catch(err=>console.warn('hand tracking frame skipped:', err))
        .finally(()=>{handsBusy=false});
    }
    raf=requestAnimationFrame(loop);
  };
  raf=requestAnimationFrame(loop);
}
function handleFist(now){
  if(!fist){lastFistState=false;fistSince=0;fistProgress=0;return}
  if(!lastFistState)fistSince=now;
  lastFistState=true;
  fistProgress = (readyToCapture && selectedCandidate>=0) ? Math.min(1,(now-fistSince)/520) : 0;
  if(readyToCapture && now-fistSince>520 && selectedCandidate>=0){
    readyToCapture=false;fistProgress=0;submitAnswer(selectedCandidate);
  }
}
function submitAnswer(index){
  const q=currentQuestion(); if(!q)return;
  const correct=index===q.answer;
  if(correct)score++;

  // แสดงผลบนตัวเลือกทันที:
  // - เลือกถูก => ตัวเลือกที่เลือกเป็นสีเขียว
  // - เลือกผิด => ตัวเลือกที่เลือกเป็นสีแดง + คำตอบที่ถูกเป็นสีเขียว
  answerResultStates=new Map();
  answerResultStates.set(index,correct?'correct':'wrong');
  if(!correct) answerResultStates.set(q.answer,'correct');

  attempts.push({id:q.id,prompt:q.prompt,selected:q.choices[index],correct:q.choices[q.answer],ok:correct,explanation:q.explanation});
  $('scoreLabel').textContent=`คะแนน ${score}`;
  showToast(correct?'✓ ถูกต้อง':'✕ ยังไม่ถูก',correct?'good':'bad');

  // หยุดรับการกำมือซ้ำระหว่างช่วงแสดงสีเฉลย
  readyToCapture=false;
  lastFistState=false;
  fistSince=0;
  fistProgress=0;

  setTimeout(()=>{currentIndex++;loadQuestion()},900);
}
function showToast(text,kind){const el=$('arToast');el.textContent=text;el.style.borderColor=kind==='good'?'rgba(100,243,196,.55)':'rgba(255,123,143,.55)';el.classList.add('show');setTimeout(()=>el.classList.remove('show'),600)}
function endStage(){
  if(raf)cancelAnimationFrame(raf); raf=null; readyToCapture=false; handPoint=null;
  if(stream){stream.getTracks().forEach(t=>t.stop());stream=null} video.srcObject=null;
  const total=currentStage?.questions?.length||10,wrong=total-score;
  $('resultTitle').textContent=`จบด่าน ${currentStage.id}`; $('resultSubtitle').textContent=currentStage.title;
  $('finalScore').textContent=score; $('correctCount').textContent=score; $('wrongCount').textContent=wrong; $('accuracyCount').textContent=`${Math.round(score/total*100)}%`;
  $('answerReview').innerHTML=attempts.map((a,i)=>`<div class="review-item ${a.ok?'review-correct':'review-wrong'}"><div class="review-badge">${a.ok?'✓':'×'}</div><div class="review-copy"><strong>ข้อ ${i+1}: ${escapeHtml(a.prompt)}</strong><span>${a.ok?'ตอบถูก':'ตอบ: '+escapeHtml(a.selected)+' • เฉลย: '+escapeHtml(a.correct)} ${a.explanation?'• '+escapeHtml(a.explanation):''}</span></div></div>`).join('');
  setStatus('สรุปผล');showScreen('resultScreen');
}
$('cameraStartBtn').addEventListener('click',startCamera);
$('exitGameBtn').addEventListener('click',()=>{if(confirm('ออกจากด่านนี้และกลับหน้าเลือกด่านหรือไม่')){if(raf)cancelAnimationFrame(raf);if(stream)stream.getTracks().forEach(t=>t.stop());stream=null;video.srcObject=null;answerResultStates=new Map();showScreen('homeScreen');setStatus('พร้อมเล่น')}});
$('retryBtn').addEventListener('click',()=>{prepareStage(currentStage.id);});
$('stageMenuBtn').addEventListener('click',()=>{showScreen('homeScreen');setStatus('พร้อมเล่น')});
$('adminBtn').addEventListener('click',()=>showModal('adminLoginModal'));
$('adminLoginBtn').addEventListener('click',async()=>{const note=$('adminError');note.textContent='';try{const r=await fetch('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('adminPassword').value})});const d=await r.json();if(!r.ok)throw new Error(d.error||'เข้าสู่ระบบไม่ได้');location.href='/admin.html';}catch(e){note.textContent=e.message}});
$('adminPassword').addEventListener('keydown',e=>{if(e.key==='Enter')$('adminLoginBtn').click()});
document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>hideModal(b.dataset.close)));
loadGame().catch(e=>{$('stageGrid').innerHTML=`<div class="small-note">${escapeHtml(e.message)}</div>`});
