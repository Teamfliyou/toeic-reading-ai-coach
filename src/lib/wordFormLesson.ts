// Leçon de référence : choisir entre nom, verbe, adjectif et adverbe (TOEIC partie 5).

export type WordClass = {
  id: "noun" | "verb" | "adjective" | "adverb";
  label: string;
  role: string;
  suffixes: { suffix: string; examples: string }[];
  positions: string[];
  trap?: string;
};

export const WORD_CLASSES: WordClass[] = [
  {
    id: "noun", label: "Nom", role: "Désigne une chose, une personne, une idée (sujet ou complément).",
    suffixes: [
      { suffix: "-tion / -sion", examples: "decision, expansion, application" },
      { suffix: "-ment", examples: "payment, management, agreement" },
      { suffix: "-ance / -ence", examples: "performance, experience, absence" },
      { suffix: "-ity / -ness", examples: "quality, availability, awareness" },
      { suffix: "-er / -or / -ist / -ee", examples: "manager, supervisor, specialist, employee" },
      { suffix: "-ship / -hood / -ism", examples: "ownership, neighborhood, tourism" },
    ],
    positions: [
      "Après un article ou un déterminant : the, a, an, this, that, my, our, their, its, some, any.",
      "Après un adjectif : a new policy, a major change.",
      "Après une préposition : of, in, for, with, by, on.",
      "En sujet devant le verbe, ou en complément après le verbe : the delivery arrived.",
    ],
    trap: "Un possessif (our, their, his…) est toujours suivi d'un nom, éventuellement précédé d'un adjectif.",
  },
  {
    id: "verb", label: "Verbe", role: "Exprime une action ou un état ; il porte le temps de la phrase.",
    suffixes: [
      { suffix: "-ize / -ise", examples: "organize, finalize, authorize" },
      { suffix: "-ify", examples: "simplify, clarify, verify" },
      { suffix: "-ate", examples: "create, communicate, evaluate" },
      { suffix: "-en", examples: "strengthen, widen, shorten" },
    ],
    positions: [
      "Après un sujet : The manager approves the plan.",
      "Après un modal : will, can, must, should, may + verbe à la base.",
      "Après to (infinitif) : plans to expand, in order to save.",
      "Après do / does / did / don't : did not receive.",
    ],
    trap: "Après un modal ou « to », on met toujours la forme de base : will improve, jamais will improvement.",
  },
  {
    id: "adjective", label: "Adjectif", role: "Décrit un nom ou qualifie le sujet.",
    suffixes: [
      { suffix: "-ful / -less", examples: "helpful, useful, careless" },
      { suffix: "-able / -ible", examples: "reliable, available, flexible" },
      { suffix: "-al / -ial", examples: "practical, financial, additional" },
      { suffix: "-ive / -ous", examples: "effective, competitive, various" },
      { suffix: "-ent / -ant", examples: "efficient, important, dependent" },
      { suffix: "-ic / -ary / -y", examples: "economic, necessary, costly*" },
    ],
    positions: [
      "Avant un nom : a reliable supplier, an excellent service.",
      "Après be / become / seem / remain / look / feel : The results are satisfactory.",
      "Après un adverbe d'intensité : very, quite, extremely, highly + adjectif.",
      "Après l'article/le possessif mais avant le nom : its ___ service → adjectif.",
    ],
    trap: "*Attention : certains mots en -ly sont des adjectifs (friendly, costly, timely, lively, likely, daily).",
  },
  {
    id: "adverb", label: "Adverbe", role: "Modifie un verbe, un adjectif, un autre adverbe ou toute la phrase.",
    suffixes: [
      { suffix: "adjectif + -ly", examples: "carefully, quickly, recently, significantly" },
      { suffix: "-ally", examples: "automatically, financially (adjectif en -ic/-al)" },
      { suffix: "Formes irrégulières", examples: "well, fast, hard, late, early, often, soon" },
    ],
    positions: [
      "Entre le sujet et le verbe : She carefully reviewed the file.",
      "Entre l'auxiliaire et le participe : has steadily increased / was immediately rejected.",
      "Juste avant un adjectif : extremely easy, highly profitable.",
      "En fin de phrase : The team worked efficiently.",
    ],
    trap: "Un adverbe n'est jamais obligatoire dans la phrase : si on peut le supprimer et que la phrase reste correcte, c'est souvent un adverbe.",
  },
];

export const RECIPE: { clue: string; answer: string }[] = [
  { clue: "article / possessif / préposition + ___ (+ of)", answer: "NOM" },
  { clue: "article + ___ + nom", answer: "ADJECTIF" },
  { clue: "be / become / seem + ___", answer: "ADJECTIF (ou participe passé)" },
  { clue: "will / can / must / to + ___", answer: "VERBE (forme de base)" },
  { clue: "___ + adjectif, ou sujet + ___ + verbe", answer: "ADVERBE" },
  { clue: "have / has / be + ___ + participe passé", answer: "ADVERBE" },
];

export type QuizItem = { prompt: string; options: string[]; answer: string; why: string };
export type QuizSeries = { id: string; title: string; intro: string; items: QuizItem[] };

const NATURE = ["Nom", "Verbe", "Adjectif", "Adverbe"];

export const SERIES: QuizSeries[] = [
  {
    id: "suffix",
    title: "Exercice 1 · Reconnaître la nature grâce au suffixe",
    intro: "Quelle est la nature de chaque mot ? Regardez la terminaison.",
    items: [
      { prompt: "management", options: NATURE, answer: "Nom", why: "Le suffixe -ment forme des noms (manage → management)." },
      { prompt: "organize", options: NATURE, answer: "Verbe", why: "Le suffixe -ize forme des verbes." },
      { prompt: "reliable", options: NATURE, answer: "Adjectif", why: "Le suffixe -able forme des adjectifs." },
      { prompt: "recently", options: NATURE, answer: "Adverbe", why: "Adjectif + -ly = adverbe (recent → recently)." },
      { prompt: "expansion", options: NATURE, answer: "Nom", why: "Le suffixe -sion forme des noms." },
      { prompt: "simplify", options: NATURE, answer: "Verbe", why: "Le suffixe -ify forme des verbes." },
      { prompt: "dependent", options: NATURE, answer: "Adjectif", why: "Le suffixe -ent est typique des adjectifs (dependant est le nom, dependent l'adjectif)." },
      { prompt: "financially", options: NATURE, answer: "Adverbe", why: "financial + -ly : la terminaison -ally donne un adverbe." },
    ],
  },
  {
    id: "position",
    title: "Exercice 2 · Deviner la nature du mot manquant",
    intro: "Ne cherchez pas encore le mot : quelle est la nature de ce qui manque ?",
    items: [
      { prompt: "The ___ of the report was surprising.", options: NATURE, answer: "Nom", why: "Article « the » avant et préposition « of » après : un nom est attendu." },
      { prompt: "She will ___ the file tomorrow.", options: NATURE, answer: "Verbe", why: "Après le modal « will », il faut un verbe à la base." },
      { prompt: "We need a very ___ solution.", options: NATURE, answer: "Adjectif", why: "« very » + ___ + nom : l'adjectif qualifie « solution »." },
      { prompt: "The CEO spoke ___ about the merger.", options: NATURE, answer: "Adverbe", why: "La phrase est complète sans lui : il précise comment le CEO a parlé." },
      { prompt: "Our ___ has grown steadily.", options: NATURE, answer: "Nom", why: "Possessif « our » + ___ + verbe : le sujet est un nom." },
      { prompt: "Employees are ___ to use the gym.", options: NATURE, answer: "Adjectif", why: "Après « be », on attend un adjectif (eligible)." },
      { prompt: "They have ___ finished the report.", options: NATURE, answer: "Adverbe", why: "Entre l'auxiliaire « have » et le participe : adverbe." },
      { prompt: "The firm plans to ___ its offices.", options: NATURE, answer: "Verbe", why: "Après « to » (infinitif) : un verbe." },
    ],
  },
  {
    id: "form",
    title: "Exercice 3 · Choisir la bonne forme (style TOEIC partie 5)",
    intro: "Choisissez la forme du mot qui complète la phrase.",
    items: [
      { prompt: "The company announced a major ___ in its pricing policy.", options: ["change", "changed", "changeable", "changeably"], answer: "change", why: "Article + adjectif (major) + ___ : un nom est attendu." },
      { prompt: "Ms. Lee ___ reviewed the contract before signing.", options: ["careful", "carefully", "care", "carefulness"], answer: "carefully", why: "Entre le sujet et le verbe : adverbe." },
      { prompt: "We offer a ___ solution to your storage problem.", options: ["practice", "practical", "practically", "practise"], answer: "practical", why: "Article + ___ + nom : adjectif." },
      { prompt: "All employees must ___ with the new safety rules.", options: ["comply", "compliance", "compliant", "compliantly"], answer: "comply", why: "Après le modal « must » : verbe à la base." },
      { prompt: "The manager was ___ with the team's results.", options: ["satisfy", "satisfied", "satisfaction", "satisfactorily"], answer: "satisfied", why: "Après « was » : adjectif (be satisfied with)." },
      { prompt: "Please submit your ___ before the end of the month.", options: ["apply", "application", "applicable", "applicably"], answer: "application", why: "Possessif « your » + ___ : nom." },
      { prompt: "The new software is ___ easy to install.", options: ["extreme", "extremely", "extremity", "extremist"], answer: "extremely", why: "Juste avant l'adjectif « easy » : adverbe." },
      { prompt: "Sales have ___ increased since January.", options: ["steady", "steadily", "steadiness", "steadied"], answer: "steadily", why: "Entre « have » et le participe « increased » : adverbe." },
      { prompt: "The committee plans to ___ the budget next week.", options: ["finalize", "final", "finally", "finality"], answer: "finalize", why: "Après « to » : verbe." },
      { prompt: "A ___ of the survey will be sent to all participants.", options: ["summary", "summarize", "summarized", "summarily"], answer: "summary", why: "Article « A » + ___ + « of » : nom." },
      { prompt: "The hotel is known for its ___ service.", options: ["excellence", "excellent", "excellently", "excel"], answer: "excellent", why: "Possessif « its » + ___ + nom « service » : adjectif." },
      { prompt: "Mr. Tan is ___ for managing the Osaka branch.", options: ["responsible", "responsibly", "responsibility", "responsibilities"], answer: "responsible", why: "Après « is » : adjectif (responsible for)." },
      { prompt: "The new policy will ___ the efficiency of our department.", options: ["improve", "improvement", "improvable", "improvingly"], answer: "improve", why: "Après le modal « will » : verbe à la base." },
      { prompt: "Their proposal was ___ rejected by the board.", options: ["immediate", "immediately", "immediacy", "immediateness"], answer: "immediately", why: "Entre « was » et le participe « rejected » : adverbe." },
      { prompt: "The ___ of the new building will take two years.", options: ["construct", "construction", "constructive", "constructively"], answer: "construction", why: "Article « The » + ___ + « of » : nom." },
      { prompt: "It is ___ to arrive early on the day of the interview.", options: ["advise", "advisable", "advisor", "advisably"], answer: "advisable", why: "Après « It is » : adjectif." },
    ],
  },
  {
    id: "form2",
    title: "Exercice 4 · Entraînement supplémentaire",
    intro: "Même principe, phrases plus longues : repérez les mots autour du trou.",
    items: [
      { prompt: "The marketing team made a ___ effort to meet the deadline.", options: ["considerable", "considerably", "consider", "consideration"], answer: "considerable", why: "Article + ___ + nom « effort » : adjectif." },
      { prompt: "Customers can ___ their orders online at any time.", options: ["track", "tracking", "tracker", "trackable"], answer: "track", why: "Après le modal « can » : verbe à la base." },
      { prompt: "The new printer is ___ faster than the old one.", options: ["significant", "significance", "significantly", "signify"], answer: "significantly", why: "Devant le comparatif « faster » : adverbe." },
      { prompt: "Thank you for your ___ in our company.", options: ["interested", "interesting", "interest", "interestingly"], answer: "interest", why: "Possessif « your » + ___ + préposition « in » : nom." },
      { prompt: "Please read the instructions ___ before assembling the desk.", options: ["careful", "carefully", "care", "caring"], answer: "carefully", why: "Fin de proposition, après le complément : adverbe de manière." },
      { prompt: "The merger was ___ for both companies.", options: ["benefit", "beneficial", "beneficially", "beneficiary"], answer: "beneficial", why: "Après « was » : adjectif." },
      { prompt: "Ms. Garcia was ___ promoted to regional director.", options: ["recent", "recently", "recency", "recentness"], answer: "recently", why: "Entre « was » et le participe « promoted » : adverbe." },
      { prompt: "We will ___ you of any change to the schedule.", options: ["notify", "notice", "notification", "notifiable"], answer: "notify", why: "Après « will » et avant « you of » : verbe (notify someone of)." },
      { prompt: "The ___ of renewable energy has increased this year.", options: ["use", "used", "usable", "usefully"], answer: "use", why: "Article « The » + ___ + « of » : nom (le verbe use ne convient pas ici)." },
      { prompt: "Participants must submit a ___ form before entering the lab.", options: ["complete", "completion", "completely", "completes"], answer: "complete", why: "Article + ___ + nom « form » : adjectif (complete = rempli)." },
      { prompt: "The speaker was ___ received by the audience.", options: ["enthusiasm", "enthusiastic", "enthusiastically", "enthuse"], answer: "enthusiastically", why: "Entre « was » et le participe « received » : adverbe." },
      { prompt: "Our new model is ___ to the previous one.", options: ["superior", "superiority", "superiorly", "superiors"], answer: "superior", why: "Après « is » : adjectif (superior to)." },
    ],
  },
];
