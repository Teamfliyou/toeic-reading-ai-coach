import { useCallback, useEffect, useState } from "react";

interface Entry {
  id: string;
  at: string;
  actor_username: string | null;
  action: string;
  target: string | null;
  details: Record<string, unknown>;
  ip_hash: string | null;
}

const LABELS: Record<string, string> = {
  "login.success": "Connexion réussie",
  "setup.first_admin": "Création du premier administrateur",
  "user.create": "Création d'un compte",
  "user.role": "Changement de rôle",
  "user.activate": "Réactivation d'un compte",
  "user.deactivate": "Désactivation d'un compte",
  "user.password_reset": "Réinitialisation de mot de passe",
  "question.publish": "Publication de questions",
  "questions.generate": "Génération de questions",
  "report.status": "Traitement d'un signalement",
};

type Request = (action: string, body: unknown) => Promise<{ entries?: Entry[] }>;

/** Journal d'audit des actions d'administration (réservé aux administrateurs). */
export default function AuditTab({ request }: { request: Request }) {
  const [action, setAction] = useState("");
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      setEntries((await request("audit", { action: action || undefined })).entries ?? []);
    } catch (e) {
      setEntries([]);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [request, action]);
  useEffect(() => void load(), [load]);

  return (
    <section className="lexora-card" aria-label="Journal d'audit">
      <h2>Journal d'audit</h2>
      <p className="lexora-muted">Actions sensibles de l'administration (200 dernières). Aucun mot de passe ni jeton n'y est enregistré.</p>
      <label>Filtrer par action
        <select className="lexora-admin-input" value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="">Toutes</option>
          {Object.entries(LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      {error && <p role="alert" className="lexora-notice">{error}</p>}
      {entries === null ? <p className="lexora-muted">Chargement…</p> : entries.length === 0 ? (
        <p className="lexora-muted">Aucune entrée. Si le journal reste vide, vérifiez que supabase/admin_audit.sql a été exécuté.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 12 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e9ef" }}>
                <th scope="col" style={{ padding: 8 }}>Date</th><th scope="col">Auteur</th><th scope="col">Action</th><th scope="col">Cible</th><th scope="col">Détails</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} style={{ borderBottom: "1px solid #eef1f5", verticalAlign: "top" }}>
                  <td style={{ padding: 8, whiteSpace: "nowrap" }}>{new Date(e.at).toLocaleString("fr-FR")}</td>
                  <td>{e.actor_username ?? "—"}</td>
                  <td>{LABELS[e.action] ?? e.action}</td>
                  <td>{e.target ?? "—"}</td>
                  <td>{Object.entries(e.details ?? {}).map(([k, v]) => `${k} : ${String(v)}`).join(" · ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
