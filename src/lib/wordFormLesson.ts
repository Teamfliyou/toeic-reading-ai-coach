// Leçon « Word families — Les familles de mots » (TOEIC partie 5).

export type SuffixTable = { head: [string, string]; rows: [string, string][] };

export type Nature = {
  id: "noun" | "adjective" | "verb" | "adverb";
  title: string;
  definition: string;
  examples: string;
  table?: SuffixTable;
  notes: string[];
};

export const FAMILY_EXAMPLE: [string, string][] = [
  ["Verbe", "to influence (influencer)"],
  ["Nom", "influence (influence)"],
  ["Adjectif", "influential (influent)"],
  ["Adverbe", "influentially (de manière influente)"],
];

export const NATURES: Nature[] = [
  {
    id: "noun", title: "A. Le nom (noun)",
    definition: "Un nom sert à désigner une personne, un lieu, une chose ou une idée.",
    examples: "cat, school, teacher, street",
    table: {
      head: ["Suffixe fréquent", "Exemple"],
      rows: [
        ["-ance / -ence", "appearance"], ["-ness", "kindness"], ["-ity", "purity"], ["-hood", "neighbourhood"],
        ["-ism", "tourism"], ["-ment", "improvement"], ["-tion / -sion", "specialization"], ["-er / -or", "teacher / actor"],
        ["-ist", "flutist"], ["-cy", "fluency"], ["-age", "leverage"], ["-ship", "friendship"], ["-dom", "kingdom"],
      ],
    },
    notes: [],
  },
  {
    id: "adjective", title: "B. L'adjectif (adjective)",
    definition: "Un adjectif sert à décrire ou qualifier un nom.",
    examples: "old, small, fast, blue, helpful, funny",
    table: {
      head: ["Suffixe", "Exemples"],
      rows: [
        ["-able", "readable, understandable, recognizable, countable, forgivable, negotiable"],
        ["-ible", "flexible, edible, responsible, impossible"],
        ["-ive", "responsive, evasive, dismissive, expressive, informative"],
        ["-al", "legal, brutal, terminal, lethal, fatal, suicidal, exponential"],
        ["-ous", "furious, outrageous, delicious, spacious, marvellous, frivolous"],
        ["-ful", "faithful, useful, hopeful, forgetful, beautiful, tearful"],
        ["-less", "needless, spiritless, cloudless, harmless, useless, legless, worthless, priceless"],
        ["-ish", "thirtyish, yellowish, moreish, Spanish"],
      ],
    },
    notes: [],
  },
  {
    id: "verb", title: "C. Le verbe (verb)",
    definition: "Un verbe exprime une action ou un état.",
    examples: "run, eat, talk, be, hope",
    table: {
      head: ["Suffixe / terminaison", "Exemples"],
      rows: [
        ["-ise / -ize", "customize, organize, analyze, synthesize, recognize, realize, specialize"],
        ["-ify", "electrify, identify, terrify, purify, beautify, horrify"],
        ["-ate", "activate, animate, designate, originate"],
        ["-en", "deepen, strengthen"],
        ["-ed (forme conjuguée)", "wanted, acted"],
      ],
    },
    notes: ["Attention : -ed est généralement une terminaison du passé ou du participe passé, pas un suffixe permettant de reconnaître systématiquement un verbe à l'infinitif."],
  },
  {
    id: "adverb", title: "D. L'adverbe (adverb)",
    definition: "Un adverbe peut notamment préciser la manière dont se déroule une action.",
    examples: "slowly, happily, loudly",
    notes: [
      "Le suffixe le plus fréquent est -ly.",
      "Deux exceptions courantes pour les adverbes de manière : fast et hard, qui ne prennent pas -ly dans leur sens habituel.",
    ],
  },
];

export const STRATEGY = [
  "Repérer une question qui demande une forme grammaticale.",
  "Identifier la nature du mot manquant : nom, verbe, adjectif ou adverbe.",
  "Éliminer les propositions dont la nature grammaticale ne convient pas.",
  "Vérifier que le mot retenu donne une phrase correcte et logique.",
];

export const CLUES: [string, string][] = [
  ["a / an / the + ______", "Nom, ou adjectif suivi d'un nom"],
  ["very + ______", "Adjectif ou adverbe"],
  ["to + ______ (infinitif)", "Verbe à la base verbale"],
  ["Verbe d'action + ______", "Souvent un adverbe de manière"],
  ["______ + nom", "Souvent un adjectif"],
];

export const REVIEW: [string, string, string, string][] = [
  ["Nom", "Désigner", "-tion, -ment, -ness, -ity, -ship", "happiness"],
  ["Adjectif", "Décrire un nom", "-able, -ive, -ful, -less, -ous", "helpful"],
  ["Verbe", "Exprimer une action ou un état", "-ize, -ify, -ate, -en", "simplify"],
  ["Adverbe", "Préciser notamment une action", "-ly", "carefully"],
];

export type McqItem = { prompt: string; options: string[]; answer: string; why: string };

// Exemple de question donné dans le cours.
export const EXAMPLE_QUESTION: McqItem = {
  prompt: "Given the bad weather in the Mediterranean last month, the delay in shipping the spare parts to Portugal was certainly ______.",
  options: ["understand", "understandable", "understandably", "understanding"],
  answer: "understandable",
  why: "Après « was certainly », on attend ici un adjectif décrivant « the delay » : « le retard était certainement compréhensible ».",
};

export type FillItem = { before: string; after?: string; answers: string[] };
export type FillFamily = { word: string; items: FillItem[] };

// Exercice 1 : chaque famille a deux phrases à compléter.
export const FILL_FAMILIES: FillFamily[] = [
  { word: "CRITIC", items: [
    { before: "Sometimes it is necessary to", after: ".", answers: ["criticize", "criticise"] },
    { before: "He has a very", after: "approach.", answers: ["critical"] },
  ] },
  { word: "ELECTRIC", items: [
    { before: "This amazing speech is going to", after: "the audience.", answers: ["electrify"] },
    { before: "A washing machine is an", after: "appliance.", answers: ["electric", "electrical"] },
  ] },
  { word: "ACTIVE", items: [
    { before: "He is an", after: "member of our association.", answers: ["active"] },
    { before: "The police are", after: "searching for the criminal.", answers: ["actively"] },
  ] },
  { word: "HARM", items: [
    { before: "Don't worry. He is completely", after: ".", answers: ["harmless"] },
    { before: "Smoking is", after: "so please stop.", answers: ["harmful"] },
  ] },
  { word: "CHILD", items: [
    { before: "I had a very happy", after: "which I spent near a lake.", answers: ["childhood"] },
    { before: "Don't behave in such a", after: "manner.", answers: ["childish"] },
  ] },
  { word: "HAPPY", items: [
    { before: "I would like to wish for love and", after: ".", answers: ["happiness"] },
    { before: "He and his wife both seem", after: ".", answers: ["happy"] },
  ] },
  { word: "USE", items: [
    { before: "Throw away that old coat because it is completely", after: ".", answers: ["useless"] },
    { before: "They have", after: "over half of the supplies.", answers: ["used"] },
  ] },
  { word: "ORIGIN", items: [
    { before: "What an", after: "idea.", answers: ["original"] },
    { before: "The idea", after: "from China.", answers: ["originated"] },
  ] },
  { word: "EMPLOY", items: [
    { before: "The government is hoping to create more", after: "in the area.", answers: ["employment"] },
    { before: "The company is laying off thirty", after: ".", answers: ["employees"] },
  ] },
  { word: "RECOGNIZE", items: [
    { before: "He has received a lot of", after: "for his research.", answers: ["recognition"] },
    { before: "Mary has changed so much that I almost didn't", after: "her.", answers: ["recognize", "recognise"] },
  ] },
];

// Exercice 2 : QCM, dans l'ordre (A) à (D) du cours.
export const MCQ: McqItem[] = [
  { prompt: "You should ______ the piano more if you want to improve.", options: ["practising", "practical", "practise", "practically"], answer: "practise", why: "Après « should », il faut un verbe à la base verbale : practise." },
  { prompt: "This firm is very ______ concerning deliveries.", options: ["reliability", "rely", "relied", "reliable"], answer: "reliable", why: "Après « is very », on attend un adjectif : reliable (-able)." },
  { prompt: "The brand is sold ______ in luxury stores.", options: ["exclusively", "exclusive", "exclusivity", "exclusiveness"], answer: "exclusively", why: "La phrase est complète sans lui et il précise comment la marque est vendue : adverbe (-ly)." },
  { prompt: "He spoke ______ to emphasize the importance of the idea.", options: ["noisy", "loudness", "loudly", "loud"], answer: "loudly", why: "Après le verbe d'action « spoke » : adverbe de manière." },
  { prompt: "The machine is ______ $300.", options: ["worthless", "worthy", "worth", "worthiness"], answer: "worth", why: "« be worth + somme » : worth se place directement devant le montant." },
  { prompt: "The new company is ______ of our investment.", options: ["worthless", "worthy", "worth", "worthiness"], answer: "worthy", why: "« be worthy of » : adjectif suivi de la préposition « of »." },
  { prompt: "I find that the manager's comments were very ______.", options: ["helpful", "help", "helplessness", "helpfully"], answer: "helpful", why: "Après « were very », on attend un adjectif qui décrit « comments » : helpful (-ful)." },
  { prompt: "______ is important because we need to feel supported.", options: ["Friends", "Friendly", "Friendless", "Friendship"], answer: "Friendship", why: "Sujet singulier de « is » : un nom (-ship)." },
];
