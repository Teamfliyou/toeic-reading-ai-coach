import { useAuth } from "@/lib/AuthContext";

/**
 * Bouton de compte affiché dans les en-têtes. Il masque toute la fonctionnalité
 * si Supabase Auth n'est pas configuré : l'application reste inchangée.
 */
export default function AuthButton() {
  const { enabled, user, open } = useAuth();
  if (!enabled) return null;

  return (
    <button
      type="button"
      onClick={open}
      className="settings-trigger"
      title={user?.email ?? "Se connecter"}
    >
      {user ? user.email ?? "Mon compte" : "Se connecter"}
    </button>
  );
}
