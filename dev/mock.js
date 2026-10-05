'use strict';
// Development fixture server: deliberately excluded from npm files.
const http = require('node:http');
const crypto = require('node:crypto');
const {MOCK_KEY} = require('../nodes/lib/client');
const IDS = {account:'10000000-0000-4000-8000-000000000001', profile:'20000000-0000-4000-8000-000000000001', template:'30000000-0000-4000-8000-000000000001', contact:'40000000-0000-4000-8000-000000000001', message:'50000000-0000-4000-8000-000000000001'};
const SUBTYPES = ['queued','routed','sent','delivered','read','failed','scheduled','filtered','blocked','received'];
function sign(raw, webhookId, secret, timestamp = String(Math.floor(Date.now()/1000))) {
    const signature = crypto.createHmac('sha256',Buffer.from(secret.slice(6),'base64')).update(webhookId+'.'+timestamp+'.').update(raw).digest('base64');
    return {'x-webhook-id':webhookId,'x-webhook-timestamp':timestamp,'x-webhook-signature':'v1,'+signature};
}
function sample(eventType, unique = crypto.randomUUID()) {
    if(eventType==='templates')return {field:'templates',timestamp:new Date().toISOString(),payload:{template_id:unique,template_name:'welcome',status:'APPROVED'}};
    return {field:'message',event:eventType,timestamp:new Date().toISOString(),payload:{message_id:unique,message_status:eventType.slice(8).toUpperCase(),channel:'sms',...(eventType==='message.received'?{content:'Hello from the local Sent mock',contact_id:IDS.contact}:{})}};
}
function createMock() {
    const webhooks=new Map(), requests=[], deliveries=[], failures=[], replay=new Map(), messages=new Map();
    messages.set(IDS.message,{id:IDS.message,status:'DELIVERED',direction:'outbound',channel:'sms'});
    const state={webhooks,requests,deliveries,failures,replay,messages,accountType:'organization'};
    const contacts=Array.from({length:3},(_,i)=>({id:IDS.contact.slice(0,-1)+(i+1),phone_number:'+1202555010'+i,format_e164:'+1202555010'+i,available_channels:'sms,whatsapp',opt_out:false}));
    const templates=[{id:IDS.template,name:'welcome',status:'APPROVED',variables:['name','company'],channels:['sms','whatsapp'],customer_id:IDS.account}];
    function page(list,q,key) {
        const page=Number(q.get('page') || 1),size=Number(q.get('page_size') || 50);
        return {[key]:list.slice((page-1)*size,page*size),pagination:{page,page_size:size,total_items:list.length,total_pages:Math.ceil(list.length/size),has_next_page:page*size<list.length}};
    }
    const emit=async (hook,event,alter={})=>{
        const raw=alter.raw || Buffer.from(JSON.stringify(event,null,2));
        const headers={...sign(raw,hook.id,hook.signing_secret,alter.timestamp),'x-webhook-event-type':event.event || event.field,'content-type':'application/json',...alter.headers};
        const response=await fetch(hook.endpoint_url,{method:'POST',headers,body:alter.sentRaw || raw,signal:AbortSignal.timeout(5000)});
        deliveries.push({webhookId:hook.id,eventType:event.event || event.field,status:response.status});
        await response.text();
        return response.status;
    };
    const server=http.createServer(async (req,res)=>{
        try {
            const url=new URL(req.url,'http://127.0.0.1');const path=url.pathname;let raw='';
            for await(const c of req){raw+=c;if(raw.length>1024*1024){res.writeHead(413).end();return;}}
            const body=raw?JSON.parse(raw):undefined;
            const requestId='req_'+crypto.randomBytes(8).toString('hex');
            const header={'content-type':'application/json','x-request-id':requestId,'x-response-time':'1ms','x-api-version':'v3'};
            if(req.headers['x-profile-id'])header['x-profile-id']=req.headers['x-profile-id'];
            const reply=(status,data,extra={})=>{res.writeHead(status,{...header,...extra});res.end(JSON.stringify({success:status<400,data,error:status>=400?{code:'RESOURCE_001',message:'Mock resource not found'}:null,meta:{request_id:requestId,version:'v3'}}));};
            if(path==='/_mock/state'){reply(200,{requests,deliveries,webhooks:[...webhooks.values()].map(({id,display_name,endpoint_url,event_types,event_filters})=>({id,display_name,endpoint_url,event_types,event_filters}))});return;}
            if(path==='/_mock/emit' && req.method==='POST'){
                for(const hook of webhooks.values()) {
                    const types=hook.event_types.flatMap(p=>p==='message'?(hook.event_filters?.message || ['delivered']).map(t=>'message.'+t):['templates']);
                    for(const type of types)await emit(hook,sample(type));
                }
                reply(200,{deliveries});return;
            }
            const validAuth=req.headers['x-api-key']===MOCK_KEY;
            requests.push({method:req.method,path,query:Object.fromEntries(url.searchParams),body,profile:req.headers['x-profile-id'],key:req.headers['idempotency-key'],authenticated:validAuth});
            if(!validAuth){res.writeHead(401,header).end(JSON.stringify({success:false,error:{code:'AUTH_002',message:'Invalid API key'},meta:{request_id:requestId}}));return;}
            const failureIndex=failures.findIndex(f=>(!f.path || f.path===path)&&(!f.method || f.method===req.method));
            if(failureIndex>=0){const f=failures.splice(failureIndex,1)[0];if(f.disconnect){req.socket.destroy();return;}res.writeHead(f.status,{...header,...f.headers}).end(JSON.stringify(f.body || {success:false,error:{code:f.code || 'INTERNAL_001',message:f.message || 'Mock failure',details:{test:true},doc_url:'https://docs.sent.dm/reference/api/error-catalog'},meta:{request_id:requestId}}));return;}
            const replayKey=req.headers['idempotency-key'];
            if(replayKey && ['POST','PUT','PATCH'].includes(req.method) && replay.has(replayKey)){const old=replay.get(replayKey);reply(old.status,old.data,{'idempotent-replayed':'true','x-original-request-id':old.requestId});return;}
            if(path==='/v3/me' && req.method==='GET')return reply(200,{id:IDS.account,type:state.accountType,name:'Sent Local Demo',channels:{sms:{configured:true},whatsapp:{configured:true},rcs:{configured:false}},profiles:[]});
            if(path==='/v3/sender-profiles')return reply(200,page([{id:IDS.profile,name:'Demo Sender',organization_id:IDS.account}],url.searchParams,'sender_profiles'));
            if(path==='/v3/templates')return reply(200,page(templates.filter(t=>!url.searchParams.get('search') || t.name.includes(url.searchParams.get('search'))),url.searchParams,'templates'));
            if(path==='/v3/templates/'+IDS.template)return reply(200,templates[0]);
            if(path==='/v3/contacts')return reply(200,page(contacts.filter(c=>(!url.searchParams.get('phone') || c.phone_number===url.searchParams.get('phone'))&&(!url.searchParams.get('search') || c.phone_number.includes(url.searchParams.get('search')))),url.searchParams,'contacts'));
            if(path.startsWith('/v3/contacts/')){const c=contacts.find(c=>c.id===path.split('/')[3]);return reply(c?200:404,c || null);}
            if(path.startsWith('/v3/numbers/lookup/'))return reply(200,{phone_number:decodeURIComponent(path.split('/')[4]),is_valid:true,carrier_name:'Mock Mobile',line_type:'mobile',is_voip:false});
            if(path==='/v3/messages' && req.method==='POST'){
                if(!Array.isArray(body?.to) || !!body.text===!!body.template || body.channel && !Array.isArray(body.channel))return reply(400,null);
                const recipients=body.to.flatMap(to=>(body.channel || ['sent']).map(channel=>{const message_id=crypto.randomUUID();if(!body.sandbox)messages.set(message_id,{id:message_id,status:'DELIVERED',channel,direction:'outbound'});return {message_id,to,channel};}));
                const data={status:'QUEUED',recipients,...(body.template?{template_id:body.template.id,template_name:body.template.name}: {})};
                if(replayKey)replay.set(replayKey,{status:202,data,requestId});
                return reply(202,data,body.sandbox?{'x-sandbox':'true'}:{});
            }
            if(path.startsWith('/v3/messages/')){const msg=messages.get(path.split('/')[3]);return reply(msg?200:404,msg?(path.endsWith('/activities')?{message_id:msg.id,activities:['QUEUED','SENT','DELIVERED'].map(status=>({status,timestamp:new Date().toISOString(),description:'Mock lifecycle'})),pagination:null}:msg):null);}
            if(path==='/v3/webhooks/event-types')return reply(200,{event_types:[{name:'message',event_type:'message',is_active:true,sub_types:SUBTYPES.map(s=>({name:s,event_type:'message.'+s,display_name:'Message '+s,is_active:true}))},{name:'templates',event_type:'templates',display_name:'Template transitions',is_active:true}]});
            if(path==='/v3/webhooks' && req.method==='GET')return reply(200,page([...webhooks.values()].filter(w=>!url.searchParams.get('search') || w.display_name.includes(url.searchParams.get('search'))).map(w=>({...w,signing_secret:null})),url.searchParams,'webhooks'));
            if(path==='/v3/webhooks' && req.method==='POST'){
                if(!body.endpoint_url || body.event_types.some(e=>!['message','templates'].includes(e)))return reply(400,null);
                const data={...body,id:crypto.randomUUID(),signing_secret:'whsec_'+crypto.randomBytes(32).toString('base64'),is_active:true};
                webhooks.set(data.id,data);if(replayKey)replay.set(replayKey,{status:201,data,requestId});return reply(201,data);
            }
            if(path.startsWith('/v3/webhooks/')){
                const hook=webhooks.get(path.split('/')[3]);if(!hook)return reply(404,null);
                if(req.method==='DELETE'){webhooks.delete(hook.id);return reply(200,{id:hook.id,deleted:true});}
                if(path.endsWith('/test') && req.method==='POST'){const status=await emit(hook,sample(body.event_type || 'message.delivered'));return reply(200,{success:status===200,message:'Mock signed delivery HTTP '+status});}
                return reply(200,{...hook,signing_secret:null});
            }
            return reply(404,null);
        }catch {if(!res.headersSent)res.writeHead(500);res.end();}
    });
    return {state,emit,server,async start(port=0){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});this.url='http://127.0.0.1:'+server.address().port;return this;},async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
if(require.main===module)createMock().start(Number(process.env.SENT_MOCK_PORT || 1881)).then(m=>console.log('Sent mock on '+m.url));
module.exports={createMock,IDS,MOCK_KEY,sign,sample};
