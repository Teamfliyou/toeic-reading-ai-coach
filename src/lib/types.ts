export type Part = 5 | 6 | 7;

export type OptionKey = "A" | "B" | "C" | "D";

export interface Option {
  key: OptionKey;
  text: string;
}

export type DocumentKind =
  | "email"
  | "memo"
  | "article"
  | "notice"
  | "schedule"
  | "letter"
  | "message";

export interface PassageDocument {
  id: string;
  kind: DocumentKind;
  title: string;
  body: string[];
}

export interface Passage {
  id: string;
  part: Part;
  title: string;
  documents: PassageDocument[];
}

export interface Question {
  id: string;
  part: Part;
  passageId: string | null;
  orderIndex: number;
  prompt: string;
  options: Option[];
  correctKey: OptionKey;
  difficulty: 1 | 2 | 3;
  /** Type de piège (voir data/categories.json). */
  category?: string;
  tags?: string[];
  /** Thème professionnel (banque d'exercices). */
  theme?: string | null;
  /** Explication pédagogique en français, si elle est renseignée. */
  explanation?: string | null;
  /** Justification de chaque mauvaise réponse (clé A–D). */
  rationales?: Record<string, string> | null;
}

export interface AiExplanation {
  diagnostic: string;
  resolution: string;
  tip: string;
}

export interface PartInfo {
  part: Part;
  name: string;
  tagline: string;
  description: string;
  questionCount: string;
  slug: string;
  icon: string;
  accent: string;
}
