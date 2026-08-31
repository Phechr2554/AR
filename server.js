const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.SERVER_PORT || process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data', 'game.json');
const ADMIN_FILE = path.join(__dirname, 'data', 'admin.json');
const sessions = new Map();

const DEFAULT_ADMIN = {
  salt: '2b21f9b0570fd911ea76876e88a11b59',
  hash: '18d5fe51139c6915359731f8e04941f6acb3be4560daa6bdd5703cc2f779ca54e911f3260f29de8d59476591ae55cecd16f35bc441e4435555f4e0d1c0238828'
};
let admin = DEFAULT_ADMIN;
if (fs.existsSync(ADMIN_FILE)) { try { admin = JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8')); } catch (_) {} }

const mime = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon' };
function readData(){ return JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); }
function writeData(data){ const tmp=DATA_FILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify(data,null,2),'utf8');fs.renameSync(tmp,DATA_FILE); }
function hashPassword(password,salt=crypto.randomBytes(16).toString('hex')){return new Promise((resolve,reject)=>crypto.scrypt(password,salt,64,(e,d)=>e?reject(e):resolve({salt,hash:d.toString('hex')})));}
function verifyPassword(password){return new Promise((resolve,reject)=>crypto.scrypt(password,admin.salt,64,(e,d)=>{if(e)return reject(e);const a=Buffer.from(admin.hash,'hex'),b=Buffer.from(d.toString('hex'),'hex');resolve(a.length===b.length&&crypto.timingSafeEqual(a,b));}));}
function getCookie(req,name){const h=req.headers.cookie||'';const m=h.match(new RegExp('(?:^|; )'+name+'=([^;]+)'));return m?decodeURIComponent(m[1]):'';}
function isAdmin(req){const token=getCookie(req,'ar_admin');return !!token&&sessions.has(token);}
function send(res,status,body,headers={}){const isBuf=Buffer.isBuffer(body);res.writeHead(status,{'Cache-Control':'no-store','Content-Type':isBuf?'application/octet-stream':'application/json; charset=utf-8',...headers});res.end(isBuf?body:JSON.stringify(body));}
function redirect(res,to){res.writeHead(302,{Location:to});res.end();}
function parseBody(req){return new Promise((resolve,reject)=>{let raw='';req.on('data',c=>{raw+=c;if(raw.length>3e6)req.destroy();});req.on('end',()=>{try{resolve(raw?JSON.parse(raw):{});}catch(e){reject(e);}});req.on('error',reject);});}
function requireAdmin(req,res){if(!isAdmin(req)){send(res,401,{error:'ต้องเข้าสู่ระบบผู้ดูแลก่อน'});return false;}return true;}
function questionId(level,number){return `L${String(level).padStart(2,'0')}Q${String(number).padStart(2,'0')}`;}
function defaultQuestion(level,number){return {id:questionId(level,number),level,number,prompt:`คำถามใหม่สำหรับด่าน ${level} ข้อ ${number} — เลือกวิธีแยกสารที่เหมาะสม?`,choices:['การกรอง','การร่อน','การใช้แม่เหล็ก','การระเหย'],answer:0,explanation:'แก้ไขโจทย์และเฉลยนี้ได้จากแผงผู้ดูแล'}}

async function api(req,res,url){
  const data=readData();
  if(req.method==='GET'&&url.pathname==='/api/site') return send(res,200,data.site);
  if(req.method==='GET'&&url.pathname==='/api/game') return send(res,200,data);
  if(url.pathname==='/api/admin/me'&&req.method==='GET'){if(!requireAdmin(req,res))return;return send(res,200,{ok:true});}
  if(url.pathname==='/api/admin/login'&&req.method==='POST'){
    try{const body=await parseBody(req);if(typeof body.password!=='string'||!(await verifyPassword(body.password)))return send(res,401,{error:'รหัสไม่ถูกต้อง'});const token=crypto.randomBytes(32).toString('hex');sessions.set(token,Date.now());return send(res,200,{ok:true},{'Set-Cookie':`ar_admin=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`});}
    catch(e){return send(res,500,{error:'เข้าสู่ระบบไม่สำเร็จ'});}
  }
  if(url.pathname==='/api/admin/logout'&&req.method==='POST'){const t=getCookie(req,'ar_admin');if(t)sessions.delete(t);return send(res,200,{ok:true},{'Set-Cookie':'ar_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});}
  if(url.pathname.startsWith('/api/admin')&&!requireAdmin(req,res)) return;

  try {
    if(url.pathname==='/api/admin/site'&&req.method==='PUT'){const b=await parseBody(req);data.site={...data.site,name:String(b.name??data.site.name).trim()||data.site.name,subtitle:String(b.subtitle??data.site.subtitle).trim()||data.site.subtitle};writeData(data);return send(res,200,data.site);}
    let m;
    if((m=url.pathname.match(/^\/api\/admin\/stages\/(\d+)$/))&&req.method==='PUT'){const s=data.stages.find(x=>x.id===Number(m[1]));if(!s)return send(res,404,{error:'ไม่พบด่าน'});const b=await parseBody(req);s.title=String(b.title??s.title).trim()||s.title;s.description=String(b.description??s.description).trim()||s.description;writeData(data);return send(res,200,s);}
    if(url.pathname==='/api/admin/stages'&&req.method==='POST'){
      const b=await parseBody(req),id=Number(b.id);
      if(!Number.isInteger(id)||id<1||data.stages.some(s=>s.id===id))return send(res,400,{error:'หมายเลขด่านไม่ถูกต้องหรือซ้ำ'});
      const title=String(b.title||`ด่าน ${id}`).trim(),description=String(b.description||`ด่าน ${id} มี 10 ข้อ`).trim();
      const questions=Array.from({length:10},(_,i)=>defaultQuestion(id,i+1));
      const stage={id,title,description,questions:questions.map(q=>q.id)};data.stages.push(stage);data.questions.push(...questions);data.stages.sort((a,b)=>a.id-b.id);writeData(data);return send(res,200,stage);
    }
    if((m=url.pathname.match(/^\/api\/admin\/stages\/(\d+)$/))&&req.method==='DELETE'){
      if(data.stages.length<=1)return send(res,400,{error:'ต้องมีอย่างน้อย 1 ด่าน'});const id=Number(m[1]);if(!data.stages.some(s=>s.id===id))return send(res,404,{error:'ไม่พบด่าน'});
      data.stages=data.stages.filter(s=>s.id!==id).sort((a,b)=>a.id-b.id);
      data.questions=data.questions.filter(q=>q.level!==id);
      const originalStageIds=data.stages.map(s=>s.id);
      const remaining=data.questions.sort((a,b)=>a.level-b.level||a.number-b.number);
      let rebuilt=[];
      data.stages.forEach((s,index)=>{
        const sourceLevel=originalStageIds[index], target=index+1;
        const qs=remaining.filter(q=>q.level===sourceLevel);
        qs.forEach((q,qi)=>{q.level=target;q.number=qi+1;q.id=questionId(target,qi+1);});
        s.id=target;s.questions=qs.map(q=>q.id);rebuilt.push(...qs);
      });
      data.questions=rebuilt;writeData(data);return send(res,200,{ok:true});
    }
    if((m=url.pathname.match(/^\/api\/admin\/questions\/([^/]+)$/))&&req.method==='PUT'){const id=decodeURIComponent(m[1]),q=data.questions.find(x=>x.id===id);if(!q)return send(res,404,{error:'ไม่พบข้อสอบ'});const b=await parseBody(req),choices=Array.isArray(b.choices)?b.choices.map(x=>String(x).trim()).filter(Boolean):q.choices,answer=Number(b.answer);if(String(b.prompt??q.prompt).trim()===''||choices.length<4||choices.length>5||!Number.isInteger(answer)||answer<0||answer>=choices.length)return send(res,400,{error:'ข้อมูลข้อสอบไม่ถูกต้อง'});q.prompt=String(b.prompt).trim();q.choices=choices;q.answer=answer;q.explanation=String(b.explanation??q.explanation).trim();const s=data.stages.find(x=>x.id===q.level);if(s)s.questions=data.questions.filter(x=>x.level===q.level).sort((a,b)=>a.number-b.number).map(x=>x.id);writeData(data);return send(res,200,q);}
    if(url.pathname==='/api/admin/questions'&&req.method==='POST'){const b=await parseBody(req),level=Number(b.level),stage=data.stages.find(s=>s.id===level);if(!stage)return send(res,400,{error:'ไม่พบด่าน'});const existing=data.questions.filter(q=>q.level===level);if(existing.length>=10)return send(res,400,{error:'ด่านนี้มีครบ 10 ข้อแล้ว'});const choices=Array.isArray(b.choices)?b.choices.map(x=>String(x).trim()).filter(Boolean):[],answer=Number(b.answer);if(choices.length<4||choices.length>5||!Number.isInteger(answer)||answer<0||answer>=choices.length)return send(res,400,{error:'ตัวเลือกไม่ถูกต้อง'});const number=(Math.max(0,...existing.map(q=>q.number))+1),q={id:questionId(level,number),level,number,prompt:String(b.prompt||'โจทย์ใหม่').trim(),choices,answer,explanation:String(b.explanation||'').trim()};data.questions.push(q);stage.questions=data.questions.filter(x=>x.level===level).sort((a,b)=>a.number-b.number).map(x=>x.id);writeData(data);return send(res,200,q);}
    if((m=url.pathname.match(/^\/api\/admin\/questions\/([^/]+)$/))&&req.method==='DELETE'){const id=decodeURIComponent(m[1]),q=data.questions.find(x=>x.id===id);if(!q)return send(res,404,{error:'ไม่พบข้อสอบ'});const count=data.questions.filter(x=>x.level===q.level).length;if(count<=1)return send(res,400,{error:'แต่ละด่านต้องมีอย่างน้อย 1 ข้อ'});data.questions=data.questions.filter(x=>x.id!==id);writeData(data);return send(res,200,{ok:true});}
    if(url.pathname==='/api/admin/password'&&req.method==='POST'){const b=await parseBody(req);if(typeof b.newPassword!=='string'||b.newPassword.length<5)return send(res,400,{error:'รหัสใหม่ต้องมีอย่างน้อย 5 ตัวอักษร'});if(!(await verifyPassword(String(b.currentPassword||''))))return send(res,401,{error:'รหัสเดิมไม่ถูกต้อง'});admin=await hashPassword(b.newPassword);fs.writeFileSync(ADMIN_FILE,JSON.stringify(admin,null,2),'utf8');return send(res,200,{ok:true});}
    return send(res,404,{error:'ไม่พบ API'});
  } catch(e){ console.error(e); return send(res,500,{error:'เซิร์ฟเวอร์เกิดข้อผิดพลาด'}); }
}
function serveStatic(req,res,url){
  let p=url.pathname==='/'?'/index.html':url.pathname;
  if(p==='/admin')p='/admin.html';
  const file=path.normalize(path.join(PUBLIC_DIR,p));
  if(!file.startsWith(PUBLIC_DIR))return send(res,403,{error:'Forbidden'});
  fs.readFile(file,(e,b)=>{if(e)return send(res,404,{error:'ไม่พบไฟล์'});res.writeHead(200,{'Cache-Control':'no-cache','Content-Type':mime[path.extname(file)]||'application/octet-stream'});res.end(b);});
}
const server=http.createServer(async(req,res)=>{const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);if(url.pathname.startsWith('/api/'))return api(req,res,url);return serveStatic(req,res,url);});
server.listen(PORT,HOST,()=>console.log(`AR Separation Game listening on http://${HOST}:${PORT}`));
