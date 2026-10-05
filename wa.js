// WhatsApp message templates and the 24-hour customer-service window.
import {G,V,gx} from './meta.js';
const first=n=>String(n||'there').trim().split(/\s+/)[0]||'there';
const clean=v=>String(v??'').replace(/[\n\t]+/g,' ').replace(/ {2,}/g,' ').trim()||'-';
export const TPL={
  housie_first_reply:{label:'First reply',category:'MARKETING',body:'Hi {{1}}, thanks for your interest in {{2}}. I am {{3}}. Can I share details and arrange a site visit?',ex:['Rohit','a 3BHK in Boring Road','Anita from Anita Realty'],vars:(l,u)=>[first(l.name),l.need||'a property',u.name]},
  housie_visit_confirm:{label:'Visit confirmation',category:'UTILITY',body:'Hi {{1}}, your site visit for {{2}} is confirmed for {{3}}. See you there! - {{4}}',ex:['Rohit','3BHK Boring Road','Sat 4 Oct 11:00','Anita'],vars:(l,u,x)=>[first(l.name),x.property||l.need||'the property',x.at||'the agreed time',u.name]},
  housie_followup:{label:'Follow-up',category:'MARKETING',body:'Hi {{1}}, are you still looking for {{2}}? Reply YES and I will send the latest options.',ex:['Rohit','a 3BHK in Boring Road'],vars:l=>[first(l.name),l.need||'a property']}
};
export const render=(n,vars)=>TPL[n].body.replace(/\{\{(\d)\}\}/g,(_,i)=>clean(vars[i-1]));
export function mountWA(app,{q,one,run,auth,own,lead}){
  const hasCreds=a=>!!(a.wa_phone_id&&a.wa_token);
  const inWindow=id=>!!one("SELECT 1 FROM messages WHERE lead_id=? AND dir='in' AND created>datetime('now','-24 hours') LIMIT 1",id);
  const stat=(a,n)=>one('SELECT status FROM wa_templates WHERE agent_id=? AND name=?',a.id,n)?.status||'NOT_CREATED';
  const setStat=(a,n,s)=>run('INSERT INTO wa_templates(agent_id,name,status) VALUES(?,?,?) ON CONFLICT(agent_id,name) DO UPDATE SET status=excluded.status',a.id,n,s);
  async function post(a,to,payload){const r=await fetch(`${G}/${V}/${a.wa_phone_id}/messages`,{method:'POST',headers:{authorization:'Bearer '+a.wa_token,'content-type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',to:String(to||'').replace(/\D/g,''),...payload})});
    const d=await r.json().catch(()=>({}));return r.ok?'sent':'failed: '+(d.error?.message||'WhatsApp rejected the message')}
  const sendTpl=(a,u,l,n,x={})=>{const vars=TPL[n].vars(l,u,x).map(clean);return post(a,l.phone,{type:'template',template:{name:n,language:{code:'en'},components:[{type:'body',parameters:vars.map(text=>({type:'text',text}))}]}}).then(status=>({status,via:'template',body:render(n,vars)}))};
  // Send a text inside the 24h window, otherwise an approved template, otherwise report that a template is needed.
  async function notify(a,u,l,{text,tpl,x}){if(!hasCreds(a))return{status:'demo'};
    if(inWindow(l.id))return{status:await post(a,l.phone,{type:'text',text:{body:text}}),via:'text',body:text};
    if(tpl&&stat(a,tpl)==='APPROVED')return sendTpl(a,u,l,tpl,x);return{status:'needs_template'}}
  async function refresh(a){const d=await gx(`${a.wa_waba_id}/message_templates`,{token:a.wa_token,params:{fields:'name,status,language',limit:100}});
    for(const n of Object.keys(TPL)){const f=(d.data||[]).find(t=>t.name===n&&(!t.language||t.language.startsWith('en')));setStat(a,n,f?f.status:'NOT_CREATED')}}
  const list=(a,l,u)=>Object.entries(TPL).map(([name,t])=>({name,label:t.label,category:t.category,status:stat(a,name),body:t.body,preview:render(name,l?t.vars(l,u,{}):t.ex)}));
  app.get('/api/wa/templates',auth,(req,res)=>{const l=req.query.lead?lead(req,req.query.lead):null;res.json(list(req.agent,l,req.user))});
  app.post('/api/wa/templates/setup',auth,own,async(req,res)=>{const a=req.agent;if(!a.wa_token)return res.status(400).json({error:'Save your WhatsApp token first'});if(!a.wa_waba_id)return res.status(400).json({error:'Add your WhatsApp Business Account ID and save first'});
    try{for(const[name,t]of Object.entries(TPL)){try{const r=await gx(`${a.wa_waba_id}/message_templates`,{method:'POST',token:a.wa_token,params:{name,language:'en',category:t.category,components:[{type:'BODY',text:t.body,example:{body_text:[t.ex]}}]}});setStat(a,name,r.status||'PENDING')}catch(e){if(!/already exist/i.test(e.message))throw e}}
      await refresh(a);res.json(list(a,null,req.user))}catch(e){res.status(502).json({error:e.message})}});
  app.post('/api/wa/templates/refresh',auth,own,async(req,res)=>{const a=req.agent;if(!a.wa_token||!a.wa_waba_id)return res.status(400).json({error:'Add your WhatsApp token and Business Account ID first'});try{await refresh(a);res.json(list(a,null,req.user))}catch(e){res.status(502).json({error:e.message})}});
  app.post('/api/leads/:id/template',auth,async(req,res)=>{const l=lead(req,req.params.id);if(!l)return res.sendStatus(404);const n=req.body.template;if(!TPL[n])return res.status(400).json({error:'Unknown template'});const a=req.agent;
    if(!hasCreds(a)){run("INSERT INTO messages(lead_id,agent_id,dir,body) VALUES(?,?,'out',?)",l.id,a.id,render(n,TPL[n].vars(l,req.user,{})));return res.json({status:'demo'})}
    if(stat(a,n)!=='APPROVED')return res.status(400).json({error:'This template is not approved by WhatsApp yet'});
    const r=await sendTpl(a,req.user,l,n);if(r.status==='sent')run("INSERT INTO messages(lead_id,agent_id,dir,body) VALUES(?,?,'out',?)",l.id,a.id,r.body);res.json({status:r.status})});
  return{notify,inWindow};
}
