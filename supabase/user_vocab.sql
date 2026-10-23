-- Carnet de vocabulaire des utilisateurs connectés. À exécuter après user_data.sql.
-- Idempotent. Lu et écrit par le navigateur avec le jeton de l'utilisateur :
-- la RLS limite chaque utilisateur à ses propres lignes (aucun accès anonyme).
-- Les suppressions sont des « pierres tombales » (deleted = true) pour se synchroniser.

create table if not exists public.user_vocab (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  term text not null check (char_length(term) between 1 and 80),
  meaning text not null check (char_length(meaning) between 1 and 300),
  example text not null default '' check (char_length(example) <= 300),
  source_question_id text,
  box int not null check (box between 1 and 5),
  due timestamptz not null,
  mastered boolean not null default false,
  lapses int not null default 0,
  deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_user_vocab_user on public.user_vocab (user_id, updated_at desc);

alter table public.user_vocab enable row level security;
revoke all on table public.user_vocab from anon;
grant select, insert, update, delete on table public.user_vocab to authenticated;

drop policy if exists "Vocabulaire : accès par le propriétaire" on public.user_vocab;
create policy "Vocabulaire : accès par le propriétaire"
  on public.user_vocab for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
