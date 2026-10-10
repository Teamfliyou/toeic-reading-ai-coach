import type { PartInfo } from "./types";

export const PARTS: PartInfo[] = [
  {
    part: 5,
    name: "Phrases à trous",
    tagline: "Incomplete Sentences",
    description:
      "Grammaire et vocabulaire : choisissez le mot ou groupe de mots qui complète chaque phrase.",
    questionCount: "30 questions à l'examen",
    slug: "part5",
    icon: "sentence",
    accent: "from-violet-500/80 to-fuchsia-500/80",
  },
  {
    part: 6,
    name: "Textes à trous",
    tagline: "Text Completion",
    description:
      "Complétez un e-mail, une lettre ou un article en insérant le mot ou la phrase adapté au contexte.",
    questionCount: "16 questions à l'examen",
    slug: "part6",
    icon: "text",
    accent: "from-cyan-500/80 to-blue-500/80",
  },
  {
    part: 7,
    name: "Compréhension écrite",
    tagline: "Reading Comprehension",
    description:
      "Lisez un ou plusieurs documents (e-mails, plannings, messages croisés) et répondez aux questions.",
    questionCount: "54 questions à l'examen",
    slug: "part7",
    icon: "reading",
    accent: "from-indigo-500/80 to-emerald-500/80",
  },
];

export function getPartInfo(part: number): PartInfo {
  return PARTS.find((p) => p.part === part) ?? PARTS[0];
}
