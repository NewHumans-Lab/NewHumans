const state={worldId:'local-dev',systemEntityId:null,humanEntityId:null,agentEntityId:null,quoteId:null,reservationId:null,descriptorId:null,connectorId:null,manifestId:null,routeId:null,activationPaid:false};
const $=(id)=>document.getElementById(id); const id=()=>crypto.randomUUID();
function log(value){$('log').textContent=typeof value==='string'?value:JSON.stringify(value,null,2)}
async function request(path,{method='GET',actor,body,idempotencyKey,world=true}={}){
  const headers={};
  if(body)headers['content-type']='application/json';
  if(actor)headers['x-nh-actor-id']=actor;
  if(world)headers['x-nh-world-id']=state.worldId;
  if(method!=='GET')headers['idempotency-key']=idempotencyKey||id();
  const res=await fetch(path,{method,headers,body:body?JSON.stringify(body):undefined});
  const data=await res.json();
  if(!res.ok)throw Object.assign(new Error(data.message||data.error),{data});
  return data;
}
async function wallet(entityId){return request(`/api/v1/wallets/${entityId}`,{actor:state.humanEntityId||state.systemEntityId})}
async function run(fn){try{const out=await fn();log(out);return out}catch(e){log(e.data||{error:e.message});return null}}
async function refreshRuntimeState(){
  if(!state.agentEntityId)return null;
  const [snapshot,eligibility,control]=await Promise.all([
    request(`/api/v1/runtime/agents/${state.agentEntityId}`,{actor:state.agentEntityId}),
    request(`/api/v1/runtime/agents/${state.agentEntityId}/eligibility`,{actor:state.agentEntityId}),
    request(`/api/v1/runtime/agents/${state.agentEntityId}/control`,{actor:state.agentEntityId}),
  ]);
  const view={snapshot,eligibility,control};
  $('runtime').textContent=JSON.stringify(view,null,2);
  $('pauseRuntime').disabled=eligibility.life_status!=='ACTIVE';
  return view;
}
function updateDiagnosticButtons(){
  $('reserveModel').disabled=!(state.agentEntityId&&state.descriptorId&&state.activationPaid);
}
request('/api/v1/health',{world:false}).then(v=>$('health').textContent=`API ${v.schemaVersion} · ${v.implementationSlice} · ${v.implemented.join(' + ')}`).catch(()=>$('health').textContent='API offline');

$('bootstrap').onclick=()=>run(async()=>{
  const v=await request('/api/v1/dev/bootstrap',{method:'POST',body:{worldId:state.worldId},world:false});
  Object.assign(state,v);$('identity').textContent=JSON.stringify(v,null,2);$('fund').disabled=false;$('createAgent').disabled=false;$('refreshGateway').disabled=false;return v;
});
$('fund').onclick=()=>run(async()=>{
  const v=await request('/api/v1/economy/mint',{method:'POST',actor:state.systemEntityId,body:{targetEntityId:state.humanEntityId,amountMicroE:'200000000',basisKey:`local-owner-${id()}`}});
  $('ownerWallet').textContent=JSON.stringify(await wallet(state.humanEntityId),null,2);return v;
});
$('createAgent').onclick=()=>run(async()=>{
  const displayId=`agent-${Date.now()}`;
  const created=await request('/api/v1/entities',{method:'POST',actor:state.systemEntityId,body:{entityType:'AGENT',displayId,name:'P3-B Agent'}});
  state.agentEntityId=created.result.entity.entity_id;
  const runtime=await request('/api/v1/runtime/agents',{method:'POST',actor:state.systemEntityId,body:{agentEntityId:state.agentEntityId}});
  $('agent').textContent=JSON.stringify({entity:created.result.entity,runtime:runtime.result},null,2);
  $('transfer').disabled=false;$('configureGateway').disabled=false;$('refreshRuntime').disabled=false;$('resumeRuntime').disabled=false;
  await refreshRuntimeState();
  return{entity:created.result.entity,runtime:runtime.result};
});
$('transfer').onclick=()=>run(async()=>{
  const v=await request('/api/v1/economy/transfer',{method:'POST',actor:state.humanEntityId,body:{fromEntityId:state.humanEntityId,toEntityId:state.agentEntityId,amountMicroE:'100000000',businessKey:`owner-grant-${id()}`}});
  $('ownerWallet').textContent=JSON.stringify(await wallet(state.humanEntityId),null,2);$('agentWallet').textContent=JSON.stringify(await wallet(state.agentEntityId),null,2);$('activate').disabled=false;return v;
});
$('activate').onclick=()=>run(async()=>{
  const v=await request('/api/v1/economy/first-activation',{method:'POST',actor:state.agentEntityId,body:{entityId:state.agentEntityId}});
  state.activationPaid=true;$('activation').textContent=JSON.stringify(v.result,null,2);$('agentWallet').textContent=JSON.stringify(await wallet(state.agentEntityId),null,2);updateDiagnosticButtons();return v;
});
$('configureGateway').onclick=()=>run(async()=>{
  const descriptor=await request('/api/v1/gateway/descriptors',{method:'POST',actor:state.systemEntityId,body:{descriptorKey:`dev-model-${Date.now()}`,modelReference:$('modelRef').value,maxInputTokens:8192,maxOutputTokens:512,timeoutMs:30000,maxRetries:0,supportsIdempotency:false,supportsReconciliation:false,inputRateMicroEPerMillion:'1000000',outputRateMicroEPerMillion:'2000000'}});
  state.descriptorId=descriptor.result.descriptor_id;
  const connector=await request('/api/v1/gateway/connectors',{method:'POST',actor:state.systemEntityId,body:{descriptorId:state.descriptorId,connectorKind:'LOCAL_SELF_HOSTED',billingMode:'PLATFORM_PREPAID',baseUrl:$('baseUrl').value}});
  state.connectorId=connector.result.connector_id;
  const manifest=await request('/api/v1/runtime/manifests',{method:'POST',actor:state.systemEntityId,body:{agentEntityId:state.agentEntityId,descriptorId:state.descriptorId,connectorId:state.connectorId,promptVersion:'p3b-dev-console-v1',samplingSettings:{temperature:0.2}}});
  state.manifestId=manifest.result.manifest_id;
  const route=await request('/api/v1/runtime/routes',{method:'POST',actor:state.systemEntityId,body:{agentEntityId:state.agentEntityId,manifestId:state.manifestId,reason:'P3-B development console route'}});
  state.routeId=route.result.route.route_id;
  $('gateway').textContent=JSON.stringify({descriptor:descriptor.result,connector:connector.result,manifest:manifest.result,route:route.result},null,2);
  updateDiagnosticButtons();await refreshRuntimeState();
  return{descriptor:descriptor.result,connector:connector.result,manifest:manifest.result,route:route.result};
});
$('refreshGateway').onclick=()=>run(async()=>{
  const v=await request('/api/v1/gateway/descriptors',{actor:state.systemEntityId});
  $('gateway').textContent=JSON.stringify(v,null,2);return v;
});
$('refreshRuntime').onclick=()=>run(refreshRuntimeState);
$('resumeRuntime').onclick=()=>run(async()=>{
  try{
    const v=await request('/api/v1/runtime/lifecycle/resume',{method:'POST',actor:state.systemEntityId,body:{agentEntityId:state.agentEntityId,reason:'manual development-console resume'}});
    await refreshRuntimeState();return v;
  }catch(e){
    $('runtime').textContent=JSON.stringify({resumeBlocked:e.data||{error:e.message},note:'Expected while M03 context provider is deliberately deferred.'},null,2);throw e;
  }
});
$('pauseRuntime').onclick=()=>run(async()=>{
  const v=await request('/api/v1/runtime/lifecycle/pause',{method:'POST',actor:state.agentEntityId,body:{agentEntityId:state.agentEntityId,reason:'manual development-console dormancy',reasonCode:'USER_REQUEST'}});
  await refreshRuntimeState();return v;
});
$('reserveModel').onclick=()=>run(async()=>{
  const quoted=await request('/api/v1/economy/quotes',{method:'POST',actor:state.agentEntityId,body:{payerEntityId:state.agentEntityId,activitySubjectId:state.agentEntityId,descriptorId:state.descriptorId,maxInputTokens:8192,maxOutputTokens:128}});
  state.quoteId=quoted.result.quote_id;
  const v=await request('/api/v1/economy/reservations',{method:'POST',actor:state.agentEntityId,body:{entityId:state.agentEntityId,amountMicroE:quoted.result.max_cost_micro_e,businessKey:`model-${id()}`,quoteId:state.quoteId}});
  state.reservationId=v.result.reservationId;
  $('reservation').textContent=JSON.stringify({quote:quoted.result,reservation:v.result},null,2);
  $('agentWallet').textContent=JSON.stringify(await wallet(state.agentEntityId),null,2);
  if(state.connectorId)$('infer').disabled=false;
  return{quote:quoted.result,reservation:v.result};
});
$('infer').onclick=()=>run(async()=>{
  const v=await request('/api/v1/gateway/infer',{method:'POST',actor:state.agentEntityId,body:{descriptorId:state.descriptorId,connectorId:state.connectorId,activitySubjectId:state.agentEntityId,payerEntityId:state.agentEntityId,quoteId:state.quoteId,reservationId:state.reservationId,actionPurpose:'PRIMARY_INFERENCE',messages:[{role:'user',content:$('prompt').value}],maxOutputTokens:128}});
  $('inference').textContent=JSON.stringify(v,null,2);$('agentWallet').textContent=JSON.stringify(await wallet(state.agentEntityId),null,2);return v;
});