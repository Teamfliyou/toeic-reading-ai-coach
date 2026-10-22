import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

export const DEEPSEEK_STORAGE_KEY = "deepseek_user_api_key";

interface SettingsContextValue {
  apiKey: string | null;
  hasPersonalKey: boolean;
  isOpen: boolean;
  open: () => void;
  close: () => void;
  /** Vrai si la clé enregistrée est conservée dans le navigateur (localStorage). */
  keyRemembered: boolean;
  saveKey: (key: string, remember: boolean) => void;
  clearKey: () => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  // La clé n'est écrite dans le localStorage que si l'utilisateur le demande :
  // sinon elle reste en mémoire et disparaît au rechargement (exposition réduite
  // en cas de XSS). Une clé déjà mémorisée est reprise telle quelle.
  const [stored] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      return localStorage.getItem(DEEPSEEK_STORAGE_KEY);
    } catch {
      return null;
    }
  });
  const [apiKey, setApiKey] = useState<string | null>(stored);
  const [keyRemembered, setKeyRemembered] = useState<boolean>(Boolean(stored));
  const [isOpen, setIsOpen] = useState(false);

  const saveKey = useCallback((key: string, remember: boolean) => {
    const trimmed = key.trim();
    if (!trimmed) return;
    try {
      if (remember) localStorage.setItem(DEEPSEEK_STORAGE_KEY, trimmed);
      else localStorage.removeItem(DEEPSEEK_STORAGE_KEY);
    } catch {
      /* Stockage bloqué : la clé reste en mémoire pour cette session. */
    }
    setApiKey(trimmed);
    setKeyRemembered(remember);
  }, []);

  const clearKey = useCallback(() => {
    try {
      localStorage.removeItem(DEEPSEEK_STORAGE_KEY);
    } catch {
      /* Rien à effacer si le stockage est inaccessible. */
    }
    setApiKey(null);
    setKeyRemembered(false);
  }, []);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  return (
    <SettingsContext.Provider
      value={{
        apiKey,
        hasPersonalKey: Boolean(apiKey),
        keyRemembered,
        isOpen,
        open,
        close,
        saveKey,
        clearKey,
      }}
    >
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    throw new Error("useSettings doit être utilisé dans un SettingsProvider");
  }
  return ctx;
}
