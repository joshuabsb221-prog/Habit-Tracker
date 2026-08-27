-- Orbit — sync schema.
--
-- Run this once in the Supabase SQL editor (Dashboard → SQL Editor → New query → Run).
-- It creates one row per account holding the whole Orbit document, and fences every
-- row behind row-level security so an account can only ever touch its own.

create table if not exists public.orbit_state (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  doc        jsonb       not null default '{}'::jsonb,
  rev        bigint      not null default 1,
  updated_at timestamptz not null default now()
);

alter table public.orbit_state enable row level security;

-- Three narrow policies rather than one broad one, so a mistake in any single
-- statement cannot widen the others.
drop policy if exists "orbit_state read own"   on public.orbit_state;
drop policy if exists "orbit_state insert own" on public.orbit_state;
drop policy if exists "orbit_state update own" on public.orbit_state;

create policy "orbit_state read own"
  on public.orbit_state for select
  using (auth.uid() = user_id);

create policy "orbit_state insert own"
  on public.orbit_state for insert
  with check (auth.uid() = user_id);

create policy "orbit_state update own"
  on public.orbit_state for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Keep updated_at honest, and stop a client from rewriting history by replaying an
-- old revision: rev must move forward. The app already does compare-and-set on rev,
-- so a device that lost a race retries against the newer row instead of clobbering it.
create or replace function public.orbit_state_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' and new.rev <= old.rev then
    raise exception 'stale revision % (current %)', new.rev, old.rev using errcode = '40001';
  end if;
  return new;
end;
$$;

drop trigger if exists orbit_state_touch on public.orbit_state;
create trigger orbit_state_touch
  before insert or update on public.orbit_state
  for each row execute function public.orbit_state_touch();
