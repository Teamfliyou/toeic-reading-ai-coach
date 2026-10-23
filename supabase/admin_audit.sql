-- Journal d'audit de l'administration + préparation de la MFA (TOTP).
-- À exécuter après admin_users.sql. Idempotent. Service_role uniquement.

create table if not exists public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  actor_id uuid,
  actor_username text,
  action text not null,
  target text,
  details jsonb not null default '{}'::jsonb,
  ip_hash text
);
create index if not exists idx_admin_audit_at on public.admin_audit_log (at desc);
create index if not exists idx_admin_audit_action on public.admin_audit_log (action, at desc);

alter table public.admin_audit_log enable row level security;
revoke all on table public.admin_audit_log from anon, authenticated;

-- Le journal est en ajout seul : on interdit la modification et la suppression,
-- même au service_role, tant que ce déclencheur est en place (à retirer pour purger).
create or replace function public.admin_audit_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'admin_audit_log est en ajout seul';
end;
$$;
drop trigger if exists trg_admin_audit_immutable on public.admin_audit_log;
create trigger trg_admin_audit_immutable
  before update or delete on public.admin_audit_log
  for each row execute function public.admin_audit_immutable();

-- Préparation MFA (non imposée, non utilisée par la connexion pour l'instant).
-- Voir docs/admin-mfa.md : le secret doit être chiffré côté serveur avant stockage.
alter table public.lexora_admin_users add column if not exists totp_secret_enc text;
alter table public.lexora_admin_users add column if not exists totp_enabled boolean not null default false;
alter table public.lexora_admin_users add column if not exists totp_recovery_hashes text[] not null default '{}';
