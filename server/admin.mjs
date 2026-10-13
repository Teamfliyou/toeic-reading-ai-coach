import "dotenv/config";
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const COOKIE = "lexora_admin";
const MODEL = "deepseek-flash";
const PRICES = { miss: 0.15, hit: 0.003, output: 0.60 };
const loginAttempts = new Map();
const buckets = new Map();
function envSecret() {
  if (!process.env.ADMIN_PASSWORD || !process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_SESSION_SECRET.length < 32) return null;
  return process.env.ADMIN_SESSION_SECRET;
}
function json(res, code, data) { res.statusCode=code;res.setHeader("Content-Type","application/json; charset=utf-8");res.setHeader("Cache-Control","no-store");res.end(JSON.stringify(data)); }
async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  let body="";for await (const chunk of req) { body+=chunk; if(body.length>32000) throw new Error("Requête trop volumineuse");}
  return JSON.parse(body||"{}");
}
function sign(data,secret){return createHmac("sha256",secret).update(data).digest("hex");}
function cookies(req){return Object.fromEntries(String(req.headers.cookie||"").split(";").map(v=>v.trim().split(/=(.*)/s).slice(0,2)).filter(v=>v[0]));}
function authorized(req) {
  const secret=envSecret(), token=cookies(req)[COOKIE];if(!secret||!token)return false;
  const pieces=token.split(".");if(pieces.length!==2)return false;
  const [payload,signature]=pieces;const expected=sign(payload,secret);
  if(signature.length!==expected.length||!timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))return false;
  const issued=Number(payload);return Number.isFinite(issued)&&issued<=Date.now()&&Date.now()-issued<8*3600*1000;
}
function sameOrigin(req) {
  const origin=req.headers.origin; if(!origin)return false;
  try {const u=new URL(origin);const host=req.headers["x-forwarded-host"]||req.headers.host;return u.host===host&&["https:","http:"].includes(u.protocol);}catch{return false;}
}
function rate(map,key,max,windowMs){
  const now=Date.now(),list=(map.get(key)||[]).filter(t=>now-t<windowMs);
  if(list.length>=max){map.set(key,list);return false;}
  list.push(now);map.set(key,list);if(map.size>2000)map.clear();return true;
}
function comparePassword(input,actual) {
  const salt="lexora-admin-password-v1";
  const a=scryptSync(input,salt,32),b=scryptSync(actual,salt,32);
  return timingSafeEqual(a,b);
}
function validateItem(x,part){
  if(!x||typeof x!=="object"||typeof x.prompt!=="string"||x.prompt.length<15||x.prompt.length>1500)return false;
  if(!Array.isArray(x.options)||x.options.length!==4)return false;
  if(x.options.some((o,i)=>o?.key!=="ABCD"[i]||typeof o.text!=="string"||!o.text.trim()))return false;
  return "ABCD".includes(x.correctKey)&&x.part===part&&typeof x.explanation==="string";
}
function peakUTC(now=new Date()){
  const day=now.getUTCDay(),h=now.getUTCHours();
  return day>=1&&day<=5&&((h>=1&&h<4)||(h>=6&&h<10));
}
function cost(usage){
  const input=usage?.prompt_tokens||0, output=usage?.completion_tokens||0;
  const hit=Math.min(input,usage?.prompt_cache_hit_tokens||0),miss=Math.max(0,input-hit);
  const rate=peakUTC()?2:1;
  return {inputTokens:input,outputTokens:output,cacheHitTokens:hit,estimatedUsd:Number(((miss*PRICES.miss+hit*PRICES.hit+output*PRICES.output)/1e6*rate).toFixed(6)),ratePeriod:rate===2?"peak":"off-peak",model:MODEL,priceReference:"https://api-docs.deepseek.com/quick_start/pricing/"};
}
async function generate(body) {
  const part=Number(body.part),quantity=Number(body.quantity),topic=String(body.topic||"").slice(0,120),difficulty=Number(body.difficulty),kind=String(body.kind||"");
  if(![5,6,7].includes(part)||!Number.isInteger(quantity)||quantity<1||quantity>20||![1,2,3].includes(difficulty)||!["grammar","vocabulary","email","memo","article","schedule","notice"].includes(kind))throw new Error("Paramètres de génération invalides");
  if(!process.env.DEEPSEEK_API_KEY)throw new Error("Clé DEEPSEEK_API_KEY absente du serveur");
  const directive=part===5?"Génère des phrases à trou indépendantes; passage doit être null.": "Génère un document professionnel anglais original et des questions liées; passage doit inclure title et documents avec un document kind parmi email,memo,article,notice,schedule,letter,message, et body tableau de paragraphes. Pour la partie 6, place les trous numérotés (1)______ etc. dans le document; pour la partie 7, questions de compréhension associées au document.";
  const prompt=`Génère EXACTEMENT ${quantity} questions originales en anglais de niveau difficulté ${difficulty}/3 pour anglais professionnel, partie ${part}, type ${kind}, thème ${topic||"varié"}. ${directive} Aucun texte protégé ou question officielle recopiée. Répartis équitablement les réponses A/B/C/D. Une seule bonne réponse clairement justifiable par question. Chaque question est {part: ${part}, prompt: string, options:[{key:"A",text:string},{key:"B",text:string},{key:"C",text:string},{key:"D",text:string}],correctKey:"A"|"B"|"C"|"D",explanation:string en français}. Pour les parties 6/7 ajoute un objet passage={title:string,documents:[{kind:string,title:string,body:string[]}]}. Réponds seulement avec {questions:Question[],passage:Passage|null}. Si partie 6, chaque question fait référence à un trou distinct numéroté dans l'ordre.`;
  const response=await fetch("https://api.deepseek.com/chat/completions",{method:"POST",headers:{"Authorization":`Bearer ${process.env.DEEPSEEK_API_KEY}`,"Content-Type":"application/json"},body:JSON.stringify({model:MODEL,messages:[{role:"system",content:"You are an expert professional English test-item writer. Produce valid original exam-style practice content as JSON. Never copy branded test questions. Ensure exactly one correct choice, fluent English, coherent passage and accurate French explanations."},{role:"user",content:prompt}],response_format:{type:"json_object"},stream:false,temperature:0.6,max_tokens:8000}),signal:AbortSignal.timeout(90000)});
  if(!response.ok)throw new Error(`DeepSeek HTTP ${response.status}`);
  const payload=await response.json();let result;
  try{result=JSON.parse(payload?.choices?.[0]?.message?.content||"{}");}catch{throw new Error("DeepSeek n'a pas renvoyé un JSON valide");}
  const questions=Array.isArray(result.questions)?result.questions:[];
  if(questions.length!==quantity||!questions.every(x=>validateItem(x,part)))throw new Error("Lot incomplet ou invalide. Réessayez avec moins de questions.");
  if(part!==5&&(!result.passage||!Array.isArray(result.passage.documents)||!result.passage.documents.length))throw new Error("Document absent du lot.");
  return {questions,passage:part===5?null:result.passage,cost:cost(payload.usage),notice:"Brouillon non publié : vérifiez les réponses avant export."};
}
export async function handleAdmin(req,res) {
  const action=new URL(req.url||"/api/admin","http://localhost").searchParams.get("action")||"session";
  if(action==="session"&&req.method==="GET")return json(res,200,{authenticated:authorized(req),configured:Boolean(envSecret()),generationConfigured:Boolean(process.env.DEEPSEEK_API_KEY)});
  if(req.method!=="POST")return json(res,405,{error:"Méthode non autorisée"});
  if(!sameOrigin(req)||!String(req.headers["content-type"]||"").startsWith("application/json"))return json(res,403,{error:"Origine non autorisée"});
  if(!envSecret())return json(res,503,{error:"ADMIN_PASSWORD et ADMIN_SESSION_SECRET doivent être configurés côté serveur."});
  if(action==="logout"){res.setHeader("Set-Cookie",`${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/api/admin; Max-Age=0`);return json(res,200,{ok:true});}
  if(action==="login"){
    const ip=String(req.headers["x-forwarded-for"]||req.socket?.remoteAddress||"unknown").split(",")[0];
    if(!rate(loginAttempts,ip,5,15*60000))return json(res,429,{error:"Trop de tentatives. Réessayez ultérieurement."});
    let body;try{body=await readBody(req);}catch{return json(res,400,{error:"JSON invalide"});}
    const password=typeof body.password==="string"?body.password:"";
    if(password.length>256||!comparePassword(password,process.env.ADMIN_PASSWORD))return json(res,401,{error:"Mot de passe incorrect"});
    const ts=String(Date.now()),token=`${ts}.${sign(ts,envSecret())}`;
    res.setHeader("Set-Cookie",`${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/api/admin; Max-Age=28800`);
    return json(res,200,{ok:true});
  }
  if(!authorized(req))return json(res,401,{error:"Connexion administrateur requise"});
  if(action==="generate"){
    if(!rate(buckets,"generation",10,3600000))return json(res,429,{error:"Limite de 10 générations par heure atteinte"});
    try{return json(res,200,await generate(await readBody(req)));}
    catch(e){return json(res,400,{error:e instanceof Error?e.message:"Erreur de génération"});}
  }
  return json(res,404,{error:"Action inconnue"});
}
