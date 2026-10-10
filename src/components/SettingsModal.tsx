import { useEffect, useState } from "react";
import { useSettings } from "@/lib/SettingsContext";

function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {open ? (
        <>
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
          <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
          <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
          <path d="m1 1 22 22" />
        </>
      ) : (
        <>
          <path d="M2 12s3-8 10-8 10 8 10 8-3 8-10 8-10-8-10-8z" />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
    </svg>
  );
}

export default function SettingsModal() {
  const { apiKey, hasPersonalKey, isOpen, close, saveKey, clearKey } =
    useSettings();
  const [draft, setDraft] = useState("");
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setDraft(apiKey ?? "");
      setShow(false);
    }
  }, [isOpen, apiKey]);

  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, close]);

  if (!isOpen) return null;

  const canSave = draft.trim().length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={close}
      role="dialog"
      aria-modal="true"
      aria-label="Paramètres"
    >
      <div
        className="glass-strong w-full max-w-md animate-fade-up p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-bold text-white/95">Paramètres</h2>
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

        <div className="mb-5 flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm">
          <span aria-hidden="true">{hasPersonalKey ? "🟢" : "🔵"}</span>
          <span className="font-medium text-white/90">
            {hasPersonalKey
              ? "Clé personnelle active"
              : "Clé du serveur par défaut"}
          </span>
        </div>

        <label className="mb-2 block text-sm font-medium text-white/80">
          Clé API DeepSeek
        </label>
        <div className="relative">
          <input
            type={show ? "text" : "password"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="sk-..."
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-xl border border-white/20 bg-slate-900/95 px-3 py-2.5 pr-11 text-sm text-white placeholder:text-white/40 outline-none transition-colors focus:border-violet-400/60"
          />
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            aria-label={show ? "Masquer la clé" : "Afficher la clé"}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          >
            <EyeIcon open={show} />
          </button>
        </div>
        <p className="mt-2 text-xs text-white/45">
          La clé est stockée uniquement dans votre navigateur (localStorage) et
          transmise à chaque requête d'explication.
        </p>

        <div className="mt-5 flex flex-col gap-3">
          <button
            type="button"
            disabled={!canSave}
            onClick={() => {
              saveKey(draft);
              close();
            }}
            className="w-full rounded-xl bg-gradient-to-r from-violet-500 to-cyan-500 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-violet-500/20 transition-all duration-200 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Enregistrer
          </button>
          <button
            type="button"
            disabled={!hasPersonalKey}
            onClick={() => {
              clearKey();
              setDraft("");
            }}
            className="w-full rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm font-semibold text-red-200 transition-all duration-200 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Supprimer / Réinitialiser la clé
          </button>
        </div>
      </div>
    </div>
  );
}
