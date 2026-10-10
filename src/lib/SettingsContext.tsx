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
  saveKey: (key: string) => void;
  clearKey: () => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [apiKey, setApiKey] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return localStorage.getItem(DEEPSEEK_STORAGE_KEY);
  });
  const [isOpen, setIsOpen] = useState(false);

  const saveKey = useCallback((key: string) => {
    const trimmed = key.trim();
    if (!trimmed) return;
    localStorage.setItem(DEEPSEEK_STORAGE_KEY, trimmed);
    setApiKey(trimmed);
  }, []);

  const clearKey = useCallback(() => {
    localStorage.removeItem(DEEPSEEK_STORAGE_KEY);
    setApiKey(null);
  }, []);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  return (
    <SettingsContext.Provider
      value={{
        apiKey,
        hasPersonalKey: Boolean(apiKey),
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
