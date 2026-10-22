-- Durcissement IA + limitation distribuée de la connexion admin.
-- À exécuter APRÈS supabase/ai_explanations.sql et supabase/admin_users.sql.
-- Idempotent : peut être relancé sans risque.
--
-- Contenu :
--   * ai_usage_events : colonnes `day` / `counted_daily` (remboursement du quota) ;
--   * ai_reserve_explain : expire les réservations `pending` périmées (appel
--     serverless tué) sans rembourser le budget (prudence : l'appel a pu être
--     facturé), accepte aussi un quota pour les anonymes ;
--   * ai_release_explain : rembourse aussi le quota quotidien ;
--   * admin_login_attempts + admin_login_attempt/clear : fenêtre glissante par
--     IP et par identifiant, atomique, valable sur toutes les instances.
--
-- Sécurité : service_role uniquement (RLS activée, aucun droit anon/authenticated).

-- 1) Colonnes de suivi du quota quotidien -------------------------------------
alter table public.ai_usage_events add column if not exists day date;
alter table public.ai_usage_events add column if not exists counted_daily boolean not null default false;
create index if not exists idx_ai_usage_events_pending
  on public.ai_usage_events (created_at) where status = 'pending';

-- 2) Réservation : expiration des `pending` périmés ---------------------------
drop function if exists public.ai_reserve_explain(text,int,int,int,numeric,text,numeric,numeric);

create or replace function public.ai_reserve_explain(
  p_actor text,
  p_daily_limit int,
  p_per_minute int,
  p_window_seconds int,
  p_estimated_usd numeric,
  p_month text,
  p_limit_usd numeric,
  p_suspend_usd numeric,
  p_stale_seconds int default 120
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
  v_counted boolean := false;
begin
  insert into public.ai_budget (month, limit_usd, suspend_usd, spent_usd)
    values (p_month, p_limit_usd, p_suspend_usd, 0)
    on conflict (month) do nothing;

  -- Le verrou sur la ligne budgétaire sérialise les réservations simultanées.
  select spent_usd into v_spent
    from public.ai_budget where month = p_month for update;

  -- Réservations périmées (fonction tuée avant finalize/release) : marquées
  -- « failed ». Le budget réservé n'est PAS remboursé (l'appel a pu être facturé).
  update public.ai_usage_events
    set status = 'failed', finalized_at = now()
    where status = 'pending'
      and created_at < now() - make_interval(secs => greatest(p_stale_seconds, 30));

  select count(*) into v_inflight
    from public.ai_usage_events
    where actor = p_actor and status = 'pending';
  if v_inflight > 0 then
    return jsonb_build_object('ok', false, 'reason', 'in_flight');
  end if;

  if v_spent >= p_suspend_usd or v_spent + p_estimated_usd > p_limit_usd then
    return jsonb_build_object('ok', false, 'reason', 'budget');
  end if;

  if p_per_minute > 0 then
    select count(*) into v_recent
      from public.ai_usage_events
      where actor = p_actor
        and status in ('pending','succeeded')
        and created_at > now() - make_interval(secs => p_window_seconds);
    if v_recent >= p_per_minute then
      return jsonb_build_object('ok', false, 'reason', 'rate');
    end if;
  end if;

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
    v_counted := true;
  end if;

  insert into public.ai_usage_events (actor, status, reserved_usd, day, counted_daily)
    values (p_actor, 'pending', p_estimated_usd, v_day, v_counted)
    returning id into v_event;

  update public.ai_budget
    set spent_usd = spent_usd + p_estimated_usd, updated_at = now()
    where month = p_month;

  return jsonb_build_object('ok', true, 'event_id', v_event);
end;
$$;

-- 3) Libération : rembourse le budget ET le quota quotidien ---------------------
create or replace function public.ai_release_explain(p_event uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reserved numeric;
  v_month text;
  v_actor text;
  v_day date;
  v_counted boolean;
begin
  select e.reserved_usd, to_char(e.created_at at time zone 'utc', 'YYYY-MM'),
         e.actor, e.day, e.counted_daily
    into v_reserved, v_month, v_actor, v_day, v_counted
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

  if v_counted and v_day is not null then
    update public.ai_daily_usage set used = greatest(0, used - 1)
      where actor = v_actor and day = v_day;
  end if;
end;
$$;

-- 4) Limitation distribuée de la connexion admin ------------------------------
create table if not exists public.admin_login_attempts (
  id uuid primary key default gen_random_uuid(),
  ip text not null,
  username text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_admin_login_attempts_ip on public.admin_login_attempts (ip, created_at desc);
create index if not exists idx_admin_login_attempts_user on public.admin_login_attempts (username, created_at desc);

alter table public.admin_login_attempts enable row level security;
revoke all on table public.admin_login_attempts from anon, authenticated;

-- Enregistre une tentative et indique si elle est autorisée (fenêtre glissante
-- par IP et par identifiant). Une tentative réussie est retirée via
-- admin_login_clear : seuls les échecs comptent durablement.
create or replace function public.admin_login_attempt(
  p_ip text,
  p_username text,
  p_max_ip int,
  p_max_user int,
  p_window_seconds int
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_since timestamptz := now() - make_interval(secs => p_window_seconds);
  v_ip_count int;
  v_user_count int;
  v_oldest timestamptz;
  v_id uuid;
begin
  -- Sérialise les tentatives concurrentes sur la même IP / le même identifiant.
  perform pg_advisory_xact_lock(hashtext('admin_login_ip:' || p_ip));
  perform pg_advisory_xact_lock(hashtext('admin_login_user:' || p_username));

  delete from public.admin_login_attempts where created_at < now() - interval '1 day';

  select count(*), min(created_at) into v_ip_count, v_oldest
    from public.admin_login_attempts where ip = p_ip and created_at > v_since;
  select count(*) into v_user_count
    from public.admin_login_attempts where username = p_username and created_at > v_since;

  if v_ip_count >= p_max_ip or v_user_count >= p_max_user then
    return jsonb_build_object(
      'ok', false,
      'retry_after',
      greatest(1, ceil(extract(epoch from (coalesce(v_oldest, now()) + make_interval(secs => p_window_seconds) - now())))::int)
    );
  end if;

  insert into public.admin_login_attempts (ip, username) values (p_ip, p_username)
    returning id into v_id;
  return jsonb_build_object('ok', true, 'attempt_id', v_id);
end;
$$;

create or replace function public.admin_login_clear(p_attempt uuid)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.admin_login_attempts where id = p_attempt;
$$;

-- Exécution réservée au serveur -------------------------------------------
revoke all on function public.ai_reserve_explain(text,int,int,int,numeric,text,numeric,numeric,int) from public, anon, authenticated;
revoke all on function public.ai_release_explain(uuid) from public, anon, authenticated;
revoke all on function public.admin_login_attempt(text,text,int,int,int) from public, anon, authenticated;
revoke all on function public.admin_login_clear(uuid) from public, anon, authenticated;
