const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB = path.join(DATA_DIR, 'dispatch.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
fs.mkdirSync(BACKUP_DIR, { recursive: true });
const {record:recordDiagnostic,exportEvents:exportDiagnosticEvents}=require('./server-diagnostics');
process.on('uncaughtExceptionMonitor',error=>recordDiagnostic('process.uncaughtException',{name:error?.name||'Error',message:error?.message||String(error),stack:error?.stack||''},'error'));
process.on('warning',warning=>recordDiagnostic('process.warning',{name:warning?.name||'Warning',message:warning?.message||String(warning),stack:warning?.stack||''},'warning'));
process.on('unhandledRejection',reason=>{recordDiagnostic('process.unhandledRejection',{name:reason?.name||'Rejection',message:reason?.message||String(reason),stack:reason?.stack||''},'error');setImmediate(()=>{throw reason instanceof Error?reason:new Error(String(reason));});});
// Load only non-tracked local configuration. Never embed Supabase secrets in browser assets.
try { for (const raw of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(String.fromCharCode(10))) { const line=raw.trim(), i=line.indexOf('='); if(i>0) { const key=line.slice(0,i).trim(); let value=line.slice(i+1).trim(); if(!Object.hasOwn(process.env,key)) process.env[key]=value.replace(/^['"]|['"]$/g,''); } } } catch {}
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TOMTOM_API_KEY = String(process.env.TOMTOM_API_KEY || '').trim();
const supabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && SUPABASE_SERVICE_ROLE_KEY);
const supabaseBaseValid = (()=>{try{const u=new URL(SUPABASE_URL);return ['https:','http:'].includes(u.protocol)&&!(u.protocol==='http:'&&!['localhost','127.0.0.1'].includes(u.hostname));}catch{return false;}})();
const now = () => new Date().toISOString();
const id = (prefix = 'id') => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

function seed() {
  const date = now();
  return {
    version: 1,
    locationEventIds: [],
    lastAutoBackup: null,
    settings: { company: 'Metro Traffic Operations', timezone: 'Africa/Johannesburg', absenceMinutes: 60, offlineMinutes: 5, geofenceReadings: 2, gpsAccuracy: 50, locationInterval: 15, retentionDays: 90, sosEscalationMinutes: 2, speedLimit: 90, trafficProvider: 'tomtom', trafficKey: '', trafficEnabled: false, mapProvider: 'Esri World Street Map', mapTileUrl: '/tiles/{z}/{x}/{y}.png', smtpHost: '', emailFrom: '', backupFrequency: 'hourly', backupRetention: 14, supervisor: '', soundEnabled: true },
    sites: [
      { id: 'site-sandton', name: 'Sandton Drive & Rivonia Rd', areaType: 'work', color: '#e0a12a', coordinates: [[-26.1038,28.0535],[-26.1038,28.0592],[-26.108,28.0592],[-26.108,28.0535]], assigned: ['officer-01','officer-02'], tolerance: 40 },
      { id: 'site-m1', name: 'M1 Grayston Interchange', areaType: 'work', color: '#648b73', coordinates: [[-26.0955,28.064],[-26.0955,28.070],[-26.1005,28.070],[-26.1005,28.064]], assigned: ['officer-03'], tolerance: 40 },
      { id: 'site-breach', name: 'Restricted: Nelson Mandela Sq', areaType: 'restricted', color: '#d15c4c', coordinates: [[-26.1075,28.054],[-26.1075,28.056],[-26.109,28.056],[-26.109,28.054]], assigned: [], tolerance: 20 }
    ],
    officers: [
      { id:'officer-01', name:'Amara Dlamini', callSign:'Unit 12', group:'North Sector', phone:'Android • 12', status:'on-site', shiftId:'shift-01', siteId:'site-sandton', lat:-26.1052, lng:28.0562, accuracy:8, battery:86, signal:4, online:true, lastSeen:date, onSiteSince:date, color:'#5b9d87', speed:0, stunned:false, tracking:true, history:[], config:{locationInterval:15,defaultGroup:'North Sector',colorCode:'1',timeSlot:'1',frequency:''} },
      { id:'officer-02', name:'Lebo Mokoena', callSign:'Unit 07', group:'North Sector', phone:'Android • 07', status:'on-site', shiftId:'shift-02', siteId:'site-sandton', lat:-26.1064, lng:28.0576, accuracy:12, battery:67, signal:3, online:true, lastSeen:date, onSiteSince:date, color:'#7d8fd0', speed:0, stunned:false, tracking:true, history:[], config:{locationInterval:15,defaultGroup:'North Sector',colorCode:'1',timeSlot:'1',frequency:''} },
      { id:'officer-03', name:'Sibusiso Khumalo', callSign:'Unit 23', group:'East Sector', phone:'Android • 23', status:'en-route', shiftId:'shift-03', siteId:'site-m1', lat:-26.0919, lng:28.0644, accuracy:14, battery:41, signal:2, online:true, lastSeen:date, color:'#ce835e', speed:22, stunned:false, tracking:true, history:[], config:{locationInterval:15,defaultGroup:'East Sector',colorCode:'1',timeSlot:'1',frequency:''} },
      { id:'officer-04', name:'Naledi Nkosi', callSign:'Unit 31', group:'West Sector', phone:'Android • 31', status:'off-duty', shiftId:null, siteId:null, lat:-26.143, lng:28.035, accuracy:9, battery:100, signal:5, online:true, lastSeen:date, color:'#bb729b', speed:0, stunned:false, tracking:false, history:[], config:{locationInterval:15,defaultGroup:'West Sector',colorCode:'1',timeSlot:'1',frequency:''} }
    ],
    alerts: [ {id:'alert-001',type:'geofence',title:'Restricted zone entered',detail:'Unit 23 · location reported inside Nelson Mandela Sq restricted perimeter',officerId:'officer-03',siteId:'site-breach',lat:-26.1082,lng:28.055,raisedAt:date,status:'raised',events:[{status:'raised',at:date,by:'System'}]} ],
    messages: [{id:'msg-001',from:'Control',to:'officer-01',group:'North Sector',body:'Shift brief: monitor westbound flow on Sandton Drive.',createdAt:date,deliveredAt:date,readAt:null}],
    calls: [], recordings: [], traffic: [], audit: [{id:id('audit'),at:date,actor:'Local console',action:'System initialized',target:'Dispatch'}],
    groups: ['North Sector','East Sector','West Sector','All units'], relays:[{id:'relay-main',name:'Johannesburg Control Node',host:'127.0.0.1',status:'configured',mode:'primary',lastCheck:null,latencyMs:null}], regions:[], scheduledMessages:[], callPatches:[], telemetry:[], emails:[], simulation:{active:false,startedAt:null,stoppedAt:null,units:{}}, updatedAt:date
  };
}
let cloudReady=false,cloudInitError=null,cloudWriteQueue=Promise.resolve(),cloudRecoveryTimer=null,cloudRecoveryDelay=5000,volatileCallIds=new Set();
function cloudHeaders(extra={}){return {'apikey':SUPABASE_SERVICE_ROLE_KEY,'Authorization':`Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,'Content-Type':'application/json',...extra};}
async function cloudRequest(path,options={}){
  if(!supabaseConfigured||!supabaseBaseValid)throw Object.assign(new Error('Supabase server configuration is missing or invalid'),{status:503});
  const response=await fetch(`${SUPABASE_URL}${path}`,{...options,signal:AbortSignal.timeout(12000),headers:cloudHeaders(options.headers||{})});
  const text=await response.text();let body=null;try{body=text?JSON.parse(text):null;}catch{body=text;}
  if(!response.ok)throw Object.assign(new Error(`Supabase request failed (${response.status})`),{status:response.status,details:body});
  return body;
}
async function persistCloudSnapshot(snapshot){
  let lastError;
  for(let attempt=0;attempt<3;attempt++){
    try{
      await cloudRequest('/rest/v1/dispatch_state?on_conflict=id',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({id:1,payload:snapshot,updated_at:now()})});
      return;
    }catch(error){
      lastError=error;
      const retryable=!error.status||error.status>=500||[408,429].includes(error.status);
      if(!retryable||attempt===2)break;
      await new Promise(resolve=>setTimeout(resolve,500*(2**attempt)));
    }
  }
  throw lastError;
}
async function initializeCloud(){
  if(!supabaseConfigured||!supabaseBaseValid){cloudInitError='Supabase server configuration is missing or invalid';return false;}
  try{
    const rows=await cloudRequest('/rest/v1/dispatch_state?select=payload&id=eq.1');
    const pendingCalls=Array.isArray(state?.calls)?state.calls.filter(call=>volatileCallIds.has(call.id)):[];
    if(Array.isArray(rows)&&rows.length){
      const remote=rows[0].payload;
      state=pendingCalls.length?{...remote,calls:[...pendingCalls,...(remote.calls||[]).filter(call=>!volatileCallIds.has(call.id))]}:remote;
    }else await persistCloudSnapshot(state);
    state.locationEventIds ||= [];state.simulation ||= {active:false,startedAt:null,stoppedAt:null,units:{}};state.simulation.units ||= {};state.relays ||= [];state.settings ||= {};
    locationEventSet.clear();for(const key of state.locationEventIds)locationEventSet.add(key);
    cloudReady=true;cloudInitError=null;
    if(pendingCalls.length){await persistCloudSnapshot(state);for(const call of pendingCalls)volatileCallIds.delete(call.id);}
    console.log('Supabase persistence initialized');return true;
  }catch(error){cloudReady=false;cloudInitError=`Supabase initialization failed (${error.status||'network'})`;console.error(cloudInitError);return false;}
}
function scheduleCloudRecovery(){
  if(cloudReady||cloudRecoveryTimer||!supabaseConfigured||!supabaseBaseValid)return;
  cloudRecoveryTimer=setTimeout(async()=>{
    cloudRecoveryTimer=null;
    if(cloudReady)return;
    const recovered=await initializeCloud();
    if(recovered){cloudRecoveryDelay=5000;console.log('Supabase persistence recovered');return;}
    cloudRecoveryDelay=Math.min(60000,cloudRecoveryDelay*2);
    scheduleCloudRecovery();
  },cloudRecoveryDelay);
  cloudRecoveryTimer.unref?.();
}
function save(){
  state.updatedAt=now();
  if(!supabaseConfigured||!cloudReady)return Promise.resolve();
  const snapshot=structuredClone(state);const write=cloudWriteQueue.then(()=>{if(!cloudReady)throw Object.assign(new Error('Supabase storage is unavailable'),{status:503});return persistCloudSnapshot(snapshot);});cloudWriteQueue=write.catch(error=>{if(cloudReady){cloudReady=false;cloudInitError=`Supabase state persistence failed (${error.status||'network'})`;console.error(cloudInitError);}scheduleCloudRecovery();});return write;
}
let state;
try { state = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch { state = seed(); save(); }
state.locationEventIds ||= [];
state.settings ||= {};
const backupFrequencyMigrated=state.settings.backupFrequency!=='hourly';
state.settings.backupFrequency='hourly';
if(backupFrequencyMigrated)save().catch(error=>console.error('Could not persist hourly backup schedule:',error.message));
state.simulation ||= {active:false,startedAt:null,stoppedAt:null,units:{}};
state.simulation.units ||= {};
state.relays ||= [];
let relayMigration=false;for(const relay of state.relays)if(relay.status==='online'&&!relay.lastCheck){relay.status='configured';relayMigration=true;}if(relayMigration)save();
state.settings.mapProviderUserSet ||= false;
if(state.settings.mapProvider==='OpenStreetMap'&&!state.settings.mapProviderUserSet){state.settings.mapProvider='Esri World Street Map';save();}
const locationEventSet = new Set(state.locationEventIds);
const rtcPeers=new Map(),rtcInbox=new Map(),trafficTileCache=new Map();

function audit(action, target = '', actor = 'Local console') { state.audit.unshift({id:id('audit'), at:now(), actor, action, target}); state.audit = state.audit.slice(0, 3000); }
function safeOfficer(o) { const { history, ...rest } = o; return {...rest, history: history || []}; }
function trafficApiKey() { return TOMTOM_API_KEY || String(state.settings.trafficKey || '').trim(); }
function clientStateForRole(role) { const body={...state,officers:state.officers.map(safeOfficer)}; body.settings={...state.settings,trafficKeyConfigured:Boolean(trafficApiKey())}; if(role!=='admin') body.settings.trafficKey=''; return body; }

function processLocation(officer, point) {
  if(!officer.shiftId||!officer.tracking)return {ignored:true,reason:'Location sharing is off duty'};
  const receivedAt = now();
  const key = point.eventId || `${officer.id}:${point.timestamp}:${point.lat}:${point.lng}`;
  if (locationEventSet.has(key)) return {duplicate:true};
  const p = { eventId:key, lat:Number(point.lat), lng:Number(point.lng), accuracy:Number(point.accuracy ?? 15), speed:Number(point.speed || 0), phoneTime:point.timestamp || receivedAt, receivedAt };
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng) || Math.abs(p.lat)>90 || Math.abs(p.lng)>180) throw new Error('Invalid coordinates');
  locationEventSet.add(key);state.locationEventIds.push(key);if(state.locationEventIds.length>100000){const expired=state.locationEventIds.splice(0,1000);expired.forEach(x=>locationEventSet.delete(x));}
  officer.lat=p.lat; officer.lng=p.lng; officer.accuracy=p.accuracy; officer.speed=p.speed; officer.lastSeen=receivedAt; officer.online=true;
  if (officer.tracking && officer.shiftId) officer.history.push(p);
  if (officer.history.length > 50000) officer.history.splice(0, 1000);
  if (officer.speed > Number(state.settings.speedLimit || 90)) raiseAlert('speed', 'Speed limit exceeded', `${officer.callSign} · ${Math.round(officer.speed)} km/h`, officer, null, p);
  const site=state.sites.find(s=>s.id===officer.siteId);
  if (site && officer.shiftId && p.accuracy <= Number(state.settings.gpsAccuracy || 50)) {
    const inside=pointInPolygon([p.lat,p.lng], site.coordinates) || pointNearPolygon([p.lat,p.lng], site.coordinates, Number(site.tolerance||0));
    const prev=officer.history.slice(-Number(state.settings.geofenceReadings || 2));
    const consecutive=prev.length >= Number(state.settings.geofenceReadings || 2) && prev.every(q=>pointInPolygon([q.lat,q.lng],site.coordinates)===inside && q.accuracy<=Number(state.settings.gpsAccuracy||50));
    if (consecutive && inside && !['on-site','on-break'].includes(officer.status)) { officer.status='on-site'; officer.onSiteSince=receivedAt; officer.leftSiteAt=null; audit('Officer arrived on site',`${officer.callSign} · ${site.name}`); }
    if (consecutive && !inside && officer.status==='on-site') { officer.status='left-site'; officer.leftSiteAt=receivedAt; raiseAlert('left-site','Officer left assigned site',`${officer.callSign} · ${site.name}`,officer,site,p); }
    if (consecutive && !inside && officer.status==='en-route' && Date.now()-Date.parse(officer.clockedInAt||receivedAt) > Number(state.settings.absenceMinutes||60)*60000) raiseAbsence(officer,site);
  }
  for (const region of [...state.regions,...state.sites.filter(x=>x.areaType==='restricted')]) if (region.areaType==='restricted' && (!region.assigned?.length || region.assigned.includes(officer.id)) && pointInPolygon([p.lat,p.lng],region.coordinates)) raiseAlert('geofence','Restricted zone entered',`${officer.callSign} · ${region.name}`,officer,region,p);
  return {point:p};
}
function pointInPolygon(point, polygon=[]) { let inside=false; for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){const [yi,xi]=polygon[i], [yj,xj]=polygon[j]; if(((xi>point[1])!==(xj>point[1]))&&(point[0]<(yj-yi)*(point[1]-xi)/(xj-xi+1e-12)+yi))inside=!inside;} return inside; }
function pointNearPolygon(point,polygon=[],toleranceMeters=0){if(!toleranceMeters||polygon.length<2)return false;const latScale=111320,lonScale=111320*Math.cos(point[0]*Math.PI/180),x=point[1]*lonScale,y=point[0]*latScale;for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){const ax=polygon[j][1]*lonScale,ay=polygon[j][0]*latScale,bx=polygon[i][1]*lonScale,by=polygon[i][0]*latScale,dx=bx-ax,dy=by-ay,t=Math.max(0,Math.min(1,((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy||1))),dist=Math.hypot(x-(ax+t*dx),y-(ay+t*dy));if(dist<=toleranceMeters)return true;}return false;}
function raiseAlert(type,title,detail,officer,site,point={}) {
  const duplicate=state.alerts.find(a=>a.type===type&&a.officerId===officer?.id&&a.status!=='handled'&&Date.now()-Date.parse(a.raisedAt)<120000);
  if(duplicate)return duplicate;
  const at=now(), alert={id:id('alert'),type,title,detail,officerId:officer?.id||null,siteId:site?.id||null,lat:point.lat??officer?.lat??null,lng:point.lng??officer?.lng??null,accuracy:point.accuracy??officer?.accuracy??null,raisedAt:at,status:'raised',events:[{status:'raised',at,by:'System'}]}; state.alerts.unshift(alert); return alert;
}
function raiseAbsence(o,s) { if(state.alerts.some(a=>a.type==='absence'&&a.officerId===o.id&&a.shiftId===o.shiftId))return; const a=raiseAlert('absence','Officer has not reached site',`${o.callSign} · ${s.name}`,o,s); a.shiftId=o.shiftId; }

async function sampleTomTomTraffic(siteId,{force=false}={}){
  const site=state.sites.find(x=>x.id===siteId&&x.areaType==='work');if(!site)throw Object.assign(new Error('Unknown work site'),{status:400});
  const key=trafficApiKey();if(!key)throw Object.assign(new Error('Configure TOMTOM_API_KEY in the server .env or set the key in administrator Settings'),{status:409});
  const previous=[...(state.traffic||[])].reverse().find(x=>x.siteId===site.id);
  if(!force&&previous&&Date.now()-Date.parse(previous.at)<5*60*1000)return {reading:previous,sampled:false};
  const lat=site.coordinates.reduce((n,p)=>n+Number(p[0]||0),0)/site.coordinates.length,lng=site.coordinates.reduce((n,p)=>n+Number(p[1]||0),0)/site.coordinates.length;if(!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180)throw Object.assign(new Error('Work site has invalid coordinates'),{status:400});
  const endpoint=new URL('https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json');endpoint.searchParams.set('point',`${lat},${lng}`);endpoint.searchParams.set('key',key);
  let response;try{response=await fetch(endpoint,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(12000)});}catch{throw Object.assign(new Error('Could not reach TomTom Traffic API from the Dispatch server'),{status:502});}
  if(!response.ok)throw Object.assign(new Error(`TomTom returned HTTP ${response.status}; check the Traffic Flow API permission, quota, and key restrictions`),{status:502});
  let data;try{data=await response.json();}catch{throw Object.assign(new Error('TomTom returned an unreadable traffic response'),{status:502});}
  const flow=data?.flowSegmentData,currentSpeed=Number(flow?.currentSpeed),freeFlowSpeed=Number(flow?.freeFlowSpeed);
  if(!Number.isFinite(currentSpeed)||!Number.isFinite(freeFlowSpeed)||freeFlowSpeed<=0)throw Object.assign(new Error('TomTom response has no valid flow segment for this site'),{status:502});
  const ratio=Math.max(0,Math.min(1,currentSpeed/freeFlowSpeed)),reading={id:id('traffic'),siteId:site.id,at:now(),currentSpeed,freeFlowSpeed,confidence:Number(flow.confidence||0),roadClosure:Boolean(flow.roadClosure),ratio,level:flow.roadClosure?'stopped':ratio<.25?'heavy':ratio<.55?'slow':ratio<.8?'moderate':'free',provider:'TomTom'};
  state.traffic.push(reading);if(state.traffic.length>100000)state.traffic.splice(0,1000);await save();return {reading,sampled:true};
}
async function serveTomTomTrafficTile(res,url){
  const match=url.pathname.match(/^\/api\/traffic\/tiles\/flow\/relative\/(\d+)\/(\d+)\/(\d+)\.png$/);if(!match)return send(res,404,JSON.stringify({error:'Unknown traffic tile'}),'application/json; charset=utf-8');
  const z=Number(match[1]),x=Number(match[2]),y=Number(match[3]);if(!Number.isInteger(z)||z<0||z>20||!Number.isInteger(x)||!Number.isInteger(y)||x<0||y<0||x>=2**z||y>=2**z)return send(res,400,JSON.stringify({error:'Invalid tile coordinates'}),'application/json; charset=utf-8');
  const key=trafficApiKey();if(!key)return send(res,409,JSON.stringify({error:'TomTom Traffic is not configured'}),'application/json; charset=utf-8');
  const keyFingerprint=crypto.createHash('sha256').update(key).digest('hex').slice(0,12),cacheKey=`${keyFingerprint}:${z}/${x}/${y}`,cached=trafficTileCache.get(cacheKey);if(cached&&cached.until>Date.now()){res.writeHead(200,{'Content-Type':cached.type,'Cache-Control':'private, max-age=30','X-Content-Type-Options':'nosniff'});return res.end(cached.data);}
  const upstream=new URL(`https://api.tomtom.com/traffic/map/4/tile/flow/relative/${z}/${x}/${y}.png`);upstream.searchParams.set('key',key);upstream.searchParams.set('tileSize','256');upstream.searchParams.set('thickness','8');
  try{const response=await fetch(upstream,{headers:{Accept:'image/png'},signal:AbortSignal.timeout(12000)});if(!response.ok)return send(res,502,JSON.stringify({error:`TomTom traffic tiles returned HTTP ${response.status}`}),'application/json; charset=utf-8');const data=Buffer.from(await response.arrayBuffer()),type=response.headers.get('content-type')||'image/png';if(data.length>2*1024*1024)return send(res,502,JSON.stringify({error:'TomTom traffic tile exceeded the allowed size'}),'application/json; charset=utf-8');if(trafficTileCache.size>300)trafficTileCache.clear();trafficTileCache.set(cacheKey,{data,type,until:Date.now()+30000});res.writeHead(200,{'Content-Type':type,'Cache-Control':'private, max-age=30','X-Content-Type-Options':'nosniff'});return res.end(data);}catch{return send(res,502,JSON.stringify({error:'Could not reach TomTom traffic tiles from the Dispatch server'}),'application/json; charset=utf-8');}
}
const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.woff2':'font/woff2','.woff':'font/woff'};
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/api/')){const startedAt=Date.now();res.once('finish',()=>recordDiagnostic('http.request',{method:req.method,path:url.pathname,status:res.statusCode,durationMs:Date.now()-startedAt},res.statusCode>=500?'error':res.statusCode>=400?'warning':'info'));}
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');res.setHeader('Permissions-Policy','geolocation=(self), microphone=(self)');if(requestIsHttps(req))res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');
  if(url.pathname.startsWith('/api/auth/')) { res.setHeader('Cache-Control','no-store'); await handleAuthApi(req,res,url); if(!res.writableEnded)send(res,404,JSON.stringify({error:'Not found'}),'application/json; charset=utf-8'); return; }
  if(url.pathname.startsWith('/api/')) {
    res.setHeader('Cache-Control','no-store');
    if(!supabaseConfigured||!supabaseBaseValid)return send(res,503,JSON.stringify({error:'Supabase server configuration is required.'}),'application/json; charset=utf-8');
    const rtcRequest=url.pathname.startsWith('/api/rtc/'),actionRequest=req.method==='POST'&&url.pathname==='/api/action',trafficTileRequest=req.method==='GET'&&url.pathname.startsWith('/api/traffic/tiles/flow/'),diagnosticsRequest=req.method==='GET'&&url.pathname==='/api/diagnostics/export';
    if(!cloudReady&&!rtcRequest&&!actionRequest&&!trafficTileRequest&&!diagnosticsRequest)return send(res,503,JSON.stringify({error:cloudInitError?`Supabase storage unavailable: ${cloudInitError}. Check the database schema and connection.`:'Supabase storage is not ready. Check the database schema and connection.'}),'application/json; charset=utf-8');
    const authUser=await currentUser(req,res);if(!authUser)return send(res,401,JSON.stringify({error:'Sign in required'}),'application/json; charset=utf-8');
    if(req.method==='POST'&&!originAllowed(req))return send(res,403,JSON.stringify({error:'Request origin rejected'}),'application/json; charset=utf-8');
    if(req.method==='POST'&&url.pathname==='/api/rtc/register'){try{const b=await readBody(req),peerId=String(b.peerId||''),role=b.role==='field'?'field':'control';if(!/^[a-zA-Z0-9_-]{12,80}$/.test(peerId))throw Error('Invalid voice peer id');if(role==='field'&&!state.officers.some(o=>o.id===b.officerId))throw Error('Choose a valid field terminal');rtcPeers.set(peerId,{peerId,role,officerId:role==='field'?b.officerId:'control',label:String(b.label||'').slice(0,80),lastSeen:Date.now()});return send(res,200,JSON.stringify({ok:true}),'application/json; charset=utf-8');}catch(e){return send(res,400,JSON.stringify({ok:false,error:e.message}),'application/json; charset=utf-8');}}
    if(req.method==='GET'&&url.pathname==='/api/rtc/peers'){const nowMs=Date.now();for(const [pid,p] of rtcPeers)if(nowMs-p.lastSeen>15000)rtcPeers.delete(pid);const officerId=url.searchParams.get('officerId'),role=url.searchParams.get('role');const peers=[...rtcPeers.values()].filter(p=>p.peerId!==url.searchParams.get('exclude')&&(!officerId||p.officerId===officerId)&&(!role||p.role===role)&&(p.role!=='field'||state.officers.some(o=>o.id===p.officerId&&o.shiftId&&!o.stunned))).map(({peerId,role,officerId,label})=>({peerId,role,officerId,label}));return send(res,200,JSON.stringify({peers}),'application/json; charset=utf-8');}
    if(req.method==='GET'&&url.pathname==='/api/rtc/poll'){const peerId=url.searchParams.get('peer'),peer=rtcPeers.get(peerId);if(!peer||Date.now()-peer.lastSeen>15000)return send(res,404,JSON.stringify({error:'Voice client is not registered'}),'application/json; charset=utf-8');const messages=rtcInbox.get(peerId)||[];rtcInbox.delete(peerId);return send(res,200,JSON.stringify({messages}),'application/json; charset=utf-8');}
    if(req.method==='POST'&&url.pathname==='/api/rtc/signal'){try{const b=await readBody(req),from=rtcPeers.get(b.fromPeer),to=rtcPeers.get(b.toPeer);if(!from||Date.now()-from.lastSeen>15000)throw Error('Caller voice client expired');if(!to||Date.now()-to.lastSeen>15000)throw Error('Target terminal has no live voice client');if(!['offer','answer','ice','hangup','reject'].includes(b.type))throw Error('Invalid voice signal');const queue=rtcInbox.get(b.toPeer)||[];if(queue.length>100)throw Error('Voice signal queue is full');queue.push({id:id('rtc'),at:now(),fromPeer:b.fromPeer,callId:String(b.callId||''),type:b.type,payload:b.payload||{}});rtcInbox.set(b.toPeer,queue);return send(res,200,JSON.stringify({ok:true}),'application/json; charset=utf-8');}catch(e){return send(res,409,JSON.stringify({ok:false,error:e.message}),'application/json; charset=utf-8');}}
    if(req.method==='GET'&&url.pathname==='/api/diagnostics/export') return send(res,200,JSON.stringify({events:exportDiagnosticEvents()}),'application/json; charset=utf-8');
    if(req.method==='GET'&&url.pathname==='/api/state') { const since=url.searchParams.get('since'); const body=clientStateForRole(authUser.role); if(since && since===state.updatedAt) return send(res,304,''); return send(res,200,JSON.stringify(body),'application/json; charset=utf-8'); }
    if(req.method==='GET'&&url.pathname==='/api/export') { const format=url.searchParams.get('format')||'csv', type=url.searchParams.get('type')||'officers'; const rows=exportRows(type); if(format==='json')return send(res,200,JSON.stringify(rows,null,2),'application/json; charset=utf-8'); return send(res,200,toCsv(rows),'text/csv; charset=utf-8',{'Content-Disposition':`attachment; filename="dispatch-${type}-${new Date().toISOString().slice(0,10)}.csv"`}); }
    if(req.method==='POST'&&url.pathname==='/api/traffic/sample') { try { const b=await readBody(req);if(b.force&&authUser.role!=='admin')return send(res,403,JSON.stringify({ok:false,error:'Administrator access required to force a traffic refresh'}),'application/json; charset=utf-8');const result=await sampleTomTomTraffic(String(b.siteId||''),{force:Boolean(b.force)});return send(res,200,JSON.stringify({ok:true,...result}),'application/json; charset=utf-8'); }catch(e){return send(res,e.status||502,JSON.stringify({ok:false,error:e.message||'Traffic sample failed'}),'application/json; charset=utf-8');} }
    if(req.method==='GET'&&url.pathname.startsWith('/api/traffic/tiles/flow/')) return serveTomTomTrafficTile(res,url);
    if(req.method==='POST'&&url.pathname==='/api/traffic') { try { const b=await readBody(req), site=state.sites.find(x=>x.id===b.siteId); if(!site)throw Error('Unknown site'); const currentSpeed=Number(b.currentSpeed),freeFlowSpeed=Number(b.freeFlowSpeed);if(!Number.isFinite(currentSpeed)||!Number.isFinite(freeFlowSpeed)||freeFlowSpeed<=0)throw Error('Invalid flow reading'); const ratio=Math.max(0,Math.min(1,currentSpeed/freeFlowSpeed));const level=b.roadClosure?'stopped':ratio<.25?'heavy':ratio<.55?'slow':ratio<.8?'moderate':'free'; const reading={id:id('traffic'),siteId:site.id,at:now(),currentSpeed,freeFlowSpeed,confidence:Number(b.confidence||0),roadClosure:Boolean(b.roadClosure),ratio,level,provider:'TomTom'};state.traffic.push(reading);if(state.traffic.length>100000)state.traffic.splice(0,1000);await save();return send(res,200,JSON.stringify({ok:true,reading}),'application/json; charset=utf-8'); } catch(e) { return send(res,e.status?503:400,JSON.stringify({ok:false,error:e.status?'Supabase persistence failed':e.message}),'application/json; charset=utf-8'); } }
    if(req.method==='POST'&&url.pathname==='/api/action') { try { const body=await readBody(req),callAction=['call-start','call-answer','call-fail','call-end'].includes(body.type);if(!cloudReady&&!callAction)return send(res,503,JSON.stringify({ok:false,error:cloudInitError?`Supabase storage unavailable: ${cloudInitError}`:'Supabase storage is not ready'}),'application/json; charset=utf-8');recordDiagnostic('system.action',{action:String(body.type||'unknown').slice(0,80)},'info'); body.actor=authUser.email||'Authenticated user'; if(authUser.role!=='admin'&&['settings','backup','import','officer-delete','site-delete','region-delete','group-delete'].includes(body.type))return send(res,403,JSON.stringify({error:'Administrator access required for this action'}),'application/json; charset=utf-8');const result=await action(body);let volatile=false;try{await save();}catch(error){if(!callAction)throw error;volatile=true;}if(callAction&&!cloudReady){volatile=true;const callId=result.call||body.id;if(callId)volatileCallIds.add(callId);}return send(res,200,JSON.stringify({ok:true,result,state:clientStateForRole(authUser.role),volatile}),'application/json; charset=utf-8'); } catch(e) { return send(res,e.status?503:400,JSON.stringify({ok:false,error:e.status?'Supabase persistence failed':e.message}),'application/json; charset=utf-8'); } }
    if(req.method==='POST'&&url.pathname==='/api/ingest/location') { try { const b=await readBody(req), o=state.officers.find(x=>x.id===b.officerId); if(!o)throw Error('Unknown officer'); const r=processLocation(o,b); await save(); return send(res,200,JSON.stringify({ok:true,...r}),'application/json; charset=utf-8'); }catch(e){return send(res,e.status?503:400,JSON.stringify({ok:false,error:e.status?'Supabase persistence failed':e.message}),'application/json; charset=utf-8');} }
    if(req.method==='POST'&&url.pathname==='/api/backup') { if(authUser.role!=='admin')return send(res,403,JSON.stringify({error:'Administrator access required'}),'application/json; charset=utf-8');try{return send(res,200,JSON.stringify(await makeBackup()),'application/json; charset=utf-8');}catch(e){return send(res,503,JSON.stringify({error:'Supabase backup failed'}),'application/json; charset=utf-8');} }
    if(req.method==='GET'&&url.pathname==='/api/backups') { if(authUser.role!=='admin')return send(res,403,JSON.stringify({error:'Administrator access required'}),'application/json; charset=utf-8');try{return send(res,200,JSON.stringify(await listBackups()),'application/json; charset=utf-8');}catch{return send(res,503,JSON.stringify({error:'Supabase backup storage is unavailable'}),'application/json; charset=utf-8');} }
    if(req.method==='POST'&&url.pathname==='/api/restore') { try { if(authUser.role!=='admin')return send(res,403,JSON.stringify({error:'Administrator access required'}),'application/json; charset=utf-8');const b=await readBody(req),file=String(b.file||'');if(!/^dispatch-[a-zA-Z0-9T_.-]+$/.test(file))throw Error('Invalid backup identifier');const rows=await cloudRequest(`/rest/v1/dispatch_backups?select=payload&file=eq.${encodeURIComponent(file)}&limit=1`);const restored=rows?.[0]?.payload;if(!restored?.officers||!restored?.sites)throw Error('Backup file was not found or is invalid');const prior=state;state=restored;state.locationEventIds ||= [];locationEventSet.clear();state.locationEventIds.forEach(x=>locationEventSet.add(x));audit('Database restored',file,authUser.email);await save();return send(res,200,JSON.stringify({ok:true,restoredAt:now(),previousRecords:prior.officers.length+prior.sites.length}),'application/json; charset=utf-8');}catch(e){return send(res,e.status||400,JSON.stringify({ok:false,error:e.message}),'application/json; charset=utf-8');} }
    return send(res,404,JSON.stringify({error:'Not found'}),'application/json; charset=utf-8');
  }
  let file=decodeURIComponent(url.pathname);
  if(file==='/'||file==='/')file='/index.html';
  const target=path.resolve(PUBLIC,`.${file}`); if(!target.startsWith(PUBLIC+path.sep)){return send(res,403,'Forbidden','text/plain');}
  fs.readFile(target,(e,content)=> e?send(res,404,'Not found','text/plain',{'Cache-Control':'no-store'}):send(res,200,content,MIME[path.extname(target)]||'application/octet-stream',{'Cache-Control':'no-cache'}));
});
function makeSimulationRoute(officer,index){
  const site=state.sites.find(x=>x.id===officer.siteId&&x.areaType==='work')||state.sites.find(x=>x.areaType==='work');
  if(!site)return [];
  const center=site.coordinates.reduce((a,p)=>[a[0]+p[0]/site.coordinates.length,a[1]+p[1]/site.coordinates.length],[0,0]);
  const shift=(index%3-1)*0.00035,lat=center[0],lng=center[1];
  return [[officer.lat,officer.lng],[lat-0.0012+shift,lng-0.0015],[lat+0.0001,lng-0.0018+shift],[lat+0.0012,lng+0.0003],[lat,lng],[lat-0.0011,lng+0.0015-shift],[lat,lng],[lat+0.0012,lng-0.0006],[lat,lng]];
}
function localDistanceMeters(a,b){const lat=(a[0]+b[0])*Math.PI/360;return Math.hypot((b[0]-a[0])*111320,(b[1]-a[1])*111320*Math.cos(lat));}
function tickSimulation(){
  const sim=state.simulation;if(!sim?.active)return false;
  const stepSeconds=5;let changed=false;
  for(const o of state.officers){const track=sim.units?.[o.id];if(!track||!o.shiftId||!o.tracking||o.stunned)continue;const route=track.route||[];if(route.length<2)continue;
    const speed=20+((track.sequence*7+track.seed*11)%27);let moveMeters=speed*1000/3600*stepSeconds,guard=0;
    while(moveMeters>0&&guard++<20){const a=route[track.leg%route.length],b=route[(track.leg+1)%route.length],distance=localDistanceMeters(a,b);if(distance<1){track.leg=(track.leg+1)%route.length;track.progress=0;continue;}const left=distance-track.progress,move=Math.min(moveMeters,left);track.progress+=move;moveMeters-=move;if(track.progress>=distance-0.01){track.leg=(track.leg+1)%route.length;track.progress=0;}}
    const a=route[track.leg%route.length],b=route[(track.leg+1)%route.length],distance=localDistanceMeters(a,b)||1,t=Math.min(1,track.progress/distance),lat=a[0]+(b[0]-a[0])*t,lng=a[1]+(b[1]-a[1])*t;
    processLocation(o,{lat,lng,accuracy:6+track.seed%4,speed,timestamp:now(),eventId:`sim-${sim.startedAt}-${o.id}-${track.sequence++}`});changed=true;
  }
  if(changed){sim.lastTick=now();return true;}
  sim.active=false;sim.stoppedAt=now();return true;
}

function action(b) {
  const at=now(), o=state.officers.find(x=>x.id===b.officerId), actor=b.actor||'Local console';
  switch(b.type){
    case 'clock-in': {if(!o)throw Error('Choose an officer'); if(o.stunned)throw Error('This terminal is stunned'); if(o.shiftId)throw Error('Officer is already clocked in'); const s=state.sites.find(x=>x.id===b.siteId)||state.sites.find(x=>x.areaType==='work'); if(!s)throw Error('Create a work site first'); o.shiftId=id('shift');o.siteId=s.id;o.status='en-route';o.tracking=true;o.clockedInAt=at;o.onSiteSince=null;o.history=[];audit('Clocked in',`${o.callSign} · ${s.name}`,actor); return {officer:o.id,site:s.id};}
    case 'clock-out': {if(!o)throw Error('Choose an officer');o.status='off-duty';o.shiftId=null;o.tracking=false;o.clockedOutAt=at; for(const a of state.alerts.filter(x=>x.officerId===o.id&&x.status!=='handled'&&['absence','left-site'].includes(x.type))){a.status='handled';a.events.push({status:'handled',at,by:actor,note:'Shift ended'});}audit('Clocked out',o.callSign,actor);return {};}
    case 'sos': {if(!o)throw Error('Choose an officer');if(!o.shiftId)throw Error('Officer must be clocked in to raise SOS');if(o.stunned)throw Error('This terminal is stunned and cannot transmit');const a=raiseAlert('sos','SOS emergency',`${o.callSign} needs immediate assistance`,o,null,{lat:o.lat,lng:o.lng,accuracy:o.accuracy});a.raisedAt=at; a.phonePressedAt=b.raisedAt||null; a.offline=!o.online; audit('SOS raised',o.callSign,actor);return {alert:a.id};}
    case 'alert-status': {const a=state.alerts.find(x=>x.id===b.id);if(!a)throw Error('Alert not found');if(!['taken','handled'].includes(b.status))throw Error('Invalid alert status');if(b.status==='handled'&&!String(b.note||'').trim())throw Error('Add a short resolution note');a.status=b.status;a.events.push({status:b.status,at,by:actor,note:b.note||''});if(b.status==='taken')a.takenBy=actor;if(b.status==='handled'){a.handledBy=actor;a.note=b.note;}audit(`Alert ${b.status}`,a.title,actor);return {};}
    case 'message': {const body=String(b.body||'').trim();if(!body)throw Error('Write a message first');const sender=state.officers.find(x=>x.callSign===b.from);if(sender&&!sender.shiftId)throw Error('Clock in before sending messages');if(sender?.stunned)throw Error('This terminal is stunned and cannot transmit');const recipient=state.officers.find(x=>x.id===b.to);const m={id:id('msg'),from:b.from||'Control',to:b.to||'all',group:b.group||null,body,createdAt:at,deliveredAt:b.to==='all'||(recipient?.online&&!recipient?.stunned)?at:null,readAt:null,scheduledAt:b.scheduledAt||null};if(m.scheduledAt)state.scheduledMessages.push(m);else state.messages.unshift(m);audit(m.scheduledAt?'Message scheduled':'Message sent',m.to,actor);return {message:m.id};}
    case 'mark-read': {const m=state.messages.find(x=>x.id===b.id);if(m)m.readAt=at;return {};}
    case 'site-save': {if(!b.name?.trim())throw Error('Site name is required');const coords=(b.coordinates||[]).map(p=>[Number(p[0]),Number(p[1])]);if(coords.length<3)throw Error('Draw at least three points on the map');let s=b.id&&state.sites.find(x=>x.id===b.id);if(s)Object.assign(s,{name:b.name.trim(),areaType:b.areaType||'work',coordinates:coords,color:b.color||'#e0a12a',tolerance:Number(b.tolerance||40),assigned:b.assigned||[]});else{s={id:id('site'),name:b.name.trim(),areaType:b.areaType||'work',coordinates:coords,color:b.color||'#e0a12a',tolerance:Number(b.tolerance||40),assigned:[]};state.sites.push(s);}audit('Site saved',s.name,actor);return {site:s.id};}
    case 'site-delete': {state.sites=state.sites.filter(x=>x.id!==b.id);audit('Site deleted',b.id,actor);return {};}
    case 'officer-save': {let person=b.officer||{};let x=person.id&&state.officers.find(y=>y.id===person.id);if(x){Object.assign(x,person);audit('Officer details updated',x.callSign,actor);}else{x={id:id('officer'),name:person.name||'New officer',callSign:person.callSign||'Unit',group:person.group||state.groups[0],phone:person.phone||'Android',status:'off-duty',shiftId:null,siteId:null,lat:-26.104,lng:28.056,accuracy:0,battery:100,signal:0,online:false,lastSeen:null,color:person.color||'#648b73',speed:0,stunned:false,tracking:false,history:[],config:{locationInterval:15,defaultGroup:person.group||state.groups[0],colorCode:'1',timeSlot:'1',frequency:''}};state.officers.push(x);audit('Officer added',x.callSign,actor);}return {officer:x.id};}
    case 'officer-delete': {if(!o)throw Error('Officer not found');if(o.shiftId)throw Error('Clock out before removing an officer');state.officers=state.officers.filter(x=>x.id!==o.id);audit('Officer removed',o.callSign,actor);return {};}
    case 'stun': {if(!o)throw Error('Choose an officer');o.stunned=Boolean(b.stunned);audit(o.stunned?'Terminal stunned':'Terminal reactivated',o.callSign,actor);if(o.stunned)raiseAlert('stun','Terminal stunned',o.callSign,o,null);return {};}
    case 'status-query': {const units=b.officerId?state.officers.filter(x=>x.id===b.officerId):state.officers;audit('Terminal status query',b.officerId||`${units.length} units`,actor);return {units:units.map(x=>({id:x.id,callSign:x.callSign,online:x.online,stunned:x.stunned,shiftId:x.shiftId,status:x.status,battery:x.battery,signal:x.signal,lat:x.lat,lng:x.lng,accuracy:x.accuracy,lastSeen:x.lastSeen}))};}
    case 'break': {if(!o||!o.shiftId)throw Error('Officer must be on shift');if(b.enabled){if(o.status==='on-break')throw Error('Break is already active');o.status='on-break';o.breakStartedAt=at;audit('Break started',o.callSign,actor);return {status:o.status};}if(o.status!=='on-break')throw Error('No active break');o.breakEndedAt=at;o.status='en-route';const s=state.sites.find(x=>x.id===o.siteId);if(s&&(pointInPolygon([o.lat,o.lng],s.coordinates)||pointNearPolygon([o.lat,o.lng],s.coordinates,Number(s.tolerance||0))))o.status='on-site';audit('Break ended',o.callSign,actor);return {status:o.status};}
    case 'tracking': {if(!o)throw Error('Choose an officer');o.tracking=Boolean(b.enabled);audit(o.tracking?'Tracking started':'Tracking stopped',o.callSign,actor);return {};}
    case 'location': {if(!o)throw Error('Choose an officer');return processLocation(o,{lat:b.lat,lng:b.lng,accuracy:b.accuracy||12,speed:b.speed||0,timestamp:b.timestamp||at,eventId:b.eventId||id('loc')});}
    case 'call-start': {const caller=state.officers.find(x=>x.callSign===b.from);if(caller&&(!caller.shiftId||caller.stunned))throw Error('Clock in and be active before starting a voice call');const c={id:id('call'),type:b.callType||'private',from:b.from||'Control',to:b.to||'all',group:b.group||null,startedAt:at,endedAt:null,status:b.live?'ringing':'active',live:Boolean(b.live),audioMode:b.live?'webrtc-lan':null,participants:b.participantIds||[],recording:null,channel:Number(b.channel||1)};if(state.calls.filter(x=>['active','ringing'].includes(x.status)).length>=8)throw Error('All eight dispatch channels are busy');state.calls.unshift(c);audit(b.live?'Live voice call ringing':'Call started',`${c.type} · ${c.to}`,actor);return {call:c.id};}
    case 'call-answer': {const c=state.calls.find(x=>x.id===b.id);if(!c)throw Error('Call not found');if(c.status==='ringing')c.status='active';c.answeredAt=at;if(b.participant&&!c.participants.includes(b.participant))c.participants.push(b.participant);audit('Live voice call answered',c.id,actor);return {};}
    case 'call-fail': {const c=state.calls.find(x=>x.id===b.id);if(!c)throw Error('Call not found');c.status='failed';c.endedAt=at;c.failure=String(b.reason||'Call failed').slice(0,200);audit('Voice call failed',c.failure,actor);return {};}
    case 'call-end': {const c=state.calls.find(x=>x.id===b.id);if(!c)throw Error('Call not found');c.endedAt=at;c.status='ended';audit('Call ended',c.id,actor);return {};}
    case 'recording-save': {const r={id:id('rec'),callId:b.callId||null,name:b.name||'Dispatch recording',mime:b.mime||'audio/webm',data:b.data||'',createdAt:at,duration:Number(b.duration||0),from:b.from||'Control',to:b.to||'all'};state.recordings.unshift(r);if(b.callId){const c=state.calls.find(x=>x.id===b.callId);if(c)c.recording=r.id;}audit('Recording stored',r.name,actor);return {recording:r.id};}
    case 'group-save': {const name=String(b.name||'').trim();if(!name)throw Error('Group name required');if(!state.groups.includes(name))state.groups.push(name);audit('Group added',name,actor);return {};}
    case 'group-delete': {state.groups=state.groups.filter(x=>x!==b.name);audit('Group removed',b.name,actor);return {};}
    case 'config-save': {if(!o)throw Error('Choose a terminal');o.config={...o.config,...b.config};if(b.config?.alias)o.callSign=b.config.alias;if(b.config?.defaultGroup)o.group=b.config.defaultGroup;o.configUpdatedAt=at;o.configAck='local-simulated';audit('Terminal configuration applied locally',o.callSign,actor);return {};}
    case 'region-save': {const r={id:b.id||id('region'),name:b.name,areaType:b.areaType||'work',coordinates:b.coordinates||[],assigned:b.assigned||[]};const i=state.regions.findIndex(x=>x.id===r.id);if(i>=0)state.regions[i]=r;else state.regions.push(r);audit('Region saved',r.name,actor);return {region:r.id};}
    case 'region-delete': {state.regions=state.regions.filter(x=>x.id!==b.id);audit('Region deleted',b.id,actor);return {}; }
    case 'relay-save': {const r={id:b.id||id('relay'),name:b.name||'Relay node',host:b.host||'127.0.0.1',mode:b.mode||'relay',status:'configured'};const i=state.relays.findIndex(x=>x.id===r.id);if(i>=0)state.relays[i]=r;else state.relays.push(r);audit('Relay node configured',r.name,actor);return {relay:r.id};}
    case 'patch-save': {const p={id:id('patch'),name:b.name||'Audio patch',members:b.members||[],active:true,createdAt:at};state.callPatches.push(p);audit('Audio patch preset saved',p.name,actor);return {};}
    case 'patch-stop': {const p=state.callPatches.find(x=>x.id===b.id);if(p)p.active=false;audit('Audio patch removed',b.id,actor);return {};}
    case 'telemetry': {if(!o)throw Error('Choose a terminal');const t={id:id('tel'),officerId:o.id,point:b.point||'Auxiliary output 1',value:b.value??true,at};state.telemetry.unshift(t);o.outputs ||= {};o.outputs[t.point]=t.value;audit('Simulated telemetry output changed',`${o.callSign} · ${t.point} · ${t.value?'ON':'OFF'}`,actor);return {output:t};}
    case 'settings': {Object.assign(state.settings,b.settings||{});state.settings.backupFrequency='hourly';if(Object.hasOwn(b.settings||{},'mapProvider'))state.settings.mapProviderUserSet=true;audit('System settings changed','Settings',actor);return {}; }
    case 'audit': audit(b.action||'Console action',b.target||'',actor);return {};
    case 'import': {const list=b.officers||[];let added=0;for(const item of list){if(!item.name)continue;const dup=state.officers.some(x=>x.callSign===item.callSign);if(dup)continue;action({type:'officer-save',officer:item,actor});added++;}audit('Batch import',`${added} officers`);return {added};}
    case 'simulation-start': {if(state.simulation?.active)return {started:false,active:true};const units=state.officers.filter(x=>x.shiftId&&x.tracking&&!x.stunned);if(!units.length)throw Error('Clock in at least one active unit before starting the route simulation');const tracks={};units.forEach((person,index)=>{const route=makeSimulationRoute(person,index);if(route.length>1)tracks[person.id]={route,leg:0,progress:0,sequence:0,seed:index+1};});if(!Object.keys(tracks).length)throw Error('No work site is available for the route simulation');state.simulation={active:true,startedAt:at,stoppedAt:null,lastTick:null,units:tracks};audit('Route simulation started',`${units.length} active units`,actor);return {started:true,units:units.length};}
    case 'simulation-stop': {const wasActive=Boolean(state.simulation?.active);state.simulation={...(state.simulation||{}),active:false,stoppedAt:at};audit('Route simulation stopped','Active units',actor);return {stopped:wasActive};}
    case 'simulate': {const points=[[-26.1034,28.0529],[-26.1012,28.0581],[-26.0992,28.0653],[-26.112,28.05],[-26.0969,28.0674]];let i=0;for(const person of state.officers.filter(x=>x.shiftId&&!x.stunned)){const p=points[(Date.now()/3000|0+i++)%points.length];processLocation(person,{lat:p[0]+(Math.random()-.5)*.002,lng:p[1]+(Math.random()-.5)*.002,accuracy:8+Math.random()*10,speed:4+Math.random()*35,timestamp:at,eventId:id('sim')});}audit('Demo locations simulated','Active units',actor);return {};}
    case 'backup': return makeBackup();
    default: throw Error(`Unsupported action: ${b.type}`);
  }
}
async function makeBackup(){await save();await cloudWriteQueue;const file=`dispatch-${new Date().toISOString().replace(/[:.]/g,'-')}`,payload=structuredClone(state),size=Buffer.byteLength(JSON.stringify(payload));await cloudRequest('/rest/v1/dispatch_backups',{method:'POST',headers:{Prefer:'return=minimal'},body:JSON.stringify({file,payload,size_bytes:size})});await pruneBackups();return {file,createdAt:now(),size};}
async function pruneBackups(){const keep=Math.max(1,Number(state.settings.backupRetention||14)),files=await listBackups();for(const item of files.slice(keep))await cloudRequest(`/rest/v1/dispatch_backups?file=eq.${encodeURIComponent(item.file)}`,{method:'DELETE'});}
async function listBackups(){const rows=await cloudRequest('/rest/v1/dispatch_backups?select=file,size_bytes,created_at&order=created_at.desc&limit=500');return (rows||[]).map(x=>({file:x.file,size:Number(x.size_bytes||0),modifiedAt:x.created_at}));}
function exportRows(type){if(type==='locations')return state.officers.flatMap(o=>(o.history||[]).map(p=>({officer:o.callSign,lat:p.lat,lng:p.lng,accuracy:p.accuracy,phoneTime:p.phoneTime,receivedAt:p.receivedAt})));if(type==='alerts')return state.alerts.map(a=>({type:a.type,title:a.title,officer:state.officers.find(o=>o.id===a.officerId)?.callSign,status:a.status,raisedAt:a.raisedAt,takenBy:a.takenBy,handledBy:a.handledBy,note:a.note}));if(type==='messages')return state.messages.map(m=>({from:m.from,to:m.to,body:m.body,createdAt:m.createdAt,deliveredAt:m.deliveredAt,readAt:m.readAt}));if(type==='calls')return state.calls.map(c=>({type:c.type,from:c.from,to:c.to,startedAt:c.startedAt,endedAt:c.endedAt,status:c.status,recording:c.recording}));if(type==='traffic')return state.traffic.map(t=>({site:state.sites.find(s=>s.id===t.siteId)?.name,at:t.at,currentSpeed:t.currentSpeed,freeFlowSpeed:t.freeFlowSpeed,ratio:t.ratio,confidence:t.confidence,level:t.level,roadClosure:t.roadClosure,provider:t.provider}));if(type==='audit')return state.audit;if(type==='sites')return state.sites.map(s=>({id:s.id,name:s.name,areaType:s.areaType,tolerance:s.tolerance,assigned:s.assigned.join('|')}));return state.officers.map(o=>({id:o.id,name:o.name,callSign:o.callSign,group:o.group,status:o.status,site:state.sites.find(s=>s.id===o.siteId)?.name||'',online:o.online,lastSeen:o.lastSeen,battery:o.battery,stunned:o.stunned}));}
function toCsv(rows){if(!rows.length)return '';const keys=[...new Set(rows.flatMap(x=>Object.keys(x)))];return [keys.map(csvCell).join(','),...rows.map(r=>keys.map(k=>csvCell(Array.isArray(r[k])?r[k].join('|'):r[k])).join(','))].join('\r\n');}
function csvCell(v){let s=String(v??'');if(/^[=+\-@\t\r]/.test(s))s="'"+s;return `"${s.replaceAll('"','""')}"`;}
function readBody(req){return new Promise((resolve,reject)=>{let data='';req.on('data',c=>{data+=c;if(data.length>25_000_000){reject(Error('Request too large'));req.destroy();}});req.on('end',()=>{try{resolve(data?JSON.parse(data):{});}catch{reject(Error('Invalid JSON'));}});req.on('error',reject);});}
function send(res,status,body,type='text/plain; charset=utf-8',headers={}){res.writeHead(status,{'Content-Type':type,...headers});res.end(body);}
function parseCookies(req){const out={};for(const part of String(req.headers.cookie||'').split(';')){const i=part.indexOf('=');if(i>0)try{out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim());}catch{}}return out;}
function requestIsHttps(req){return Boolean(req.socket.encrypted||(String(process.env.DISPATCH_TRUST_PROXY||'').toLowerCase()==='true'&&String(req.headers['x-forwarded-proto']||'').split(',')[0].trim()==='https'));}
function cookieLine(req,name,value,maxAge){const secure=String(process.env.DISPATCH_COOKIE_SECURE||'').toLowerCase()==='false'?false:(String(process.env.DISPATCH_COOKIE_SECURE||'').toLowerCase()==='true'||requestIsHttps(req));return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure?'; Secure':''}`;}
function writeSessionCookies(req,res,session){const headers=[cookieLine(req,'dispatch_access',session.access_token,Math.max(60,Number(session.expires_in)||3600)),cookieLine(req,'dispatch_refresh',session.refresh_token,60*60*24*30)];res.setHeader('Set-Cookie',headers);}
function clearSessionCookies(req,res){res.setHeader('Set-Cookie',[cookieLine(req,'dispatch_access','',0),cookieLine(req,'dispatch_refresh','',0)]);}
function safeAuthUser(user){const meta=user?.app_metadata||{},role=['admin','dispatcher'].includes(meta.dispatch_role)?meta.dispatch_role:'dispatcher';return {id:user.id,email:user.email||'',role,name:user.user_metadata?.full_name||user.user_metadata?.name||''};}
async function supabaseAuth(path,{method='GET',body,accessToken='',admin=false}={}){
  const key=admin?SUPABASE_SERVICE_ROLE_KEY:SUPABASE_ANON_KEY;
  const headers={'apikey':key,'Content-Type':'application/json'};if(accessToken)headers.Authorization=`Bearer ${accessToken}`;else if(admin)headers.Authorization=`Bearer ${SUPABASE_SERVICE_ROLE_KEY}`;
  const response=await fetch(`${SUPABASE_URL}${path}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(12000)});const text=await response.text();let data={};try{data=text?JSON.parse(text):{};}catch{}
  if(!response.ok)throw Object.assign(new Error('Authentication request failed'),{status:response.status,data});return data;
}
const authCache=new Map(),loginAttempts=new Map();
async function currentUser(req,res){
  if(!supabaseConfigured||!supabaseBaseValid)return null;
  const cookies=parseCookies(req);let access=cookies.dispatch_access,refresh=cookies.dispatch_refresh;if(!access&&!refresh)return null;
  const cacheKey=access?crypto.createHash('sha256').update(access).digest('hex'):'';const cached=cacheKey&&authCache.get(cacheKey);if(cached&&cached.until>Date.now())return cached.user;
  try{let user=await supabaseAuth('/auth/v1/user',{accessToken:access});const safe=safeAuthUser(user);if(cacheKey){authCache.set(cacheKey,{user:safe,until:Date.now()+30000});if(authCache.size>2000)authCache.delete(authCache.keys().next().value);}return safe;}
  catch(error){if(error.status!==401||!refresh)return null;}
  try{const session=await supabaseAuth('/auth/v1/token?grant_type=refresh_token',{method:'POST',body:{refresh_token:refresh}});if(!session.access_token||!session.refresh_token)return null;writeSessionCookies(req,res,session);const user=session.user||await supabaseAuth('/auth/v1/user',{accessToken:session.access_token});return safeAuthUser(user);}
  catch{return null;}
}
function originAllowed(req){const origin=req.headers.origin;if(!origin)return true;try{const u=new URL(origin),host=req.headers['x-forwarded-host']||req.headers.host;return u.host===host;}catch{return false;}}
function loginRateLimited(req){const key=req.socket.remoteAddress||'unknown',entry=loginAttempts.get(key)||{count:0,reset:Date.now()+15*60*1000};if(entry.reset<Date.now()){entry.count=0;entry.reset=Date.now()+15*60*1000;}entry.count++;loginAttempts.set(key,entry);return entry.count>12;}
async function handleAuthApi(req,res,url){
  if(url.pathname==='/api/auth/status'&&req.method==='GET')return send(res,200,JSON.stringify({configured:supabaseConfigured&&supabaseBaseValid,ready:cloudReady,message:!supabaseConfigured||!supabaseBaseValid?'Server credentials are not configured.':cloudReady?null:cloudInitError||'Supabase schema or connection needs attention.'}),'application/json; charset=utf-8');
  if(!originAllowed(req))return send(res,403,JSON.stringify({error:'Request origin rejected'}),'application/json; charset=utf-8');
  if(url.pathname==='/api/auth/login'&&req.method==='POST'){
    const host=String(req.headers.host||'').split(':')[0];const localHost=['localhost','127.0.0.1','::1'].includes(host)||['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);if(String(process.env.DISPATCH_COOKIE_SECURE||'true').toLowerCase()!=='false'&&!requestIsHttps(req)&&!localHost)return send(res,426,JSON.stringify({error:'HTTPS is required for sign-in. Use a trusted TLS reverse proxy or local development on localhost.'}),'application/json; charset=utf-8');
    if(loginRateLimited(req))return send(res,429,JSON.stringify({error:'Too many sign-in attempts. Wait 15 minutes and try again.'}),'application/json; charset=utf-8');
    if(!supabaseConfigured||!supabaseBaseValid||!cloudReady)return send(res,503,JSON.stringify({error:'Supabase authentication and storage are not ready.'}),'application/json; charset=utf-8');
    try{const b=await readBody(req),email=String(b.email||'').trim().toLowerCase(),password=String(b.password||'');if(!email||!password)throw Object.assign(new Error('Enter your email and password.'),{status:400});const session=await supabaseAuth('/auth/v1/token?grant_type=password',{method:'POST',body:{email,password}});if(!session.access_token||!session.refresh_token)throw Object.assign(new Error('Sign-in failed.'),{status:401});writeSessionCookies(req,res,session);loginAttempts.delete(req.socket.remoteAddress||'unknown');return send(res,200,JSON.stringify({ok:true,user:safeAuthUser(session.user)}),'application/json; charset=utf-8');}
    catch(error){return send(res,error.status===400?400:error.status===429?429:401,JSON.stringify({error:error.status===400?error.message:'Email or password is incorrect.'}),'application/json; charset=utf-8');}
  }
  if(url.pathname==='/api/auth/logout'&&req.method==='POST'){const cookies=parseCookies(req);try{if(cookies.dispatch_access){authCache.delete(crypto.createHash('sha256').update(cookies.dispatch_access).digest('hex'));await supabaseAuth('/auth/v1/logout',{method:'POST',accessToken:cookies.dispatch_access});}}catch{}clearSessionCookies(req,res);return send(res,200,JSON.stringify({ok:true}),'application/json; charset=utf-8');}
  if(url.pathname==='/api/auth/me'&&req.method==='GET'){const user=await currentUser(req,res);return user?send(res,200,JSON.stringify({user}),'application/json; charset=utf-8'):send(res,401,JSON.stringify({error:'Sign in required'}),'application/json; charset=utf-8');}
  if(url.pathname==='/api/auth/password'&&req.method==='POST'){
    const actor=await currentUser(req,res);if(!actor)return send(res,401,JSON.stringify({error:'Sign in required'}),'application/json; charset=utf-8');
    try{const b=await readBody(req),currentPassword=String(b.currentPassword||''),newPassword=String(b.newPassword||'');if(newPassword.length<14)throw Object.assign(new Error('Choose a password with at least 14 characters'),{status:400});if(newPassword===currentPassword)throw Object.assign(new Error('Choose a different password'),{status:400});let session;try{session=await supabaseAuth('/auth/v1/token?grant_type=password',{method:'POST',body:{email:actor.email,password:currentPassword}});}catch{throw Object.assign(new Error('Current password is incorrect'),{status:400});}await supabaseAuth('/auth/v1/user',{method:'PUT',accessToken:session.access_token,body:{password:newPassword}});writeSessionCookies(req,res,session);return send(res,200,JSON.stringify({ok:true}),'application/json; charset=utf-8');}catch(error){return send(res,error.status||400,JSON.stringify({error:error.message||'Could not change password'}),'application/json; charset=utf-8');}
  }
  if(url.pathname==='/api/auth/users'&&(req.method==='GET'||req.method==='POST')){
    const actor=await currentUser(req,res);if(!actor)return send(res,401,JSON.stringify({error:'Sign in required'}),'application/json; charset=utf-8');if(actor.role!=='admin')return send(res,403,JSON.stringify({error:'Administrator access required'}),'application/json; charset=utf-8');if(!cloudReady)return send(res,503,JSON.stringify({error:'Supabase storage is not ready'}),'application/json; charset=utf-8');
    try{if(req.method==='GET'){const result=await cloudRequest('/auth/v1/admin/users?page=1&per_page=100');const users=(result.users||[]).map(safeAuthUser);return send(res,200,JSON.stringify({users}),'application/json; charset=utf-8');}
      const b=await readBody(req),email=String(b.email||'').trim().toLowerCase(),password=String(b.password||''),name=String(b.name||'').trim().slice(0,100),role=['dispatcher','admin'].includes(b.role)?b.role:'dispatcher';if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw Object.assign(new Error('Enter a valid email address'),{status:400});if(password.length<14)throw Object.assign(new Error('Use a temporary password of at least 14 characters'),{status:400});const created=await cloudRequest('/auth/v1/admin/users',{method:'POST',body:{email,password,email_confirm:true,user_metadata:{full_name:name},app_metadata:{dispatch_role:role}}});audit('User account created',`${email} · ${role}`,actor.email);await save();return send(res,201,JSON.stringify({ok:true,user:safeAuthUser(created.user||created)}),'application/json; charset=utf-8');
    }catch(error){const status=error.status===400?400:error.status===422?409:error.status||500;return send(res,status,JSON.stringify({error:error.status===400?error.message:error.status===422?'An account with that email may already exist':'Could not complete user management request'}),'application/json; charset=utf-8');}
  }
  return null;
}

// Background rules: one-hour assignment warning and stale/offline state. Server timestamps are authoritative.
let autoBackupInProgress=false,autoBackupRetryAt=0;
setInterval(()=>{let dirty=false;const ms=Date.now();if(tickSimulation())dirty=true;for(const o of state.officers){if(o.online&&o.lastSeen&&ms-Date.parse(o.lastSeen)>Number(state.settings.offlineMinutes||5)*60000){o.online=false;raiseAlert('offline','Terminal offline',`${o.callSign} · last seen ${o.lastSeen}`,o,null);dirty=true;}if(o.shiftId&&o.status==='en-route'&&o.clockedInAt&&ms-Date.parse(o.clockedInAt)>Number(state.settings.absenceMinutes||60)*60000){const before=state.alerts.length;raiseAbsence(o,state.sites.find(s=>s.id===o.siteId)||{});dirty ||= state.alerts.length!==before;}}
  for(const m of state.messages){const recipient=state.officers.find(x=>x.id===m.to);if(!m.deliveredAt&&recipient?.online&&!recipient.stunned){m.deliveredAt=now();dirty=true;}}
  const pending=state.scheduledMessages.filter(m=>m.scheduledAt&&Date.parse(m.scheduledAt)<=ms);if(pending.length){for(const m of pending){const recipient=state.officers.find(x=>x.id===m.to);m.deliveredAt=m.to==='all'||(recipient?.online&&!recipient.stunned)?now():null;state.messages.unshift(m);}state.scheduledMessages=state.scheduledMessages.filter(m=>!pending.includes(m));dirty=true;}
  for(const a of state.alerts.filter(x=>x.type==='sos'&&x.status==='raised'&&!x.escalated&&ms-Date.parse(x.raisedAt)>Number(state.settings.sosEscalationMinutes||2)*60000)){a.escalated=true;a.events.push({status:'escalated',at:now(),by:'System'});dirty=true;}
  const cutoff=ms-Math.max(1,Number(state.settings.retentionDays||90))*86400000;for(const o of state.officers){const before=(o.history||[]).length;o.history=(o.history||[]).filter(p=>Date.parse(p.receivedAt)>=cutoff);if(before!==o.history.length)dirty=true;}
  for(const key of ['messages','calls','recordings','alerts','traffic','telemetry','emails'])if(Array.isArray(state[key])){const before=state[key].length;state[key]=state[key].filter(x=>Date.parse(x.createdAt||x.raisedAt||x.startedAt||x.at||now())>=cutoff);if(before!==state[key].length)dirty=true;}
  const lastAutoBackupAt=Date.parse(state.lastAutoBackup||'');if(!autoBackupInProgress&&ms>=autoBackupRetryAt&&(!Number.isFinite(lastAutoBackupAt)||ms-lastAutoBackupAt>=3600000)){autoBackupInProgress=true;makeBackup().then(backup=>{state.lastAutoBackup=now();autoBackupRetryAt=0;recordDiagnostic('backup.auto.succeeded',{file:backup.file,sizeBytes:backup.size});console.log(`Hourly full-state backup created: ${backup.file} (${backup.size} bytes)`);save().catch(error=>{recordDiagnostic('backup.auto.metadata-save-failed',{message:error.message,status:error.status||null},'error');console.error('Could not persist automatic backup timestamp:',error.message);});}).catch(error=>{autoBackupRetryAt=Date.now()+300000;recordDiagnostic('backup.auto.failed',{message:error.message,status:error.status||null},'error');console.error('Hourly full-state backup failed; retrying in five minutes:',error.message);}).finally(()=>{autoBackupInProgress=false;});}
  if(dirty)save().catch(()=>{});
},5000).unref();
const PORT=Number(process.env.PORT||3000);
const startServer=()=>server.listen(PORT,process.env.HOST||'0.0.0.0',()=>console.log(`Dispatch Control Room running locally at http://localhost:${PORT}`));
if(supabaseConfigured&&supabaseBaseValid)initializeCloud().then(ready=>{if(!ready)scheduleCloudRecovery();}).finally(startServer);else startServer();
