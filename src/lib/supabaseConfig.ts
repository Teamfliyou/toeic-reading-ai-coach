// La clé publishable Supabase est publique et soumise aux politiques RLS.
// Ne jamais utiliser une clé secret/service_role dans le navigateur.
export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || "https://dankxnymzjsbwefibrcf.supabase.co";
export const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || "sb_publishable_WYkh5TuXMr3m5GkZMjL10w_6uSOCxAG";
