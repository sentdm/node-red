'use strict';
const assert=require('node:assert/strict');
const http=require('node:http');
const helper=require('node-red-node-test-helper');
const sent=require('../nodes/sent');
const {TYPES}=require('../nodes/lib/actions');
const {createMock,IDS,MOCK_KEY,sample}=require('../dev/mock');
helper.init(require.resolve('node-red'));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const base={
    'get-account':{},'send-message':{mode:'text',to:'+12025550100',toType:'str',text:'Hello',textType:'str'},
    'get-message-status':{messageId:IDS.message,messageIdType:'str'},'get-message-activities':{messageId:IDS.message,messageIdType:'str'},
    'list-contacts':{},'get-contact':{contactId:IDS.contact,contactIdType:'str'},'get-phone-number-details':{phone:'+12025550100',phoneType:'str'},'custom-api-call':{path:'/v3/me'}
};
describe('Node-RED runtime integration',function(){
    let mock,hookServer;
    async function testModule(RED){sent(RED);hookServer=http.createServer(RED.httpNode);await new Promise(r=>hookServer.listen(0,'127.0.0.1',r));RED.settings.sentWebhookBaseUrl='http://127.0.0.1:'+hookServer.address().port;}
    beforeEach(async()=>{process.env.SENT_NODE_RED_DEVELOPMENT='1';mock=await createMock().start();helper.settings({sentDevelopment:{baseUrl:mock.url},sentInstanceId:'test-instance',userDir:require('node:path').resolve('.test-runtime')});await new Promise(r=>helper.startServer(r));helper.settings({sentDevelopment:{baseUrl:mock.url},sentWebhookBaseUrl:helper.url().replace('localhost','127.0.0.1'),sentInstanceId:'test-instance',userDir:require('node:path').resolve('.test-runtime')});});
    afterEach(async()=>{await helper.unload();if(hookServer){hookServer.closeAllConnections();await new Promise(r=>hookServer.close(r));}await new Promise(r=>helper.stopServer(r));await mock.close();});
    async function load(type,config={}){const flow=[{id:'account',type:'sent-account',name:'QA account'},{id:'action',type:'sent-'+type,account:'account',...base[type],...config,wires:[['output']]},{id:'output',type:'helper'}];await helper.load(testModule,flow,{account:{apiKey:MOCK_KEY}});return {node:helper.getNode('action'),account:helper.getNode('account'),flow};}
    async function input(msg={payload:{},_msgid:'stable-message'}){return new Promise((resolve,reject)=>{const node=helper.getNode('action');helper.getNode('output').once('input',resolve);node.on('call:error',call=>reject(call.args[0]));node.receive(msg);});}
    async function expectError(msg={payload:{}}){const node=helper.getNode('action');const result=new Promise(resolve=>node.once('call:error',call=>resolve(call.args)));node.receive(msg);const args=await result;assert.ok(args[0]);assert.ok(args[1].sent.error);return args[1].sent.error;}
    it('loads config with isolated password credentials and checks auth',async()=>{const {account,flow}=await load('get-account');assert.equal(account.credentials.apiKey,MOCK_KEY);assert.ok(!JSON.stringify(flow).includes(MOCK_KEY));assert.equal((await account.authenticate()).type,'organization');});
    it('rejects invalid account authentication',async()=>{const {account}=await load('get-account');mock.state.failures.push({status:401});await assert.rejects(account.authenticate());});
    it('does not attach org profile headers to profile keys',async()=>{mock.state.accountType='profile';await load('get-contact',{profile:IDS.profile});const error=await expectError();assert.match(error.message,/organization/);assert.equal(mock.state.requests.length,1);assert.equal(mock.state.requests[0].profile,undefined);});
    for(const type of TYPES){
        it(type+' succeeds and preserves incoming msg',async()=>{await load(type);const out=await input({payload:{},custom:'keep',_msgid:'m1'});assert.equal(out.custom,'keep');assert.ok(out.sent.statusCode>=200&&out.sent.statusCode<300);assert.ok(out.payload);});
        it(type+' exposes structured API errors to Catch',async()=>{await load(type);mock.state.failures.push({status:400,code:'VALIDATION_001'});const e=await expectError();assert.equal(e.statusCode,400);assert.equal(e.code,'VALIDATION_001');assert.ok(e.requestId);});
        if(type!=='get-account')it(type+' passes validated profile scope',async()=>{await load(type,{profile:IDS.profile,profileType:'str'});await input();assert.equal(mock.state.requests.at(-1).profile,IDS.profile);});
    }
    const dynamicCases=[['get-message-status','messageId',IDS.message],['get-message-activities','messageId',IDS.message],['get-contact','contactId',IDS.contact],['get-phone-number-details','phone','+12025550100'],['custom-api-call','path','/v3/me'],['list-contacts','search','202']];
    for(const [type,field,value]of dynamicCases){
        it(type+' resolves typed msg input',async()=>{await load(type,{[field]:'request.value',[field+'Type']:'msg'});const out=await input({request:{value}});assert.equal(out.sent.statusCode,200);});
        it(type+' validates input before request',async()=>{const value=type==='list-contacts'?{page:0,pageType:'num'}:{[field]:'', [field+'Type']:'str'};await load(type,value);const e=await expectError();assert.equal(e.code,'INPUT_INVALID');});
    }
    it('Send supports template variables and sandbox',async()=>{await load('send-message',{mode:'template',template:IDS.template,parameters:'{"name":"Ada"}',parametersType:'json',variables:[{name:'company',type:'msg',value:'company'}],sandbox:true,sandboxType:'bool'});const out=await input({company:'Example'});const req=mock.state.requests.at(-1);assert.deepEqual(req.body.template.parameters,{name:'Ada',company:'Example'});assert.equal(req.body.sandbox,true);assert.equal(out.sent.sandbox,true);assert.equal(mock.state.messages.size,1);});
    it('Send supports template name fallback',async()=>{await load('send-message',{mode:'template',template:'welcome',templateBy:'name'});await input();assert.equal(mock.state.requests.at(-1).body.template.name,'welcome');});
    it('Send supports dynamic recipient array and free-form text',async()=>{await load('send-message',{to:'payload.to',toType:'msg',text:'payload.text',textType:'msg'});await input({payload:{to:['+12025550100','+12025550101'],text:'Hi'}});assert.equal(mock.state.requests.at(-1).body.to.length,2);});
    for(const channel of ['sent','sms','whatsapp','rcs'])it('Send supports '+channel,async()=>{await load('send-message',{channel});await input();assert.deepEqual(mock.state.requests.at(-1).body.channel,[channel]);});
    it('Send broadcasts channel array',async()=>{await load('send-message',{channel:'["sms","whatsapp"]',channelType:'json'});const out=await input();assert.equal(out.payload.recipients.length,2);});
    it('Send permits omitted channel',async()=>{await load('send-message',{channel:''});await input();assert.equal(mock.state.requests.at(-1).body.channel,undefined);});
    it('Send accepts explicit key',async()=>{await load('send-message',{idempotencyKey:'my-key'});await input();assert.equal(mock.state.requests.at(-1).key,'my-key');});
    it('Send uses same generated key and body across retries',async()=>{await load('send-message');mock.state.failures.push({status:503});await input();assert.match(mock.state.requests[0].key,/^nr_[a-f0-9]{64}$/);assert.equal(mock.state.requests[0].key,mock.state.requests[1].key);assert.deepEqual(mock.state.requests[0].body,mock.state.requests[1].body);});
    it('Send stable msg identity replays once',async()=>{await load('send-message');await input();const out=await input();assert.equal(out.sent.idempotentReplayed,true);assert.equal(mock.state.messages.size,2);});
    it('Send acceptance is not delivery',async()=>{const {node}=await load('send-message');const out=await input();assert.equal(out.sent.statusCode,202);assert.equal(out.payload.status,'QUEUED');assert.equal(node.status.lastCall.args[0].text,'accepted');});
    for(const bad of [{to:'12025550100'},{to:''},{channel:'email'},{text:''},{mode:'unknown'},{mode:'template',template:''},{parameters:'[]',parametersType:'json',mode:'template',template:IDS.template},{sandbox:'yes',sandboxType:'str'}])it('Send rejects invalid '+JSON.stringify(bad),async()=>{await load('send-message',bad);assert.equal((await expectError()).code,'INPUT_INVALID');});
    it('Contacts pages are distinct and stop at last page',async()=>{await load('list-contacts',{page:'page',pageType:'msg',pageSize:2,pageSizeType:'num'});const a=await input({page:1}),b=await input({page:2});assert.equal(a.payload.contacts.length,2);assert.equal(b.payload.contacts.length,1);assert.equal(b.payload.pagination.has_next_page,false);assert.notEqual(a.payload.contacts[0].id,b.payload.contacts[0].id);});
    it('Contacts filters preserve plus and scope',async()=>{await load('list-contacts',{phoneFilter:'+12025550100',contactChannel:'sms',search:'202'});await input();const q=mock.state.requests.at(-1).query;assert.equal(q.phone,'+12025550100');assert.equal(q.channel,'sms');assert.equal(q.search,'202');});
    it('Custom preserves a nonstandard successful body',async()=>{await load('custom-api-call');mock.state.failures.push({status:200,body:{plain:'value'}});const out=await input();assert.deepEqual(out.payload,{plain:'value'});});
    it('Custom redacts secrets returned by API',async()=>{await load('custom-api-call');mock.state.failures.push({status:200,body:{success:true,data:{api_key:MOCK_KEY,signing_secret:'whsec_c2VjcmV0'}}});const out=await input();assert.ok(!JSON.stringify(out).includes(MOCK_KEY));assert.equal(out.payload.signing_secret,'[redacted]');});
    it('closing an account cancels queued requests and rejects later authentication',async()=>{
        const {account}=await load('get-account');
        mock.state.failures.push({status:429,headers:{'retry-after':'120'}});
        await assert.rejects(account.request('GET','/v3/me'));
        const pending=account.request('GET','/v3/me');
        const cancelled=assert.rejects(pending,e=>e.sent.code==='CANCELLED');
        await helper.unload();
        await cancelled;
        await assert.rejects(account.authenticate(),/closing/);
        assert.equal(mock.state.requests.length,1);
    });
    for(const path of ['https://evil.example/v3/me','//evil.example','/v3/%2e%2e/me'])it('Custom runtime rejects SSRF '+path,async()=>{await load('custom-api-call',{path});await expectError();assert.equal(mock.state.requests.length,0);});
    it('Admin lookups support profiles, templates, variables and event types',async()=>{await load('get-account');for(const resource of ['status','profiles','templates','template?id='+IDS.template,'events']){const r=await helper.request().get('/sent/accounts/account/'+resource).expect(200);assert.ok(!JSON.stringify(r.body).includes(MOCK_KEY));}assert.ok(mock.state.requests.some(r=>r.path==='/v3/sender-profiles'));assert.ok(mock.state.requests.some(r=>r.query.status==='APPROVED'));});
    it('Admin rejects undeployed accounts and arbitrary resources',async()=>{await load('get-account');await helper.request().get('/sent/accounts/missing/status').expect(404);await helper.request().get('/sent/accounts/account/evil').expect(404);});
    async function trigger(type='new-event',config={}){const loaded=await load(type,config);await loaded.node.ready;assert.equal(mock.state.webhooks.size,1);return {...loaded,hook:[...mock.state.webhooks.values()][0]};}
    it('registers canonical event parent/filter and reports active',async()=>{const {hook,node}=await trigger('new-event',{events:'message.delivered,message.failed'});assert.deepEqual(hook.event_types,['message']);assert.deepEqual(hook.event_filters.message,['delivered','failed']);assert.equal(node.status.lastCall.args[0].text,'webhook active');});
    it('specialized trigger registers only received',async()=>{const {hook}=await trigger('new-message-received',{events:'message.delivered'});assert.deepEqual(hook.event_filters,{message:['received']});});
    it('deletes owned webhook on close',async()=>{await trigger();await helper.unload();assert.equal(mock.state.webhooks.size,0);});
    it('redeploy creates one subscription and removes previous',async()=>{const {flow,hook}=await trigger();await helper.setFlows(flow,'full',{account:{apiKey:MOCK_KEY}});await helper.getNode('action').ready;assert.equal(mock.state.webhooks.size,1);assert.ok(!mock.state.webhooks.has(hook.id));});
    it('cleans crash orphans by exact owner and preserves unrelated hooks',async()=>{const {flow,hook}=await trigger();await helper.unload();hookServer.closeAllConnections();await new Promise(r=>hookServer.close(r));const orphan={...hook,id:'60000000-0000-4000-8000-000000000001'};mock.state.webhooks.set(orphan.id,orphan);const unrelated={...hook,id:'60000000-0000-4000-8000-000000000002',display_name:hook.display_name+'-other'};mock.state.webhooks.set(unrelated.id,unrelated);await helper.load(testModule,flow,{account:{apiKey:MOCK_KEY}});await helper.getNode('action').ready;assert.ok(!mock.state.webhooks.has(orphan.id));assert.ok(mock.state.webhooks.has(unrelated.id));assert.equal(mock.state.webhooks.size,2);});
    it('failed registration never marks active',async()=>{mock.state.failures.push({method:'POST',status:400});const {node}=await load('new-event');await node.ready;assert.equal(node.status.lastCall.args[0].text,'registration failed');assert.equal(mock.state.webhooks.size,0);});
    it('registration rejects short signing secrets and deletes the created webhook',async()=>{
        mock.state.failures.push({method:'POST',status:201,body:{success:true,data:{id:IDS.message,signing_secret:'whsec_YQ=='}}});
        const {node}=await load('new-event');await node.ready;
        assert.equal(node.status.lastCall.args[0].text,'registration failed');
        assert.ok(mock.state.requests.some(r=>r.method==='DELETE'&&r.path==='/v3/webhooks/'+IDS.message));
    });
    it('exact raw whitespace/unicode payload succeeds',async()=>{const {hook}=await trigger();const event=sample('message.delivered');event.payload.note='Unicode é ☺';const raw=Buffer.from(JSON.stringify(event,null,3)+'\n');const output=new Promise(r=>helper.getNode('output').once('input',r));assert.equal(await mock.emit(hook,event,{raw}),200);assert.deepEqual((await output).payload,event);});
    it('one byte raw payload modification fails',async()=>{const {hook}=await trigger();const event=sample('message.delivered');const raw=Buffer.from(JSON.stringify(event));const tamper=Buffer.from(raw);tamper[tamper.length-2]=32;assert.equal(await mock.emit(hook,event,{raw,sentRaw:tamper}),401);});
    it('invalid signature fails',async()=>{const {hook}=await trigger();assert.equal(await mock.emit(hook,sample('message.delivered'),{headers:{'x-webhook-signature':'v1,'+Buffer.alloc(32).toString('base64')}}),401);});
    it('invalid signing secret fails',async()=>{const {hook}=await trigger();assert.equal(await mock.emit({...hook,signing_secret:'whsec_'+Buffer.alloc(32).toString('base64')},sample('message.delivered')),401);});
    it('API error logs omit reflected customer content while Catch retains diagnostics',async()=>{
        await load('get-account');mock.state.failures.push({status:400,code:'VALIDATION_001',message:'Private fixture content'});
        const node=helper.getNode('action');await expectError();
        const error=node.error.lastCall.args[0],msg=node.error.lastCall.args[1];
        assert.equal(error.message,'Sent request failed HTTP 400 (VALIDATION_001)');
        assert.equal(msg.sent.error.message,'Private fixture content');
    });
    for(const header of ['x-webhook-signature','x-webhook-id','x-webhook-timestamp','x-webhook-event-type'])it('missing '+header+' fails',async()=>{const {hook}=await trigger();assert.equal(await mock.emit(hook,sample('message.delivered'),{headers:{[header]:''}}),400);});
    for(const offset of [-301,301])it('rejects replay timestamp '+offset,async()=>{const {hook}=await trigger();assert.equal(await mock.emit(hook,sample('message.delivered'),{timestamp:String(Math.floor(Date.now()/1000)+offset)}),401);});
    it('returns 2xx for ignored outbound events without emitting',async()=>{const {hook,node}=await trigger('new-message-received');assert.equal(await mock.emit(hook,sample('message.delivered')),200);await pause(20);assert.equal(node.send.callCount,0);});
    it('New Event filters while acknowledging unrelated subtypes',async()=>{const {hook,node}=await trigger('new-event',{events:'message.delivered'});assert.equal(await mock.emit(hook,sample('message.sent')),200);await pause(10);assert.equal(node.send.callCount,0);});
    for(const [type,config,eventType] of [['new-message-received',{},'message.received'],['new-event',{events:'message.delivered'},'message.delivered'],['new-event',{events:'templates'},'templates']])it('deduplicates '+eventType+' and returns 2xx',async()=>{const {hook,node}=await trigger(type,config);const event=sample(eventType);assert.equal(await mock.emit(hook,event),200);assert.equal(await mock.emit(hook,event),200);await pause(20);assert.equal(node.send.callCount,1);assert.ok(!JSON.stringify(node.send.firstCall.args).includes('whsec_'));});
    it('same webhook ID accepts distinct outbound states',async()=>{const {hook,node}=await trigger('new-event',{events:'message'});const event=sample('message.sent');await mock.emit(hook,event);event.event='message.delivered';event.payload.message_status='DELIVERED';await mock.emit(hook,event);await pause(10);assert.equal(node.send.callCount,2);});
    it('acknowledges before downstream asynchronous work completes',async()=>{const {hook}=await trigger();let finished=false;helper.getNode('output').on('input',()=>setTimeout(()=>{finished=true;},200));const start=Date.now();assert.equal(await mock.emit(hook,sample('message.delivered')),200);assert.equal(finished,false);assert.ok(Date.now()-start<200);await pause(210);});
    it('event metadata preserves complete envelope without signing secret',async()=>{const {hook}=await trigger('new-message-received');const event=sample('message.received'),promise=new Promise(r=>helper.getNode('output').once('input',r));await mock.emit(hook,event);const msg=await promise;assert.equal(msg.topic,event.event);assert.equal(msg.sent.webhook.id,hook.id);assert.deepEqual(msg.payload,event);assert.ok(!JSON.stringify(msg).includes(hook.signing_secret));});
    it('webhook outputs redact reflected account credentials in ordinary string fields',async()=>{
        const {hook}=await trigger('new-message-received');
        const event=sample('message.received');event.payload.content='reflected '+MOCK_KEY;
        const output=new Promise(r=>helper.getNode('output').once('input',r));
        assert.equal(await mock.emit(hook,event),200);
        assert.equal((await output).payload.payload.content,'reflected [redacted]');
    });
    it('rejects malformed signed JSON',async()=>{const {hook}=await trigger();assert.equal(await mock.emit(hook,sample('message.delivered'),{raw:Buffer.from('{broken')}),400);});
    it('rejects header/envelope event mismatch',async()=>{const {hook}=await trigger();assert.equal(await mock.emit(hook,sample('message.delivered'),{headers:{'x-webhook-event-type':'message.received'}}),400);});
    it('rejects a body exceeding one MiB',async()=>{const {hook}=await trigger();const e=sample('message.delivered');e.payload.large='x'.repeat(1024*1024);assert.equal(await mock.emit(hook,e),413);});
    it('rejects compressed webhook bodies',async()=>{const {hook}=await trigger();assert.equal(await mock.emit(hook,sample('message.delivered'),{headers:{'content-encoding':'gzip'}}),415);});
    it('removed receiver returns 404',async()=>{const {hook}=await trigger();await helper.setFlows([{id:'account',type:'sent-account'}],'full',{account:{apiKey:MOCK_KEY}});assert.equal(await mock.emit(hook,sample('message.delivered')),404);});
    it('template-name filtering emits matching templates only',async()=>{const {hook,node}=await trigger('new-event',{events:'templates',templateNames:'welcome'});const e=sample('templates');e.payload.template_name='other';assert.equal(await mock.emit(hook,e),200);await pause(5);assert.equal(node.send.callCount,0);e.payload.template_name='welcome';await mock.emit(hook,e);await pause(5);assert.equal(node.send.callCount,1);});
    it('webhook test API delivers through receiver',async()=>{const {hook,account}=await trigger('new-message-received');const result=await account.request('POST','/v3/webhooks/'+hook.id+'/test',{body:{event_type:'message.received'}});assert.equal(result.data.success,true);});
    it('missing account raises Catch with preserved input',async()=>{await helper.load(testModule,[{id:'action',type:'sent-get-account',account:'missing'}]);assert.match((await expectError({original:'keep'})).message,/Account/);});

});
