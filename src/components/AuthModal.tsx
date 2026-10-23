import { useEffect, useState, type FormEvent } from "react";
import { useDialog } from "@/lib/useDialog";
import { useAuth } from "@/lib/AuthContext";

type Mode = "signin" | "signup";

const MIN_PASSWORD = 6;

export default function AuthModal() {
  const { enabled, user, isOpen, close, signIn, signUp, signOut } = useAuth();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setError(null);
      setNotice(null);
      setPassword("");
      setBusy(false);
    }
  }, [isOpen]);

  const dialogRef = useDialog<HTMLDivElement>(Boolean(enabled && isOpen), close);

  if (!enabled || !isOpen) return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setNotice(null);

    if (!email.trim() || password.length < MIN_PASSWORD) {
      setError(
        `Saisissez une adresse e-mail valide et un mot de passe d'au moins ${MIN_PASSWORD} caractères.`
      );
      return;
    }

    setBusy(true);
    try {
      if (mode === "signin") {
        await signIn(email, password);
        close();
      } else {
        const { needsConfirmation } = await signUp(email, password);
        if (needsConfirmation) {
          setNotice(
            "Compte créé. Vérifiez votre boîte mail pour confirmer votre adresse, puis connectez-vous."
          );
          setMode("signin");
        } else {
          close();
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Une erreur est survenue.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={close}
      role="dialog"
      aria-modal="true"
      aria-label="Connexion"
    >
      <div
        ref={dialogRef}
        className="glass-strong w-full max-w-md animate-fade-up p-6"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-bold text-white/95">
            {user ? "Mon compte" : "Connexion à Lernoviq"}
          </h2>
          <button
            type="button"
            onClick={close}
            aria-label="Fermer"
            className="glass-btn px-2.5 py-1.5"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {user ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm">
              <span aria-hidden="true">🟢</span>
              <span className="font-medium text-white/90">
                Connecté{user.email ? ` : ${user.email}` : ""}
              </span>
            </div>
            <p className="text-xs text-white/50">
              Vos explications IA gratuites sont décomptées sur votre compte
              (10 par jour, 3 par minute). Les exercices restent accessibles même
              si le quota est atteint.
            </p>
            <button
              type="button"
              onClick={() => {
                void signOut();
                close();
              }}
              className="w-full rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm font-semibold text-red-200 transition-all duration-200 hover:bg-red-500/20"
            >
              Se déconnecter
            </button>
          </div>
        ) : (
          <>
            <div className="mb-5 grid grid-cols-2 gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-1 text-sm">
              {(["signin", "signup"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    setMode(value);
                    setError(null);
                  }}
                  aria-pressed={mode === value}
                  className={`rounded-lg px-3 py-2 font-medium transition-colors ${
                    mode === value
                      ? "bg-white/15 text-white"
                      : "text-white/60 hover:text-white"
                  }`}
                >
                  {value === "signin" ? "Se connecter" : "Créer un compte"}
                </button>
              ))}
            </div>

            <form onSubmit={submit} className="flex flex-col gap-3">
              <label className="block text-sm font-medium text-white/80">
                Adresse e-mail
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="vous@exemple.com"
                  autoComplete="email"
                  spellCheck={false}
                  className="mt-2 w-full rounded-xl border border-white/20 bg-slate-900/95 px-3 py-2.5 text-sm text-white placeholder:text-white/40 outline-none transition-colors focus:border-violet-400/60"
                />
              </label>

              <label className="block text-sm font-medium text-white/80">
                Mot de passe
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="••••••"
                  autoComplete={mode === "signin" ? "current-password" : "new-password"}
                  className="mt-2 w-full rounded-xl border border-white/20 bg-slate-900/95 px-3 py-2.5 text-sm text-white placeholder:text-white/40 outline-none transition-colors focus:border-violet-400/60"
                />
              </label>

              {error && (
                <p role="alert" className="text-xs text-red-200">
                  {error}
                </p>
              )}
              {notice && (
                <p role="status" className="text-xs text-emerald-200">
                  {notice}
                </p>
              )}

              <button
                type="submit"
                disabled={busy}
                className="mt-1 w-full rounded-xl bg-gradient-to-r from-violet-500 to-cyan-500 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-violet-500/20 transition-all duration-200 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy
                  ? "Veuillez patienter…"
                  : mode === "signin"
                  ? "Se connecter"
                  : "Créer mon compte"}
              </button>
            </form>

            <p className="mt-4 text-xs text-white/45">
              Gratuit : 10 explications IA par jour, sans clé à fournir. Votre
              adresse n'est utilisée que pour votre compte Lernoviq.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
