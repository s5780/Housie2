// Meta (Facebook / Instagram) integration: Facebook Login, ad accounts, campaign creation and management, legal pages.
import crypto from 'crypto';
export const V=process.env.META_GRAPH_VERSION||'v26.0';
export const G=process.env.META_GRAPH_BASE||'https://graph.facebook.com';
const {META_APP_ID,META_APP_SECRET,AD_COUNTRY='IN',COMPANY_NAME='Housie',CONTACT_EMAIL='support@example.com'}=process.env;
const SCOPES='ads_management,ads_read,business_management,pages_show_list,pages_read_engagement,pages_manage_ads,pages_manage_metadata,leads_retrieval';
export async function gx(path,{method='GET',token,params={}}={}){
  const u=new URL(`${G}/${V}/${path}`);let init={method};
  if(method==='GET'){for(const[k,v]of Object.entries(params))u.searchParams.set(k,typeof v==='object'?JSON.stringify(v):v);if(token)u.searchParams.set('access_token',token)}
  else init={method,headers:{'content-type':'application/json'},body:JSON.stringify({...params,...(token?{access_token:token}:{})})};
  const r=await fetch(u,init),d=await r.json().catch(()=>({}));
  if(!r.ok||d.error){const e=new Error(d.error?.error_user_msg||d.error?.message||'Meta request failed');e.code=d.error?.code;e.expired=d.error?.code===190;throw e}
  return d}
const adsTok=a=>a.meta_user_token||a.meta_token;
const tipFor=c=>{const cpl=c.leads?c.spend/c.leads:null;return cpl===null?(c.spend>2000?'No leads yet. Change the audience or creative.':'Too early to judge. Let it run.'):cpl<300?'Low cost per lead. Raise budget by 20%.':cpl<600?'Healthy. Test one new creative.':'Cost per lead is high. Narrow the audience or refresh the ad.'};
export function mountMeta(app,{q,one,run,auth,own,BASE_URL,jwt,JWT_SECRET}){
  const fail=(res,e)=>res.status(e.expired?409:502).json({error:e.expired?'Your Facebook connection expired. Please reconnect.':e.message,reconnect:!!e.expired});
  const ex=p=>gx('oauth/access_token',{params:{client_id:META_APP_ID,client_secret:META_APP_SECRET,...p}});
  async function refresh(a){if(!a.meta_user_token||!META_APP_ID||(a.meta_token_exp||0)-Date.now()>20*864e5)return;
    try{const d=await ex({grant_type:'fb_exchange_token',fb_exchange_token:a.meta_user_token});run('UPDATE agents SET meta_user_token=?,meta_token_exp=? WHERE id=?',d.access_token,Date.now()+(d.expires_in||5184000)*1000,a.id);a.meta_user_token=d.access_token}catch{}}
  // ----- Facebook Login connect flow -----
  app.get('/api/meta/login',auth,own,(req,res)=>{if(!META_APP_ID||!META_APP_SECRET)return res.status(503).json({error:'Meta app is not configured on the server'});
    const state=jwt.sign({m:req.agent.id},JWT_SECRET,{expiresIn:'15m'});
    res.json({url:`https://www.facebook.com/${V}/dialog/oauth?client_id=${META_APP_ID}&redirect_uri=${encodeURIComponent(BASE_URL+'/meta/callback')}&state=${state}&scope=${SCOPES}`})});
  app.get('/meta/callback',async(req,res)=>{try{if(req.query.error)throw new Error(req.query.error_description||'Permission was not granted');
    const st=jwt.verify(String(req.query.state||''),JWT_SECRET);if(!st.m)throw new Error('Invalid state');
    const s=await ex({redirect_uri:BASE_URL+'/meta/callback',code:req.query.code});const l=await ex({grant_type:'fb_exchange_token',fb_exchange_token:s.access_token});
    run('UPDATE agents SET meta_user_token=?,meta_token_exp=? WHERE id=?',l.access_token,Date.now()+(l.expires_in||5184000)*1000,st.m);res.redirect('/?meta=pick')}
    catch(e){res.redirect('/?meta=error&msg='+encodeURIComponent(e.message))}});
  app.get('/api/meta/status',auth,own,(req,res)=>{const a=req.agent,t=adsTok(a);res.json({configured:!!(META_APP_ID&&META_APP_SECRET),connected:!!t,needs_pick:!!t&&!(a.meta_page_id&&a.meta_ad_account),page_id:a.meta_page_id,ad_account:a.meta_ad_account,
    expired:!!a.meta_token_exp&&a.meta_token_exp<Date.now(),expiring_days:a.meta_token_exp?Math.ceil((a.meta_token_exp-Date.now())/864e5):null})});
  app.get('/api/meta/options',auth,own,async(req,res)=>{try{const t=req.agent.meta_user_token;if(!t)return res.status(400).json({error:'Connect Facebook first'});
    const [p,ac]=await Promise.all([gx('me/accounts',{token:t,params:{fields:'id,name',limit:100}}),gx('me/adaccounts',{token:t,params:{fields:'account_id,name,currency,account_status',limit:100}})]);
    res.json({pages:(p.data||[]).map(x=>({id:x.id,name:x.name})),accounts:(ac.data||[]).filter(x=>x.account_status===1)})}catch(e){fail(res,e)}});
  app.post('/api/meta/select',auth,own,async(req,res)=>{try{const a=req.agent,t=a.meta_user_token;if(!t)return res.status(400).json({error:'Connect Facebook first'});
    const pg=((await gx('me/accounts',{token:t,params:{fields:'id,name,access_token',limit:100}})).data||[]).find(x=>x.id===String(req.body.page_id));if(!pg)return res.status(400).json({error:'Page not found'});
    const ac=((await gx('me/adaccounts',{token:t,params:{fields:'account_id,currency',limit:100}})).data||[]).find(x=>x.account_id===String(req.body.ad_account).replace('act_',''));if(!ac)return res.status(400).json({error:'Ad account not found'});
    await gx(`${pg.id}/subscribed_apps`,{method:'POST',token:pg.access_token,params:{subscribed_fields:'leadgen'}});
    run('UPDATE agents SET meta_page_id=?,meta_token=?,meta_ad_account=?,meta_currency=? WHERE id=?',pg.id,pg.access_token,ac.account_id,ac.currency,a.id);res.json({ok:true,currency:ac.currency})}catch(e){fail(res,e)}});
  app.post('/api/meta/disconnect',auth,own,(req,res)=>{run('UPDATE agents SET meta_user_token=NULL,meta_token=NULL,meta_page_id=NULL,meta_ad_account=NULL,meta_token_exp=NULL WHERE id=?',req.agent.id);res.json({ok:true})});
  // ----- Campaigns: sync, status, budget, create -----
  app.post('/api/campaigns/sync',auth,own,async(req,res)=>{const a=req.agent;if(!adsTok(a)||!a.meta_ad_account)return res.status(400).json({error:'Connect Facebook and choose an ad account first'});
    try{await refresh(a);const d=await gx(`act_${a.meta_ad_account}/campaigns`,{token:adsTok(a),params:{fields:'name,status,insights.date_preset(last_30d){spend,impressions,clicks,actions}',limit:50}});let n=0;
      for(const c of d.data||[]){if(['DELETED','ARCHIVED'].includes(c.status))continue;const i=c.insights?.data?.[0]||{};
        const l=(i.actions||[]).filter(x=>/lead|messaging_conversation_started/.test(x.action_type)).reduce((t,x)=>t+Number(x.value),0),sp=Math.round(Number(i.spend||0));
        run(`INSERT INTO campaigns(agent_id,meta_id,name,status,spend,leads,impressions,clicks,tip) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(agent_id,meta_id) DO UPDATE SET name=excluded.name,status=excluded.status,spend=excluded.spend,leads=excluded.leads,impressions=excluded.impressions,clicks=excluded.clicks,tip=excluded.tip`,a.id,c.id,c.name,c.status,sp,l,Number(i.impressions||0),Number(i.clicks||0),tipFor({spend:sp,leads:l}));n++}
      res.json({synced:n})}catch(e){fail(res,e)}});
  app.get('/api/campaigns',auth,own,(req,res)=>res.json(q(`SELECT c.*,(SELECT COUNT(*) FROM leads l WHERE l.agent_id=c.agent_id AND l.meta_campaign_id=c.meta_id) crm_leads,(SELECT COUNT(*) FROM visits v JOIN leads l ON l.id=v.lead_id WHERE l.agent_id=c.agent_id AND l.meta_campaign_id=c.meta_id) crm_visits FROM campaigns c WHERE c.agent_id=? ORDER BY c.id DESC`,req.agent.id)));
  const mineC=req=>one('SELECT * FROM campaigns WHERE id=? AND agent_id=?',req.params.id,req.agent.id);
  app.post('/api/campaigns/:id/status',auth,own,async(req,res)=>{const c=mineC(req);if(!c)return res.sendStatus(404);const st=req.body.status==='PAUSED'?'PAUSED':'ACTIVE';
    try{await gx(c.meta_id,{method:'POST',token:adsTok(req.agent),params:{status:st}});run('UPDATE campaigns SET status=? WHERE id=?',st,c.id);res.json({ok:true})}catch(e){fail(res,e)}});
  app.post('/api/campaigns/:id/budget',auth,own,async(req,res)=>{const c=mineC(req),b=Number(req.body.daily_budget);if(!c)return res.sendStatus(404);
    if(req.agent.meta_currency&&req.agent.meta_currency!=='INR')return res.status(400).json({error:'Only INR ad accounts are supported for now'});if(!(b>=100&&b<=100000))return res.status(400).json({error:'Daily budget must be between ₹100 and ₹1,00,000'});
    try{const t=adsTok(req.agent),s=(await gx(`${c.meta_id}/adsets`,{token:t,params:{fields:'id',limit:10}})).data||[];if(s.length!==1)return res.status(400).json({error:'This campaign has several ad sets. Change the budget in Ads Manager.'});
      await gx(s[0].id,{method:'POST',token:t,params:{daily_budget:String(Math.round(b*100))}});run('UPDATE campaigns SET daily_budget=? WHERE id=?',b,c.id);res.json({ok:true})}catch(e){fail(res,e)}});
  app.post('/api/campaigns/create',auth,own,async(req,res)=>{const a=req.agent,t=adsTok(a),B=req.body,goal=B.goal==='whatsapp'?'whatsapp':'leads',lead=goal==='leads';
    if(!t||!a.meta_ad_account||!a.meta_page_id)return res.status(400).json({error:'Connect Facebook and choose a page and ad account first'});
    if(a.meta_currency&&a.meta_currency!=='INR')return res.status(400).json({error:'Only INR ad accounts are supported for now'});
    const p=one('SELECT * FROM properties WHERE id=? AND agent_id=?',B.property_id,a.id);if(!p)return res.status(400).json({error:'Choose a property'});
    const budget=Number(B.daily_budget),days=Number(B.days),city=String(B.city||'').trim(),rad=Math.min(80,Math.max(17,Number(B.radius_km)||25)),amin=Math.max(18,Number(B.age_min)||21),amax=Math.min(65,Number(B.age_max)||60),head=String(B.headline||'').slice(0,40),text=String(B.text||'').slice(0,125);
    if(!(budget>=100&&budget<=100000))return res.status(400).json({error:'Daily budget must be between ₹100 and ₹1,00,000'});if(!(days>=1&&days<=60))return res.status(400).json({error:'Run the ad for 1 to 60 days'});
    if(!city)return res.status(400).json({error:'Enter the city to target'});if(!head||!text)return res.status(400).json({error:'Headline and text are required'});
    if(!lead&&!a.wa_number)return res.status(400).json({error:'Add your WhatsApp number in Setup first'});
    const img=one('SELECT data FROM photos WHERE property_id=? ORDER BY pos,id LIMIT 1',p.id);if(!img)return res.status(400).json({error:'Add at least one photo to this property first'});
    const act=`act_${a.meta_ad_account}`,name=`Housie · ${p.title} · ${new Date().toISOString().slice(0,10)}`;let camp,step='start';
    try{await refresh(a);
      step='city';const geo=(await gx('search',{token:t,params:{type:'adgeolocation',location_types:['city'],q:city,country_code:AD_COUNTRY,limit:1}})).data?.[0];if(!geo){const e=new Error(`City "${city}" was not found`);e.user=1;throw e}
      step='image';const im=await gx(`${act}/adimages`,{method:'POST',token:t,params:{bytes:img.data.toString('base64')}});const hash=Object.values(im.images||{})[0]?.hash;
      let form;if(lead){step='lead form';form=(await gx(`${a.meta_page_id}/leadgen_forms`,{method:'POST',token:a.meta_token,params:{name:name+' form',follow_up_action_url:`${BASE_URL}/p/${p.id}`,privacy_policy:{url:`${BASE_URL}/privacy`},questions:[{type:'FULL_NAME'},{type:'PHONE'},{type:'CUSTOM',key:'budget',label:'Your budget'},{type:'CUSTOM',key:'requirement',label:'What are you looking for?'}]}})).id}
      step='campaign';camp=(await gx(`${act}/campaigns`,{method:'POST',token:t,params:{name,objective:'OUTCOME_LEADS',status:'PAUSED',special_ad_categories:['HOUSING'],special_ad_category_country:[AD_COUNTRY],is_adset_budget_sharing_enabled:false}})).id;
      step='ad set';const start=new Date(Date.now()+10*6e4);
      const set=(await gx(`${act}/adsets`,{method:'POST',token:t,params:{name:name+' set',campaign_id:camp,daily_budget:String(Math.round(budget*100)),billing_event:'IMPRESSIONS',optimization_goal:lead?'LEAD_GENERATION':'CONVERSATIONS',destination_type:lead?'ON_AD':'WHATSAPP',bid_strategy:'LOWEST_COST_WITHOUT_CAP',
        promoted_object:lead?{page_id:a.meta_page_id}:{page_id:a.meta_page_id,whatsapp_phone_number:a.wa_number},targeting:{geo_locations:{cities:[{key:geo.key,radius:rad,distance_unit:'kilometer'}]},age_min:amin,age_max:amax,targeting_automation:{advantage_audience:0}},start_time:start.toISOString(),end_time:new Date(start.getTime()+days*864e5).toISOString(),status:'ACTIVE'}})).id;
      step='creative';const cr=(await gx(`${act}/adcreatives`,{method:'POST',token:t,params:{name:name+' creative',object_story_spec:{page_id:a.meta_page_id,link_data:{image_hash:hash,message:text,name:head,link:lead?`https://www.facebook.com/${a.meta_page_id}`:'https://api.whatsapp.com/send',
        call_to_action:lead?{type:'SIGN_UP',value:{lead_gen_form_id:form}}:{type:'WHATSAPP_MESSAGE',value:{app_destination:'WHATSAPP'}}}}}})).id;
      step='ad';await gx(`${act}/ads`,{method:'POST',token:t,params:{name:name+' ad',adset_id:set,creative:{creative_id:cr},status:'ACTIVE'}});
      const r=run('INSERT INTO campaigns(agent_id,meta_id,name,status,adset_id,daily_budget,goal,property_id,tip) VALUES(?,?,?,?,?,?,?,?,?)',a.id,camp,name,'PAUSED',set,budget,goal,p.id,'Created in Housie. Review it, then tap Launch.');
      res.json({id:r.lastInsertRowid,status:'PAUSED'})}
    catch(e){if(camp)await gx(camp,{method:'POST',token:t,params:{status:'DELETED'}}).catch(()=>{});if(e.expired)return fail(res,e);res.status(e.user?400:502).json({error:e.user?e.message:`Could not create the ad (${step}): ${e.message}`})}});
  // ----- Pages Meta requires for app review and lead forms -----
  const page=(t,b)=>`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${t} · ${COMPANY_NAME}</title><body style="font-family:system-ui;max-width:680px;margin:0 auto;padding:20px;line-height:1.6;color:#16163A"><h1>${t}</h1>${b}<p style="color:#6B6E93">Last updated: ${new Date().toISOString().slice(0,10)}</p>`;
  app.get('/privacy',(_q,r)=>r.send(page('Privacy Policy',`<p>${COMPANY_NAME} is a CRM for real estate agents. This policy explains what data we handle.</p><h3>Data we collect</h3><p>Agent account details (name, email, phone); lead details that agents receive from Facebook and Instagram lead forms, WhatsApp messages and property pages (name, phone, email, budget, requirement, messages); property listings and photos; and subscription payment status.</p><h3>How we use it</h3><p>To show leads to the agent who owns them, send WhatsApp messages the agent approves, run ad campaigns the agent creates, and provide AI suggestions. We do not sell personal data.</p><h3>Who processes it</h3><p>Meta (Facebook, Instagram, WhatsApp), Razorpay (payments) and our AI provider process data only to deliver these features.</p><h3>Retention and deletion</h3><p>Data is kept while the account is active. To delete your data, see <a href="/data-deletion">data deletion</a> or email ${CONTACT_EMAIL}.</p><h3>Contact</h3><p>${COMPANY_NAME}, ${CONTACT_EMAIL}</p>`)));
  app.get('/terms',(_q,r)=>r.send(page('Terms of Service',`<p>By using ${COMPANY_NAME} you agree to use it lawfully, to contact only people who have consented to be contacted, and to follow the policies of Meta and WhatsApp. Ads you create are your responsibility and are billed by Meta to your ad account. Subscriptions renew until cancelled. We may suspend accounts that break these terms. Contact: ${CONTACT_EMAIL}.</p>`)));
  app.get('/data-deletion',(_q,r)=>r.send(page('Data Deletion',`<p>To delete your ${COMPANY_NAME} account and all related data (leads, messages, listings, photos), email <b>${CONTACT_EMAIL}</b> from your registered email address with the subject "Delete my data". We will confirm and complete deletion within 30 days. You can also remove ${COMPANY_NAME} from your Facebook account under Settings &gt; Business Integrations.</p>`)));
}
