'use strict';
const assert=require('node:assert/strict');
const http=require('node:http');
const {Client,safePath,clean,retryAfter,MOCK_KEY}=require('../nodes/lib/client');
const {createMock,IDS}=require('../dev/mock');
describe('Shared secure transport',function(){
    let mock,client,waits;
    beforeEach(async()=>{process.env.SENT_NODE_RED_DEVELOPMENT='1';mock=await createMock().start();waits=[];client=new Client(MOCK_KEY,{development:{baseUrl:mock.url},wait:async ms=>{waits.push(ms);}});});
    afterEach(async()=>{client.close();await mock.close();});
    it('authenticates with UUID credential and preserves metadata',async()=>{const r=await client.request('GET','/v3/me');assert.equal(r.data.type,'organization');assert.equal(r.sent.apiVersion,'v3');assert.match(r.sent.requestId,/^req_/);assert.equal(r.sent.responseTime,'1ms');assert.equal(mock.state.requests[0].authenticated,true);});
    it('rejects invalid credentials with structured error',async()=>{mock.state.failures.push({status:401,code:'AUTH_002'});await assert.rejects(client.request('GET','/v3/me'),e=>e.sent.statusCode===401&&e.sent.code==='AUTH_002'&&e.sent.details.test&&!!e.sent.doc_url&&!!e.sent.requestId);assert.equal(mock.state.requests.length,1);});
    it('preserves profile header metadata',async()=>{const r=await client.request('GET','/v3/contacts',{profile:IDS.profile});assert.equal(mock.state.requests[0].profile,IDS.profile);assert.equal(r.sent.profileId,IDS.profile);});
    it('refuses non-UUID API keys before network traffic',async()=>{const c=new Client('invalid');await assert.rejects(c.request('GET','/v3/me'),/UUID/);});
    it('has no enumerable credential',()=>{assert.ok(!JSON.stringify(client).includes(MOCK_KEY));});
    it('redacts nested keys, signing secrets and reflected credentials',()=>{const c=client.sanitize({api_key:'other',error:{message:'bad '+MOCK_KEY+' whsec_YWJjZA==',signing_secret:'secret'}});assert.ok(!JSON.stringify(c).includes(MOCK_KEY));assert.equal(c.api_key,'[redacted]');assert.equal(c.error.signing_secret,'[redacted]');assert.ok(!JSON.stringify(c).includes('whsec_'));});
    it('preserves unknown non-secret fields while cleaning',()=>assert.deepEqual(clean({data:5,items:[{x:true}]}),{data:5,items:[{x:true}]}));
    for(const path of ['https://evil.example/v3/me','//evil.example/v3/me','/v3/../me','/v3/%2e%2e/me','/v3/%252e%252e/me','/v3/\\evil','/v3/%5cevil','/v3//evil','/v3/me?x=1','/v3/me#x','/v2/me','/v3/%0ame','/v3/%zz','/v3/%252f%252fevil'])it('rejects unsafe path '+path,()=>assert.throws(()=>safePath(path)));
    it('preserves encoded leading plus in lookup path',()=>assert.equal(safePath('/v3/numbers/lookup/%2B12025550100'),'/v3/numbers/lookup/%2B12025550100'));
    for(const h of ['x-api-key','X-API-KEY','x-profile-id','host','authorization','proxy-authorization','Idempotency-Key','content-length','connection'])it('rejects custom header '+h,async()=>{await assert.rejects(client.request('GET','/v3/me',{headers:{[h]:'evil'}}));assert.equal(mock.state.requests.length,0);});
    it('allows safe language header and scalar query encoding',async()=>{await client.request('GET','/v3/contacts',{headers:{'Accept-Language':'en'},query:{phone:'+12025550100',page:1,page_size:2}});assert.equal(mock.state.requests[0].query.phone,'+12025550100');});
    it('rejects header newline injection',async()=>assert.rejects(client.request('GET','/v3/me',{headers:{'accept-language':'en\r\nx-api-key:bad'}})));
    it('rejects nested query values',async()=>assert.rejects(client.request('GET','/v3/me',{query:{x:{a:1}}})));
    it('rejects GET body',async()=>assert.rejects(client.request('GET','/v3/me',{body:{}})));
    it('refuses redirects without contacting the destination',async()=>{
        let calls=0;const external=http.createServer((_req,res)=>{calls++;res.end();});await new Promise(r=>external.listen(0,'127.0.0.1',r));
        try{mock.state.failures.push({status:302,headers:{location:'http://127.0.0.1:'+external.address().port+'/steal'}});await assert.rejects(client.request('GET','/v3/me'),e=>e.sent.code==='REDIRECT_REFUSED');assert.equal(calls,0);}finally{await new Promise(r=>external.close(r));}
    });
    it('obeys 429 Retry-After before retrying GET',async()=>{mock.state.failures.push({status:429,headers:{'retry-after':'2'}});await client.request('GET','/v3/me');assert.ok(waits.some(w=>w>=2000));assert.equal(mock.state.requests.length,2);});
    it('returns long Retry-After without retrying early',async()=>{mock.state.failures.push({status:429,headers:{'retry-after':'120'}});await assert.rejects(client.request('GET','/v3/me'),e=>e.sent.retryAfter==='120');assert.equal(mock.state.requests.length,1);});
    it('parses Retry-After HTTP date',()=>assert.equal(retryAfter('Wed, 01 Jan 2025 00:00:02 GMT',Date.parse('2025-01-01T00:00:00Z')),2000));
    it('retries GET network disconnect',async()=>{mock.state.failures.push({disconnect:true});await client.request('GET','/v3/me');assert.equal(mock.state.requests.length,2);});
    it('bounds transient GET retries at three attempts',async()=>{mock.state.failures.push(...Array.from({length:3},()=>({status:503})));await assert.rejects(client.request('GET','/v3/me'));assert.equal(mock.state.requests.length,3);});
    for(const method of ['POST','PUT','PATCH','DELETE'])it('does not retry unprotected '+method,async()=>{mock.state.failures.push({status:503});await assert.rejects(client.request(method,'/v3/messages',{body:{}}));assert.equal(mock.state.requests.length,1);});
    it('reuses mutation idempotency key after a conflict',async()=>{mock.state.failures.push({status:409,code:'CONFLICT_001'});await client.request('POST','/v3/messages',{key:'stable-1',body:{to:['+12025550100'],text:'hello'}});assert.deepEqual(mock.state.requests.map(r=>r.key),['stable-1','stable-1']);});
    it('does not retry other conflict codes',async()=>{mock.state.failures.push({status:409,code:'OTHER'});await assert.rejects(client.request('POST','/v3/messages',{key:'stable',body:{}}));assert.equal(mock.state.requests.length,1);});
    it('preserves replay and original request headers',async()=>{const o={key:'replay',body:{to:['+12025550100'],text:'hello'}};const a=await client.request('POST','/v3/messages',o),b=await client.request('POST','/v3/messages',o);assert.equal(b.sent.idempotentReplayed,true);assert.equal(b.sent.originalRequestId,a.sent.requestId);assert.deepEqual(a.data,b.data);});
    for(const key of ['bad.key','with spaces','x'.repeat(256)])it('rejects malformed idempotency '+key.slice(0,12),async()=>assert.rejects(client.request('POST','/v3/messages',{key,body:{}})));
    it('blocks development override without mock credential',()=>assert.throws(()=>new Client(IDS.account,{development:{baseUrl:mock.url}})));
    it('blocks development override to external hosts',()=>assert.throws(()=>new Client(MOCK_KEY,{development:{baseUrl:'http://example.com'}})));
    it('blocks development override without opt-in',()=>{delete process.env.SENT_NODE_RED_DEVELOPMENT;assert.throws(()=>new Client(MOCK_KEY,{development:{baseUrl:mock.url}}));});
    it('cancels a queued mutation before it can send after node removal',async()=>{client.minInterval=1000;client.wait=require('node:timers/promises').setTimeout;await client.request('GET','/v3/me');const controller=new AbortController();const pending=client.request('POST','/v3/messages',{body:{to:['+12025550100'],text:'cancel me'},key:'cancelled',signal:controller.signal});controller.abort();await assert.rejects(pending,e=>e.sent.code==='CANCELLED');assert.equal(mock.state.requests.length,1);});

});
