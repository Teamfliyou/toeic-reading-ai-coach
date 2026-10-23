-- Objectifs d'étude des utilisateurs connectés (date d'examen, score visé, objectif
-- quotidien). À exécuter après user_data.sql. Idempotent. RLS : chaque utilisateur
-- ne voit et ne modifie que sa propre ligne ; aucun accès anonyme.

create table if not exists public.user_goals (
  user_id uuid primary key references auth.users(id) on delete cascade,
  exam_date date,
  target_score int check (target_score between 5 and 495),
  daily_goal int not null default 10 check (daily_goal between 1 and 200),
  updated_at timestamptz not null default now()
);

alter table public.user_goals enable row level security;
revoke all on table public.user_goals from anon;
grant select, insert, update, delete on table public.user_goals to authenticated;

drop policy if exists "Objectifs : accès par le propriétaire" on public.user_goals;
create policy "Objectifs : accès par le propriétaire"
  on public.user_goals for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
