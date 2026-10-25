// Types partagés par les écrans d'administration de la banque d'exercices.

export type QStatus = "draft" | "review" | "published" | "archived";
export type QSource = "ai" | "import" | "manual";

export interface OptionRow {
  key: "A" | "B" | "C" | "D";
  text: string;
}

export interface ReviewFlag {
  code: string;
  message: string;
  severity?: string;
}

export interface QuestionRow {
  id: string;
  slug: string | null;
  part: 5 | 6 | 7;
  passage_id: string | null;
  passage_title?: string | null;
  order_index: number;
  prompt: string;
  options: OptionRow[];
  correct_key: "A" | "B" | "C" | "D";
  difficulty: 1 | 2 | 3;
  category: string | null;
  theme: string | null;
  tags: string[];
  explanation: string | null;
  option_rationales: Record<string, string> | null;
  status: QStatus;
  source: QSource;
  version: number;
  needs_review: boolean;
  review_flags: ReviewFlag[];
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  origin_version: string | null;
  open_reports?: number;
}

export interface PassageDoc {
  kind: string;
  title: string;
  body: string[];
}
export interface PassageRow {
  id: string;
  part: number;
  title: string;
  documents: PassageDoc[];
  status: QStatus;
}

export interface Filters {
  part?: number;
  difficulty?: number;
  category?: string;
  status?: QStatus;
  source?: QSource;
  needs_review?: boolean;
  q?: string;
  sort?: "newest" | "oldest" | "updated";
  job_id?: string;
  batch_id?: string;
  passage_id?: string;
}

export interface ListResult {
  total: number;
  limit: number;
  offset: number;
  rows: QuestionRow[];
}

export interface Revision {
  id: number;
  version: number;
  change_type: "edit" | "status" | "delete";
  changed_by: string;
  created_at: string;
  snapshot: Partial<QuestionRow>;
}

export interface QuestionDetail {
  question: QuestionRow;
  passage: PassageRow | null;
  siblings: QuestionRow[];
  revisions: Revision[];
  reports: { id: string; reason: string; comment: string; status: string; created_at: string }[];
}

export interface StatsResult {
  total: number;
  passages: number;
  needs_review: number;
  duplicate_groups: number;
  by_status: Record<string, number>;
  by_part_status: Record<string, number>;
  by_difficulty: Record<string, number>;
  by_category: Record<string, number>;
  by_source: Record<string, number>;
  answers_published: Record<string, number>;
}

export interface DuplicateGroup {
  hash: string;
  count: number;
  items: { id: string; slug: string; status: QStatus; prompt: string; created_at: string }[];
}

export interface IssueRow {
  id: number;
  ref: string | null;
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  payload: unknown;
}

export interface JobRow {
  id: string;
  status: "queued" | "running" | "paused" | "completed" | "cancelled" | "failed";
  part: 5 | 6 | 7;
  kind: string;
  difficulty: number;
  theme: string | null;
  options: { mixed?: boolean; category?: string | null; verify?: boolean };
  total_requested: number;
  batch_size: number;
  batches_total: number;
  batches_done: number;
  batches_failed: number;
  generated_count: number;
  validated_count: number;
  flagged_count: number;
  rejected_count: number;
  duplicate_count: number;
  estimated_usd: number | string;
  actual_usd: number | string;
  errors: { at: string; batch: number; attempt: number; final: boolean; message: string }[];
  created_by: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface JobBatch {
  idx: number;
  quantity: number;
  status: "pending" | "running" | "done" | "failed" | "cancelled";
  attempts: number;
  generated: number;
  validated: number;
  flagged: number;
  rejected: number;
  cost_usd: number | string;
  error: string | null;
}

export interface JobReport {
  job: JobRow;
  batches: JobBatch[];
  issue_counts: Record<string, number>;
}

export interface JobPlan {
  part: number;
  kind: string;
  total: number;
  batchSize: number;
  batches: number;
  verify: boolean;
  estimatedUsd: number;
}

export const STATUS_LABELS: Record<QStatus, string> = {
  draft: "Brouillon",
  review: "En validation",
  published: "Publié",
  archived: "Archivé",
};
export const SOURCE_LABELS: Record<QSource, string> = { ai: "IA", import: "Import", manual: "Manuel" };
export const DIFFICULTY_LABELS = ["", "Facile", "Intermédiaire", "Avancé"];
export const PART_LABELS: Record<number, string> = { 5: "Partie 5 · Phrases à trous", 6: "Partie 6 · Textes à trous", 7: "Partie 7 · Compréhension" };
