create extension if not exists pgcrypto;
create schema if not exists private;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  role text not null default 'viewer' check (role in ('admin','viewer')),
  created_at timestamptz not null default now()
);

create table if not exists public.brands (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  short_name text not null default '',
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.meta_connections (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  ad_account_id text not null,
  ad_account_name text not null,
  encrypted_access_token text not null,
  token_expires_at timestamptz,
  connected_by uuid references auth.users(id),
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  unique (brand_id, ad_account_id)
);

create table if not exists public.meta_oauth_pending (
  state_id text primary key,
  brand_id uuid not null references public.brands(id) on delete cascade,
  connected_by uuid not null references auth.users(id),
  encrypted_access_token text not null,
  token_expires_at timestamptz,
  accounts jsonb not null,
  expires_at timestamptz not null
);

create table if not exists public.daily_metrics (
  id bigint generated always as identity primary key,
  brand_id uuid not null references public.brands(id) on delete cascade,
  connection_id uuid not null references public.meta_connections(id) on delete cascade,
  day date not null,
  spend numeric(14,2) not null default 0,
  impressions bigint not null default 0,
  link_clicks bigint not null default 0,
  reach bigint not null default 0,
  inline_link_clicks bigint not null default 0,
  raw_actions jsonb not null default '[]'::jsonb,
  fetched_at timestamptz not null default now(),
  unique(connection_id, day)
);
create index if not exists daily_metrics_brand_day_idx on public.daily_metrics(brand_id, day desc);

alter table public.profiles enable row level security;
alter table public.brands enable row level security;
alter table public.meta_connections enable row level security;
alter table public.meta_oauth_pending enable row level security;
alter table public.daily_metrics enable row level security;

create policy "admins read own profile" on public.profiles for select to authenticated using (id = auth.uid());
create policy "admins manage brands" on public.brands for all to authenticated using (exists(select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')) with check (exists(select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));
create policy "admins manage meta connections" on public.meta_connections for all to authenticated using (exists(select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')) with check (exists(select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));
create policy "admins read metrics" on public.daily_metrics for select to authenticated using (exists(select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

create or replace function private.create_profile_for_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id, display_name, role) values (new.id, coalesce(new.raw_user_meta_data->>'name', new.email, new.phone), 'viewer');
  return new;
end;
$$;
drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile after insert on auth.users for each row execute procedure private.create_profile_for_new_user();

-- Promote the trusted owner account manually in Supabase SQL Editor after registration:
-- update public.profiles set role='admin' where id=(select id from auth.users where email='YOUR_ADMIN_EMAIL');
