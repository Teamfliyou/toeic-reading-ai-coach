// Chargement des exercices côté élève : JAMAIS toute la banque. Le navigateur demande à Supabase
// une série limitée (tirage aléatoire indexé, filtres, questions inédites d'abord) et retombe sur
// le jeu local data/questions.json si Supabase est inaccessible ou non migré.
//
// Ordre de repli : fonctions de la banque (supabase/question_bank.sql) → lecture REST bornée
// d'une base non migrée → jeu local JSON.

import type { Part, Passage, Question } from "../types.ts";

export interface Dataset {
  passages: Passage[];
  questions: Question[];
}

export type Origin = "bank" | "legacy" | "local";
export interface PickedSet extends Dataset {
  origin: Origin;
  /** Filtres abandonnés faute de questions suffisantes (ex. « difficulté »). */
  relaxed: string[];
}

export interface PickOptions {
  /** Questions (partie 5) ou documents (parties 6 et 7) à tirer. */
  limit?: number;
  difficulty?: number;
  category?: string;
  theme?: string;
  /** Identifiants (slugs) déjà vus : les inédits passent d'abord. */
  exclude?: string[];
  /** Autorise l'abandon progressif des filtres si la banque en manque (défaut : oui). */
  relax?: boolean;
}

export interface Source {
  url: string;
  key: string;
  local: Dataset;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  rng?: () => number;
}

export const DEFAULT_LIMIT: Record<Part, number> = { 5: 20, 6: 3, 7: 3 };
const MAX_EXCLUDE = 600;

const rowOf = (x: unknown) => x as Record<string, unknown>;

/** Ligne SQL (colonnes de bank_public_question ou de la table) → question de l'application. */
export function mapQuestion(row: Record<string, unknown>, local?: Dataset): Question {
  const byPrompt = local?.questions.find((q) => q.prompt === row.prompt);
  const tags = Array.isArray(row.tags) && row.tags.length ? (row.tags as string[]) : byPrompt?.tags;
  return {
    id: (row.slug as string | null) ?? (row.id as string),
    part: row.part as Part,
    passageId: (row.passage_id as string | null) ?? null,
    orderIndex: (row.order_index as number) ?? 0,
    prompt: row.prompt as string,
    options: row.options as Question["options"],
    correctKey: row.correct_key as Question["correctKey"],
    difficulty: row.difficulty as Question["difficulty"],
    category: (row.category as string | null) ?? byPrompt?.category,
    tags,
    theme: (row.theme as string | null) ?? null,
    explanation: (row.explanation as string | null) ?? null,
    rationales: (row.option_rationales as Record<string, string> | null) ?? null,
  };
}

export function mapPassage(row: Record<string, unknown>): Passage {
  return { id: row.id as string, part: row.part as Part, title: row.title as string, documents: row.documents as Passage["documents"] };
}

function shuffle<T>(list: T[], rng: () => number): T[] {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const matches = (q: Question, o: PickOptions) =>
  (!o.difficulty || q.difficulty === o.difficulty) && (!o.category || q.category === o.category) && (!o.theme || q.theme === o.theme);

/** Même logique que le tirage SQL, appliquée au jeu local (secours hors ligne). */
export function pickLocal(local: Dataset, part: Part, opts: PickOptions = {}, rng: () => number = Math.random): Dataset {
  const limit = opts.limit ?? DEFAULT_LIMIT[part];
  const seen = new Set(opts.exclude ?? []);
  const inPart = local.questions.filter((q) => q.part === part);
  const unseenFirst = <T>(items: T[], idOf: (x: T) => string[]): T[] => {
    const fresh = items.filter((x) => !idOf(x).some((id) => seen.has(id)));
    const old = items.filter((x) => idOf(x).some((id) => seen.has(id)));
    return [...shuffle(fresh, rng), ...shuffle(old, rng)];
  };
  if (part === 5) {
    const pool = inPart.filter((q) => !q.passageId && matches(q, opts));
    return { passages: [], questions: unseenFirst(pool, (q) => [q.id]).slice(0, limit) };
  }
  const byPassage = new Map<string, Question[]>();
  for (const q of inPart) if (q.passageId) byPassage.set(q.passageId, [...(byPassage.get(q.passageId) ?? []), q]);
  const eligible = [...byPassage.entries()].filter(([, qs]) => qs.some((q) => matches(q, opts)));
  const chosen = unseenFirst(eligible, ([, qs]) => qs.map((q) => q.id)).slice(0, limit);
  const ids = new Set(chosen.map(([id]) => id));
  return {
    passages: local.passages.filter((p) => ids.has(p.id)),
    questions: chosen.flatMap(([, qs]) => [...qs].sort((a, b) => a.orderIndex - b.orderIndex)),
  };
}

class MissingFunction extends Error {}

async function callRpc(src: Source, name: string, args: Record<string, unknown>): Promise<unknown> {
  const doFetch = src.fetchImpl ?? fetch;
  const response = await doFetch(`${src.url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: src.key, "Content-Type": "application/json" },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(src.timeoutMs ?? 8000),
  });
  if (response.status === 404) throw new MissingFunction(name);
  if (!response.ok) throw new Error(`Supabase ${name} : HTTP ${response.status}`);
  return response.json();
}

function mapBankSet(data: unknown, local: Dataset): Dataset {
  const d = data as { questions?: unknown[]; passages?: unknown[] };
  return {
    questions: (d?.questions ?? []).map((q) => mapQuestion(rowOf(q), local)),
    passages: (d?.passages ?? []).map((p) => mapPassage(rowOf(p))),
  };
}

async function bankPick(src: Source, part: Part, o: PickOptions): Promise<Dataset> {
  const limit = o.limit ?? DEFAULT_LIMIT[part];
  const common = {
    p_part: part, p_limit: limit, p_difficulty: o.difficulty ?? null, p_category: o.category ?? null,
    p_theme: o.theme ?? null, p_exclude: (o.exclude ?? []).slice(0, MAX_EXCLUDE),
  };
  const data = await callRpc(src, part === 5 ? "bank_pick_questions" : "bank_pick_passages", common);
  return mapBankSet(data, src.local);
}

/** Base non migrée : lecture REST bornée (200 lignes), tirage fait dans le navigateur. */
async function legacyPick(src: Source, part: Part, o: PickOptions): Promise<Dataset> {
  const doFetch = src.fetchImpl ?? fetch;
  const get = async (path: string) => {
    const r = await doFetch(`${src.url}/rest/v1/${path}`, { headers: { apikey: src.key }, signal: AbortSignal.timeout(src.timeoutMs ?? 8000) });
    if (!r.ok) throw new Error(`Supabase ${path} : HTTP ${r.status}`);
    return (await r.json()) as Record<string, unknown>[];
  };
  const rows = await get(`questions?part=eq.${part}&select=*&order=order_index.asc&limit=200`);
  if (!rows.length) throw new Error("Aucune question disponible dans Supabase");
  const passageIds = [...new Set(rows.map((r) => r.passage_id as string | null).filter((x): x is string => Boolean(x)))];
  const passages = part === 5 || !passageIds.length ? [] : await get(`passages?id=in.(${passageIds.join(",")})&select=*`);
  const all: Dataset = { questions: rows.map((r) => mapQuestion(r, src.local)), passages: passages.map(mapPassage) };
  return pickLocal(all, part, o, src.rng);
}

/**
 * Une série d'exercices pour une partie. Si les filtres laissent trop peu de questions, ils sont
 * abandonnés un à un (difficulté, puis thème, puis catégorie) et `relaxed` l'indique.
 */
export async function pickSet(src: Source, part: Part, opts: PickOptions = {}): Promise<PickedSet> {
  const limit = opts.limit ?? DEFAULT_LIMIT[part];
  const enough = (d: Dataset) => (part === 5 ? d.questions.length : d.passages.length) >= Math.min(limit, part === 5 ? 5 : 1);
  const attempts: { o: PickOptions; dropped: string[] }[] = [{ o: opts, dropped: [] }];
  if (opts.relax !== false) {
    let current = { ...opts };
    const dropped: string[] = [];
    for (const key of ["difficulty", "theme", "category"] as const) {
      if (current[key] === undefined) continue;
      current = { ...current, [key]: undefined };
      dropped.push(key);
      attempts.push({ o: current, dropped: [...dropped] });
    }
  }

  let legacy = false;
  let reachable = true;
  for (const { o, dropped } of attempts) {
    let data: Dataset | null = null;
    if (reachable && src.url && src.key) {
      try {
        data = legacy ? await legacyPick(src, part, o) : await bankPick(src, part, o);
      } catch (error) {
        if (error instanceof MissingFunction && !legacy) {
          legacy = true;
          try { data = await legacyPick(src, part, o); } catch { reachable = false; }
        } else reachable = false;
      }
    }
    if (data && enough(data)) return { ...data, origin: legacy ? "legacy" : "bank", relaxed: dropped };
    if (data && o === attempts[attempts.length - 1].o && (part === 5 ? data.questions.length : data.passages.length) > 0) {
      return { ...data, origin: legacy ? "legacy" : "bank", relaxed: dropped };
    }
    if (!reachable) break;
  }
  // Supabase injoignable (ou banque vide) : jeu local, mêmes filtres et mêmes règles.
  const local = pickLocal(src.local, part, opts, src.rng);
  if ((part === 5 ? local.questions.length : local.passages.length) >= 1 || opts.relax === false) return { ...local, origin: "local", relaxed: [] };
  return { ...pickLocal(src.local, part, { limit: opts.limit, exclude: opts.exclude }, src.rng), origin: "local", relaxed: ["difficulty", "theme", "category"] };
}

/** Questions retrouvées par identifiant (révision, historique) : 200 par appel, jeu local en secours. */
export async function loadByIds(src: Source, ids: string[]): Promise<Dataset> {
  const unique = [...new Set(ids)];
  const found: Dataset = { questions: [], passages: [] };
  const passageIds = new Set<string>();
  if (src.url && src.key) {
    try {
      for (let i = 0; i < unique.length; i += 200) {
        const data = mapBankSet(await callRpc(src, "bank_questions_by_ids", { p_ids: unique.slice(i, i + 200) }), src.local);
        for (const q of data.questions) if (!found.questions.some((x) => x.id === q.id)) found.questions.push(q);
        for (const p of data.passages) if (!passageIds.has(p.id)) { passageIds.add(p.id); found.passages.push(p); }
      }
    } catch {
      /* Supabase indisponible ou non migré : on complète avec le jeu local */
    }
  }
  const have = new Set(found.questions.map((q) => q.id));
  const missing = src.local.questions.filter((q) => unique.includes(q.id) && !have.has(q.id));
  for (const q of missing) found.questions.push(q);
  for (const p of src.local.passages) if (missing.some((q) => q.passageId === p.id) && !passageIds.has(p.id)) found.passages.push(p);
  return found;
}

export interface ExamPool {
  p5: Question[];
  p6: Dataset;
  p7: Dataset;
  origin: Origin;
}

/** Candidats pour composer un examen complet (la composition finale est faite par examBuilder). */
export async function examCandidates(src: Source, exclude: string[] = []): Promise<ExamPool> {
  if (src.url && src.key) {
    try {
      const d = (await callRpc(src, "bank_exam_candidates", { p_exclude: exclude.slice(0, MAX_EXCLUDE) })) as { p5: unknown[]; p6: unknown; p7: unknown };
      const pool: ExamPool = {
        p5: (d.p5 ?? []).map((q) => mapQuestion(rowOf(q), src.local)),
        p6: mapBankSet(d.p6, src.local),
        p7: mapBankSet(d.p7, src.local),
        origin: "bank",
      };
      if (pool.p5.length + pool.p6.questions.length + pool.p7.questions.length > 0) return pool;
    } catch {
      /* repli local */
    }
  }
  const all = (part: Part) => pickLocal(src.local, part, { limit: 1000, exclude }, src.rng);
  return { p5: all(5).questions, p6: all(6), p7: all(7), origin: "local" };
}
