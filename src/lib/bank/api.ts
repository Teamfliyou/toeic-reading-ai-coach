// Appels à /api/admin pour la banque d'exercices (cookie de session HttpOnly, même origine).

export class AdminApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
  }
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** Nombre de nouvelles tentatives sur erreur réseau, 429 ou 5xx (défaut : 0). */
  retries?: number;
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Annulé", "AbortError"));
    }, { once: true });
  });

/** Appelle une action d'administration. Les erreurs 4xx ne sont jamais rejouées. */
export async function adminRequest<T = unknown>(action: string, body: unknown = {}, options: RequestOptions = {}): Promise<T> {
  const retries = options.retries ?? 0;
  let attempt = 0;
  for (;;) {
    try {
      const response = await fetch(`/api/admin?action=${encodeURIComponent(action)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
        signal: options.signal,
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (response.ok) return data as T;
      const error = new AdminApiError(data.error || "Erreur du serveur", response.status);
      if (response.status === 429 || response.status >= 500) throw error;
      error.status = response.status;
      throw Object.assign(error, { final: true });
    } catch (error) {
      const final = (error as { final?: boolean }).final;
      if (final || (error as Error).name === "AbortError" || attempt >= retries) throw error;
      attempt += 1;
      await wait(Math.min(8000, 800 * 2 ** (attempt - 1)), options.signal);
    }
  }
}
