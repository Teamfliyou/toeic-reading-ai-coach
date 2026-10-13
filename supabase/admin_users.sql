-- Lexora Admin: required before enabling the multi-user admin panel.
-- Execute once in the Supabase SQL editor. Never grant client access.
create extension if not exists pgcrypto;
create table if not exists public.lexora_admin_users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique check (username ~ '^[A-Za-z][A-Za-z0-9_.-]{2,31}$'),
  password_hash text not null,
  password_salt text not null,
  role text not null default 'editor' check (role in ('admin','editor')),
  active boolean not null default true,
  session_version integer not null default 0,
  created_at timestamptz not null default now()
);
alter table public.lexora_admin_users enable row level security;
revoke all on table public.lexora_admin_users from anon, authenticated;
-- No public RLS policies: only the server-side service_role can access this table.
