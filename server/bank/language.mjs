// Détection de la langue du contenu d'examen (le TOEIC doit être rédigé en anglais).

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

// Mots-outils anglais absents du français : repère une explication rédigée en anglais.
const ENGLISH_WORDS=/\b(the|and|is|are|was|were|this|that|with|because|which|should|would|has|have|not|an)\b/gi;
export function looksEnglish(text){
  const s=String(text||"");
  const words=(s.match(/[A-Za-zÀ-ÿ']+/g)||[]).length;
  if(words<6)return false;
  return (s.match(ENGLISH_WORDS)||[]).length/words>0.2;
}
