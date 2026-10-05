'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const run=promisify(execFile);
const {createMock,MOCK_KEY}=require('./mock');
const buildFlows=require('./build-flows');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function environment(){return Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('Malloc')));}
async function waitFor(check,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){try{const result=await check();if(result)return result;}catch{/* Server not ready yet. */}await pause(150);}throw Error('Timed out waiting for local Node-RED');}
async function prepare(directory,live=false){
    const root=path.resolve(__dirname,'..');
    fs.mkdirSync(directory,{recursive:true});fs.mkdirSync(path.join(root,'qa'),{recursive:true});
    const env=environment();
    const {stdout}=await run('npm',['pack','--json','--pack-destination','qa'],{cwd:root,env});
    const pack=JSON.parse(stdout)[0];fs.writeFileSync(path.join(root,'qa/pack-manifest.json'),JSON.stringify(pack,null,2)+'\n');
    fs.writeFileSync(path.join(directory,'package.json'),JSON.stringify({name:'sent-local-demo',version:'1.0.0',private:true,overrides:require('../package.json').overrides},null,2));
    await run('npm',['install','--cache',path.join(root,'.npm-cache'),'--ignore-scripts','--no-audit','--no-fund',path.join(root,'qa',pack.filename),'node-red@5.0.7'],{cwd:directory,env,maxBuffer:5*1024*1024});
    fs.writeFileSync(path.join(directory,'flows.json'),JSON.stringify(buildFlows(live,!live),null,2));
    fs.writeFileSync(path.join(directory,'runtime-records.jsonl'),'');
    const settings=`'use strict';\nconst fs=require('node:fs');\nmodule.exports={\nuiHost:'127.0.0.1',uiPort:1880,httpNodeRoot:'/api',flowFile:'flows.json',credentialSecret:process.env.NODE_RED_CREDENTIAL_SECRET,\nhttpAdminMiddleware:require('@sentdm/node-red-sent/nodes/lib/raw-body')({httpNodeRoot:'/api'}),\ncontextStorage:{default:{module:'localfilesystem'}},\n${live?'':"sentDevelopment:{baseUrl:'http://127.0.0.1:1881'},sentWebhookBaseUrl:'http://127.0.0.1:1880',"}\nsentInstanceId:'sent-demo-${live?'live':'mock'}',\nlogging:{console:{level:'info',metrics:false,audit:false},qa:{level:'info',metrics:false,audit:false,handler:()=>record=>{${live?'':"fs.appendFileSync(__dirname+'/runtime-records.jsonl',JSON.stringify(record)+'\\n');"}}}},\neditorTheme:{projects:{enabled:false},tours:false},\n};\n`;
    new (require('node:vm').Script)(settings);
    fs.writeFileSync(path.join(directory,'settings.js'),settings);
    return {root,pack};
}
async function exercise(directory,mock){
    const base='http://127.0.0.1:1880';
    await waitFor(async()=>mock.state.webhooks.size===2,45000);
    const nodesResponse=await fetch(base+'/nodes',{headers:{accept:'application/json'}});const nodes=await nodesResponse.json();
    const installed=nodes.find(n=>n.id==='@sentdm/node-red-sent/sent' || n.module==='@sentdm/node-red-sent');
    if(!installed || installed.err || installed.types?.length!==11)throw Error('Packed node registration did not expose all 11 types');
    const html=await (await fetch(base+'/nodes',{headers:{accept:'text/html'}})).text();
    if(!html.includes('data-template-name="sent-account"'))throw Error('Account editor definition missing');
    const flows=buildFlows(false,true);
    for(const n of flows.filter(n=>n.type==='inject' && n.id!=='inject-webhooks')){
        const r=await fetch(base+'/inject/'+n.id,{method:'POST'});if(r.status!==200)throw Error('Inject failed: '+n.id);
    }
    for(const hook of mock.state.webhooks.values()){
        const events=hook.event_types.flatMap(p=>p==='message'?(hook.event_filters.message || ['delivered']).map(t=>'message.'+t):['templates']);
        for(const event of events){const {sample}=require('./mock');if(await mock.emit(hook,sample(event))!==200)throw Error('Signed webhook failed');}
    }
    const hook=[...mock.state.webhooks.values()].find(h=>h.event_filters.message?.includes('received'));
    const {sample}=require('./mock');
    const probe=sample('message.received');
    const raw=Buffer.from(JSON.stringify(probe,null,2));
    const checks=[['valid',{},200],['duplicate',{},200],['tampered',{raw,sentRaw:Buffer.concat([raw,Buffer.from(' ')])},401],['invalid-signature',{headers:{'x-webhook-signature':'v1,'+Buffer.alloc(32).toString('base64')}},401],['missing-header',{headers:{'x-webhook-id':''}},400],['stale',{timestamp:String(Math.floor(Date.now()/1000)-301)},401]];
    const securityChecks=[];
    for(const [name,options,expectedStatus] of checks){const status=await mock.emit(hook,probe,options);if(status!==expectedStatus)throw Error('Fresh runtime security check failed: '+name);securityChecks.push({name,status});}
    const expected=flows.filter(n=>n.type==='debug'&&!['debug-errors','debug-mock-samples'].includes(n.id)).map(n=>n.id);
    const recordsFile=path.join(directory,'runtime-records.jsonl');
    const records=await waitFor(()=>{const rows=fs.readFileSync(recordsFile,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));return expected.every(id=>rows.some(r=>r.id===id))?rows:false;});
    const errors=records.filter(r=>r.level===20 || r.id==='debug-errors');if(errors.length)throw Error('Runtime error logged: '+errors.map(e=>e.id || e.type).join(','));
    for(const id of expected){const record=records.find(r=>r.id===id);if(!String(record.msg).includes('sent:'))throw Error('Missing Sent output metadata: '+id);}
    const flowExport=await(await fetch(base+'/flows')).text();if(flowExport.includes(MOCK_KEY)||flowExport.includes('whsec_'))throw Error('Secret in exported flows');
    return {nodeTypes:installed.types,debugOutputs:expected,actionRequests:mock.state.requests.length,signedDeliveries:mock.state.deliveries,securityChecks,flowExportCredentialFree:true,packedModulePath:path.join(directory,'node_modules/@sentdm/node-red-sent'),nodeRedVersion:require(path.join(directory,'node_modules/node-red/package.json')).version};
}
async function startDemo({directory=path.resolve('.demo'),live=false,fresh=false}={}){
    if(live&&!process.env.SENT_API_KEY)throw Error('Set SENT_API_KEY securely before running demo:live. No live credential is available.');
    const {root,pack}=await prepare(directory,live);
    let mock,child,closing=false;
    const stop=async()=>{if(closing)return;closing=true;if(child&&child.exitCode===null){child.kill('SIGINT');await Promise.race([new Promise(r=>child.once('exit',r)),pause(15000)]);if(child.exitCode===null)child.kill('SIGTERM');}if(mock)await mock.close();};
    try{
        if(!live)mock=await createMock().start(1881);
        const env={...environment(),NODE_RED_CREDENTIAL_SECRET:crypto.randomBytes(32).toString('hex')};
        if(!live){env.SENT_NODE_RED_DEVELOPMENT='1';env.SENT_API_KEY=MOCK_KEY;}
        else{delete env.SENT_NODE_RED_DEVELOPMENT;}
        child=spawn(process.execPath,[path.join(directory,'node_modules/node-red/red.js'),'--userDir',directory,'--settings',path.join(directory,'settings.js')],{env,stdio:['ignore','pipe','pipe']});
        const log=fs.createWriteStream(path.join(directory,'node-red.log'));child.stdout.pipe(log);child.stderr.pipe(log);
        child.once('exit',()=>{log.end();});
        await waitFor(async()=>{if(child.exitCode!==null)throw Error('Node-RED exited');const r=await fetch('http://127.0.0.1:1880/');return r.ok;});
        let evidence;
        if(!live){evidence=await exercise(directory,mock);fs.writeFileSync(path.join(root,'qa',fresh?'fresh-install.json':'demo-mock.json'),JSON.stringify({...evidence,tarball:pack.filename},null,2)+'\n');}
        console.log('Sent '+(live?'live sandbox':'mock')+' demo ready: http://localhost:1880');
        if(evidence)console.log('Verified all 11 registered types, '+evidence.debugOutputs.length+' Debug outputs and '+evidence.signedDeliveries.length+' signed deliveries.');
        if(fresh){await stop();evidence.webhookCleanup=mock.state.webhooks.size===0;if(!evidence.webhookCleanup)throw Error('Fresh runtime left an owned webhook');fs.writeFileSync(path.join(root,'qa/fresh-install.json'),JSON.stringify({...evidence,tarball:pack.filename},null,2)+'\n');return evidence;}
        fs.writeFileSync(path.join(directory,'demo.pid'),String(process.pid));
        process.once('SIGINT',()=>stop().then(()=>process.exit(0)));process.once('SIGTERM',()=>stop().then(()=>process.exit(0)));
        return {stop,child,mock,evidence};
    }catch(e){await stop();throw e;}
}
if(require.main===module)startDemo({live:process.argv.includes('--live')}).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={prepare,exercise,startDemo,waitFor};
