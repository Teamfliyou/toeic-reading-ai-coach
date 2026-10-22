// Synchronisation de l'historique et des cartes de révision avec Supabase.
//
// Les requêtes partent directement du navigateur avec le jeton de l'utilisateur :
// c'est la RLS (supabase/user_data.sql) qui garantit que chacun n'accède qu'à ses
// propres lignes. En cas d'échec (hors ligne, migration absente), les données
// restent en local et la synchronisation est retentée à la prochaine occasion.

import { getAccessToken, getSession, onAuthChange } from "./supabaseAuth";
import { supabaseUrl, supabasePublishableKey } from "./supabaseConfig";
import {
  fromRow,
  mergeAttempts,
  pendingSync,
  toRow,
  type AttemptRow,
} from "./attempts";
import { mergeCards, type ReviewCard } from "./srs";
import {
  claimAnonymousCards,
  readAllAttempts,
  readCards,
  setSyncRequester,
  writeAttempts,
  writeCards,
} from "./tracker";

interface CardRow {
  user_id?: string;
  question_id: string;
  part: number;
  box: number;
  due: string;
  mastered: boolean;
  lapses: number;
  updated_at: string;
}

const cardToRow = (c: ReviewCard, userId: string): CardRow => ({
  user_id: userId,
  question_id: c.questionId,
  part: c.part,
  box: c.box,
  due: c.due,
  mastered: c.mastered,
  lapses: c.lapses,
  updated_at: c.updatedAt,
});

const cardFromRow = (r: CardRow): ReviewCard => ({
  questionId: r.question_id,
  part: r.part,
  box: r.box,
  due: r.due,
  mastered: r.mastered,
  lapses: r.lapses,
  updatedAt: r.updated_at,
});

async function rest(
  token: string,
  path: string,
  init: { method?: string; body?: unknown; prefer?: string } = {}
): Promise<unknown> {
  const response = await fetch(new URL(`/rest/v1/${path}`, supabaseUrl), {
    method: init.method ?? "GET",
    headers: {
      apikey: supabasePublishableKey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.prefer ? { Prefer: init.prefer } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Supabase ${response.status} sur ${path}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

let running = false;
let again = false;

/** Synchronise maintenant si un utilisateur est connecté et en ligne. */
export async function syncNow(): Promise<void> {
  const session = getSession();
  if (!session || (typeof navigator !== "undefined" && navigator.onLine === false)) return;
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    const token = await getAccessToken();
    if (!token) return;
    const userId = session.user.id;

    claimAnonymousCards(userId);

    // 1) Envoi des tentatives en attente (doublons ignorés grâce à l'id).
    const pending = pendingSync(readAllAttempts(), userId);
    for (let i = 0; i < pending.length; i += 200) {
      const batch = pending.slice(i, i + 200);
      await rest(token, "user_attempts?on_conflict=id", {
        method: "POST",
        prefer: "resolution=ignore-duplicates,return=minimal",
        body: batch.map((a) => toRow(a, userId)),
      });
      const sent = new Set(batch.map((a) => a.id));
      writeAttempts(
        readAllAttempts().map((a) => (sent.has(a.id) ? { ...a, synced: true, owner: userId } : a))
      );
    }

    // 2) Réception des tentatives récentes (autres appareils).
    const remote = (await rest(
      token,
      "user_attempts?select=*&order=created_at.desc&limit=2000"
    )) as AttemptRow[] | null;
    if (Array.isArray(remote)) {
      writeAttempts(mergeAttempts(readAllAttempts(), remote.map(fromRow)));
    }

    // 3) Cartes de révision : envoi puis fusion (la plus récente gagne).
    const cards = readCards(userId);
    if (cards.length) {
      await rest(token, "user_review_cards?on_conflict=user_id,question_id", {
        method: "POST",
        prefer: "resolution=merge-duplicates,return=minimal",
        body: cards.map((c) => cardToRow(c, userId)),
      });
    }
    const remoteCards = (await rest(token, "user_review_cards?select=*&limit=2000")) as
      | CardRow[]
      | null;
    if (Array.isArray(remoteCards)) {
      writeCards(mergeCards(readCards(userId), remoteCards.map(cardFromRow)), userId);
    }
  } catch {
    /* Hors ligne ou migration absente : nouvel essai à la prochaine réponse. */
  } finally {
    running = false;
    if (again) {
      again = false;
      void syncNow();
    }
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;

/** Branche la synchronisation : après chaque réponse (temporisée), à la connexion et au retour en ligne. */
export function initSync() {
  setSyncRequester(() => {
    clearTimeout(timer);
    timer = setTimeout(() => void syncNow(), 2000);
  });
  onAuthChange((session) => {
    if (session) void syncNow();
  });
  window.addEventListener("online", () => void syncNow());
  void syncNow();
}
