-- Signalements de questions erronées. À exécuter dans l'éditeur SQL Supabase. Idempotent.
--
-- Écriture et lecture par le serveur uniquement (service_role) : RLS activée,
-- aucun droit pour anon/authenticated. L'adresse IP n'est pas stockée, seulement
-- une empreinte salée (reporter_hash) servant à limiter les abus.

create table if not exists public.question_reports (
  id uuid primary key default gen_random_uuid(),
  question_id text not null,
  part int check (part in (2, 5, 6, 7)),
  question_prompt text,
  reason text not null check (reason in ('wrong_answer','typo','ambiguous','unclear_audio','other')),
  comment text not null default '' check (char_length(comment) <= 500),
  reporter_id uuid,
  reporter_hash text not null,
  status text not null default 'open' check (status in ('open','resolved','rejected')),
  handled_by text,
  handled_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_question_reports_status on public.question_reports (status, created_at desc);
create index if not exists idx_question_reports_reporter on public.question_reports (reporter_hash, created_at desc);
create index if not exists idx_question_reports_question on public.question_reports (question_id);

alter table public.question_reports enable row level security;
revoke all on table public.question_reports from anon, authenticated;
