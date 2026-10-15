import "dotenv/config";
import {randomBytes,scryptSync,timingSafeEqual,createHmac} from "node:crypto";
const COOKIE="lexora_admin";
const headers=()=>({apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:"Bearer "+process.env.SUPABASE_SERVICE_ROLE_KEY,"Content-Type":"application/json",Prefer:"return=representation"});
const endpoint=(q="")=>new URL("/rest/v1/lexora_admin_users"+q,process.env.SUPABASE_URL).toString();
export const authConfigured=()=>Boolean(process.env.SUPABASE_URL&&process.env.SUPABASE_SERVICE_ROLE_KEY&&process.env.ADMIN_SESSION_SECRET?.length>=32);
async function sql(method,q="",body){
 const r=await fetch(endpoint(q),{method,headers:headers(),...(body?{body:JSON.stringify(body)}:{}) ,signal:AbortSignal.timeout(10000)});
 if(!r.ok)throw Error("Base des utilisateurs indisponible ("+r.status+"). Exécutez le schéma SQL.");
 return r.status===204?[]:r.json();
}
const safe=(u)=>({id:u.id,username:u.username,role:u.role,active:u.active,createdAt:u.created_at});
const hash=(password,salt)=>scryptSync(password,salt,64).toString("hex");
const verify=(password,user)=>{const a=Buffer.from(hash(password,user.password_salt),"hex"),b=Buffer.from(user.password_hash,"hex");return a.length===b.length&&timingSafeEqual(a,b);};
function hashed(password){const salt=randomBytes(24).toString("hex");return {password_salt:salt,password_hash:hash(password,salt)};}
export async function setupStatus() {
  if (!authConfigured()) return {configured:false,needsSetup:false};
  const rows=await sql("GET","?select=id&limit=1");
  return {configured:true,needsSetup:rows.length===0};
}
export async function setupFirstAdmin({setupCode,username,password}) {
  if (!authConfigured()) throw Error("Configuration Supabase ou secret de session incomplet.");
  // Setup is only authorized by the deployment owner who knows the private
  // server-side bootstrap credential, never by visiting the public setup page.
  const secret=process.env.ADMIN_INITIAL_PASSWORD;
  if (!secret || secret.length<16) throw Error("Définissez ADMIN_INITIAL_PASSWORD (16 caractères minimum) dans Vercel pour activer la configuration initiale.");
  if(typeof setupCode!=="string"||setupCode.length>256)throw Error("Code de configuration invalide.");
  const received=Buffer.from(setupCode),expected=Buffer.from(secret);
  if(received.length!==expected.length||!timingSafeEqual(received,expected))throw Error("Code de configuration invalide.");
  if(!/^[a-zA-Z][a-zA-Z0-9_.-]{2,31}$/.test(username)||typeof password!=="string"||password.length<12||password.length>256)throw Error("Identifiant ou mot de passe invalide (12 caractères minimum).");
  const current=await sql("GET","?select=id&limit=1");
  if(current.length)throw Error("Un administrateur existe déjà. Connectez-vous pour gérer les comptes.");
  try {
    const created=await sql("POST","",{username,role:"admin",active:true,...hashed(password)});
    return safe(created[0]);
  } catch(e) {
    const after=await sql("GET","?select=id&limit=1");
    if(after.length)throw Error("Configuration initiale déjà terminée.");
    throw e;
  }
}
function sign(data){return createHmac("sha256",process.env.ADMIN_SESSION_SECRET).update(data).digest("hex");}
function tokenFor(user){const raw=Buffer.from(JSON.stringify({id:user.id,at:Date.now(),version:user.session_version})).toString("base64url");return raw+"."+sign(raw);}
function parse(req){const match=String(req.headers.cookie||"").match(/(?:^|;\s*)lexora_admin=([^;]+)/);return match?.[1];}
function secure(req){return req.headers["x-forwarded-proto"]==="https"||req.socket?.encrypted?"Secure; ":"";}
export function cookie(req,token){return COOKIE+"="+token+"; Path=/api/admin; HttpOnly; "+secure(req)+"SameSite=Strict; Max-Age="+(token?28800:0);}
export async function currentUser(req){
 if(!authConfigured())return null;const token=parse(req);if(!token)return null;
 const [raw,sig]=token.split(".");if(!raw||!sig)return null;
 const expected=sign(raw);if(sig.length!==expected.length||!timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return null;
 let payload;try{payload=JSON.parse(Buffer.from(raw,"base64url").toString("utf8"));}catch{return null;}
 if(!payload?.id||Date.now()-payload.at>28800000||payload.at>Date.now())return null;
 const rows=await sql("GET","?id=eq."+encodeURIComponent(payload.id)+"&select=*&limit=1");
 const u=rows[0];return u?.active&&u.session_version===payload.version?u:null;
}
export async function login(req,username,password){
 const rows=await sql("GET","?username=eq."+encodeURIComponent(username)+"&select=*&limit=1");
 const u=rows[0];
 // Constant-time dummy password computation for nonexistent accounts.
 if(!u){hash(password,"bca923edcb90df23d4ef42abc123aaa3");return null;}
 if(!u.active||!verify(password,u))return null;
 return {token:tokenFor(u),user:safe(u)};
}
export async function listUsers(){return (await sql("GET","?select=id,username,role,active,created_at&order=created_at.asc")).map(safe);}
export async function addUser({username,password,role}){
 if(!/^[a-zA-Z][a-zA-Z0-9_.-]{2,31}$/.test(username)||typeof password!=="string"||password.length<12||password.length>256||!["admin","editor"].includes(role))throw Error("Identifiant, rôle ou mot de passe invalide (12 caractères minimum).");
 const created=await sql("POST","",{username,role,active:true,...hashed(password)});
 return safe(created[0]);
}
export async function modifyUser(actor,{id,active,password,role}){
 if(typeof id!=="string"||id.length>80)throw Error("Identifiant invalide");
 const rows=await sql("GET","?id=eq."+encodeURIComponent(id)+"&select=*&limit=1");const existing=rows[0];if(!existing)throw Error("Utilisateur introuvable");
 const changes={};if(typeof active==="boolean")changes.active=active;
 if(role!==undefined){if(!["admin","editor"].includes(role))throw Error("Rôle invalide");changes.role=role;}
 if(password!==undefined){if(typeof password!=="string"||password.length<12||password.length>256)throw Error("Mot de passe : 12 caractères minimum");Object.assign(changes,hashed(password));}
 if(!Object.keys(changes).length)throw Error("Aucune modification");
 if(existing.id===actor.id&&(changes.active===false||changes.role==="editor"))throw Error("Vous ne pouvez pas désactiver ou rétrograder votre propre compte");
 if(existing.role==="admin"&&(changes.active===false||changes.role==="editor")){
   const admins=await sql("GET","?role=eq.admin&active=eq.true&select=id");
   if(admins.length<=1)throw Error("Impossible de désactiver le dernier administrateur");
 }
 changes.session_version=existing.session_version+1;
 const result=await sql("PATCH","?id=eq."+encodeURIComponent(id),changes);
 return safe(result[0]);
}
export const publicUser=safe;
