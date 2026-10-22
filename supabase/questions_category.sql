-- Catégorie (type de piège) et étiquettes des questions, pour les statistiques.
-- À exécuter UNE fois sur une base existante, puis relancer supabase/seed.sql
-- (qui renseigne la catégorie des questions du jeu de départ).
alter table public.questions add column if not exists category text;
alter table public.questions add column if not exists tags text[] not null default '{}';
create index if not exists idx_questions_category on public.questions (category);
