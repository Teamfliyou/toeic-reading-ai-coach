import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  authEnabled,
  getSession,
  onAuthChange,
  signIn as apiSignIn,
  signOut as apiSignOut,
  signUp as apiSignUp,
  type AuthSession,
} from "./supabaseAuth";

interface AuthContextValue {
  /** Vrai si Supabase Auth est configuré (URL + clé publishable). */
  enabled: boolean;
  session: AuthSession | null;
  user: AuthSession["user"] | null;
  isOpen: boolean;
  open: () => void;
  close: () => void;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<{ needsConfirmation: boolean }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(() => getSession());
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => onAuthChange(setSession), []);

  const signIn = useCallback(async (email: string, password: string) => {
    await apiSignIn(email, password);
  }, []);

  const signUp = useCallback(
    (email: string, password: string) => apiSignUp(email, password),
    []
  );

  const signOut = useCallback(async () => {
    await apiSignOut();
  }, []);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  return (
    <AuthContext.Provider
      value={{
        enabled: authEnabled,
        session,
        user: session?.user ?? null,
        isOpen,
        open,
        close,
        signIn,
        signUp,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth doit être utilisé dans un AuthProvider");
  }
  return ctx;
}
