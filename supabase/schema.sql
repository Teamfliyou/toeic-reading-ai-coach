-- Schéma Supabase pour TOEIC Reading AI Coach
-- À exécuter dans l'éditeur SQL de votre projet Supabase.
-- (Optionnel : l'app fonctionne sans, grâce au fallback JSON local.)

create extension if not exists "pgcrypto";

create table if not exists passages (
  id uuid primary key default gen_random_uuid(),
  part int not null check (part in (5, 6, 7)),
  title text not null,
  documents jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists questions (
  id uuid primary key default gen_random_uuid(),
  part int not null check (part in (5, 6, 7)),
  passage_id uuid references passages(id) on delete cascade,
  order_index int not null default 0,
  prompt text not null,
  options jsonb not null default '[]'::jsonb,
  correct_key char(1) not null check (correct_key in ('A', 'B', 'C', 'D')),
  difficulty int not null default 1 check (difficulty between 1 and 3),
  created_at timestamptz not null default now()
);

create index if not exists idx_questions_part on questions (part, order_index);
create index if not exists idx_questions_passage on questions (passage_id);

create table if not exists attempts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  question_id uuid not null references questions(id) on delete cascade,
  selected_key char(1) not null,
  is_correct boolean not null,
  created_at timestamptz not null default now()
);

create table if not exists feedback_votes (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid references attempts(id) on delete cascade,
  vote int not null check (vote in (-1, 1)),
  created_at timestamptz not null default now()
);

-- Sécurité : lecture anonyme autorisée, écriture désactivée par défaut.
alter table passages enable row level security;
alter table questions enable row level security;
alter table attempts enable row level security;
alter table feedback_votes enable row level security;

create policy "Lecture publique des passages"
  on passages for select using (true);

create policy "Lecture publique des questions"
  on questions for select using (true);
