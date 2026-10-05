import fs from 'fs';import path from 'path';import {fileURLToPath} from 'url';import express from 'express';import Database from 'better-sqlite3';import crypto from 'crypto';import jwt from 'jsonwebtoken';import {mountMeta,G,V} from './meta.js';import {mountWA} from './wa.js';
const {TEAM_SEATS=5,META_APP_SECRET,NODE_ENV,PORT=3000,JWT_SECRET='dev-secret',BASE_URL=`http://localhost:${PORT}`,META_VERIFY_TOKEN='verify',ANTHROPIC_API_KEY,AI_MODEL='claude-sonnet-5-5'}=process.env;
if(NODE_ENV==='production'&&JWT_SECRET==='dev-secret')throw new Error('Set JWT_SECRET before running in production');
const db=new Database(process.env.DB_PATH||'data.db');db.pragma('journal_mode=WAL');
db.exec(`CREATE TABLE IF NOT EXISTS agents(id INTEGER PRIMARY KEY,name,email UNIQUE,pw,phone,meta_page_id,meta_token,wa_phone_id,wa_token);
CREATE TABLE IF NOT EXISTS wa_templates(agent_id,name,status,PRIMARY KEY(agent_id,name));
CREATE TABLE IF NOT EXISTS photos(id INTEGER PRIMARY KEY,property_id,agent_id,mime,data BLOB,pos INTEGER DEFAULT 0,created DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS campaigns(id INTEGER PRIMARY KEY,agent_id,meta_id,name,status DEFAULT 'ACTIVE',spend DEFAULT 0,leads DEFAULT 0,tip,UNIQUE(agent_id,meta_id));
CREATE TABLE IF NOT EXISTS leads(id INTEGER PRIMARY KEY,agent_id,name,phone,source,budget,need,score DEFAULT 50,stage DEFAULT 0,tip,created DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY,lead_id,agent_id,dir,body,created DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS properties(id INTEGER PRIMARY KEY,agent_id,title,price,area,locality,descr,created DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS visits(id INTEGER PRIMARY KEY,agent_id,lead_id,property_id,at,status DEFAULT 'scheduled');`);
for(const c of ['meta_ad_account','trial_ends','plan','plan_until','rzp_sub_id','owner_id','meta_user_token','meta_token_exp','meta_currency','wa_number','wa_waba_id'])try{db.exec(`ALTER TABLE agents ADD COLUMN ${c}`)}catch{}
for(const c of ['assigned_to','meta_campaign_id','meta_lead_id'])try{db.exec(`ALTER TABLE leads ADD COLUMN ${c}`)}catch{}
try{db.exec('ALTER TABLE messages ADD COLUMN wa_id')}catch{}
const normPhone=p=>{const d=String(p||'').replace(/\D/g,'');return d.length===10?'91'+d:d.length===11&&d[0]==='0'?'91'+d.slice(1):d};
for(const c of ['adset_id','daily_budget','impressions','clicks','goal','property_id'])try{db.exec(`ALTER TABLE campaigns ADD COLUMN ${c}`)}catch{}
db.exec(`CREATE TABLE IF NOT EXISTS invites(token PRIMARY KEY,owner_id,name,used DEFAULT 0,created DEFAULT CURRENT_TIMESTAMP);
UPDATE leads SET assigned_to=agent_id WHERE assigned_to IS NULL;
DROP TRIGGER IF EXISTS lead_assign;
CREATE TRIGGER lead_assign AFTER INSERT ON leads WHEN NEW.assigned_to IS NULL BEGIN
UPDATE leads SET assigned_to=(SELECT a.id FROM agents a WHERE a.id=NEW.agent_id OR a.owner_id=NEW.agent_id ORDER BY COALESCE((SELECT MAX(l.id) FROM leads l WHERE l.assigned_to=a.id AND l.id<>NEW.id),0),a.id LIMIT 1) WHERE id=NEW.id; END;`);
const q=(s,...a)=>db.prepare(s).all(...a),one=(s,...a)=>db.prepare(s).get(...a),run=(s,...a)=>db.prepare(s).run(...a);
const hash=(p,s=crypto.randomBytes(8).toString('hex'))=>s+':'+crypto.scryptSync(p,s,32).toString('hex');
const ok=(p,h)=>hash(p,h.split(':')[0])===h;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// ---------- AI (Claude API, with offline fallback) ----------
async function ai(prompt){
  if(!ANTHROPIC_API_KEY)return null;
  try{const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'content-type':'application/json','x-api-key':ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:AI_MODEL,max_tokens:400,messages:[{role:'user',content:prompt}]})});
  const d=await r.json();return d.content?.[0]?.text??null}catch{return null}}
async function scoreLead(id){
  const l=one('SELECT * FROM leads WHERE id=?',id);if(!l)return;
  const msgs=q('SELECT dir,body FROM messages WHERE lead_id=? ORDER BY id DESC LIMIT 6',id).reverse().map(m=>`${m.dir}: ${m.body}`).join('\n');
  const t=await ai(`You are a real-estate CRM assistant in India. Score this lead 0-100 for buying intent and give one short next-action tip (max 20 words). Reply ONLY JSON {"score":n,"tip":"..."}.\nLead: ${JSON.stringify({name:l.name,source:l.source,budget:l.budget,need:l.need})}\nChat:\n${msgs}`);
  let r;try{r=JSON.parse(t.replace(/```json|```/g,''))}catch{}
  if(!r)r={score:Math.min(95,40+(l.budget?15:0)+(l.need?15:0)+(l.phone?10:0)+(l.source==='WhatsApp'?10:0)),tip:'Reply within 5 minutes and offer a site visit.'};
  run('UPDATE leads SET score=?,tip=? WHERE id=?',r.score,r.tip,id)}
// ---------- WhatsApp send ----------
async function sendWA(agent,to,body){
  if(!agent.wa_phone_id||!agent.wa_token)return 'demo';
  const r=await fetch(`${G}/${V}/${agent.wa_phone_id}/messages`,{method:'POST',headers:{authorization:'Bearer '+agent.wa_token,'content-type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',to:to.replace(/\D/g,''),type:'text',text:{body}})});
  const d=await r.json().catch(()=>({}));return r.ok?'sent':'failed: '+(d.error?.message||'WhatsApp rejected the message')}
const app=express();app.set('trust proxy',1);
const hits=new Map();const limit=(max,ms)=>(req,res,next)=>{const k=req.ip+req.path,n=Date.now(),a=(hits.get(k)||[]).filter(t=>n-t<ms);if(a.length>=max)return res.status(429).json({error:'Too many attempts. Try again later.'});a.push(n);hits.set(k,a);next()};
app.use(express.json({verify:(req,_r,buf)=>{req.raw=buf}}));const __d=path.dirname(fileURLToPath(import.meta.url)),WEB=['index.html','manifest.webmanifest','sw.js','icon-192.png','icon-512.png','icon-maskable.png'];
const webFile=n=>[path.join(__d,'public',n),path.join(__d,n)].find(f=>fs.existsSync(f));
app.get('/',(req,res)=>{const f=webFile('index.html');f?res.sendFile(f):res.status(404).send('Not found')});
app.get('/:f',(req,res,next)=>{const f=WEB.includes(req.params.f)&&webFile(req.params.f);f?res.sendFile(f):next()});
const blocked=a=>a.plan==='trial'?(a.trial_ends||0)<Date.now():['solo','team'].includes(a.plan)?(a.plan_until||0)+3*864e5<Date.now():a.plan==='expired';
const own=(req,res,next)=>req.owner?next():res.status(403).json({error:'Only the team owner can do this'});
const lead=(req,id)=>req.owner?one('SELECT * FROM leads WHERE id=? AND agent_id=?',id,req.agent.id):one('SELECT * FROM leads WHERE id=? AND agent_id=? AND assigned_to=?',id,req.agent.id,req.user.id);
const auth=(req,res,next)=>{try{const u=one('SELECT * FROM agents WHERE id=?',jwt.verify((req.headers.authorization||'').slice(7),JWT_SECRET).id);if(!u)throw 0;const o=u.owner_id?one('SELECT * FROM agents WHERE id=?',u.owner_id):u;if(!o)throw 0;req.user=u;req.agent=o;req.owner=!u.owner_id;
  if(req.path!=='/api/me'){if(u.owner_id&&o.plan!=='team')return res.status(402).json({error:'The team plan is not active. Ask your team owner to renew.'});if(blocked(o)&&req.path!=='/api/billing/subscribe')return res.status(402).json({error:'Your plan has ended. Please subscribe to continue.'})}next()}catch{res.status(401).json({error:'Unauthorized'})}};
const tok=a=>jwt.sign({id:a.id},JWT_SECRET,{expiresIn:'30d'});
// ---------- Auth ----------
const seatsUsed=o=>one('SELECT COUNT(*) n FROM agents WHERE id=? OR owner_id=?',o,o).n;
app.post('/api/register',limit(15,9e5),(req,res)=>{const{name,email,password,phone,invite}=req.body;if(!name||!email||!password||password.length<6)return res.status(400).json({error:'Name, email and 6+ char password required'});
  const inv=invite?one('SELECT * FROM invites WHERE token=? AND used=0',invite):null;if(invite&&!inv)return res.status(400).json({error:'This invite link is invalid or already used'});
  if(inv&&seatsUsed(inv.owner_id)>=Number(TEAM_SEATS))return res.status(403).json({error:'This team has no free seats'});
  try{const r=inv?run('INSERT INTO agents(name,email,pw,phone,owner_id,plan) VALUES(?,?,?,?,?,?)',name,email.toLowerCase(),hash(password),phone,inv.owner_id,'member'):run('INSERT INTO agents(name,email,pw,phone,trial_ends,plan) VALUES(?,?,?,?,?,?)',name,email.toLowerCase(),hash(password),phone,Date.now()+14*864e5,'trial');
  if(inv)run('UPDATE invites SET used=1 WHERE token=?',invite);res.json({token:tok({id:r.lastInsertRowid})})}catch{res.status(409).json({error:'Email already registered'})}});
app.post('/api/login',limit(15,9e5),(req,res)=>{const a=one('SELECT * FROM agents WHERE email=?',(req.body.email||'').toLowerCase());a&&ok(req.body.password||'',a.pw)?res.json({token:tok(a)}):res.status(401).json({error:'Wrong email or password'})});
app.get('/api/me',auth,(req,res)=>{const u=req.user;if(!req.owner)return res.json({id:u.id,name:u.name,email:u.email,role:'member',workspace:req.agent.name,plan_active:!blocked(req.agent)&&req.agent.plan==='team'});const{pw,meta_user_token,...a}=u;res.json({...a,role:'owner',plan_active:!blocked(a),trial_days_left:a.plan==='trial'?Math.max(0,Math.ceil((a.trial_ends-Date.now())/864e5)):null})});
app.put('/api/settings',auth,own,(req,res)=>{for(const k of ['wa_phone_id','wa_token','wa_number','wa_waba_id'])if(req.body[k]!==undefined)run(`UPDATE agents SET ${k}=? WHERE id=?`,String(req.body[k]).trim()||null,req.agent.id);res.json({ok:true})});
// ---------- Leads ----------
app.get('/api/leads',auth,(req,res)=>res.json(q('SELECT l.*,a.name assignee FROM leads l LEFT JOIN agents a ON a.id=l.assigned_to WHERE l.agent_id=?'+(req.owner?'':' AND l.assigned_to=?')+' ORDER BY l.score DESC,l.id DESC',...(req.owner?[req.agent.id]:[req.agent.id,req.user.id]))));
app.post('/api/leads',auth,async(req,res)=>{const{name,source='Manual',budget,need}=req.body,phone=normPhone(req.body.phone);const r=run('INSERT INTO leads(agent_id,name,phone,source,budget,need) VALUES(?,?,?,?,?,?)',req.agent.id,name,phone,source,budget,need);if(!req.owner)run('UPDATE leads SET assigned_to=? WHERE id=?',req.user.id,r.lastInsertRowid);await scoreLead(r.lastInsertRowid);res.json({id:r.lastInsertRowid})});
app.patch('/api/leads/:id',auth,(req,res)=>{if(!lead(req,req.params.id))return res.sendStatus(404);run('UPDATE leads SET stage=? WHERE id=?',req.body.stage,req.params.id);res.json({ok:true})});
app.get('/api/leads/:id/messages',auth,(req,res)=>lead(req,req.params.id)?res.json(q('SELECT * FROM messages WHERE lead_id=? ORDER BY id',Number(req.params.id))):res.sendStatus(404));
app.post('/api/leads/:id/messages',auth,async(req,res)=>{const l=lead(req,req.params.id);if(!l)return res.sendStatus(404);
  if(req.agent.wa_phone_id&&req.agent.wa_token&&!wa.inWindow(l.id))return res.status(409).json({needs_template:true,error:'More than 24 hours have passed since this client last replied. WhatsApp now only allows an approved template message.'});
  const status=await sendWA(req.agent,l.phone||'',req.body.body);run('INSERT INTO messages(lead_id,agent_id,dir,body) VALUES(?,?,?,?)',l.id,req.agent.id,'out',req.body.body);res.json({status})});
app.post('/api/leads/:id/draft',auth,async(req,res)=>{const l=lead(req,req.params.id);if(!l)return res.sendStatus(404);
  const p=q('SELECT title,price FROM properties WHERE agent_id=? LIMIT 5',req.agent.id);
  const t=await ai(`Write a short, warm WhatsApp reply (Hinglish ok, max 50 words) from real-estate agent ${req.user.name} to ${l.name}. Need: ${l.need}. Budget: ${l.budget}. Suggest a site visit. Listings: ${JSON.stringify(p)}. Output only the message.`);
  res.json({draft:t||`Hi ${l.name.split(' ')[0]}! Thanks for your interest. I have options matching ${l.need||'your needs'}. Can I share details and arrange a site visit this weekend?`})});
// ---------- Properties & Visits ----------
app.get('/api/properties',auth,(req,res)=>res.json(q('SELECT * FROM properties WHERE agent_id=? ORDER BY id DESC',req.agent.id).map(p=>({...p,photos:q('SELECT id FROM photos WHERE property_id=? ORDER BY pos,id',p.id).map(x=>x.id),link:`${BASE_URL}/p/${p.id}`}))));
app.post('/api/properties',auth,(req,res)=>{const{title,price,area,locality,descr}=req.body;if(!title)return res.status(400).json({error:'Title required'});res.json({id:run('INSERT INTO properties(agent_id,title,price,area,locality,descr) VALUES(?,?,?,?,?,?)',req.agent.id,title,price,area,locality,descr).lastInsertRowid})});
app.post('/api/properties/describe',auth,async(req,res)=>{const{title,area,locality}=req.body;res.json({descr:await ai(`Write a catchy 40-word property listing description for: ${title}, ${area}, ${locality}, India.`)||`${title} in ${locality||'a prime location'}. ${area||''} of well-planned space, great connectivity and ready for a quick visit. Contact me to book a viewing.`})});
app.get('/api/visits',auth,(req,res)=>res.json(q('SELECT v.*,l.name lead,p.title property FROM visits v LEFT JOIN leads l ON l.id=v.lead_id LEFT JOIN properties p ON p.id=v.property_id WHERE v.agent_id=?'+(req.owner?'':' AND l.assigned_to=?')+' ORDER BY at',...(req.owner?[req.agent.id]:[req.agent.id,req.user.id]))));
app.post('/api/visits',auth,async(req,res)=>{const{lead_id,property_id,at}=req.body;const l=lead(req,lead_id);if(!l)return res.sendStatus(404);
  run('INSERT INTO visits(agent_id,lead_id,property_id,at) VALUES(?,?,?,?)',req.agent.id,lead_id,property_id,at);run('UPDATE leads SET stage=2 WHERE id=?',lead_id);
  await wa.notify(req.agent,req.user,l,{text:`Hi ${l.name}, your site visit is confirmed for ${at}. See you there! - ${req.user.name}`,tpl:'housie_visit_confirm',x:{at,property:(one('SELECT title FROM properties WHERE id=?',property_id)||{}).title}});res.json({ok:true})});
// ---------- Team (Agent Team plan) ----------
const mine=(req,id)=>one('SELECT * FROM agents WHERE id=? AND (owner_id=? OR id=?)',id,req.agent.id,req.agent.id);
app.get('/api/team',auth,own,(req,res)=>res.json({seats:Number(TEAM_SEATS),canInvite:req.agent.plan==='team'&&seatsUsed(req.agent.id)<Number(TEAM_SEATS),
  members:q("SELECT a.id,a.name,a.email,CASE WHEN a.owner_id IS NULL THEN 'owner' ELSE 'member' END role,(SELECT COUNT(*) FROM leads WHERE assigned_to=a.id) leads FROM agents a WHERE a.id=? OR a.owner_id=? ORDER BY a.owner_id IS NOT NULL,a.id",req.agent.id,req.agent.id)}));
app.post('/api/team/invite',auth,own,(req,res)=>{if(req.agent.plan!=='team')return res.status(403).json({error:'Upgrade to the Agent Team plan to invite agents'});if(seatsUsed(req.agent.id)>=Number(TEAM_SEATS))return res.status(403).json({error:`Seat limit reached (${TEAM_SEATS})`});
  const token=crypto.randomBytes(12).toString('hex');run('INSERT INTO invites(token,owner_id,name) VALUES(?,?,?)',token,req.agent.id,req.body.name||'');res.json({link:`${BASE_URL}/?invite=${token}`})});
app.delete('/api/team/:id',auth,own,(req,res)=>{const m=mine(req,req.params.id);if(!m||!m.owner_id)return res.status(404).json({error:'Member not found'});run('UPDATE leads SET assigned_to=? WHERE assigned_to=?',req.agent.id,m.id);run('DELETE FROM agents WHERE id=?',m.id);res.json({ok:true})});
// ---------- Billing (Razorpay Subscriptions) ----------
app.post('/api/billing/subscribe',auth,own,async(req,res)=>{const{RAZORPAY_KEY_ID:k,RAZORPAY_KEY_SECRET:sec}=process.env;const pid={solo:process.env.RZP_PLAN_SOLO,team:process.env.RZP_PLAN_TEAM}[req.body.plan];
  if(!k||!sec||!pid)return res.status(503).json({error:'Payments are not configured yet'});
  try{const r=await fetch('https://api.razorpay.com/v1/subscriptions',{method:'POST',headers:{'content-type':'application/json',authorization:'Basic '+Buffer.from(k+':'+sec).toString('base64')},body:JSON.stringify({plan_id:pid,total_count:120,customer_notify:1,notes:{agent_id:String(req.agent.id),plan:req.body.plan}})});
  const d=await r.json();if(!r.ok)return res.status(502).json({error:d.error?.description||'Razorpay error'});run('UPDATE agents SET rzp_sub_id=? WHERE id=?',d.id,req.agent.id);res.json({url:d.short_url})}catch{res.status(502).json({error:'Could not reach Razorpay'})}});
app.post('/webhooks/razorpay',(req,res)=>{const sec=process.env.RAZORPAY_WEBHOOK_SECRET;if(!sec)return res.sendStatus(503);
  const h=crypto.createHmac('sha256',sec).update(req.raw||'').digest('hex'),g=req.headers['x-razorpay-signature']||'';if(g.length!==h.length||!crypto.timingSafeEqual(Buffer.from(g),Buffer.from(h)))return res.sendStatus(403);
  const sub=req.body.payload?.subscription?.entity;
  if(sub&&['subscription.activated','subscription.charged'].includes(req.body.event)){const a=one('SELECT * FROM agents WHERE rzp_sub_id=?',sub.id)||one('SELECT * FROM agents WHERE id=?',Number(sub.notes?.agent_id));
    if(a)run('UPDATE agents SET plan=?,plan_until=?,rzp_sub_id=? WHERE id=?',sub.notes?.plan==='team'?'team':'solo',(sub.current_end||0)*1000,sub.id,a.id)}
  res.sendStatus(200)});
// ---------- Ad campaigns (Meta Marketing API) ----------
app.post('/api/ads/copy',auth,async(req,res)=>{const p=one('SELECT * FROM properties WHERE id=? AND agent_id=?',req.body.property_id,req.agent.id);if(!p)return res.status(404).json({error:'Pick a property'});
  const t=await ai(`Write 3 Facebook/Instagram ad variations for this Indian property. Each: headline (max 40 chars) and text (max 120 chars, end with a call to message on WhatsApp). Reply ONLY JSON [{"headline":"","text":""}].\nProperty: ${JSON.stringify({title:p.title,price:p.price,area:p.area,locality:p.locality})}`);
  let v;try{v=JSON.parse(t.replace(/```json|```/g,''))}catch{}
  res.json({variants:v||[{headline:`${p.title} · ${p.price}`,text:`${p.area||''} in ${p.locality||'a prime location'}. Message us on WhatsApp for a free site visit.`},{headline:`Visit ${p.title} this weekend`,text:`Ready to move in. Book a free visit on WhatsApp today.`},{headline:`Your new home in ${p.locality||'the city'}`,text:`${p.price}. Limited units. Tap to chat on WhatsApp.`}]})});
// ---------- Listing photos ----------
const kind=b=>b.length>12&&b[0]===0xFF&&b[1]===0xD8?'image/jpeg':b.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]))?'image/png':b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP'?'image/webp':null;
app.post('/api/properties/:id/photos',auth,express.raw({type:'image/*',limit:'4mb'}),(req,res)=>{const p=one('SELECT * FROM properties WHERE id=? AND agent_id=?',req.params.id,req.agent.id);if(!p)return res.sendStatus(404);
  if(!Buffer.isBuffer(req.body)||!req.body.length)return res.status(400).json({error:'Send an image file'});const m=kind(req.body);if(!m)return res.status(415).json({error:'Only JPEG, PNG or WebP images'});
  if(one('SELECT COUNT(*) n FROM photos WHERE property_id=?',p.id).n>=8)return res.status(400).json({error:'Maximum 8 photos per property'});
  res.json({id:run('INSERT INTO photos(property_id,agent_id,mime,data,pos) VALUES(?,?,?,?,?)',p.id,req.agent.id,m,req.body,one('SELECT COALESCE(MAX(pos),0)+1 n FROM photos WHERE property_id=?',p.id).n).lastInsertRowid})});
app.delete('/api/photos/:id',auth,(req,res)=>{run('DELETE FROM photos WHERE id=? AND agent_id=?',req.params.id,req.agent.id);res.json({ok:true})});
app.post('/api/photos/:id/cover',auth,(req,res)=>{const ph=one('SELECT * FROM photos WHERE id=? AND agent_id=?',req.params.id,req.agent.id);if(!ph)return res.sendStatus(404);run('UPDATE photos SET pos=(SELECT MIN(pos)-1 FROM photos WHERE property_id=?) WHERE id=?',ph.property_id,ph.id);res.json({ok:true})});
app.get('/photo/:id',(req,res)=>{const ph=one('SELECT mime,data FROM photos WHERE id=?',req.params.id);if(!ph)return res.sendStatus(404);res.set({'content-type':ph.mime,'cache-control':'public,max-age=86400','x-content-type-options':'nosniff'}).send(ph.data)});
// ---------- Public property page (clients book visits themselves) ----------
app.get('/p/:id',(req,res)=>{const p=one('SELECT p.*,a.name agent,a.phone aphone FROM properties p JOIN agents a ON a.id=p.agent_id WHERE p.id=?',req.params.id);if(!p)return res.status(404).send('Not found');const ph=q('SELECT id FROM photos WHERE property_id=? ORDER BY pos,id',p.id).map(x=>x.id);
  res.send(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(p.title)}</title>${ph.length?`<meta property=og:image content="${BASE_URL}/photo/${ph[0]}">`:''}<meta property=og:title content="${esc(p.title)} · ${esc(p.price)}"><meta property=og:description content="${esc(p.locality)} ${esc(p.area)}"><style>body{font-family:system-ui;max-width:520px;margin:0 auto;padding:16px;background:#F4F5FB;color:#16163A}.g{display:flex;gap:8px;overflow-x:auto;scroll-snap-type:x mandatory;border-radius:16px}.g img{width:100%;flex:none;height:240px;object-fit:cover;scroll-snap-align:center;border-radius:16px}.h{height:200px;border-radius:16px;background:linear-gradient(135deg,#4B3FE0,#22D3A6)}h1{margin:14px 0 4px}.pr{font-size:24px;font-weight:800;color:#4B3FE0}form{background:#fff;padding:16px;border-radius:16px;margin-top:16px;display:grid;gap:10px}input,button{font:inherit;padding:12px;border-radius:10px;border:1px solid #ddd}button{background:#4B3FE0;color:#fff;border:0;font-weight:700}</style>
${ph.length?`<div class=g>${ph.map(i=>`<img src="/photo/${i}" alt="${esc(p.title)}">`).join('')}</div>`:'<div class=h></div>'}<h1>${esc(p.title)}</h1><div>${esc(p.locality)} · ${esc(p.area)}</div><div class=pr>${esc(p.price)}</div><p>${esc(p.descr)}</p><div>Listed by <b>${esc(p.agent)}</b></div>
<form method=post action="/p/${p.id}/book"><b>Book a free site visit</b><input name=name placeholder="Your name" required><input name=phone placeholder="WhatsApp number" required><input name=at type=datetime-local required><button>Schedule visit</button></form>`)});
app.post('/p/:id/book',express.urlencoded({extended:false}),async(req,res)=>{const p=one('SELECT * FROM properties WHERE id=?',req.params.id);if(!p)return res.sendStatus(404);const a=one('SELECT * FROM agents WHERE id=?',p.agent_id);
  const l=run('INSERT INTO leads(agent_id,name,phone,source,need,stage) VALUES(?,?,?,?,?,2)',a.id,req.body.name,normPhone(req.body.phone),'Property Link',p.title);
  run('INSERT INTO visits(agent_id,lead_id,property_id,at) VALUES(?,?,?,?)',a.id,l.lastInsertRowid,p.id,req.body.at);await scoreLead(l.lastInsertRowid);
  await wa.notify(a,{name:a.name},one('SELECT * FROM leads WHERE id=?',l.lastInsertRowid),{text:`Hi ${req.body.name}, your visit for ${p.title} is booked for ${req.body.at}. - ${a.name}`,tpl:'housie_visit_confirm',x:{at:req.body.at,property:p.title}});res.send('<meta name=viewport content="width=device-width,initial-scale=1"><body style="font-family:system-ui;text-align:center;padding:60px 20px"><h2>✅ Visit booked!</h2><p>The agent will confirm on WhatsApp.</p>')});
// ---------- Meta webhooks: Facebook/Instagram Lead Ads + WhatsApp ----------
app.get('/webhooks/meta',(req,res)=>req.query['hub.verify_token']===META_VERIFY_TOKEN?res.send(req.query['hub.challenge']):res.sendStatus(403));
const sigOk=req=>{if(!META_APP_SECRET)return NODE_ENV!=='production';const h=crypto.createHmac('sha256',META_APP_SECRET).update(req.raw||'').digest('hex'),g=(req.headers['x-hub-signature-256']||'').replace('sha256=','');return g.length===h.length&&crypto.timingSafeEqual(Buffer.from(g),Buffer.from(h))};
app.post('/webhooks/meta',async(req,res)=>{if(!sigOk(req))return res.sendStatus(403);res.sendStatus(200);
  for(const e of req.body.entry||[])for(const c of e.changes||[]){
    if(c.field==='leadgen'){const a=one('SELECT * FROM agents WHERE meta_page_id=?',String(e.id));if(!a||one('SELECT 1 FROM leads WHERE meta_lead_id=?',String(c.value.leadgen_id)))continue;
      try{const d=await(await fetch(`${G}/${V}/${c.value.leadgen_id}?fields=field_data,campaign_id,ad_id,platform&access_token=${a.meta_token}`)).json();if(d.error)throw new Error(d.error.message);const f=Object.fromEntries((d.field_data||[]).map(x=>[x.name,x.values?.[0]]));
        const ph=normPhone(f.phone_number||f.phone),src=d.platform==='ig'?'Instagram':'Facebook',ex=ph&&one('SELECT * FROM leads WHERE agent_id=? AND phone=?',a.id,ph);let id;
        if(ex){run('UPDATE leads SET meta_campaign_id=COALESCE(meta_campaign_id,?),meta_lead_id=?,budget=COALESCE(budget,?),need=COALESCE(need,?) WHERE id=?',d.campaign_id||null,String(c.value.leadgen_id),f.budget||null,f.requirement||f.need||null,ex.id);id=ex.id}
        else id=run('INSERT INTO leads(agent_id,name,phone,source,budget,need,meta_campaign_id,meta_lead_id) VALUES(?,?,?,?,?,?,?,?)',a.id,f.full_name||f.name||'Facebook Lead',ph,src,f.budget,f.requirement||f.need,d.campaign_id||null,String(c.value.leadgen_id)).lastInsertRowid;
        scoreLead(id)}catch(err){console.error('leadgen',err.message)}}
    if(c.field==='messages'){const a=one('SELECT * FROM agents WHERE wa_phone_id=?',c.value.metadata?.phone_number_id);if(!a)continue;
      for(const m of c.value.messages||[]){if(m.id&&one('SELECT 1 FROM messages WHERE wa_id=?',m.id))continue;const ph=normPhone(m.from),name=c.value.contacts?.[0]?.profile?.name||ph;let l=one('SELECT * FROM leads WHERE agent_id=? AND phone=?',a.id,ph);
        if(!l)l={id:run('INSERT INTO leads(agent_id,name,phone,source) VALUES(?,?,?,?)',a.id,name,ph,'WhatsApp').lastInsertRowid};
        run('INSERT INTO messages(lead_id,agent_id,dir,body,wa_id) VALUES(?,?,?,?,?)',l.id,a.id,'in',m.text?.body||`[${m.type}]`,m.id||null);scoreLead(l.id)}}}});
mountMeta(app,{q,one,run,auth,own,BASE_URL,jwt,JWT_SECRET});
const wa=mountWA(app,{q,one,run,auth,own,lead});
app.listen(PORT,()=>console.log('Housie running on',BASE_URL));
