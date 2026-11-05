// Local, redacted server diagnostics. Runtime logs stay under ignored data/ and are never uploaded.
const fs=require('node:fs');
const path=require('node:path');
const dir=path.join(__dirname,'data');
const file=path.join(dir,'diagnostics.ndjson');
const MAX_EVENTS=12000;
const MAX_BYTES=5*1024*1024;
const sensitiveKey=/(password|passwd|secret|token|authorization|api[_-]?key|service[_-]?role|cookie|credential)/i;
let events=[];
try{fs.mkdirSync(dir,{recursive:true});if(fs.existsSync(file)){events=fs.readFileSync(file,'utf8').split(/\r?\n/).filter(Boolean).slice(-MAX_EVENTS).map(line=>{try{return JSON.parse(line);}catch{return null;}}).filter(Boolean);}}catch{}
function redactText(value){return String(value??'').slice(0,1600).replace(/(Bearer\s+)[^\s,;]+/ig,'$1[redacted]').replace(/((?:password|passwd|secret|token|authorization|api[_-]?key|service[_-]?role|cookie|credential)\s*[=:]\s*)[^\s&,;]+/ig,'$1[redacted]').replace(/([?&](?:key|token|apikey|api_key|access_token|password|secret)=)[^&#\s]*/ig,'$1[redacted]');}
function clean(value,key='',depth=0){if(sensitiveKey.test(key))return '[redacted]';if(value===null||value===undefined||typeof value==='boolean'||typeof value==='number')return value;if(typeof value==='string')return redactText(value);if(depth>3)return '[nested]';if(Array.isArray(value))return value.slice(0,16).map(item=>clean(item,'',depth+1));if(typeof value==='object'){const out={};for(const name of Object.keys(value).slice(0,32))out[name]=clean(value[name],name,depth+1);return out;}return redactText(value);}
function trimFile(){try{if(fs.statSync(file).size<=MAX_BYTES)return;const lines=fs.readFileSync(file,'utf8').split(/\r?\n/).filter(Boolean).slice(-Math.floor(MAX_EVENTS/2));fs.writeFileSync(file,lines.join('\n')+'\n',{encoding:'utf8',mode:0o600});}catch{}}
function record(name,details={},level='info'){const event={at:new Date().toISOString(),source:'server',level:String(level).slice(0,16),name:String(name||'event').slice(0,100),details:clean(details)};events.push(event);if(events.length>MAX_EVENTS)events.splice(0,events.length-MAX_EVENTS);try{fs.appendFileSync(file,JSON.stringify(event)+'\n',{encoding:'utf8',mode:0o600});trimFile();}catch{}return event;}
function exportEvents(){return events.slice(-MAX_EVENTS);}
module.exports={record,exportEvents};
