-- Données personnelles des utilisateurs connectés : historique des tentatives et
-- cartes de révision espacée (Leitner). À exécuter dans l'éditeur SQL Supabase.
-- Idempotent.
--
-- Contrairement aux tables IA, ces tables sont lues et écrites DIRECTEMENT par
-- le navigateur avec le jeton de l'utilisateur : la sécurité repose sur la RLS
-- (chaque utilisateur ne voit et ne modifie que ses lignes). Les visiteurs
-- anonymes (rôle anon) n'ont aucun accès.

create table if not exists public.user_attempts (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  question_id text not null,
  part int not null check (part in (2, 5, 6, 7)),
  category text,
  selected_key text not null check (char_length(selected_key) = 1),
  correct boolean not null,
  time_ms int not null default 0 check (time_ms >= 0),
  mode text not null check (mode in ('practice','review','exam','diagnostic','listening')),
  created_at timestamptz not null default now()
);
create index if not exists idx_user_attempts_user_time
  on public.user_attempts (user_id, created_at desc);

create table if not exists public.user_review_cards (
  user_id uuid not null references auth.users(id) on delete cascade,
  question_id text not null,
  part int not null check (part in (2, 5, 6, 7)),
  box int not null check (box between 1 and 5),
  due timestamptz not null,
  mastered boolean not null default false,
  lapses int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, question_id)
);

alter table public.user_attempts enable row level security;
alter table public.user_review_cards enable row level security;

revoke all on table public.user_attempts from anon;
revoke all on table public.user_review_cards from anon;
grant select, insert, delete on table public.user_attempts to authenticated;
grant select, insert, update, delete on table public.user_review_cards to authenticated;

drop policy if exists "Tentatives : lecture par le propriétaire" on public.user_attempts;
create policy "Tentatives : lecture par le propriétaire"
  on public.user_attempts for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "Tentatives : ajout par le propriétaire" on public.user_attempts;
create policy "Tentatives : ajout par le propriétaire"
  on public.user_attempts for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "Tentatives : suppression par le propriétaire" on public.user_attempts;
create policy "Tentatives : suppression par le propriétaire"
  on public.user_attempts for delete to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "Cartes : accès par le propriétaire" on public.user_review_cards;
create policy "Cartes : accès par le propriétaire"
  on public.user_review_cards for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
