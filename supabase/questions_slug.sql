-- Identifiant lisible des questions du jeu de départ (ex. « q5-01 »).
-- À exécuter UNE fois sur une base existante, puis relancer supabase/seed.sql.
-- Le client utilise `slug` quand il existe : les erreurs enregistrées restent
-- valables que les questions viennent de Supabase ou du JSON local de secours.
alter table public.questions add column if not exists slug text;
create unique index if not exists idx_questions_slug on public.questions (slug) where slug is not null;
