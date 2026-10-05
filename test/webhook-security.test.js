'use strict';
const assert=require('node:assert/strict');
const http=require('node:http');
const express=require('express');
const rawBody=require('../nodes/lib/raw-body');
const {verify,callbackUrl,subscription,dedupeKey,remember,createTrigger,TTL,LIMIT}=require('../nodes/lib/webhooks');
const {sign,IDS,sample}=require('../dev/mock');
describe('Webhook bounds and supported early middleware',()=>{
    it('normalizes httpNodeRoot in callback URL',()=>assert.equal(callbackUrl({settings:{sentWebhookBaseUrl:'https://hooks.example',httpNodeRoot:'/api/'}},'token'),'https://hooks.example/api/sent/webhooks/token'));
    it('rejects disabled httpNodeRoot',()=>assert.throws(()=>callbackUrl({settings:{httpNodeRoot:false}},'token')));
    it('rejects arbitrary path in public base',()=>assert.throws(()=>callbackUrl({settings:{sentWebhookBaseUrl:'https://hooks.example/path'}},'token')));
    it('encodes parent selections without subtype filter',()=>assert.deepEqual(subscription(['message','message.sent','templates']),{event_types:['message','templates'],event_filters:{}}));
    it('supports template name filter',()=>assert.deepEqual(subscription(['templates'],['welcome']).event_filters,{templates:['welcome']}));
    it('rejects unknown parents',()=>assert.throws(()=>subscription(['messages'])));
    it('rejects non-string event selections with a validation error',()=>assert.throws(()=>subscription([null]),e=>e.sent.code==='INPUT_INVALID'));
    it('closing a duplicate trigger cannot remove the original receiver',async()=>{
        const {EventEmitter}=require('node:events');
        const receivers=new Map();let retained=0;
        const account={id:'account',profile:async()=>undefined,sanitize:v=>v,retainCleanup:()=>{retained++;return()=>{retained--;};},request:async method=>({data:method==='GET'?{webhooks:[]}:{id:IDS.message,signing_secret:'whsec_'+Buffer.alloc(32,8).toString('base64')}})};
        const RED={settings:{sentInstanceId:'duplicate-test',sentWebhookBaseUrl:'https://hooks.example'},nodes:{getNode:()=>account,createNode:node=>{const events=new EventEmitter();node.id='same-id';node.on=events.on.bind(events);node.emit=events.emit.bind(events);node.status=()=>{};node.error=()=>{};node.warn=()=>{};}}};
        const Trigger=createTrigger(RED,receivers,false);
        const first=new Trigger({account:'account'});await first.ready;
        const original=[...receivers.values()][0];
        const duplicate=new Trigger({account:'account'});await duplicate.ready;
        await new Promise(resolve=>duplicate.emit('close',false,resolve));
        assert.equal(receivers.size,1);assert.equal([...receivers.values()][0],original);
        await new Promise(resolve=>first.emit('close',false,resolve));
        assert.equal(receivers.size,0);assert.equal(retained,0);
    });
    it('inbound key does not depend on webhook ID',()=>{const e=sample('message.received');assert.equal(dedupeKey(e),dedupeKey({...e,timestamp:'changed'}));});
    it('template transitions have distinct keys',()=>{const e=sample('templates');assert.notEqual(dedupeKey(e),dedupeKey({...e,payload:{...e.payload,status:'REJECTED'}}));});
    it('bounds context cache and expires seven-day entries',()=>{let data=Array.from({length:LIMIT},(_,i)=>['key'+i,1000]);const node={context:()=>({get:()=>data,set:(_k,v)=>{data=v;}})};assert.equal(remember(node,'key1',2000),false);assert.equal(remember(node,'new',2000),true);assert.equal(data.length,LIMIT);assert.equal(data[0][0],'key1');assert.equal(remember(node,'key1',TTL+3000),true);assert.equal(data.length,1);});
    it('timestamp and endpoint ID are signed',()=>{const raw=Buffer.from('{}'),secret='whsec_'+Buffer.alloc(32,8).toString('base64'),headers={...sign(raw,IDS.account,secret),'x-webhook-event-type':'templates'};assert.equal(verify(raw,headers,secret,IDS.account),200);assert.equal(verify(raw,{...headers,'x-webhook-timestamp':String(Number(headers['x-webhook-timestamp'])-1)},secret,IDS.account),401);assert.equal(verify(raw,headers,secret,IDS.message),401);});
    it('accepts rotated signatures if one valid v1 matches',()=>{const raw=Buffer.from('{}'),secret='whsec_'+Buffer.alloc(32,8).toString('base64'),headers={...sign(raw,IDS.account,secret),'x-webhook-event-type':'templates'};headers['x-webhook-signature']='v1,'+Buffer.alloc(32).toString('base64')+' '+headers['x-webhook-signature'];assert.equal(verify(raw,headers,secret,IDS.account),200);});
    it('rejects parsed objects instead of reconstructing raw bytes',()=>assert.equal(verify({}, {'x-webhook-id':IDS.account,'x-webhook-signature':'v1,x','x-webhook-event-type':'templates','x-webhook-timestamp':String(Math.floor(Date.now()/1000))},'whsec_a',IDS.account),401));
    it('early hook preserves bytes through the default admin JSON parser',async()=>{
        const app=express();app.use(rawBody({httpNodeRoot:'/api'}));app.use(express.json());
        let seen;app.post('/api/sent/webhooks/test',(req,res)=>{seen=req.sentRawBody;res.sendStatus(200);});
        const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
        try{const raw=Buffer.from('{  "test" : "café" }\n');const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/sent/webhooks/test',{method:'POST',body:raw,headers:{'content-type':'application/json'}});assert.equal(response.status,200);assert.deepEqual(seen,raw);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
    });
});
