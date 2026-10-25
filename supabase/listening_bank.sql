-- Bibliothèque centralisée du Listening (Partie 2 aujourd'hui, Parties 1, 3 et 4 demain).
-- À exécuter APRÈS supabase/question_bank.sql (réutilise bank_norm). Idempotent, non destructif.
--
-- Le fonctionnement actuel est CONSERVÉ pendant la migration : tant que cette table est vide ou
-- que Supabase est inaccessible, l'application continue de lire data/listening.json.
-- Aucun fichier audio n'est fabriqué ici : une piste n'existe que si un enregistrement (ou une
-- synthèse vocale configurée) a été fourni et référencé par son URL.

create table if not exists public.listening_tracks (
  id uuid primary key default gen_random_uuid(),
  audio_url text not null check (audio_url ~ '^(https://|/)[^ ]+[.](mp3|m4a|ogg|wav)$'),
  mime text,
  duration_ms int check (duration_ms is null or duration_ms between 500 and 600000),
  speaker text,                                    -- voix / locuteur
  language text not null default 'en',
  transcript text,                                 -- transcription de la piste
  provider text not null default 'recording' check (provider in ('recording', 'tts', 'external')),
  status text not null default 'published' check (status in ('draft', 'published', 'archived')),
  created_at timestamptz not null default now()
);
create unique index if not exists idx_listening_tracks_url on public.listening_tracks (audio_url);

create table if not exists public.listening_items (
  id uuid primary key default gen_random_uuid(),
  slug text unique,                                -- identifiant stable (ex. « l2-01 ») : clé de l'historique
  part int not null default 2 check (part in (1, 2, 3, 4)),
  prompt text not null,                            -- phrase prononcée (partie 2) ou question écrite
  transcript text,                                 -- transcription affichée après la réponse
  options jsonb not null,
  correct_key char(1) not null check (correct_key in ('A', 'B', 'C', 'D')),
  difficulty int not null default 2 check (difficulty between 1 and 3),
  category text,
  theme text,
  track_id uuid references public.listening_tracks(id) on delete set null,
  status text not null default 'draft' check (status in ('draft', 'review', 'published', 'archived')),
  source text not null default 'manual' check (source in ('json', 'import', 'manual', 'ai')),
  content_hash text,
  version int not null default 1,
  rand_key double precision not null default random(),
  needs_review boolean not null default false,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  constraint listening_options_check check (
    jsonb_typeof(options) = 'array' and jsonb_array_length(options) = case when part = 2 then 3 else 4 end
  ),
  constraint listening_correct_in_options check (
    correct_key <= case when part = 2 then 'C' else 'D' end
  )
);
create index if not exists idx_listening_pick on public.listening_items (part, rand_key) where status = 'published';
create index if not exists idx_listening_status on public.listening_items (status, part, created_at desc);
create unique index if not exists idx_listening_hash on public.listening_items (content_hash) where status <> 'archived';

create or replace function public.listening_items_biu() returns trigger
language plpgsql as $$
begin
  new.content_hash := encode(sha256(convert_to(new.part::text || '|' || public.bank_norm(new.prompt) || '|' ||
    coalesce((select string_agg(public.bank_norm(o->>'text'), '|' order by public.bank_norm(o->>'text') collate "C")
              from jsonb_array_elements(new.options) o), ''), 'UTF8')), 'hex');
  if tg_op = 'UPDATE' then
    new.updated_at := now();
    if new.prompt is distinct from old.prompt or new.options is distinct from old.options
       or new.correct_key is distinct from old.correct_key or new.transcript is distinct from old.transcript then
      new.version := old.version + 1;
    end if;
  end if;
  if new.status = 'published' and new.published_at is null then new.published_at := now(); end if;
  if new.slug is null then new.slug := 'l' || new.part || '-' || substr(new.content_hash, 1, 10); end if;
  return new;
end $$;

drop trigger if exists trg_listening_items_biu on public.listening_items;
create trigger trg_listening_items_biu before insert or update on public.listening_items
  for each row execute function public.listening_items_biu();

alter table public.listening_tracks enable row level security;
alter table public.listening_items enable row level security;
revoke all on table public.listening_tracks, public.listening_items from anon, authenticated;
grant select on table public.listening_tracks, public.listening_items to anon, authenticated;

drop policy if exists "Lecture publique des pistes publiées" on public.listening_tracks;
create policy "Lecture publique des pistes publiées" on public.listening_tracks
  for select using (status in ('published', 'archived'));
drop policy if exists "Lecture publique des exercices Listening publiés" on public.listening_items;
create policy "Lecture publique des exercices Listening publiés" on public.listening_items
  for select using (status in ('published', 'archived'));

-- Tirage d'une série (élèves) : exercices publiés, inédits d'abord, avec leur piste audio.
create or replace function public.listening_pick(
  p_part int default 2, p_limit int default 12, p_difficulty int default null, p_category text default null,
  p_exclude text[] default '{}', p_seed double precision default null
) returns jsonb language plpgsql stable as $$
declare
  v_r double precision := coalesce(p_seed, random());
  v_ids uuid[] := '{}';
  v_phase int;
  v_limit int := least(greatest(coalesce(p_limit, 12), 1), 60);
  v_ex text[] := coalesce(p_exclude, '{}');
begin
  for v_phase in 1 .. 4 loop
    exit when cardinality(v_ids) >= v_limit;
    exit when v_phase > 2 and cardinality(v_ex) = 0;
    v_ids := v_ids || array(
      select i.id from public.listening_items i
       where i.status = 'published' and i.part = p_part
         and (p_difficulty is null or i.difficulty = p_difficulty)
         and (p_category is null or i.category = p_category)
         and (cardinality(v_ex) > 0 and i.slug = any(v_ex)) = (v_phase > 2)
         and ((v_phase in (1, 3) and i.rand_key >= v_r) or (v_phase in (2, 4) and i.rand_key < v_r))
       order by i.rand_key limit v_limit - cardinality(v_ids));
  end loop;
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', i.id, 'slug', i.slug, 'part', i.part, 'prompt', i.prompt, 'transcript', i.transcript,
      'options', i.options, 'correct_key', i.correct_key, 'difficulty', i.difficulty, 'category', i.category,
      'theme', i.theme, 'audio_url', t.audio_url, 'duration_ms', t.duration_ms) order by i.rand_key)
    from public.listening_items i left join public.listening_tracks t on t.id = i.track_id and t.status = 'published'
    where i.id = any(v_ids)), '[]'::jsonb));
end $$;

-- Insertion en masse (serveur) : [{ref, item:{slug,prompt,transcript,options,correct_key,difficulty,
-- category,theme,audio_url,duration_ms,speaker,provider,needs_review}}]. Les doublons exacts
-- (même énoncé et mêmes réponses) sont ignorés : rejouer un lot est sans danger.
create or replace function public.listening_insert_items(p_items jsonb, p_ctx jsonb) returns jsonb
language plpgsql as $$
declare
  v_it jsonb;
  v_x jsonb;
  v_track uuid;
  v_new public.listening_items;
  v_inserted int := 0;
  v_dups int := 0;
  v_results jsonb := '[]'::jsonb;
  v_status text := coalesce(p_ctx->>'status', 'draft');
  v_source text := coalesce(p_ctx->>'source', 'import');
  v_actor text := coalesce(p_ctx->>'actor', 'system');
begin
  if v_status not in ('draft', 'review') then raise exception 'Statut initial invalide'; end if;
  for v_it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_x := v_it->'item';
    v_track := null;
    if nullif(v_x->>'audio_url', '') is not null then
      insert into public.listening_tracks (audio_url, duration_ms, speaker, provider, transcript, status)
        values (v_x->>'audio_url', nullif(v_x->>'duration_ms', '')::int, v_x->>'speaker',
                coalesce(nullif(v_x->>'provider', ''), 'recording'), v_x->>'transcript', 'published')
        on conflict (audio_url) do update set audio_url = excluded.audio_url
        returning id into v_track;
    end if;
    begin
      insert into public.listening_items (slug, part, prompt, transcript, options, correct_key, difficulty, category, theme,
                                          track_id, status, source, needs_review, created_by)
        values (nullif(v_x->>'slug', ''), coalesce((v_it->>'part')::int, 2), v_x->>'prompt', v_x->>'transcript', v_x->'options',
                v_x->>'correct_key', coalesce((v_x->>'difficulty')::int, 2), nullif(v_x->>'category', ''), nullif(v_x->>'theme', ''),
                v_track, v_status, v_source, coalesce((v_x->>'needs_review')::boolean, false), v_actor)
        returning * into v_new;
      v_inserted := v_inserted + 1;
      v_results := v_results || jsonb_build_object('ref', v_it->'ref', 'outcome', 'inserted', 'id', v_new.id, 'slug', v_new.slug);
    exception when unique_violation then
      v_dups := v_dups + 1;
      v_results := v_results || jsonb_build_object('ref', v_it->'ref', 'outcome', 'duplicate');
    end;
  end loop;
  return jsonb_build_object('inserted', v_inserted, 'duplicates', v_dups, 'results', v_results);
end $$;

create or replace function public.listening_set_status(p_ids uuid[], p_status text, p_actor text, p_ack boolean default false)
returns jsonb language plpgsql as $$
declare
  v_changed int := 0;
  v_skipped jsonb := '[]'::jsonb;
  v_i public.listening_items;
  v_id uuid;
begin
  if p_status not in ('draft', 'review', 'published', 'archived') then raise exception 'Statut invalide'; end if;
  foreach v_id in array p_ids loop
    select * into v_i from public.listening_items where id = v_id for update;
    if not found or v_i.status = p_status then continue; end if;
    if p_status = 'published' and v_i.needs_review and not p_ack then
      v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'needs_review'); continue;
    end if;
    update public.listening_items set status = p_status,
      needs_review = case when p_status = 'published' and p_ack then false else needs_review end where id = v_id;
    v_changed := v_changed + 1;
  end loop;
  return jsonb_build_object('changed', v_changed, 'skipped', v_skipped);
end $$;

create or replace function public.listening_admin_list(p_status text default null, p_limit int default 25, p_offset int default 0)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'total', (select count(*) from public.listening_items where p_status is null or status = p_status),
    'rows', coalesce((select jsonb_agg(to_jsonb(x)) from (
        select i.id, i.slug, i.part, i.prompt, i.options, i.correct_key, i.difficulty, i.category, i.status, i.source,
               i.needs_review, i.created_at, t.audio_url
          from public.listening_items i left join public.listening_tracks t on t.id = i.track_id
         where p_status is null or i.status = p_status
         order by i.created_at desc, i.id
         limit least(greatest(p_limit, 1), 100) offset greatest(p_offset, 0)) x), '[]'::jsonb))
$$;

do $$
declare f text;
begin
  foreach f in array array['listening_insert_items(jsonb,jsonb)', 'listening_set_status(uuid[],text,text,boolean)', 'listening_admin_list(text,int,int)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  execute 'revoke all on function public.listening_pick(int,int,int,text,text[],double precision) from public';
  execute 'grant execute on function public.listening_pick(int,int,int,text,text[],double precision) to anon, authenticated, service_role';
end $$;
