-- Migrations IA pour TOEIC Reading AI Coach / Lernoviq.
-- À exécuter dans l'éditeur SQL de votre projet Supabase.
--
-- Objets :
--   * ai_explanations : historique + cache partagé des explications IA ;
--   * ai_daily_usage  : quota quotidien par acteur (utilisateur ou IP) ;
--   * ai_usage_events : journal des réservations (débit/minute + budget) ;
--   * ai_budget       : budget mensuel (coupe-circuit).
--
-- Sécurité : ces tables ne sont accessibles qu'au serveur (service_role),
-- exactement comme public.lexora_admin_users. Aucune politique RLS publique.

create extension if not exists pgcrypto;

-- 1) Historique + cache partagé des explications ---------------------------
create table if not exists public.ai_explanations (
  id uuid primary key default gen_random_uuid(),
  question_id text not null,
  selected_key char(1) not null check (selected_key in ('A','B','C','D')),
  prompt_version text not null,
  model text not null,
  payload jsonb not null,
  lesson jsonb,
  user_id uuid,
  prompt_tokens int,
  completion_tokens int,
  cache_hit_tokens int,
  cost_usd numeric(12,8),
  hits int not null default 0,
  created_at timestamptz not null default now(),
  unique (question_id, selected_key, prompt_version, model)
);
create index if not exists idx_ai_explanations_lookup
  on public.ai_explanations (question_id, selected_key, prompt_version, model);

-- 2) Quota quotidien par acteur (utilisateur connecté ou IP) ---------------
create table if not exists public.ai_daily_usage (
  actor text not null,
  day date not null,
  used int not null default 0,
  primary key (actor, day)
);

-- 3) Journal des réservations ---------------------------------------------
create table if not exists public.ai_usage_events (
  id uuid primary key default gen_random_uuid(),
  actor text not null,
  status text not null default 'pending'
    check (status in ('pending','succeeded','failed','released')),
  reserved_usd numeric(12,8) not null default 0,
  actual_usd numeric(12,8),
  created_at timestamptz not null default now(),
  finalized_at timestamptz
);
create index if not exists idx_ai_usage_events_actor_time
  on public.ai_usage_events (actor, created_at desc);

-- 4) Budget mensuel --------------------------------------------------------
create table if not exists public.ai_budget (
  month text primary key,
  limit_usd numeric(12,4) not null,
  suspend_usd numeric(12,4) not null,
  spent_usd numeric(12,8) not null default 0,
  updated_at timestamptz not null default now()
);

-- Sécurité : service_role uniquement --------------------------------------
alter table public.ai_explanations enable row level security;
alter table public.ai_daily_usage enable row level security;
alter table public.ai_usage_events enable row level security;
alter table public.ai_budget enable row level security;

revoke all on table public.ai_explanations from anon, authenticated;
revoke all on table public.ai_daily_usage from anon, authenticated;
revoke all on table public.ai_usage_events from anon, authenticated;
revoke all on table public.ai_budget from anon, authenticated;

-- Incrémente le compteur d'utilisation du cache ---------------------------
create or replace function public.ai_touch_explanation(p_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.ai_explanations set hits = hits + 1 where id = p_id;
$$;

-- Réservation atomique : unicité en vol + budget + débit + quota ----------
create or replace function public.ai_reserve_explain(
  p_actor text,
  p_daily_limit int,
  p_per_minute int,
  p_window_seconds int,
  p_estimated_usd numeric,
  p_month text,
  p_limit_usd numeric,
  p_suspend_usd numeric
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_spent numeric;
  v_used int;
  v_recent int;
  v_inflight int;
  v_event uuid;
begin
  -- Ligne budgétaire du mois, créée à la volée puis verrouillée : le verrou
  -- sérialise les requêtes simultanées et empêche tout dépassement.
  insert into public.ai_budget (month, limit_usd, suspend_usd, spent_usd)
    values (p_month, p_limit_usd, p_suspend_usd, 0)
    on conflict (month) do nothing;

  select spent_usd into v_spent
    from public.ai_budget where month = p_month for update;

  -- Une seule explication en vol par acteur (limite de concurrence).
  select count(*) into v_inflight
    from public.ai_usage_events
    where actor = p_actor and status = 'pending';
  if v_inflight > 0 then
    return jsonb_build_object('ok', false, 'reason', 'in_flight');
  end if;

  -- Budget : suspension avant la limite dure.
  if v_spent >= p_suspend_usd or v_spent + p_estimated_usd > p_limit_usd then
    return jsonb_build_object('ok', false, 'reason', 'budget');
  end if;

  -- Débit par minute (ignoré si p_per_minute <= 0).
  if p_per_minute > 0 then
    select count(*) into v_recent
      from public.ai_usage_events
      where actor = p_actor
        and created_at > now() - make_interval(secs => p_window_seconds);
    if v_recent >= p_per_minute then
      return jsonb_build_object('ok', false, 'reason', 'rate');
    end if;
  end if;

  -- Quota quotidien (ignoré si p_daily_limit <= 0).
  if p_daily_limit > 0 then
    insert into public.ai_daily_usage (actor, day, used)
      values (p_actor, v_day, 0)
      on conflict (actor, day) do nothing;

    select used into v_used
      from public.ai_daily_usage where actor = p_actor and day = v_day for update;

    if v_used >= p_daily_limit then
      return jsonb_build_object('ok', false, 'reason', 'quota');
    end if;

    update public.ai_daily_usage set used = used + 1
      where actor = p_actor and day = v_day;
  end if;

  insert into public.ai_usage_events (actor, status, reserved_usd)
    values (p_actor, 'pending', p_estimated_usd)
    returning id into v_event;

  update public.ai_budget
    set spent_usd = spent_usd + p_estimated_usd, updated_at = now()
    where month = p_month;

  return jsonb_build_object('ok', true, 'event_id', v_event);
end;
$$;

-- Finalisation : remplace la réservation par le coût réel -----------------
create or replace function public.ai_finalize_explain(p_event uuid, p_actual_usd numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reserved numeric;
  v_month text;
begin
  select e.reserved_usd, to_char(e.created_at at time zone 'utc', 'YYYY-MM')
    into v_reserved, v_month
    from public.ai_usage_events e
    where e.id = p_event and e.status = 'pending'
    for update;
  if not found then return; end if;

  update public.ai_usage_events
    set status = 'succeeded', actual_usd = p_actual_usd, finalized_at = now()
    where id = p_event;

  update public.ai_budget
    set spent_usd = greatest(0, spent_usd - v_reserved + p_actual_usd),
        updated_at = now()
    where month = v_month;
end;
$$;

-- Libération : rembourse la réservation (échec, timeout) ------------------
create or replace function public.ai_release_explain(p_event uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reserved numeric;
  v_month text;
begin
  select e.reserved_usd, to_char(e.created_at at time zone 'utc', 'YYYY-MM')
    into v_reserved, v_month
    from public.ai_usage_events e
    where e.id = p_event and e.status = 'pending'
    for update;
  if not found then return; end if;

  update public.ai_usage_events
    set status = 'released', finalized_at = now()
    where id = p_event;

  update public.ai_budget
    set spent_usd = greatest(0, spent_usd - v_reserved), updated_at = now()
    where month = v_month;
end;
$$;

-- Exécution réservée au serveur -------------------------------------------
revoke all on function public.ai_touch_explanation(uuid) from public, anon, authenticated;
revoke all on function public.ai_reserve_explain(text,int,int,int,numeric,text,numeric,numeric) from public, anon, authenticated;
revoke all on function public.ai_finalize_explain(uuid,numeric) from public, anon, authenticated;
revoke all on function public.ai_release_explain(uuid) from public, anon, authenticated;
