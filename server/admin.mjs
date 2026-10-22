import "dotenv/config";
import {authConfigured, setupStatus, setupFirstAdmin, currentUser, login, listUsers, addUser, modifyUser, cookie, publicUser} from "./admin-users.mjs";
import { DEEPSEEK_MODEL } from "./deepseek-config.mjs";
// Modèle partagé avec /api/explain (source unique : server/deepseek-config.mjs).
export const MODEL = DEEPSEEK_MODEL;
const PRICES = { miss: 0.15, hit: 0.003, output: 0.60 };
const loginAttempts = new Map();
const buckets = new Map();
function json(res, code, data) { res.statusCode=code;res.setHeader("Content-Type","application/json; charset=utf-8");res.setHeader("Cache-Control","no-store");res.end(JSON.stringify(data)); }
async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  let body="";for await(const chunk of req){body+=chunk;if(body.length>32000)throw Error("Requête trop volumineuse");}
  return JSON.parse(body||"{}");
}
function sameOrigin(req) {
 const origin=req.headers.origin;if(!origin)return false;
 try{const u=new URL(origin),host=req.headers["x-forwarded-host"]||req.headers.host;return u.host===host&&["https:","http:"].includes(u.protocol);}catch{return false;}
}
function rate(map,key,max,windowMs){const now=Date.now(),list=(map.get(key)||[]).filter(t=>now-t<windowMs);if(list.length>=max){map.set(key,list);return false;}list.push(now);map.set(key,list);if(map.size>2000)map.clear();return true;}
function validateItem(x,part){
  if(!x||typeof x!=="object"||typeof x.prompt!=="string"||x.prompt.length<15||x.prompt.length>1500)return false;
  if(!Array.isArray(x.options)||x.options.length!==4)return false;
  if(x.options.some((o,i)=>o?.key!=="ABCD"[i]||typeof o.text!=="string"||!o.text.trim()))return false;
  return "ABCD".includes(x.correctKey)&&x.part===part&&typeof x.explanation==="string";
}
// Mots-outils français absents de l'anglais : détecte un contenu d'examen rédigé en français.
const FRENCH_WORDS=/\b(le|les|des|est|sont|vous|nous|pour|dans|une|avec|votre|qui|que|cette|ces|sur|mais|doit|être|sans|plus|très|aux|du)\b/gi;
export function looksFrench(text){
  const s=String(text||"");
  const words=(s.match(/[A-Za-zÀ-ÿ']+/g)||[]).length;
  if(words<4)return false;
  return (s.match(FRENCH_WORDS)||[]).length/words>0.12||/[«»]/.test(s);
}
export function isEnglishContent(questions,passage){
  const texts=[];
  for(const q of questions||[]){texts.push(q.prompt);for(const o of q.options||[])texts.push(o.text);}
  if(passage){texts.push(passage.title);for(const d of passage.documents||[]){texts.push(d.title);texts.push(...(Array.isArray(d.body)?d.body:[d.body]));}}
  return !texts.some(looksFrench);
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
export async function generate(body, emit = () => {}) {
  const part=Number(body.part),quantity=Number(body.quantity),topic=String(body.topic||"").slice(0,120),difficulty=Number(body.difficulty),kind=String(body.kind||"");
  if(![5,6,7].includes(part)||!Number.isInteger(quantity)||quantity<1||quantity>20||![1,2,3].includes(difficulty)||!["grammar","vocabulary","email","memo","article","schedule","notice"].includes(kind))throw new Error("Paramètres de génération invalides");
  if(!process.env.DEEPSEEK_API_KEY)throw new Error("Clé DEEPSEEK_API_KEY absente du serveur");
  const directive=part===5?"Write independent sentence-completion items with a single blank (______); passage must be null.":"Write one original professional English document and related questions; passage must include title and documents, each document having a kind among email,memo,article,notice,schedule,letter,message and a body that is an array of paragraphs. For part 6, put numbered blanks (1)______, (2)______ etc. inside the document; for part 7, write reading-comprehension questions about the document.";
  const prompt=`Write EXACTLY ${quantity} original TOEIC Reading practice questions, difficulty ${difficulty}/3, part ${part}, type ${kind}, topic ${topic||"varied business topics"}. ${directive} LANGUAGE RULE: every question prompt, every answer option, and every passage title, document title and body paragraph MUST be written entirely in English, never in French, even if the topic above is written in French. Only the "explanation" field is written in French. Do not copy protected text or official test questions. Distribute the correct answers evenly across A/B/C/D. Each question has exactly one clearly defensible correct answer. Each question is {part: ${part}, prompt: string, options:[{key:"A",text:string},{key:"B",text:string},{key:"C",text:string},{key:"D",text:string}],correctKey:"A"|"B"|"C"|"D",explanation:string (in French)}. For parts 6/7 also add passage={title:string,documents:[{kind:string,title:string,body:string[]}]}. Reply only with {questions:Question[],passage:Passage|null}. For part 6, each question refers to a distinct numbered blank, in order.`;
  emit("request_sent", "Demande envoyée à DeepSeek");
  const response=await fetch("https://api.deepseek.com/chat/completions",{method:"POST",headers:{"Authorization":`Bearer ${process.env.DEEPSEEK_API_KEY}`,"Content-Type":"application/json"},body:JSON.stringify({model:MODEL,messages:[{role:"system",content:"You are an expert professional English test-item writer. Produce valid original exam-style practice content as JSON. Never copy branded test questions. Ensure exactly one correct choice and a coherent passage. All exam content (question prompts, options, passage titles and bodies) must be in fluent English only; only the explanation field is in French."},{role:"user",content:prompt}],response_format:{type:"json_object"},stream:false,temperature:0.6,max_tokens:8000}),signal:AbortSignal.timeout(90000)});
  if(!response.ok)throw new Error(`DeepSeek HTTP ${response.status}`);
  emit("response_received", "Réponse reçue : vérification des questions");
  const payload=await response.json();let result;
  try{result=JSON.parse(payload?.choices?.[0]?.message?.content||"{}");}catch{throw new Error("DeepSeek n'a pas renvoyé un JSON valide");}
  const questions=Array.isArray(result.questions)?result.questions:[];
  if(questions.length!==quantity||!questions.every(x=>validateItem(x,part)))throw new Error("Lot incomplet ou invalide. Réessayez avec moins de questions.");
  if(part!==5&&(!result.passage||!Array.isArray(result.passage.documents)||!result.passage.documents.length))throw new Error("Document absent du lot.");
  if(!isEnglishContent(questions,part===5?null:result.passage))throw new Error("Le lot contient du français : le contenu TOEIC doit être entièrement en anglais. Relancez la génération.");
  emit("validated", `${questions.length} questions vérifiées dans le format attendu`);
  return {questions,passage:part===5?null:result.passage,cost:cost(payload.usage),notice:"Brouillon non publié : vérifiez les réponses avant export."};
}

async function publish(body){
  const base=process.env.SUPABASE_URL, key=process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!base||!key)throw new Error("Publication indisponible : renseignez SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY côté serveur.");
  const part=Number(body.part),questions=body.questions,passage=body.passage;
  if(![5,6,7].includes(part)||!Array.isArray(questions)||questions.length<1||questions.length>20||!questions.every(x=>validateItem(x,part)))throw new Error("Lot à publier invalide");
  if(part!==5&&(!passage||typeof passage.title!=="string"||!Array.isArray(passage.documents)||!passage.documents.length||passage.documents.length>3))throw new Error("Document invalide");
  const url=new URL(base);
  if(url.protocol!=="https:")throw new Error("SUPABASE_URL doit utiliser HTTPS");
  const headers={apikey:key,Authorization:"Bearer "+key,"Content-Type":"application/json",Prefer:"return=representation"};
  const endpoint=(table)=>new URL("/rest/v1/"+table,url).toString();
  let passageId=null;
  if(part!==5){
    const r=await fetch(endpoint("passages"),{method:"POST",headers,body:JSON.stringify({part,title:passage.title.slice(0,250),documents:passage.documents}),signal:AbortSignal.timeout(12000)});
    if(!r.ok)throw new Error("Impossible d'enregistrer le document dans Supabase");
    const created=await r.json();passageId=created[0]?.id;
    if(!passageId)throw new Error("Identifiant de document manquant");
  }
  const rows=questions.map((q,i)=>({part,passage_id:passageId,order_index:Date.now()%100000000+i,prompt:q.prompt,options:q.options,correct_key:q.correctKey,difficulty:[1,2,3].includes(Number(q.difficulty))?Number(q.difficulty):Number(body.difficulty)||2}));
  const response=await fetch(endpoint("questions"),{method:"POST",headers,body:JSON.stringify(rows),signal:AbortSignal.timeout(20000)});
  if(!response.ok) {
    if(passageId)await fetch(endpoint("passages")+"?id=eq."+encodeURIComponent(passageId),{method:"DELETE",headers}).catch(()=>{});
    throw new Error("Enregistrement des questions échoué");
  }
  const inserted=await response.json();
  return {saved:inserted.length,passageSaved:Boolean(passageId)};
}

export async function handleAdmin(req,res) {
 const action=new URL(req.url||"/api/admin","http://localhost").searchParams.get("action")||"session";
 try{
  if(action==="session"&&req.method==="GET"){
   const state=await setupStatus();
   const u=state.configured ? await currentUser(req) : null;
   return json(res,200,{authenticated:Boolean(u),user:u?publicUser(u):null,...state,configured:authConfigured(),generationConfigured:Boolean(process.env.DEEPSEEK_API_KEY),publicationConfigured:Boolean(process.env.SUPABASE_URL&&process.env.SUPABASE_SERVICE_ROLE_KEY)});
  }
  if(req.method!=="POST")return json(res,405,{error:"Méthode non autorisée"});
  if(!sameOrigin(req)||!String(req.headers["content-type"]||"").startsWith("application/json"))return json(res,403,{error:"Origine non autorisée"});
  if(!authConfigured())return json(res,503,{error:"Configurez les variables de connexion et Supabase côté serveur."});
  if(action==="setup"){
   const ip=String(req.headers["x-forwarded-for"]||req.socket?.remoteAddress||"unknown").split(",")[0];
   if(!rate(loginAttempts,ip,5,900000))return json(res,429,{error:"Trop de tentatives. Réessayez plus tard."});
   const user=await setupFirstAdmin(await readBody(req));
   return json(res,201,{created:true,user});
  }
  if(action==="logout"){res.setHeader("Set-Cookie",cookie(req,""));return json(res,200,{ok:true});}
  if(action==="login"){
   const ip=String(req.headers["x-forwarded-for"]||req.socket?.remoteAddress||"unknown").split(",")[0];
   if(!rate(loginAttempts,ip,5,900000))return json(res,429,{error:"Trop de tentatives. Réessayez plus tard."});
   const body=await readBody(req),username=typeof body.username==="string"?body.username:"",password=typeof body.password==="string"?body.password:"";
   if(username.length>32||password.length>256)return json(res,401,{error:"Identifiants incorrects"});
   const session=await login(req,username,password);
   if(!session)return json(res,401,{error:"Identifiants incorrects"});
   res.setHeader("Set-Cookie",cookie(req,session.token));
   return json(res,200,{ok:true,user:session.user});
  }
  const user=await currentUser(req);
  if(!user)return json(res,401,{error:"Connexion requise"});
  if(action==="users"){
   if(user.role!=="admin")return json(res,403,{error:"Réservé aux administrateurs"});
   return json(res,200,{users:await listUsers()});
  }
  if(action==="create-user"){
   if(user.role!=="admin")return json(res,403,{error:"Réservé aux administrateurs"});
   const created=await addUser(await readBody(req));return json(res,201,{user:created});
  }
  if(action==="update-user"){
   if(user.role!=="admin")return json(res,403,{error:"Réservé aux administrateurs"});
   const changed=await modifyUser(user,await readBody(req));return json(res,200,{user:changed});
  }
  if(action==="publish"){try{return json(res,200,await publish(await readBody(req)));}catch(e){return json(res,400,{error:e instanceof Error?e.message:"Publication échouée"});}}
  if(action==="generate-stream"){
   if(!rate(buckets,user.id,10,3600000))return json(res,429,{error:"Limite de génération atteinte"});
   res.statusCode=200;
   res.setHeader("Content-Type","application/x-ndjson; charset=utf-8");
   res.setHeader("Cache-Control","no-cache, no-transform");
   res.setHeader("X-Content-Type-Options","nosniff");
   res.flushHeaders?.();
   const emit=(stage,message)=>res.write(JSON.stringify({type:"status",stage,message,at:Date.now()})+"\n");
   try{
     emit("preparing","Préparation du lot de questions");
     const body=await readBody(req);
     emit("checking","Contrôle des paramètres");
     const data=await generate(body,emit);
     res.write(JSON.stringify({type:"result",data})+"\n");
   }catch(e){
     res.write(JSON.stringify({type:"error",message:e instanceof Error?e.message:"Erreur de génération"})+"\n");
   }finally{res.end();}
   return;
  }
  if(action==="generate"){
   if(!rate(buckets,user.id,10,3600000))return json(res,429,{error:"Limite de génération atteinte"});
   try{return json(res,200,await generate(await readBody(req)));}catch(e){return json(res,400,{error:e instanceof Error?e.message:"Génération échouée"});}
  }
  return json(res,404,{error:"Action inconnue"});
 }catch(e){return json(res,400,{error:e instanceof Error?e.message:"Erreur du serveur"});}
}
