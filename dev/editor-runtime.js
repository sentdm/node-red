/* This file is embedded by build-editor.js inside its isolated editor closure. */
RED.nodes.registerType('sent-account', {
    category: 'config', defaults: {name: {value: ''}, useEnv: {value: false}},
    credentials: {apiKey: {type: 'password'}}, label: function(){return this.name || 'Sent Account';},
    oneditprepare: function(){
        const accountId = this.id;
        $('#sent-check').on('click', function(){
            $('#sent-account-status').text('Checking deployed credentials…');
            $.getJSON('sent/accounts/' + encodeURIComponent(accountId) + '/status').done(d => $('#sent-account-status').text('Connected: ' + d.type + (d.name ? ' · ' + d.name : ''))).fail(() => $('#sent-account-status').text('Could not authenticate. Save and deploy the account, then retry.'));
        });
    }
});
for (const [type, label, fields] of definitions) {
    const trigger = type.startsWith('new-');
    const defaults = {name: {value: ''}, account: {value: '', type: 'sent-account', required: true}};
    const typed = [...fields];
    if (type !== 'get-account') {
        defaults.profile = {value: ''};
        if (!trigger) typed.push(['profile','Sender profile','','str']);
    }
    for (const [name, _label, value, inputType] of typed) {
        defaults[name] = {value, validate: function(v){return v === undefined || RED.validators.typedInput(name + 'Type').call(this,v);}};
        defaults[name + 'Type'] = {value: inputType};
    }
    if (type === 'send-message') Object.assign(defaults, {mode:{value:'template'}, templateBy:{value:'id'}, variables:{value:[]}});
    if (type === 'custom-api-call') defaults.method = {value:'GET'};
    if (type === 'new-event') Object.assign(defaults, {events:{value:'message.delivered', required:true}, templateNames:{value:''}});
    RED.nodes.registerType('sent-' + type, {
        category: 'Sent', color: '#DDE6FF', defaults, inputs: trigger ? 0 : 1, outputs: 1,
        icon: 'sent.svg', paletteLabel: label, label: function(){return this.name || label;},
        oneditprepare: function(){
            const node = this;
            let profilePage = 1, templatePage = 1;
            for (const [name, _label, _value, inputType] of typed) {
                if (node[name] === undefined) $('#node-input-' + name).val(_value);
                $('#node-input-' + name).typedInput({default:inputType, typeField:'#node-input-' + name + 'Type', types: ['str','msg','json','num','bool','env']});
            }
            function lookup(resource, query, apply){
                const account = $('#node-input-account').val();
                if (!account || account === '_ADD_') {$('#sent-lookup-status').text('Save and deploy a Sent Account first. Manual values still work.'); return;}
                const profileInput = $('#node-input-profile');
                const dynamic = !trigger && profileInput.length && profileInput.typedInput('type') !== 'str';
                if (dynamic && resource !== 'profiles') {$('#sent-lookup-status').text('Choose a fixed profile for discovery. Dynamic profiles are evaluated at runtime.');return;}
                query.profile = resource === 'profiles' ? '' : profileInput.val() || '';
                $('#sent-lookup-status').text('Loading…');
                $.getJSON('sent/accounts/' + encodeURIComponent(account) + '/' + resource,query).done(d=>{
                    $('#sent-lookup-status').text('Options loaded. Manual values remain available.'); apply(d);
                }).fail(()=>$('#sent-lookup-status').text('Options unavailable. Deploy credentials or enter manual values.'));
            }
            function loadProfiles(){lookup('profiles',{page:profilePage},d=>{
                const select=$('#sent-profile-options').empty().append($('<option>').val('').text('Choose profile — page '+profilePage));
                for(const p of d.sender_profiles || []) select.append($('<option>').val(p.id).text(p.name || p.id));
            });}
            $('#sent-profiles').on('click',()=>{profilePage=1;loadProfiles();});
            $('#sent-profiles-next').on('click',()=>{profilePage++;loadProfiles();});
            $('#sent-profile-options').on('change',function(){if(!this.value)return;if(!trigger)$('#node-input-profile').typedInput('type','str');if(trigger)$('#node-input-profile').val(this.value);else $('#node-input-profile').typedInput('value',this.value);});
            function variables(rows){
                $('#sent-variables').empty();
                rows.forEach((row,index)=>{
                    const outer=$('<div>').addClass('form-row sent-variable').data('variableName',row.name).appendTo('#sent-variables');
                    $('<label>').text(row.name).appendTo(outer);
                    const hidden=$('<input type="hidden">').attr('id','sent-var-type-'+index).val(row.type || 'str').appendTo(outer);
                    $('<input type="text">').val(row.value ?? '').appendTo(outer).typedInput({typeField:hidden,types:['str','msg','num','bool','env'],default:row.type || 'str'});
                });
            }
            if(type==='send-message'){
                if(node.templateBy === undefined) $('#node-input-templateBy').val('id');
                if(node.mode === undefined) $('#node-input-mode').val('template');
                variables(node.variables || []);
                const showMode=()=>{$('.sent-template').toggle($('#node-input-mode').val()==='template');$('.sent-text').toggle($('#node-input-mode').val()==='text');};
                $('#node-input-mode').on('change',showMode);showMode();
                function templates(){lookup('templates',{page:templatePage,search:$('#sent-template-search').val()},d=>{
                    const select=$('#sent-template-options').empty().append($('<option>').val('').text('Choose approved template — page '+templatePage));
                    for(const t of d.templates || [])select.append($('<option>').val(t.id).text(t.name || t.id));
                });}
                $('#sent-templates').on('click',()=>{templatePage=1;templates();});
                $('#sent-templates-next').on('click',()=>{templatePage++;templates();});
                $('#sent-template-options').on('change',function(){
                    if(!this.value)return;$('#node-input-template').typedInput('type','str');$('#node-input-template').typedInput('value',this.value);$('#node-input-templateBy').val('id');
                    lookup('template',{id:this.value},d=>variables((d.variables || []).map(name=>({name,type:'str',value:''}))));
                });
            }
            $('#sent-events').on('click',()=>lookup('events',{},d=>{
                const root=$('#sent-event-options').empty(), selected=String($('#node-input-events').val()).split(',').map(s=>s.trim());
                function add(entry,parent){
                    const value=entry.event_type || (parent && !String(entry.name).includes('.') ? parent+'.'+entry.name : entry.name);
                    if(!value || entry.is_active===false)return;
                    if(entry.sub_types?.length){entry.sub_types.forEach(s=>add(s,value));return;}
                    const line=$('<label>').css({display:'block',width:'100%'}).appendTo(root);
                    $('<input type="checkbox">').css('width','auto').val(value).prop('checked',selected.includes(value)).appendTo(line).on('change',()=>$('#node-input-events').val(root.find('input:checked').map(function(){return this.value;}).get().join(',')));
                    line.append(document.createTextNode(' '+(entry.display_name || value)));
                }
                (d.event_types || []).forEach(e=>add(e));
            }));
        },
        oneditsave: function(){
            if(type==='send-message')this.variables=$('#sent-variables .sent-variable').map(function(){const input=$(this).find('input[type=text]');return {name:$(this).data('variableName'),type:input.typedInput('type'),value:input.typedInput('value')};}).get();
        }
    });
}
