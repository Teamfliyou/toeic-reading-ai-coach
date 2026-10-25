-- Banque d'exercices évolutive (100 000+ questions) — Lernoviq.
-- À exécuter dans l'éditeur SQL Supabase APRÈS schema.sql, questions_slug.sql et
-- questions_category.sql. Idempotent et NON destructif : aucune donnée n'est
-- supprimée ni réécrite ; les questions existantes deviennent « publiées ».
--
-- Contenu :
--   1. colonnes de la banque (statut, origine, explication, version, empreintes…) ;
--   2. historique des modifications (question_revisions) ;
--   3. importation par lots (import_batches, bank_issues) reprenable et atomique ;
--   4. file de génération IA persistante (generation_jobs, generation_batches) ;
--   5. fonctions publiques (tirage aléatoire paginé, jeux d'examen) pour le navigateur ;
--   6. fonctions d'administration (liste, édition, statut, suppression contrôlée,
--      doublons, statistiques) réservées au service_role.
--
-- Sécurité : les lecteurs (anon/authenticated) ne voient que les questions
-- « publiées » ou « archivées » (l'historique d'un élève reste lisible). Tout le
-- reste passe par le serveur avec la clé service_role.

create extension if not exists pgcrypto;

-- 1) Fonctions de normalisation et d'empreinte --------------------------------
-- L'implémentation JavaScript (server/bank/text.mjs) applique exactement la même
-- normalisation : minuscules, tout caractère hors [a-z0-9] devient un espace.
create or replace function public.bank_norm(p text) returns text
language sql immutable parallel safe as $$
  select btrim(regexp_replace(lower(coalesce(p, '')), '[^a-z0-9]+', ' ', 'g'))
$$;

create or replace function public.bank_passage_hash(p_part int, p_title text, p_documents jsonb)
returns text language sql immutable as $$
  select encode(sha256(convert_to(
    p_part::text || '|' || public.bank_norm(p_title) || '|' ||
    coalesce((
      select string_agg(
        public.bank_norm(d.doc->>'title') || '~' || public.bank_norm(
          case jsonb_typeof(d.doc->'body')
            when 'array' then (select string_agg(x, ' ' order by o) from jsonb_array_elements_text(d.doc->'body') with ordinality as t(x, o))
            else d.doc->>'body'
          end),
        '|' order by d.ord)
      from jsonb_array_elements(coalesce(p_documents, '[]'::jsonb)) with ordinality as d(doc, ord)
    ), ''), 'UTF8')), 'hex')
$$;

create or replace function public.bank_question_hash(p_part int, p_prompt text, p_options jsonb, p_passage_hash text)
returns text language sql immutable as $$
  select encode(sha256(convert_to(
    p_part::text || '|' || public.bank_norm(p_prompt) || '|' ||
    coalesce((
      select string_agg(public.bank_norm(o->>'text'), '|' order by public.bank_norm(o->>'text'))
      from jsonb_array_elements(coalesce(p_options, '[]'::jsonb)) o
    ), '') || '|' || coalesce(p_passage_hash, ''), 'UTF8')), 'hex')
$$;

-- 2) Colonnes des passages et des questions ---------------------------------
alter table public.passages add column if not exists status text not null default 'published';
alter table public.passages add column if not exists source text not null default 'manual';
alter table public.passages add column if not exists theme text;
alter table public.passages add column if not exists content_hash text;
alter table public.passages add column if not exists lsh int[];
alter table public.passages add column if not exists rand_key double precision not null default random();
alter table public.passages add column if not exists updated_at timestamptz not null default now();
alter table public.passages add column if not exists import_batch_id uuid;
alter table public.passages add column if not exists generation_job_id uuid;

alter table public.questions add column if not exists status text not null default 'published';
alter table public.questions add column if not exists source text not null default 'manual';
alter table public.questions add column if not exists theme text;
alter table public.questions add column if not exists explanation text;
alter table public.questions add column if not exists option_rationales jsonb;
alter table public.questions add column if not exists external_id text;
alter table public.questions add column if not exists content_hash text;
alter table public.questions add column if not exists lsh int[];
alter table public.questions add column if not exists rand_key double precision not null default random();
alter table public.questions add column if not exists version int not null default 1;
alter table public.questions add column if not exists origin_version text;
alter table public.questions add column if not exists needs_review boolean not null default false;
alter table public.questions add column if not exists review_flags jsonb not null default '[]'::jsonb;
alter table public.questions add column if not exists created_by text;
alter table public.questions add column if not exists updated_by text;
alter table public.questions add column if not exists updated_at timestamptz not null default now();
alter table public.questions add column if not exists published_at timestamptz;
alter table public.questions add column if not exists import_batch_id uuid;
alter table public.questions add column if not exists generation_job_id uuid;
alter table public.questions add column if not exists search_vec tsvector
  generated always as (to_tsvector('english', coalesce(prompt, ''))) stored;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'questions_status_check') then
    alter table public.questions add constraint questions_status_check
      check (status in ('draft', 'review', 'published', 'archived'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'questions_source_check') then
    alter table public.questions add constraint questions_source_check
      check (source in ('ai', 'import', 'manual'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'passages_status_check') then
    alter table public.passages add constraint passages_status_check
      check (status in ('draft', 'review', 'published', 'archived'));
  end if;
end $$;

-- Rattrapage des lignes existantes (avant la création des triggers : pas de révision).
update public.passages set content_hash = public.bank_passage_hash(part, title, documents) where content_hash is null;
update public.questions q set
  content_hash = public.bank_question_hash(q.part, q.prompt, q.options,
    (select p.content_hash from public.passages p where p.id = q.passage_id)),
  published_at = coalesce(q.published_at, q.created_at)
where q.content_hash is null;

-- 3) Index --------------------------------------------------------------------
-- Tirage aléatoire : on parcourt l'index dans l'ordre de rand_key (pas de ORDER BY random()).
create index if not exists idx_questions_pick on public.questions (part, rand_key) where status = 'published';
create index if not exists idx_questions_pick_diff on public.questions (part, difficulty, rand_key) where status = 'published';
create index if not exists idx_questions_pick_cat on public.questions (part, category, rand_key) where status = 'published';
create index if not exists idx_questions_passage_status on public.questions (passage_id, status);
create index if not exists idx_questions_admin_list on public.questions (created_at desc, id);
create index if not exists idx_questions_status_part on public.questions (status, part, difficulty);
create index if not exists idx_questions_hash on public.questions (content_hash);
create index if not exists idx_questions_lsh on public.questions using gin (lsh);
create index if not exists idx_questions_search on public.questions using gin (search_vec);
create index if not exists idx_questions_import_batch on public.questions (import_batch_id) where import_batch_id is not null;
create index if not exists idx_questions_job on public.questions (generation_job_id) where generation_job_id is not null;
create index if not exists idx_questions_external on public.questions (external_id) where external_id is not null;
create index if not exists idx_passages_pick on public.passages (part, rand_key) where status = 'published';
create index if not exists idx_passages_hash on public.passages (content_hash);
create index if not exists idx_passages_lsh on public.passages using gin (lsh);

-- Unicité du contenu (hors archives) : garantie forte contre les doublons, même si
-- deux importations s'exécutent en parallèle. Si des doublons existent déjà dans la
-- base, l'index unique n'est pas créé (simple index) : à nettoyer depuis la bibliothèque.
do $$ begin
  if not exists (select 1 from pg_indexes where indexname = 'idx_questions_content_unique') then
    if exists (select 1 from public.questions where status <> 'archived' and content_hash is not null
               group by content_hash having count(*) > 1) then
      raise notice 'Doublons exacts présents : index unique non créé. Utilisez Bibliothèque → Doublons.';
    else
      create unique index idx_questions_content_unique on public.questions (content_hash)
        where status <> 'archived' and content_hash is not null;
    end if;
  end if;
end $$;

-- 4) Historique des modifications ---------------------------------------------
create table if not exists public.question_revisions (
  id bigint generated always as identity primary key,
  question_id uuid not null,        -- pas de clé étrangère : l'historique survit à une suppression
  version int not null,
  change_type text not null check (change_type in ('edit', 'status', 'delete')),
  snapshot jsonb not null,
  changed_by text not null default 'system',
  created_at timestamptz not null default now()
);
create index if not exists idx_question_revisions_question on public.question_revisions (question_id, id desc);

-- 5) Triggers : empreinte, identifiant stable, version, historique -----------
create or replace function public.bank_passages_biu() returns trigger
language plpgsql as $$
begin
  new.content_hash := public.bank_passage_hash(new.part, new.title, new.documents);
  if tg_op = 'UPDATE' then new.updated_at := now(); end if;
  return new;
end $$;

drop trigger if exists trg_bank_passages_biu on public.passages;
create trigger trg_bank_passages_biu before insert or update on public.passages
  for each row execute function public.bank_passages_biu();

-- Un passage modifié change l'empreinte de ses questions.
create or replace function public.bank_passages_au() returns trigger
language plpgsql as $$
begin
  if new.content_hash is distinct from old.content_hash then
    update public.questions q set
      content_hash = public.bank_question_hash(q.part, q.prompt, q.options, new.content_hash)
    where q.passage_id = new.id;
  end if;
  return null;
end $$;

drop trigger if exists trg_bank_passages_au on public.passages;
create trigger trg_bank_passages_au after update on public.passages
  for each row execute function public.bank_passages_au();

create or replace function public.bank_questions_biu() returns trigger
language plpgsql as $$
declare
  v_phash text;
  v_slug text;
  v_try int := 0;
  v_actor text := coalesce(nullif(current_setting('app.actor', true), ''), 'system');
  v_content_changed boolean;
  v_tracked_changed boolean;
begin
  if new.passage_id is not null then
    select content_hash into v_phash from public.passages where id = new.passage_id;
  end if;

  if tg_op = 'INSERT'
     or new.prompt is distinct from old.prompt or new.options is distinct from old.options
     or new.passage_id is distinct from old.passage_id or new.part is distinct from old.part then
    new.content_hash := public.bank_question_hash(new.part, new.prompt, new.options, v_phash);
  end if;

  if tg_op = 'UPDATE' then
    v_content_changed := new.prompt is distinct from old.prompt or new.options is distinct from old.options
      or new.correct_key is distinct from old.correct_key or new.explanation is distinct from old.explanation
      or new.option_rationales is distinct from old.option_rationales or new.difficulty is distinct from old.difficulty
      or new.category is distinct from old.category or new.theme is distinct from old.theme
      or new.tags is distinct from old.tags or new.passage_id is distinct from old.passage_id
      or new.order_index is distinct from old.order_index;
    v_tracked_changed := v_content_changed or new.status is distinct from old.status;
    if v_tracked_changed then
      insert into public.question_revisions (question_id, version, change_type, snapshot, changed_by)
        values (old.id, old.version, case when v_content_changed then 'edit' else 'status' end,
                to_jsonb(old) - 'search_vec' - 'lsh', v_actor);
      new.updated_at := now();
      new.updated_by := v_actor;
    end if;
    if v_content_changed then new.version := old.version + 1; end if;
  else
    new.created_by := coalesce(new.created_by, v_actor);
  end if;

  if new.status = 'published' and new.published_at is null then new.published_at := now(); end if;

  if new.slug is null then
    v_slug := 'q' || new.part || '-' || substr(new.content_hash, 1, 12);
    while exists (select 1 from public.questions where slug = v_slug and id is distinct from new.id) loop
      v_try := v_try + 1;
      v_slug := 'q' || new.part || '-' || substr(new.content_hash, 1, 12) || '-' || v_try;
    end loop;
    new.slug := v_slug;
  end if;
  return new;
end $$;

drop trigger if exists trg_bank_questions_biu on public.questions;
create trigger trg_bank_questions_biu before insert or update on public.questions
  for each row execute function public.bank_questions_biu();

create or replace function public.bank_questions_bd() returns trigger
language plpgsql as $$
begin
  insert into public.question_revisions (question_id, version, change_type, snapshot, changed_by)
    values (old.id, old.version, 'delete', to_jsonb(old) - 'search_vec' - 'lsh',
            coalesce(nullif(current_setting('app.actor', true), ''), 'system'));
  return old;
end $$;

drop trigger if exists trg_bank_questions_bd on public.questions;
create trigger trg_bank_questions_bd before delete on public.questions
  for each row execute function public.bank_questions_bd();

-- 6) Importation et génération : tables ---------------------------------------
create table if not exists public.import_batches (
  id uuid primary key default gen_random_uuid(),
  filename text not null,
  fingerprint text,                         -- empreinte du fichier : permet de reprendre le même import
  format text not null check (format in ('csv', 'xlsx', 'json')),
  kind text not null default 'reading' check (kind in ('reading', 'listening')),
  status text not null default 'processing'
    check (status in ('processing', 'completed', 'failed', 'cancelled')),
  total_rows int not null default 0,
  chunk_size int not null default 200,
  chunks_total int not null default 0,
  chunks_done int[] not null default '{}',
  rows_done int not null default 0,
  accepted int not null default 0,
  duplicates int not null default 0,
  rejected int not null default 0,
  flagged int not null default 0,
  mapping jsonb not null default '{}'::jsonb,
  created_by text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists idx_import_batches_fingerprint on public.import_batches (fingerprint, created_at desc);
create index if not exists idx_import_batches_recent on public.import_batches (created_at desc);

create table if not exists public.generation_jobs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'paused', 'completed', 'cancelled', 'failed')),
  part int not null check (part in (5, 6, 7)),
  kind text not null,
  difficulty int not null check (difficulty between 1 and 3),
  theme text,
  options jsonb not null default '{}'::jsonb,
  total_requested int not null check (total_requested between 1 and 20000),
  batch_size int not null check (batch_size between 1 and 20),
  batches_total int not null,
  batches_done int not null default 0,
  batches_failed int not null default 0,
  generated_count int not null default 0,
  validated_count int not null default 0,     -- passés en « en validation » sans alerte
  flagged_count int not null default 0,       -- gardés en brouillon : vérification humaine
  rejected_count int not null default 0,      -- refusés par les contrôles (non enregistrés)
  duplicate_count int not null default 0,
  estimated_usd numeric(12,6) not null default 0,
  actual_usd numeric(12,6) not null default 0,
  errors jsonb not null default '[]'::jsonb,  -- historique des erreurs (50 dernières)
  created_by text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists idx_generation_jobs_recent on public.generation_jobs (created_at desc);
create index if not exists idx_generation_jobs_active on public.generation_jobs (status) where status in ('queued', 'running');

create table if not exists public.generation_batches (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.generation_jobs(id) on delete cascade,
  idx int not null,
  quantity int not null check (quantity between 1 and 20),
  status text not null default 'pending'
    check (status in ('pending', 'running', 'done', 'failed', 'cancelled')),
  attempts int not null default 0,
  lease_until timestamptz,
  lease_token uuid,
  worker text,
  generated int not null default 0,
  validated int not null default 0,
  flagged int not null default 0,
  rejected int not null default 0,
  cost_usd numeric(12,6) not null default 0,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  unique (job_id, idx)
);
create index if not exists idx_generation_batches_claim on public.generation_batches (job_id, idx)
  where status in ('pending', 'running');

create table if not exists public.bank_issues (
  id bigint generated always as identity primary key,
  import_batch_id uuid references public.import_batches(id) on delete cascade,
  job_id uuid references public.generation_jobs(id) on delete cascade,
  ref text,                                  -- numéro de ligne ou de question dans le lot
  severity text not null check (severity in ('error', 'warning', 'info')),
  code text not null,
  message text not null,
  payload jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_bank_issues_import on public.bank_issues (import_batch_id, severity, id) where import_batch_id is not null;
create index if not exists idx_bank_issues_job on public.bank_issues (job_id, severity, id) where job_id is not null;

alter table public.import_batches enable row level security;
alter table public.generation_jobs enable row level security;
alter table public.generation_batches enable row level security;
alter table public.bank_issues enable row level security;
alter table public.question_revisions enable row level security;
revoke all on table public.import_batches, public.generation_jobs, public.generation_batches,
  public.bank_issues, public.question_revisions from anon, authenticated;

-- 7) RLS publique : seules les questions publiées/archivées sont lisibles -----
drop policy if exists "Lecture publique des questions" on public.questions;
drop policy if exists "Lecture publique des questions publiées" on public.questions;
create policy "Lecture publique des questions publiées"
  on public.questions for select using (status in ('published', 'archived'));

drop policy if exists "Lecture publique des passages" on public.passages;
drop policy if exists "Lecture publique des passages publiés" on public.passages;
create policy "Lecture publique des passages publiés"
  on public.passages for select using (status in ('published', 'archived'));

-- 8) Insertion atomique d'éléments (usage interne des importations/générations) -
-- p_items : [{ref, part, passage:{key,title,documents,lsh}|null,
--             question:{prompt,options,correct_key,difficulty,category,theme,tags,explanation,
--                       option_rationales,order_index,external_id,lsh,needs_review,review_flags}}]
-- p_ctx   : {status, source, actor, import_batch_id, generation_job_id, origin_version}
create or replace function public.bank_insert_items(p_items jsonb, p_ctx jsonb) returns jsonb
language plpgsql as $$
declare
  v_item jsonb;
  v_q jsonb;
  v_p jsonb;
  v_part int;
  v_status text := coalesce(p_ctx->>'status', 'draft');
  v_source text := coalesce(p_ctx->>'source', 'import');
  v_actor text := coalesce(p_ctx->>'actor', 'system');
  v_batch uuid := nullif(p_ctx->>'import_batch_id', '')::uuid;
  v_job uuid := nullif(p_ctx->>'generation_job_id', '')::uuid;
  v_origin text := p_ctx->>'origin_version';
  v_keymap jsonb := '{}'::jsonb;
  v_key text;
  v_pid uuid;
  v_phash text;
  v_hash text;
  v_existing record;
  v_new record;
  v_constraint text;
  v_inserted int := 0;
  v_dups int := 0;
  v_results jsonb := '[]'::jsonb;
  v_needs boolean;
begin
  if v_status not in ('draft', 'review') then
    raise exception 'bank_insert_items : statut initial invalide (%)', v_status;
  end if;
  perform set_config('app.actor', v_actor, true);

  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_q := v_item->'question';
    v_p := v_item->'passage';
    v_part := (v_item->>'part')::int;
    v_pid := null;
    v_phash := null;

    if v_p is not null and jsonb_typeof(v_p) = 'object' then
      v_key := coalesce(v_p->>'key', v_p->>'title');
      if v_keymap ? v_key then
        v_pid := (v_keymap->>v_key)::uuid;
      else
        v_phash := public.bank_passage_hash(v_part, v_p->>'title', v_p->'documents');
        select id into v_pid from public.passages where content_hash = v_phash and status <> 'archived' limit 1;
        if v_pid is null then
          insert into public.passages (part, title, documents, status, source, theme, lsh, import_batch_id, generation_job_id)
            values (v_part, left(v_p->>'title', 250), v_p->'documents', v_status, v_source, v_p->>'theme',
                    array(select jsonb_array_elements_text(coalesce(v_p->'lsh', '[]'::jsonb))::int),
                    v_batch, v_job)
            returning id into v_pid;
        end if;
        v_keymap := v_keymap || jsonb_build_object(v_key, v_pid::text);
      end if;
      select content_hash into v_phash from public.passages where id = v_pid;
    end if;

    v_hash := public.bank_question_hash(v_part, v_q->>'prompt', v_q->'options', v_phash);
    select id, slug, status into v_existing from public.questions
      where content_hash = v_hash and status <> 'archived' limit 1;
    if found then
      v_dups := v_dups + 1;
      v_results := v_results || jsonb_build_object('ref', v_item->'ref', 'outcome', 'duplicate',
        'existing_id', v_existing.id, 'existing_slug', v_existing.slug);
      continue;
    end if;

    v_needs := coalesce((v_q->>'needs_review')::boolean, false);
    begin
      insert into public.questions (
        part, passage_id, order_index, prompt, options, correct_key, difficulty, category, theme, tags,
        explanation, option_rationales, status, source, external_id, needs_review, review_flags, lsh,
        origin_version, import_batch_id, generation_job_id, created_by)
      values (
        v_part, v_pid, coalesce((v_q->>'order_index')::int, 0), v_q->>'prompt', v_q->'options',
        v_q->>'correct_key', coalesce((v_q->>'difficulty')::int, 2), nullif(v_q->>'category', ''),
        nullif(v_q->>'theme', ''),
        array(select jsonb_array_elements_text(coalesce(v_q->'tags', '[]'::jsonb))),
        nullif(v_q->>'explanation', ''), v_q->'option_rationales',
        v_status, v_source, nullif(v_q->>'external_id', ''), v_needs,
        coalesce(v_q->'review_flags', '[]'::jsonb),
        array(select jsonb_array_elements_text(coalesce(v_q->'lsh', '[]'::jsonb))::int),
        v_origin, v_batch, v_job, v_actor)
      returning id, slug into v_new;
      v_inserted := v_inserted + 1;
      v_results := v_results || jsonb_build_object('ref', v_item->'ref', 'outcome', 'inserted',
        'id', v_new.id, 'slug', v_new.slug, 'passage_id', v_pid);
    exception when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'idx_questions_content_unique' then
        v_dups := v_dups + 1;
        v_results := v_results || jsonb_build_object('ref', v_item->'ref', 'outcome', 'duplicate');
      else
        raise;
      end if;
    end;
  end loop;

  return jsonb_build_object('inserted', v_inserted, 'duplicates', v_dups, 'results', v_results);
end $$;

create or replace function public.bank_record_issues(p_issues jsonb, p_batch uuid, p_job uuid) returns void
language plpgsql as $$
begin
  insert into public.bank_issues (import_batch_id, job_id, ref, severity, code, message, payload)
  select p_batch, p_job, i.ref, i.severity, i.code, left(i.message, 500), i.payload
  from jsonb_to_recordset(coalesce(p_issues, '[]'::jsonb))
    as i(ref text, severity text, code text, message text, payload jsonb)
  where i.severity in ('error', 'warning', 'info');
end $$;

-- 9) Importation par lots ---------------------------------------------------
create or replace function public.bank_import_start(
  p_filename text, p_format text, p_fingerprint text, p_total_rows int, p_chunk_size int,
  p_chunks_total int, p_mapping jsonb, p_actor text, p_kind text default 'reading'
) returns jsonb language plpgsql as $$
declare v_row public.import_batches;
begin
  -- Reprise : un import inachevé du même fichier est repris au lieu d'être recommencé.
  select * into v_row from public.import_batches
    where fingerprint = p_fingerprint and p_fingerprint is not null
      and status = 'processing' and chunk_size = p_chunk_size and chunks_total = p_chunks_total
    order by created_at desc limit 1;
  if found then
    return to_jsonb(v_row) || jsonb_build_object('resumed', true);
  end if;
  insert into public.import_batches (filename, format, kind, fingerprint, total_rows, chunk_size, chunks_total, mapping, created_by)
    values (left(p_filename, 200), p_format, p_kind, p_fingerprint, p_total_rows, p_chunk_size, p_chunks_total,
            coalesce(p_mapping, '{}'::jsonb), p_actor)
    returning * into v_row;
  return to_jsonb(v_row) || jsonb_build_object('resumed', false);
end $$;

create or replace function public.bank_import_commit(
  p_batch uuid, p_chunk int, p_items jsonb, p_issues jsonb, p_stats jsonb, p_actor text
) returns jsonb language plpgsql as $$
declare
  v_b public.import_batches;
  v_res jsonb;
  v_done int[];
begin
  select * into v_b from public.import_batches where id = p_batch for update;
  if not found then raise exception 'Import introuvable'; end if;
  if v_b.status = 'cancelled' then raise exception 'Import annulé'; end if;
  if p_chunk = any(v_b.chunks_done) then
    return jsonb_build_object('already_done', true, 'batch', to_jsonb(v_b));
  end if;

  v_res := public.bank_insert_items(p_items, jsonb_build_object(
    'status', 'draft', 'source', 'import', 'actor', p_actor, 'import_batch_id', p_batch,
    'origin_version', 'import-v1'));

  -- Doublons exacts découverts à l'insertion : tracés dans le rapport.
  insert into public.bank_issues (import_batch_id, ref, severity, code, message, payload)
  select p_batch, r->>'ref', 'error', 'duplicate_exact',
         'Doublon exact d''une question existante' || coalesce(' (' || (r->>'existing_slug') || ')', ''),
         r
  from jsonb_array_elements(v_res->'results') r where r->>'outcome' = 'duplicate';
  perform public.bank_record_issues(p_issues, p_batch, null);

  v_done := array_append(v_b.chunks_done, p_chunk);
  update public.import_batches set
    chunks_done = v_done,
    rows_done = rows_done + coalesce((p_stats->>'rows')::int, 0),
    accepted = accepted + (v_res->>'inserted')::int,
    duplicates = duplicates + (v_res->>'duplicates')::int,
    rejected = rejected + coalesce((p_stats->>'rejected')::int, 0),
    flagged = flagged + coalesce((p_stats->>'flagged')::int, 0),
    status = case when cardinality(v_done) >= chunks_total then 'completed' else 'processing' end,
    finished_at = case when cardinality(v_done) >= chunks_total then now() else null end,
    updated_at = now()
  where id = p_batch returning * into v_b;

  return jsonb_build_object('already_done', false, 'inserted', v_res->'inserted',
    'duplicates', v_res->'duplicates', 'results', v_res->'results', 'batch', to_jsonb(v_b));
end $$;

create or replace function public.bank_import_cancel(p_batch uuid) returns void
language sql as $$
  update public.import_batches set status = 'cancelled', finished_at = now(), updated_at = now()
  where id = p_batch and status = 'processing'
$$;

-- 10) File de génération IA -------------------------------------------------
create or replace function public.gen_create_job(p_params jsonb, p_actor text, p_max_per_hour int default 5)
returns jsonb language plpgsql as $$
declare
  v_total int := (p_params->>'total')::int;
  v_size int := (p_params->>'batch_size')::int;
  v_batches int;
  v_job public.generation_jobs;
  i int;
begin
  if (select count(*) from public.generation_jobs
        where created_by = p_actor and created_at > now() - interval '1 hour') >= p_max_per_hour then
    raise exception 'rate_limit';
  end if;
  v_batches := ceil(v_total::numeric / v_size);
  insert into public.generation_jobs (part, kind, difficulty, theme, options, total_requested, batch_size,
                                      batches_total, estimated_usd, created_by)
    values ((p_params->>'part')::int, p_params->>'kind', (p_params->>'difficulty')::int,
            nullif(p_params->>'theme', ''), coalesce(p_params->'options', '{}'::jsonb),
            v_total, v_size, v_batches, coalesce((p_params->>'estimated_usd')::numeric, 0), p_actor)
    returning * into v_job;
  for i in 0 .. v_batches - 1 loop
    insert into public.generation_batches (job_id, idx, quantity)
      values (v_job.id, i, least(v_size, v_total - i * v_size));
  end loop;
  return to_jsonb(v_job);
end $$;

-- Réserve (bail) un lot à traiter. `for update skip locked` + jeton de bail : deux
-- exécutions simultanées ne peuvent jamais traiter le même lot.
create or replace function public.gen_claim_batch(
  p_job uuid default null, p_lease_seconds int default 150, p_worker text default null, p_max_attempts int default 3
) returns jsonb language plpgsql as $$
declare
  v_b public.generation_batches;
  v_job public.generation_jobs;
  v_token uuid := gen_random_uuid();
begin
  -- Lots dont le bail a expiré après trop d'essais : définitivement en échec.
  update public.generation_batches set status = 'failed', error = coalesce(error, 'Bail expiré après plusieurs essais'),
      finished_at = now()
    where status = 'running' and lease_until < now() and attempts >= p_max_attempts
      and (p_job is null or job_id = p_job);

  select b.* into v_b
    from public.generation_batches b
    join public.generation_jobs j on j.id = b.job_id
   where j.status in ('queued', 'running')
     and (p_job is null or b.job_id = p_job)
     and (b.status = 'pending' or (b.status = 'running' and b.lease_until < now()))
     and b.attempts < p_max_attempts
   order by j.created_at, b.idx
   for update of b skip locked
   limit 1;
  if not found then
    perform public.gen_refresh_jobs(p_job);
    return null;
  end if;

  update public.generation_batches set status = 'running', attempts = attempts + 1,
      lease_until = now() + make_interval(secs => p_lease_seconds), lease_token = v_token,
      worker = p_worker, started_at = coalesce(started_at, now())
    where id = v_b.id returning * into v_b;
  update public.generation_jobs set status = 'running', started_at = coalesce(started_at, now()), updated_at = now()
    where id = v_b.job_id and status = 'queued';
  select * into v_job from public.generation_jobs where id = v_b.job_id;
  return jsonb_build_object('batch', to_jsonb(v_b) - 'lease_token', 'token', v_token, 'job', to_jsonb(v_job));
end $$;

-- Clôture d'un job quand plus aucun lot n'est actif.
create or replace function public.gen_refresh_jobs(p_job uuid default null) returns void
language plpgsql as $$
begin
  update public.generation_jobs j set
    status = case when (select count(*) from public.generation_batches b where b.job_id = j.id and b.status = 'done') = 0
                  then 'failed' else 'completed' end,
    finished_at = now(), updated_at = now(),
    batches_done = (select count(*) from public.generation_batches b where b.job_id = j.id and b.status = 'done'),
    batches_failed = (select count(*) from public.generation_batches b where b.job_id = j.id and b.status = 'failed')
  where j.status in ('queued', 'running')
    and (p_job is null or j.id = p_job)
    and not exists (select 1 from public.generation_batches b where b.job_id = j.id and b.status in ('pending', 'running'));
end $$;

create or replace function public.gen_commit_batch(
  p_batch uuid, p_token uuid, p_items jsonb, p_issues jsonb, p_stats jsonb
) returns jsonb language plpgsql as $$
declare
  v_b public.generation_batches;
  v_j public.generation_jobs;
  v_res jsonb;
  v_cost numeric := coalesce((p_stats->>'cost_usd')::numeric, 0);
  v_status text;
begin
  select * into v_b from public.generation_batches where id = p_batch for update;
  if not found then raise exception 'Lot introuvable'; end if;
  if v_b.status = 'done' then return jsonb_build_object('already_done', true); end if;
  if v_b.status <> 'running' or v_b.lease_token is distinct from p_token then
    raise exception 'lease_lost';
  end if;
  select * into v_j from public.generation_jobs where id = v_b.job_id for update;

  -- Statut initial : « en validation » (aucune alerte) ou « brouillon » (à vérifier) ; décidé par item.
  v_res := (
    select jsonb_build_object(
      'inserted', coalesce(sum((r->>'inserted')::int), 0),
      'duplicates', coalesce(sum((r->>'duplicates')::int), 0),
      'results', coalesce(jsonb_agg(r->'results'), '[]'::jsonb))
    from (
      select public.bank_insert_items(g.items, jsonb_build_object(
        'status', g.st, 'source', 'ai', 'actor', 'ai:job:' || v_j.id::text,
        'generation_job_id', v_j.id, 'origin_version', coalesce(p_stats->>'origin_version', 'gen-v1'))) as r
      from (
        select it->>'target_status' as st, jsonb_agg(it) as items
        from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) it
        group by it->>'target_status'
      ) g
    ) s);

  perform public.bank_record_issues(p_issues, null, v_j.id);

  update public.generation_batches set status = 'done', finished_at = now(), lease_until = null,
      generated = coalesce((p_stats->>'generated')::int, 0), validated = coalesce((p_stats->>'validated')::int, 0),
      flagged = coalesce((p_stats->>'flagged')::int, 0), rejected = coalesce((p_stats->>'rejected')::int, 0),
      cost_usd = v_cost
    where id = p_batch;

  update public.generation_jobs set
      generated_count = generated_count + coalesce((p_stats->>'generated')::int, 0),
      validated_count = validated_count + coalesce((p_stats->>'validated')::int, 0),
      flagged_count = flagged_count + coalesce((p_stats->>'flagged')::int, 0),
      rejected_count = rejected_count + coalesce((p_stats->>'rejected')::int, 0),
      duplicate_count = duplicate_count + (v_res->>'duplicates')::int,
      actual_usd = actual_usd + v_cost, updated_at = now()
    where id = v_j.id;
  perform public.gen_refresh_jobs(v_j.id);
  select status into v_status from public.generation_jobs where id = v_j.id;
  return jsonb_build_object('already_done', false, 'inserted', v_res->'inserted',
    'duplicates', v_res->'duplicates', 'job_status', v_status);
end $$;

-- Échec d'un lot : nouvel essai (retry) ou échec définitif. Le coût éventuellement
-- facturé (réponse reçue mais inutilisable) reste imputé au job.
create or replace function public.gen_fail_batch(
  p_batch uuid, p_token uuid, p_error text, p_cost numeric default 0, p_retry boolean default true,
  p_max_attempts int default 3
) returns jsonb language plpgsql as $$
declare
  v_b public.generation_batches;
  v_final boolean;
  v_status text;
begin
  select * into v_b from public.generation_batches where id = p_batch for update;
  if not found then raise exception 'Lot introuvable'; end if;
  if v_b.status <> 'running' or v_b.lease_token is distinct from p_token then
    raise exception 'lease_lost';
  end if;
  v_final := not p_retry or v_b.attempts >= p_max_attempts;
  update public.generation_batches set
      status = case when v_final then 'failed' else 'pending' end,
      lease_until = null, lease_token = null, error = left(p_error, 500), cost_usd = cost_usd + coalesce(p_cost, 0),
      finished_at = case when v_final then now() else null end
    where id = p_batch;
  update public.generation_jobs set
      actual_usd = actual_usd + coalesce(p_cost, 0), updated_at = now(),
      errors = (select coalesce(jsonb_agg(e), '[]'::jsonb) from (
        select e from jsonb_array_elements(errors || jsonb_build_array(jsonb_build_object(
          'at', now(), 'batch', v_b.idx, 'attempt', v_b.attempts, 'final', v_final, 'message', left(p_error, 300)))) e
        order by (e->>'at') desc limit 50) x)
    where id = v_b.job_id;
  perform public.gen_refresh_jobs(v_b.job_id);
  select status into v_status from public.generation_jobs where id = v_b.job_id;
  return jsonb_build_object('final', v_final, 'job_status', v_status);
end $$;

create or replace function public.gen_cancel_job(p_job uuid, p_actor text) returns jsonb
language plpgsql as $$
declare v_job public.generation_jobs;
begin
  update public.generation_batches set status = 'cancelled', finished_at = now()
    where job_id = p_job and status = 'pending';
  update public.generation_jobs set status = 'cancelled', finished_at = now(), updated_at = now()
    where id = p_job and status in ('queued', 'running', 'paused') returning * into v_job;
  if not found then raise exception 'Job introuvable ou déjà terminé'; end if;
  return to_jsonb(v_job);
end $$;

create or replace function public.gen_pause_job(p_job uuid, p_pause boolean) returns jsonb
language plpgsql as $$
declare v_job public.generation_jobs;
begin
  if p_pause then
    update public.generation_jobs set status = 'paused', updated_at = now()
      where id = p_job and status in ('queued', 'running') returning * into v_job;
  else
    update public.generation_jobs set status = 'queued', updated_at = now()
      where id = p_job and status = 'paused' returning * into v_job;
  end if;
  if not found then raise exception 'Job introuvable ou état incompatible'; end if;
  return to_jsonb(v_job);
end $$;

-- Reprise : les lots en échec repartent à zéro tentative ; un job terminé est relancé.
create or replace function public.gen_resume_job(p_job uuid) returns jsonb
language plpgsql as $$
declare v_job public.generation_jobs;
begin
  update public.generation_batches set status = 'pending', attempts = 0, error = null, finished_at = null,
      lease_until = null, lease_token = null
    where job_id = p_job and status = 'failed';
  update public.generation_jobs set status = 'queued', finished_at = null, updated_at = now(),
      batches_failed = 0
    where id = p_job and status in ('failed', 'completed', 'paused')
      and exists (select 1 from public.generation_batches b where b.job_id = p_job and b.status = 'pending')
    returning * into v_job;
  if not found then raise exception 'Rien à reprendre pour ce job'; end if;
  return to_jsonb(v_job);
end $$;

-- 11) Fonctions publiques (navigateur) ----------------------------------------
-- Colonnes exposées aux élèves : pas d'empreintes, pas de notes de relecture.
create or replace function public.bank_public_question(q public.questions) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'id', q.id, 'slug', q.slug, 'part', q.part, 'passage_id', q.passage_id, 'order_index', q.order_index,
    'prompt', q.prompt, 'options', q.options, 'correct_key', q.correct_key, 'difficulty', q.difficulty,
    'category', q.category, 'theme', q.theme, 'tags', to_jsonb(q.tags), 'explanation', q.explanation,
    'option_rationales', q.option_rationales)
$$;

-- Tirage aléatoire de questions de la partie 5 (ou de toute question isolée).
-- Parcours de l'index sur rand_key (aucun ORDER BY random()) : coût constant à 100 000 lignes.
-- Les questions déjà vues (p_exclude : slugs ou ids) passent en dernier recours.
create or replace function public.bank_pick_questions(
  p_part int, p_limit int default 20, p_difficulty int default null, p_category text default null,
  p_theme text default null, p_exclude text[] default '{}', p_seed double precision default null
) returns jsonb language plpgsql stable as $$
declare
  v_r double precision := coalesce(p_seed, random());
  v_ids uuid[] := '{}';
  v_phase int;
  v_limit int := least(greatest(coalesce(p_limit, 20), 1), 200);
  v_seen boolean;
  v_fwd boolean;
  v_exclude text[] := coalesce(p_exclude, '{}');
begin
  for v_phase in 1 .. 4 loop
    exit when cardinality(v_ids) >= v_limit;
    exit when v_phase > 2 and cardinality(v_exclude) = 0;
    v_seen := v_phase > 2;
    v_fwd := v_phase in (1, 3);
    v_ids := v_ids || array(
      select q.id from public.questions q
       where q.status = 'published' and q.part = p_part and q.passage_id is null
         and (p_difficulty is null or q.difficulty = p_difficulty)
         and (p_category is null or q.category = p_category)
         and (p_theme is null or q.theme = p_theme)
         and (cardinality(v_exclude) > 0 and (q.slug = any(v_exclude) or q.id::text = any(v_exclude))) = v_seen
         and ((v_fwd and q.rand_key >= v_r) or (not v_fwd and q.rand_key < v_r))
       order by q.rand_key
       limit v_limit - cardinality(v_ids));
  end loop;
  return jsonb_build_object('questions', coalesce((
    select jsonb_agg(public.bank_public_question(q) order by q.rand_key)
      from public.questions q where q.id = any(v_ids)), '[]'::jsonb));
end $$;

-- Tirage de passages (parties 6 et 7) avec TOUTES leurs questions. Un passage n'est
-- proposé que si chacune de ses questions est publiée (pas de document tronqué).
create or replace function public.bank_pick_passages(
  p_part int, p_limit int default 4, p_difficulty int default null, p_category text default null,
  p_theme text default null, p_exclude text[] default '{}', p_seed double precision default null,
  p_min_q int default 1, p_max_q int default 20
) returns jsonb language plpgsql stable as $$
declare
  v_r double precision := coalesce(p_seed, random());
  v_ids uuid[] := '{}';
  v_phase int;
  v_limit int := least(greatest(coalesce(p_limit, 4), 1), 100);
  v_seen boolean;
  v_fwd boolean;
  v_exclude text[] := coalesce(p_exclude, '{}');
begin
  for v_phase in 1 .. 4 loop
    exit when cardinality(v_ids) >= v_limit;
    exit when v_phase > 2 and cardinality(v_exclude) = 0;
    v_seen := v_phase > 2;
    v_fwd := v_phase in (1, 3);
    v_ids := v_ids || array(
      select p.id from public.passages p
       where p.status = 'published' and p.part = p_part
         and ((v_fwd and p.rand_key >= v_r) or (not v_fwd and p.rand_key < v_r))
         and (select count(*) filter (where s.status = 'published') = count(*)
                     and count(*) between p_min_q and p_max_q
                     and (p_difficulty is null or bool_or(s.difficulty = p_difficulty))
                     and (p_category is null or bool_or(s.category = p_category))
                     and (p_theme is null or bool_or(s.theme = p_theme))
                     and (cardinality(v_exclude) > 0 and bool_or(s.slug = any(v_exclude) or s.id::text = any(v_exclude))) = v_seen
                from public.questions s where s.passage_id = p.id)
       order by p.rand_key
       limit v_limit - cardinality(v_ids));
  end loop;
  return jsonb_build_object(
    'passages', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'part', p.part, 'title', p.title,
        'documents', p.documents) order by p.rand_key) from public.passages p where p.id = any(v_ids)), '[]'::jsonb),
    'questions', coalesce((select jsonb_agg(public.bank_public_question(q) order by q.passage_id, q.order_index)
        from public.questions q where q.passage_id = any(v_ids) and q.status = 'published'), '[]'::jsonb));
end $$;

-- Jeu de candidats pour un examen Reading complet (la composition finale est faite
-- par le client : 30 + 16 + 54 questions, passages entiers).
create or replace function public.bank_exam_candidates(p_exclude text[] default '{}', p_seed double precision default null)
returns jsonb language plpgsql stable as $$
declare
  v_seed double precision := coalesce(p_seed, random());
  v_p6 jsonb;
  v_p7 jsonb;
begin
  v_p6 := public.bank_pick_passages(6, 14, null, null, null, p_exclude, v_seed, 4, 4);
  v_p7 := public.bank_pick_passages(7, 40, null, null, null, p_exclude, v_seed, 2, 5);
  return jsonb_build_object(
    'p5', public.bank_pick_questions(5, 90, null, null, null, p_exclude, v_seed)->'questions',
    'p6', v_p6, 'p7', v_p7);
end $$;

-- Effectifs publiés (pour afficher « examen réduit » et les filtres de l'élève).
create or replace function public.bank_public_counts() returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'by_part', coalesce((select jsonb_object_agg(part::text, n) from (
        select part, count(*) n from public.questions where status = 'published' group by part) s), '{}'::jsonb),
    'by_category', coalesce((select jsonb_object_agg(k, n) from (
        select part::text || ':' || category as k, count(*) n from public.questions
         where status = 'published' and category is not null group by part, category) s), '{}'::jsonb),
    'by_difficulty', coalesce((select jsonb_object_agg(k, n) from (
        select part::text || ':' || difficulty as k, count(*) n from public.questions
         where status = 'published' group by part, difficulty) s), '{}'::jsonb))
$$;

-- Lecture groupée par identifiants (révision, historique) : slugs ou uuid, 200 maximum.
create or replace function public.bank_questions_by_ids(p_ids text[]) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'questions', coalesce((select jsonb_agg(public.bank_public_question(q)) from public.questions q
       where q.status in ('published', 'archived')
         and (q.slug = any(p_ids[1:200]) or q.id::text = any(p_ids[1:200]))), '[]'::jsonb),
    'passages', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'part', p.part, 'title', p.title,
        'documents', p.documents)) from public.passages p where p.id in (
          select q.passage_id from public.questions q
           where q.status in ('published', 'archived') and q.passage_id is not null
             and (q.slug = any(p_ids[1:200]) or q.id::text = any(p_ids[1:200])))
         and p.status in ('published', 'archived')), '[]'::jsonb))
$$;

-- 12) Administration (service_role uniquement) --------------------------------
create or replace function public.bank_admin_row(q public.questions) returns jsonb
language sql stable as $$
  select (to_jsonb(q) - 'search_vec' - 'lsh' - 'rand_key')
         || jsonb_build_object('passage_title', (select p.title from public.passages p where p.id = q.passage_id))
$$;

-- Liste paginée et filtrée. Filtres : part, difficulty, category, theme, status, source,
-- needs_review, q (texte), passage_id, job_id, batch_id, sort (newest|oldest|updated).
create or replace function public.bank_admin_list(p_filters jsonb default '{}', p_limit int default 25, p_offset int default 0)
returns jsonb language plpgsql stable as $$
declare
  f jsonb := coalesce(p_filters, '{}');
  v_where text := 'true';
  v_order text;
  v_tsq tsquery;
  v_limit int := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset int := least(greatest(coalesce(p_offset, 0), 0), 100000);
  v_total bigint;
  v_rows jsonb;
begin
  if f ? 'part' then v_where := v_where || ' and q.part = ($1->>''part'')::int'; end if;
  if f ? 'difficulty' then v_where := v_where || ' and q.difficulty = ($1->>''difficulty'')::int'; end if;
  if f ? 'category' then v_where := v_where || ' and q.category = $1->>''category'''; end if;
  if f ? 'theme' then v_where := v_where || ' and q.theme = $1->>''theme'''; end if;
  if f ? 'status' then v_where := v_where || ' and q.status = $1->>''status'''; end if;
  if f ? 'source' then v_where := v_where || ' and q.source = $1->>''source'''; end if;
  if f ? 'needs_review' then v_where := v_where || ' and q.needs_review = ($1->>''needs_review'')::boolean'; end if;
  if f ? 'passage_id' then v_where := v_where || ' and q.passage_id = ($1->>''passage_id'')::uuid'; end if;
  if f ? 'job_id' then v_where := v_where || ' and q.generation_job_id = ($1->>''job_id'')::uuid'; end if;
  if f ? 'batch_id' then v_where := v_where || ' and q.import_batch_id = ($1->>''batch_id'')::uuid'; end if;
  if nullif(btrim(f->>'q'), '') is not null then
    v_tsq := plainto_tsquery('english', f->>'q');
    v_where := v_where || ' and (q.search_vec @@ $2 or q.slug ilike (replace(replace($1->>''q'', ''%'', ''''), ''_'', '''') || ''%''))';
  end if;
  v_order := case f->>'sort'
    when 'oldest' then 'q.created_at asc, q.id'
    when 'updated' then 'q.updated_at desc, q.id'
    else 'q.created_at desc, q.id' end;

  execute 'select count(*) from public.questions q where ' || v_where into v_total using f, v_tsq;
  execute 'select coalesce(jsonb_agg(public.bank_admin_row(s)), ''[]''::jsonb) from (select q.* from public.questions q where '
    || v_where || ' order by ' || v_order || ' limit ' || v_limit || ' offset ' || v_offset || ') s'
    into v_rows using f, v_tsq;
  return jsonb_build_object('total', v_total, 'limit', v_limit, 'offset', v_offset, 'rows', v_rows);
end $$;

create or replace function public.bank_admin_get(p_id uuid) returns jsonb
language plpgsql stable as $$
declare v_q public.questions;
begin
  select * into v_q from public.questions where id = p_id;
  if not found then return null; end if;
  return jsonb_build_object(
    'question', public.bank_admin_row(v_q),
    'passage', (select to_jsonb(p) - 'lsh' - 'rand_key' from public.passages p where p.id = v_q.passage_id),
    'siblings', coalesce((select jsonb_agg(public.bank_admin_row(s) order by s.order_index)
        from public.questions s where s.passage_id = v_q.passage_id and v_q.passage_id is not null), '[]'::jsonb),
    'revisions', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'version', r.version,
        'change_type', r.change_type, 'changed_by', r.changed_by, 'created_at', r.created_at,
        'snapshot', r.snapshot) order by r.id desc)
        from (select * from public.question_revisions where question_id = p_id order by id desc limit 20) r), '[]'::jsonb));
end $$;

create or replace function public.bank_update_question(
  p_id uuid, p_patch jsonb, p_expected_version int, p_actor text
) returns jsonb language plpgsql as $$
declare
  v_q public.questions;
  v_opts jsonb;
begin
  perform set_config('app.actor', coalesce(p_actor, 'system'), true);
  select * into v_q from public.questions where id = p_id for update;
  if not found then raise exception 'Question introuvable'; end if;
  if p_expected_version is not null and v_q.version <> p_expected_version then
    raise exception 'version_conflict';
  end if;
  v_opts := coalesce(p_patch->'options', v_q.options);
  if jsonb_typeof(v_opts) <> 'array' or jsonb_array_length(v_opts) <> 4 then
    raise exception 'Quatre propositions sont requises';
  end if;
  begin
    update public.questions set
      prompt = coalesce(p_patch->>'prompt', prompt),
      options = v_opts,
      correct_key = coalesce(p_patch->>'correct_key', correct_key),
      difficulty = coalesce((p_patch->>'difficulty')::int, difficulty),
      category = case when p_patch ? 'category' then nullif(p_patch->>'category', '') else category end,
      theme = case when p_patch ? 'theme' then nullif(p_patch->>'theme', '') else theme end,
      explanation = case when p_patch ? 'explanation' then nullif(p_patch->>'explanation', '') else explanation end,
      option_rationales = case when p_patch ? 'option_rationales' then p_patch->'option_rationales' else option_rationales end,
      tags = case when p_patch ? 'tags' then array(select jsonb_array_elements_text(p_patch->'tags')) else tags end,
      lsh = case when p_patch ? 'lsh' then array(select jsonb_array_elements_text(p_patch->'lsh')::int) else lsh end,
      needs_review = case when coalesce((p_patch->>'ack_review')::boolean, false) then false else needs_review end,
      review_flags = case when coalesce((p_patch->>'ack_review')::boolean, false) then '[]'::jsonb else review_flags end
    where id = p_id returning * into v_q;
  exception when unique_violation then
    raise exception 'duplicate_content';
  end;
  return public.bank_admin_row(v_q);
end $$;

create or replace function public.bank_update_passage(
  p_id uuid, p_title text, p_documents jsonb, p_actor text
) returns jsonb language plpgsql as $$
declare v_p public.passages;
begin
  perform set_config('app.actor', coalesce(p_actor, 'system'), true);
  update public.passages set title = coalesce(left(p_title, 250), title), documents = coalesce(p_documents, documents)
    where id = p_id returning * into v_p;
  if not found then raise exception 'Document introuvable'; end if;
  return to_jsonb(v_p) - 'lsh' - 'rand_key';
end $$;

-- Changement de statut, individuel ou en masse (500 questions maximum).
-- Transitions : draft→review|published|archived, review→draft|published|archived,
-- published→archived, archived→draft|review|published. Une question à vérifier
-- (needs_review) n'est publiée qu'avec p_ack = true (confirmation humaine explicite).
create or replace function public.bank_set_status(p_ids uuid[], p_status text, p_actor text, p_ack boolean default false)
returns jsonb language plpgsql as $$
declare
  v_q public.questions;
  v_changed int := 0;
  v_skipped jsonb := '[]'::jsonb;
  v_id uuid;
  v_pass_status text;
begin
  if p_status not in ('draft', 'review', 'published', 'archived') then raise exception 'Statut invalide'; end if;
  if cardinality(p_ids) > 500 then raise exception 'Au plus 500 questions à la fois'; end if;
  perform set_config('app.actor', coalesce(p_actor, 'system'), true);
  foreach v_id in array p_ids loop
    select * into v_q from public.questions where id = v_id for update;
    if not found then
      v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'not_found'); continue;
    end if;
    if v_q.status = p_status then continue; end if;
    if v_q.status = 'published' and p_status <> 'archived' then
      v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'archive_first'); continue;
    end if;
    if p_status = 'published' then
      if v_q.needs_review and not p_ack then
        v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'needs_review'); continue;
      end if;
      if v_q.part in (6, 7) and v_q.passage_id is null then
        v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'missing_passage'); continue;
      end if;
    end if;
    begin
      update public.questions set status = p_status,
          needs_review = case when p_status = 'published' and p_ack then false else needs_review end
        where id = v_id;
      if p_status = 'published' and v_q.passage_id is not null then
        update public.passages set status = 'published' where id = v_q.passage_id and status <> 'published';
      end if;
      v_changed := v_changed + 1;
    exception when unique_violation then
      v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'duplicate');
    end;
  end loop;
  return jsonb_build_object('changed', v_changed, 'skipped', v_skipped);
end $$;

-- Suppression contrôlée : uniquement les questions JAMAIS publiées (donc absentes de
-- tout historique d'élève). Les autres doivent être archivées.
create or replace function public.bank_delete_questions(p_ids uuid[], p_actor text)
returns jsonb language plpgsql as $$
declare
  v_deleted int := 0;
  v_skipped jsonb := '[]'::jsonb;
  v_q public.questions;
  v_id uuid;
begin
  if cardinality(p_ids) > 500 then raise exception 'Au plus 500 questions à la fois'; end if;
  perform set_config('app.actor', coalesce(p_actor, 'system'), true);
  foreach v_id in array p_ids loop
    select * into v_q from public.questions where id = v_id for update;
    if not found then continue; end if;
    if v_q.published_at is not null or v_q.status in ('published', 'archived') then
      v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'was_published'); continue;
    end if;
    delete from public.questions where id = v_id;
    v_deleted := v_deleted + 1;
    if v_q.passage_id is not null then
      delete from public.passages p where p.id = v_q.passage_id and p.status <> 'published'
        and not exists (select 1 from public.questions s where s.passage_id = p.id);
    end if;
  end loop;
  return jsonb_build_object('deleted', v_deleted, 'skipped', v_skipped);
end $$;

-- Candidats proches (index LSH) pour une liste d'éléments : [{i, part, lsh:[…]}].
create or replace function public.bank_find_similar_many(p_items jsonb) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('i', x.i, 'candidates', coalesce(c.cands, '[]'::jsonb))), '[]'::jsonb)
  from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as x(i int, part int, lsh int[])
  cross join lateral (
    select jsonb_agg(jsonb_build_object('id', s.id, 'slug', s.slug, 'status', s.status,
                                        'prompt', s.prompt, 'options', s.options)) as cands
    from (select q.id, q.slug, q.status, q.prompt, q.options from public.questions q
           where q.lsh && x.lsh and q.part = x.part and q.status <> 'archived' limit 8) s
  ) c
$$;

create or replace function public.bank_duplicate_groups(p_limit int default 25, p_offset int default 0)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'total', (select count(*) from (select 1 from public.questions where status <> 'archived' and content_hash is not null
                group by content_hash having count(*) > 1) g),
    'groups', coalesce((select jsonb_agg(jsonb_build_object('hash', g.content_hash, 'count', g.n, 'items', g.items))
      from (
        select d.content_hash, d.n, (select jsonb_agg(jsonb_build_object('id', q.id, 'slug', q.slug,
                 'status', q.status, 'prompt', q.prompt, 'created_at', q.created_at) order by q.created_at)
               from public.questions q where q.content_hash = d.content_hash and q.status <> 'archived') as items
        from (select content_hash, count(*) n from public.questions
               where status <> 'archived' and content_hash is not null
               group by content_hash having count(*) > 1
               order by count(*) desc, content_hash limit least(greatest(p_limit, 1), 100)
               offset greatest(p_offset, 0)) d
      ) g), '[]'::jsonb))
$$;

create or replace function public.bank_admin_stats() returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'total', (select count(*) from public.questions),
    'by_status', coalesce((select jsonb_object_agg(status, n) from (
        select status, count(*) n from public.questions group by status) s), '{}'::jsonb),
    'by_part_status', coalesce((select jsonb_object_agg(k, n) from (
        select part::text || ':' || status as k, count(*) n from public.questions group by part, status) s), '{}'::jsonb),
    'by_difficulty', coalesce((select jsonb_object_agg(k, n) from (
        select part::text || ':' || difficulty as k, count(*) n from public.questions
         where status = 'published' group by part, difficulty) s), '{}'::jsonb),
    'by_category', coalesce((select jsonb_object_agg(k, n) from (
        select coalesce(category, '(aucune)') as k, count(*) n from public.questions
         where status <> 'archived' group by category) s), '{}'::jsonb),
    'by_source', coalesce((select jsonb_object_agg(source, n) from (
        select source, count(*) n from public.questions group by source) s), '{}'::jsonb),
    'answers_published', coalesce((select jsonb_object_agg(correct_key, n) from (
        select correct_key, count(*) n from public.questions where status = 'published' group by correct_key) s), '{}'::jsonb),
    'needs_review', (select count(*) from public.questions where needs_review and status <> 'archived'),
    'passages', (select count(*) from public.passages),
    'duplicate_groups', (select count(*) from (select 1 from public.questions
        where status <> 'archived' and content_hash is not null group by content_hash having count(*) > 1) g))
$$;

-- 13) Droits des fonctions ------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'bank_insert_items(jsonb,jsonb)', 'bank_record_issues(jsonb,uuid,uuid)',
    'bank_import_start(text,text,text,int,int,int,jsonb,text,text)',
    'bank_import_commit(uuid,int,jsonb,jsonb,jsonb,text)', 'bank_import_cancel(uuid)',
    'gen_create_job(jsonb,text,int)', 'gen_claim_batch(uuid,int,text,int)', 'gen_refresh_jobs(uuid)',
    'gen_commit_batch(uuid,uuid,jsonb,jsonb,jsonb)', 'gen_fail_batch(uuid,uuid,text,numeric,boolean,int)',
    'gen_cancel_job(uuid,text)', 'gen_pause_job(uuid,boolean)', 'gen_resume_job(uuid)',
    'bank_admin_row(questions)', 'bank_admin_list(jsonb,int,int)', 'bank_admin_get(uuid)',
    'bank_update_question(uuid,jsonb,int,text)', 'bank_update_passage(uuid,text,jsonb,text)',
    'bank_set_status(uuid[],text,text,boolean)', 'bank_delete_questions(uuid[],text)',
    'bank_find_similar_many(jsonb)', 'bank_duplicate_groups(int,int)', 'bank_admin_stats()'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  foreach f in array array[
    'bank_pick_questions(int,int,int,text,text,text[],double precision)',
    'bank_pick_passages(int,int,int,text,text,text[],double precision,int,int)',
    'bank_exam_candidates(text[],double precision)', 'bank_public_counts()', 'bank_questions_by_ids(text[])'
  ] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated, service_role', f);
  end loop;
end $$;
