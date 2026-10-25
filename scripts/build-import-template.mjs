// Régénère data/import-template.json : exemples valides des parties 5, 6 et 7 pour le
// modèle d'importation téléchargeable (Bibliothèque → Importer des exercices).
// Usage : node scripts/build-import-template.mjs
import { writeFileSync } from "node:fs";
import { FIELDS } from "../server/bank/import.mjs";

const headers = FIELDS.map((f) => f.id);
const row = (values) => Object.fromEntries(headers.map((h) => [h, values[h] ?? ""]));

const p6Text = [
  "From: Facilities Management",
  "Subject: Move to the Riverside Building",
  "We are pleased to announce that our offices (1)______ to the Riverside Building on March 3. All employees should (2)______ their personal belongings in the boxes provided by Friday.",
  "The new location offers (3)______ parking and a larger cafeteria. If you have any questions about the move, please (4)______ the Facilities desk.",
].join("\n");
const p7Email = [
  "From: Daniela Ruiz, Training Manager",
  "Subject: Customer Service Workshop",
  "I am pleased to invite all members of the sales team to a customer service workshop on April 12. The session will help you handle complaints more effectively and build lasting relationships with our clients. Please confirm your attendance by April 5 so that we can prepare enough materials.",
].join("\n");
const p7Schedule = [
  "9:00 – 10:00: Welcome and introductions",
  "10:00 – 12:00: Handling difficult customers",
  "12:00 – 1:00: Lunch break",
  "1:00 – 3:00: Role-play session",
  "3:00 – 4:00: Questions and closing remarks",
].join("\n");

const rows = [
  row({
    part: 5, prompt: "All invoices must be submitted ______ the end of the month.",
    option_a: "by", option_b: "until", option_c: "since", option_d: "during", correct: "A", difficulty: 1,
    category: "prepositions", theme: "Accounting", tags: "deadline;preposition",
    explanation: "« by » indique une échéance (au plus tard à cette date) ; « until » exprime une durée continue.",
    rationale_b: "« until » décrit une action qui dure jusqu'à une date, pas une date limite.",
    rationale_c: "« since » s'utilise avec un point de départ dans le passé.",
    rationale_d: "« during » est suivi d'une période, pas d'une date butoir.",
    external_id: "EX-P5-001",
  }),
  row({
    part: 5, prompt: "The new manager is responsible for ______ the sales team's quarterly goals.",
    option_a: "set", option_b: "setting", option_c: "to set", option_d: "sets", correct: "B", difficulty: 2,
    category: "verb-patterns", theme: "Management", tags: "gerund",
    explanation: "Après une préposition (« for »), le verbe se met au gérondif : « setting ».",
    external_id: "EX-P5-002",
  }),
  row({
    part: 5, prompt: "Ms. Okafor was ______ by her colleagues for her excellent presentation.",
    option_a: "congratulate", option_b: "congratulating", option_c: "congratulated", option_d: "congratulation", correct: "C", difficulty: 2,
    category: "passive-modals", theme: "Human resources", tags: "passive",
    explanation: "La voix passive se construit avec « be » + participe passé : « was congratulated ».",
    external_id: "EX-P5-003",
  }),
  ...[
    ["We are pleased to announce that our offices (1)______ to the Riverside Building on March 3.", "moving", "will move", "moved", "to move", "B", "verb-tenses", "Le futur planifié s'exprime avec « will move »."],
    ["All employees should (2)______ their personal belongings in the boxes provided by Friday.", "packing", "packed", "pack", "to pack", "C", "verb-patterns", "Après le modal « should », le verbe reste à l'infinitif sans « to »."],
    ["The new location offers (3)______ parking and a larger cafeteria.", "convenient", "conveniently", "convenience", "conveniences", "A", "word-forms", "Un adjectif (« convenient ») est requis devant le nom « parking »."],
    ["If you have any questions about the move, please (4)______ the Facilities desk.", "contacts", "contacted", "contacting", "contact", "D", "verb-patterns", "L'impératif poli « please contact » utilise l'infinitif."],
  ].map(([prompt, a, b, c, d, correct, category, explanation], i) => row({
    part: 6, passage_ref: "P6-OFFICE-MOVE", passage_title: "Memo — Office Relocation",
    doc1_kind: "memo", doc1_title: "To: All Staff", doc1_text: p6Text,
    question_number: i + 1, prompt, option_a: a, option_b: b, option_c: c, option_d: d, correct, difficulty: 2,
    category, theme: "Office life", explanation, external_id: `EX-P6-00${i + 1}`,
  })),
  ...[
    ["What is the main purpose of the e-mail?", "To announce a customer service workshop", "To request a budget increase", "To introduce a new employee", "To cancel a client meeting", "A", "reading-purpose", 1, "Le courriel annonce un atelier de formation : c'est son objet principal."],
    ["According to the schedule, what will happen right after the lunch break?", "A welcome speech", "A role-play session", "A group photograph", "A sales report", "B", "reading-detail", 2, "Le planning place les jeux de rôle (« role-play ») juste après le déjeuner."],
    ["What can be inferred about the participants?", "They are new to the company.", "They have attended the workshop before.", "They work in the sales department.", "They are travelling from abroad.", "C", "reading-inference", 3, "Le courriel est adressé à « All Sales Staff » : les participants travaillent aux ventes."],
  ].map(([prompt, a, b, c, d, correct, category, difficulty, explanation], i) => row({
    part: 7, passage_ref: "P7-WORKSHOP", passage_title: "E-mail and Schedule — Customer Service Workshop",
    doc1_kind: "email", doc1_title: "To: All Sales Staff", doc1_text: p7Email,
    doc2_kind: "schedule", doc2_title: "Workshop Schedule — April 12", doc2_text: p7Schedule,
    question_number: i + 1, prompt, option_a: a, option_b: b, option_c: c, option_d: d, correct, difficulty,
    category, theme: "Sales", explanation, external_id: `EX-P7-00${i + 1}`,
  })),
];

const notes = [
  "Un fichier = une ligne par question. Parties 5, 6 et 7 dans la même feuille.",
  "Champs obligatoires : prompt, option_a à option_d, correct (A, B, C ou D). part est obligatoire sauf si vous choisissez une partie par défaut à l'importation.",
  "Partie 5 : l'énoncé contient un trou « ______ ». Ne renseignez aucun document.",
  "Partie 6 : le document contient des trous numérotés « (1)______ », « (2)______ »… ; chaque ligne est la phrase contenant le trou (identique au document). Répétez passage_ref et le texte du document sur toutes les lignes du même document.",
  "Partie 7 : 1 à 3 documents (doc1_*, doc2_*, doc3_*), 2 à 5 questions par document. Répétez passage_ref et les textes sur chaque ligne.",
  "Types de document : email, memo, article, notice, schedule, letter, message. Séparez les paragraphes par un retour à la ligne.",
  "difficulty : 1 (facile), 2 (intermédiaire) ou 3 (avancé). category : voir la liste dans l'interface (ex. prepositions, verb-tenses, reading-detail).",
  "tags : séparés par des points-virgules. explanation et rationale_* : en français.",
  "Tout est importé en BROUILLON : rien n'est publié avant votre validation dans la bibliothèque.",
  "Le contenu doit être original. Ne collez pas de questions officielles protégées par le droit d'auteur.",
];

writeFileSync(new URL("../data/import-template.json", import.meta.url), JSON.stringify({ headers, rows, notes }, null, 2) + "\n");
console.log(`data/import-template.json : ${rows.length} lignes d'exemple.`);
