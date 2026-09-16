import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, withTransaction } from '../db.js';
import { createEntity, runCommand } from '../services/core.js';
import { chargeDailyActivityFee, firstActivation, getWallet, mint, releaseReservation, reserve, transfer } from '../services/economy.js';
import { buildCommandEnvelope, toRunCommand } from '../shared/contracts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');
if (process.env.NODE_ENV === 'production') throw new Error('P0/P1 development auth adapter is not production authentication');
const pool = createPool(); const port = Number(process.env.PORT || 3000);
function json(res,status,body){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(body))}
async function body(req){const chunks=[];for await(const chunk of req)chunks.push(chunk);return chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):{}}
function actor(req){return req.headers['x-nh-actor-id']} function key(req){return req.headers['idempotency-key']} function utcDate(){return new Date().toISOString().slice(0,10)}
function canonicalCommand(req,data,commandType){
  const {worldId,...payload}=data;
  const envelope=buildCommandEnvelope({worldId,commandType,idempotencyKey:key(req),payload});
  // Keep the P0/P1 Action payload hash based on the original HTTP body so an
  // in-flight retry created before P1.1 remains replay-compatible after upgrade.
  return {run:{...toRunCommand(envelope,actor(req)),payload:data},data:{worldId:envelope.world_id,...envelope.payload}};
}

async function api(req,res,url){
  if(req.method==='GET'&&url.pathname==='/api/v1/health')return json(res,200,{ok:true,schemaVersion:'nh.v3.0'});
  if(req.method==='POST'&&url.pathname==='/api/v1/dev/bootstrap'){
    if(process.env.NODE_ENV==='production'||process.env.LOCAL_DEV_BOOTSTRAP!=='true')return json(res,404,{error:'NOT_FOUND'});
    const data=await body(req),worldId=data.worldId||'local-dev';
    const result=await withTransaction(pool,async(client)=>{
      let system=(await client.query("SELECT entity_id FROM core.entities WHERE world_id=$1 AND entity_type='SYSTEM' ORDER BY created_at LIMIT 1",[worldId])).rows[0];
      if(!system)system=await createEntity(client,{worldId,entityType:'SYSTEM',displayId:'system',name:'NewHumans System',origin:'LOCAL_DEV'});
      let human=(await client.query("SELECT entity_id FROM core.entities WHERE world_id=$1 AND display_id='owner'",[worldId])).rows[0];
      if(!human)human=await createEntity(client,{worldId,entityType:'HUMAN',displayId:'owner',name:'Local Owner',createdBy:system.entity_id,origin:'LOCAL_DEV'},{actorEntityId:system.entity_id});
      return{worldId,systemEntityId:system.entity_id,humanEntityId:human.entity_id};
    }); return json(res,200,result);
  }
  if(req.method==='POST'&&url.pathname==='/api/v1/entities'){
    const input=await body(req); const command=canonicalCommand(req,input,'core.create_entity');
    const out=await runCommand(pool,command.run,async(client,ctx)=>{
      if(ctx.actor.entity_type!=='SYSTEM')throw Object.assign(new Error('entity creation requires SYSTEM actor in P1'),{code:'FORBIDDEN',status:403});
      const data=command.data,actorId=ctx.actor.entity_id;
      return{entity:await createEntity(client,{worldId:data.worldId,entityType:data.entityType,displayId:data.displayId,name:data.name,createdBy:actorId,origin:'API'},{actorEntityId:actorId,actionId:ctx.actionId})};
    }); return json(res,201,out);
  }
  const walletMatch=url.pathname.match(/^\/api\/v1\/worlds\/([^/]+)\/wallets\/([0-9a-f-]+)$/);
  if(req.method==='GET'&&walletMatch){const[,worldId,entityId]=walletMatch;return json(res,200,await withTransaction(pool,(client)=>getWallet(client,decodeURIComponent(worldId),entityId)))}
  const commands={
    '/api/v1/economy/mint':['economy.mint',mint], '/api/v1/economy/transfer':['economy.transfer',transfer], '/api/v1/economy/reservations':['economy.reserve',reserve],
    '/api/v1/economy/reservations/release':['economy.release_reservation',releaseReservation], '/api/v1/economy/first-activation':['economy.first_activation',firstActivation], '/api/v1/economy/daily-fee':['economy.daily_fee',chargeDailyActivityFee]
  };
  if(req.method==='POST'&&commands[url.pathname]){
    const input=await body(req); if(url.pathname.endsWith('activation')||url.pathname.endsWith('daily-fee'))input.billingDate||=utcDate();
    const[actionType,fn]=commands[url.pathname]; const command=canonicalCommand(req,input,actionType);
    const out=await runCommand(pool,command.run,(client,ctx)=>fn(client,{...command.data,actorEntityId:ctx.actor.entity_id,actionId:ctx.actionId}));
    return json(res,url.pathname.endsWith('reservations')?201:200,out);
  }
  return false;
}
async function staticFile(req,res,url){if(req.method!=='GET')return false;const rel=url.pathname==='/'?'index.html':url.pathname.slice(1);if(!['index.html','app.js','styles.css'].includes(rel))return false;const content=await fs.readFile(path.join(publicDir,rel));const type=rel.endsWith('.html')?'text/html; charset=utf-8':rel.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8';res.writeHead(200,{'content-type':type});res.end(content);return true}
const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);if(url.pathname.startsWith('/api/')){const handled=await api(req,res,url);if(handled!==false)return;return json(res,404,{error:'NOT_FOUND'})}if(await staticFile(req,res,url))return;json(res,404,{error:'NOT_FOUND'})}catch(error){console.error(error);json(res,error.status||500,{error:error.code||'INTERNAL_ERROR',message:error.message,actionId:error.actionId||null})}});
server.listen(port,()=>console.log(`NewHumans P0/P1 listening on :${port}`)); process.on('SIGTERM',async()=>{server.close();await pool.end()});
