import "dotenv/config";
import { readFileSync } from "node:fs";
import {authConfigured, setupStatus, setupFirstAdmin, currentUser, login, listUsers, addUser, modifyUser, cookie, publicUser} from "./admin-users.mjs";
import { DEEPSEEK_MODEL, computeCost } from "./deepseek-config.mjs";
import { quotaConfigured, reserve, finalize, release, currentMonth, budgetLimits } from "./quota.mjs";
import { clientIp } from "./rate-limit.mjs";
import { listReports, setReportStatus } from "./report.mjs";
import { recordAudit, userChangeEvents, listAudit } from "./audit.mjs";
import { registerAttempt, clearAttempt } from "./login-limiter.mjs";
// Modèle partagé avec /api/explain (source unique : server/deepseek-config.mjs).
export const MODEL = DEEPSEEK_MODEL;
const CATEGORIES=JSON.parse(readFileSync(new URL("../data/categories.json",import.meta.url),"utf8"));
/** Catégories (types de piège) autorisées pour une partie. */
export const categoriesForPart=(part)=>CATEGORIES.filter(c=>c.parts.includes(part)).map(c=>c.id);
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
export async function generate(body, emit = () => {}) {
  const part=Number(body.part),quantity=Number(body.quantity),topic=String(body.topic||"").slice(0,120),difficulty=Number(body.difficulty),kind=String(body.kind||"");
  if(![5,6,7].includes(part)||!Number.isInteger(quantity)||quantity<1||quantity>20||![1,2,3].includes(difficulty)||!["grammar","vocabulary","email","memo","article","schedule","notice"].includes(kind))throw new Error("Paramètres de génération invalides");
  if(!process.env.DEEPSEEK_API_KEY)throw new Error("Clé DEEPSEEK_API_KEY absente du serveur");
  const directive=part===5?"Write independent sentence-completion items with a single blank (______); passage must be null.":"Write one original professional English document and related questions; passage must include title and documents, each document having a kind among email,memo,article,notice,schedule,letter,message and a body that is an array of paragraphs. For part 6, put numbered blanks (1)______, (2)______ etc. inside the document; for part 7, write reading-comprehension questions about the document.";
  const prompt=`Write EXACTLY ${quantity} original TOEIC Reading practice questions, difficulty ${difficulty}/3, part ${part}, type ${kind}, topic ${topic||"varied business topics"}. ${directive} LANGUAGE RULE: every question prompt, every answer option, and every passage title, document title and body paragraph MUST be written entirely in English, never in French, even if the topic above is written in French. Only the "explanation" field is written in French. Do not copy protected text or official test questions. Distribute the correct answers evenly across A/B/C/D. Each question has exactly one clearly defensible correct answer. Each question is {part: ${part}, prompt: string, options:[{key:"A",text:string},{key:"B",text:string},{key:"C",text:string},{key:"D",text:string}],correctKey:"A"|"B"|"C"|"D",explanation:string (in French),category:string (exactly one of: ${categoriesForPart(part).join(", ")})}. For parts 6/7 also add passage={title:string,documents:[{kind:string,title:string,body:string[]}]}. Reply only with {questions:Question[],passage:Passage|null}. For part 6, each question refers to a distinct numbered blank, in order.`;
  emit("request_sent", "Demande envoyée à DeepSeek");
  const response=await fetch("https://api.deepseek.com/chat/completions",{method:"POST",headers:{"Authorization":`Bearer ${process.env.DEEPSEEK_API_KEY}`,"Content-Type":"application/json"},body:JSON.stringify({model:MODEL,messages:[{role:"system",content:"You are an expert professional English test-item writer. Produce valid original exam-style practice content as JSON. Never copy branded test questions. Ensure exactly one correct choice and a coherent passage. All exam content (question prompts, options, passage titles and bodies) must be in fluent English only; only the explanation field is in French."},{role:"user",content:prompt}],response_format:{type:"json_object"},stream:false,temperature:0.6,max_tokens:8000}),signal:AbortSignal.timeout(90000)});
  if(!response.ok)throw new Error(`DeepSeek HTTP ${response.status}`);
  emit("response_received", "Réponse reçue : vérification des questions");
  const payload=await response.json();const usage=computeCost(payload.usage);let result;
  // Dès ici DeepSeek a facturé l'appel : toute erreur porte le coût réel pour le budget.
  const bad=(message)=>Object.assign(new Error(message),{usage});
  try{result=JSON.parse(payload?.choices?.[0]?.message?.content||"{}");}catch{throw bad("DeepSeek n'a pas renvoyé un JSON valide");}
  const questions=Array.isArray(result.questions)?result.questions:[];
  for(const q of questions)if(q&&typeof q==="object")q.category=categoriesForPart(part).includes(q.category)?q.category:null;
  if(questions.length!==quantity||!questions.every(x=>validateItem(x,part)))throw bad("Lot incomplet ou invalide. Réessayez avec moins de questions.");
  if(part!==5&&(!result.passage||!Array.isArray(result.passage.documents)||!result.passage.documents.length))throw bad("Document absent du lot.");
  if(!isEnglishContent(questions,part===5?null:result.passage))throw bad("Le lot contient du français : le contenu TOEIC doit être entièrement en anglais. Relancez la génération.");
  emit("validated", `${questions.length} questions vérifiées dans le format attendu`);
  return {questions,passage:part===5?null:result.passage,cost:usage,notice:"Brouillon non publié : vérifiez les réponses avant export."};
}

// Réservation sur le budget mensuel partagé avec les explications (même plafond),
// et limite horaire par administrateur appliquée en base (valable sur toutes les instances).
export async function withBudget(user,run){
  let eventId=null;
  if(quotaConfigured()){
    const {limitUsd,suspendUsd}=budgetLimits();
    const r=await reserve({actor:"admin:"+user.id,dailyLimit:0,perMinute:Number(process.env.ADMIN_GENERATE_PER_HOUR)||10,windowSeconds:3600,estimatedUsd:Number(process.env.AI_ESTIMATED_GENERATION_USD)||0.012,limitUsd,suspendUsd,month:currentMonth()});
    if(!r.ok)throw new Error({rate:"Limite de génération atteinte",budget:"Budget mensuel d'IA atteint",in_flight:"Une génération est déjà en cours"}[r.reason]||"Génération indisponible pour le moment");
    eventId=r.eventId;
  }
  try{
    const out=await run();
    if(eventId)await finalize(eventId,out.cost?.estimatedUsd??0).catch(()=>{});
    return out;
  }catch(e){
    if(eventId){const billed=e?.usage?.estimatedUsd;if(billed>0)await finalize(eventId,billed).catch(()=>{});else await release(eventId).catch(()=>{});}
    throw e;
  }
}

/**
 * Enregistre un lot RELU ET VALIDÉ par un humain (jamais appelé automatiquement).
 * Les contrôles de format et de langue sont refaits ici : le contenu a pu être modifié
 * dans l'interface après la génération.
 */
export async function publishBatch(body){
  const base=process.env.SUPABASE_URL, key=process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!base||!key)throw new Error("Publication indisponible : renseignez SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY côté serveur.");
  const part=Number(body.part),questions=body.questions,passage=body.passage;
  if(![5,6,7].includes(part)||!Array.isArray(questions)||questions.length<1||questions.length>20||!questions.every(x=>validateItem(x,part)))throw new Error("Lot à publier invalide");
  if(part!==5&&(!passage||typeof passage.title!=="string"||!Array.isArray(passage.documents)||!passage.documents.length||passage.documents.length>3))throw new Error("Document invalide");
  if(!isEnglishContent(questions,part===5?null:passage))throw new Error("Le lot contient du français : le contenu TOEIC doit être entièrement en anglais.");
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
  const allowed=categoriesForPart(part);
  const rows=questions.map((q,i)=>({part,passage_id:passageId,order_index:Date.now()%100000000+i,prompt:q.prompt,options:q.options,correct_key:q.correctKey,difficulty:[1,2,3].includes(Number(q.difficulty))?Number(q.difficulty):Number(body.difficulty)||2,category:allowed.includes(q.category)?q.category:null,tags:[]}));
  const insert=(payload)=>fetch(endpoint("questions"),{method:"POST",headers,body:JSON.stringify(payload),signal:AbortSignal.timeout(20000)});
  let response=await insert(rows);
  // Base non migrée (colonnes category/tags absentes) : on publie sans catégorie plutôt que d'échouer.
  if(response.status===400)response=await insert(rows.map(({category:_c,tags:_t,...rest})=>rest));
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
   const gate=await registerAttempt(clientIp(req),"__setup__");
   if(!gate.ok){res.setHeader("Retry-After",String(gate.retryAfterSec));return json(res,429,{error:"Trop de tentatives. Réessayez plus tard."});}
   const user=await setupFirstAdmin(await readBody(req));
   await clearAttempt(gate.attemptId);
   await recordAudit({actor:user,action:"setup.first_admin",target:user.username,req});
   return json(res,201,{created:true,user});
  }
  if(action==="logout"){res.setHeader("Set-Cookie",cookie(req,""));return json(res,200,{ok:true});}
  if(action==="login"){
   const body=await readBody(req),username=typeof body.username==="string"?body.username:"",password=typeof body.password==="string"?body.password:"";
   const gate=await registerAttempt(clientIp(req),username);
   if(!gate.ok){res.setHeader("Retry-After",String(gate.retryAfterSec));return json(res,429,{error:"Trop de tentatives. Réessayez plus tard."});}
   if(username.length>32||password.length>256)return json(res,401,{error:"Identifiants incorrects"});
   const session=await login(req,username,password);
   if(!session)return json(res,401,{error:"Identifiants incorrects"});
   await clearAttempt(gate.attemptId);
   await recordAudit({actor:session.user,action:"login.success",target:session.user.username,req});
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
   const created=await addUser(await readBody(req));
   await recordAudit({actor:user,action:"user.create",target:created.username,details:{role:created.role},req});
   return json(res,201,{user:created});
  }
  if(action==="update-user"){
   if(user.role!=="admin")return json(res,403,{error:"Réservé aux administrateurs"});
   const body=await readBody(req);
   const changed=await modifyUser(user,body);
   for(const event of userChangeEvents(body,changed))await recordAudit({actor:user,req,...event});
   return json(res,200,{user:changed});
  }
  if(action==="audit"){
   if(user.role!=="admin")return json(res,403,{error:"Réservé aux administrateurs"});
   const body=await readBody(req);
   return json(res,200,{entries:await listAudit({action:typeof body.action==="string"?body.action:undefined})});
  }
  if(action==="reports"){const body=await readBody(req);return json(res,200,{reports:await listReports(typeof body.status==="string"?body.status:"open")});}
  if(action==="report-status"){const body=await readBody(req);const report=await setReportStatus(body.id,body.status,user.username);await recordAudit({actor:user,action:"report.status",target:body.id,details:{status:body.status},req});return json(res,200,{report});}
  if(action==="publish"){try{const published=await publishBatch(await readBody(req));await recordAudit({actor:user,action:"question.publish",details:{saved:published.saved,passageSaved:published.passageSaved},req});return json(res,200,published);}catch(e){return json(res,400,{error:e instanceof Error?e.message:"Publication échouée"});}}
  if(action==="generate-stream"){
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
     const data=await withBudget(user,()=>generate(body,emit));
     await recordAudit({actor:user,action:"questions.generate",details:{part:Number(body.part),count:data.questions.length,costUsd:data.cost.estimatedUsd},req});
     res.write(JSON.stringify({type:"result",data})+"\n");
   }catch(e){
     res.write(JSON.stringify({type:"error",message:e instanceof Error?e.message:"Erreur de génération"})+"\n");
   }finally{res.end();}
   return;
  }
  if(action==="generate"){
   try{const body=await readBody(req);const batch=await withBudget(user,()=>generate(body));await recordAudit({actor:user,action:"questions.generate",details:{part:Number(body.part),count:batch.questions.length,costUsd:batch.cost.estimatedUsd},req});return json(res,200,batch);}catch(e){return json(res,400,{error:e instanceof Error?e.message:"Génération échouée"});}
  }
  return json(res,404,{error:"Action inconnue"});
 }catch(e){return json(res,400,{error:e instanceof Error?e.message:"Erreur du serveur"});}
}
