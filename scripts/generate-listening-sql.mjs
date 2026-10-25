// Génère supabase/listening_seed.sql depuis data/listening.json : migration du Listening Partie 2
// vers la bibliothèque centralisée (supabase/listening_bank.sql). Idempotent (clé : slug).
// Usage : npm run listening:generate   (npm run check:data vérifie que le fichier est à jour)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const q = (value) => `'${String(value).replace(/'/g, "''")}'`;

export function buildListeningSeedSql(data) {
  const lines = [
    "-- Listening Partie 2 : données de départ générées depuis data/listening.json (npm run listening:generate).",
    "-- À exécuter après supabase/listening_bank.sql. Idempotent : relancer ne crée aucun doublon (clé : slug).",
    "-- Les exercices sont PUBLIÉS (contenu déjà validé) ; aucun fichier audio n'est créé : la synthèse vocale",
    "-- du navigateur reste utilisée tant qu'un enregistrement n'est pas référencé (champ `audio` du JSON).",
    "",
  ];
  for (const item of data.part2) {
    let trackSql = "null";
    if (item.audio) {
      lines.push(`insert into public.listening_tracks (audio_url, provider) values (${q(item.audio)}, 'recording') on conflict (audio_url) do nothing;`);
      trackSql = `(select id from public.listening_tracks where audio_url = ${q(item.audio)})`;
    }
    const transcript = [item.prompt, ...item.options.map((o) => `${o.key}. ${o.text}`)].join(" ");
    lines.push(
      `insert into public.listening_items (slug, part, prompt, transcript, options, correct_key, difficulty, category, track_id, status, source) values (` +
        `${q(item.id)}, 2, ${q(item.prompt)}, ${q(transcript)}, ${q(JSON.stringify(item.options))}::jsonb, ${q(item.correctKey)}, ${Number(item.difficulty) || 2}, ${q(item.category)}, ${trackSql}, 'published', 'json') ` +
        "on conflict (slug) do nothing;"
    );
  }
  return lines.join("\n") + "\n";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const data = JSON.parse(readFileSync(new URL("../data/listening.json", import.meta.url), "utf8"));
  writeFileSync(new URL("../supabase/listening_seed.sql", import.meta.url), buildListeningSeedSql(data));
  console.log(`supabase/listening_seed.sql : ${data.part2.length} exercices.`);
}
