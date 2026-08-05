-- ReadTrack production schema (Postgres / Supabase).
-- Run this once in the Supabase SQL editor (Project -> SQL Editor -> New query)
-- before deploying. Safe to re-run: everything uses IF NOT EXISTS / OR REPLACE.
--
-- Design notes:
--   * Real users are Supabase Auth users (auth.users). "profiles" extends each
--     auth user with the app-specific fields (username, avatar, created_at)
--     that used to live on our own "users" table.
--   * A trigger auto-creates a profile row the moment someone signs up, using
--     the name/username passed in at signup (see auth.js / the frontend
--     signup call, which sends them as user metadata).
--   * All foreign keys that used to point at users.id now point at
--     profiles.id (a uuid matching auth.users.id).
--   * Our Express server connects with the postgres superuser (via
--     DATABASE_URL) and does its own authorization checks in code — it does
--     NOT rely on Postgres Row Level Security, because the browser never
--     talks to Postgres directly (only through our own authenticated API).

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  username text unique,
  avatar_seed text,
  created_at timestamptz not null default now()
);

create table if not exists books (
  id bigserial primary key,
  api_id text unique,
  isbn text,
  title text not null,
  authors text,
  cover_url text,
  pages integer,
  published_year integer,
  categories text,
  language text,
  description text,
  created_at timestamptz not null default now()
);

-- Safe to re-run against an already-created table.
alter table books add column if not exists description text;

create table if not exists user_books (
  id bigserial primary key,
  user_id uuid not null references profiles(id) on delete cascade,
  book_id bigint not null references books(id) on delete cascade,
  status text not null default 'por_leer' check (status in ('por_leer','leyendo','leido')),
  rating integer check (rating between 1 and 5),
  notes text,
  start_date date,
  end_date date,
  planned_start_date date,
  planned_end_date date,
  progress_percent integer not null default 0 check (progress_percent between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, book_id)
);

-- Safe to re-run against an already-created table (adds the column if this
-- schema was applied before progress_percent existed).
alter table user_books add column if not exists progress_percent integer not null default 0;
alter table user_books drop constraint if exists user_books_progress_percent_check;
alter table user_books add constraint user_books_progress_percent_check check (progress_percent between 0 and 100);

create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_user_books_updated_at on user_books;
create trigger trg_user_books_updated_at
before update on user_books
for each row execute function set_updated_at();

create table if not exists contacts (
  id bigserial primary key,
  user_id uuid not null references profiles(id) on delete cascade,
  contact_user_id uuid not null references profiles(id) on delete cascade,
  status text not null default 'pendiente' check (status in ('pendiente','aceptado')),
  created_at timestamptz not null default now(),
  unique (user_id, contact_user_id)
);

create table if not exists goals (
  id bigserial primary key,
  user_id uuid not null references profiles(id) on delete cascade,
  year integer not null,
  target_books integer not null default 0,
  monthly_target integer,
  unique (user_id, year)
);

create table if not exists invites (
  id bigserial primary key,
  code text unique not null,
  created_by uuid not null references profiles(id) on delete cascade,
  used_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  used_at timestamptz
);

create table if not exists book_clubs (
  id bigserial primary key,
  name text not null unique,
  description text,
  owner_user_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists club_members (
  id bigserial primary key,
  club_id bigint not null references book_clubs(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','member')),
  joined_at timestamptz not null default now(),
  unique (club_id, user_id)
);

create table if not exists club_books (
  id bigserial primary key,
  club_id bigint not null references book_clubs(id) on delete cascade,
  book_id bigint not null references books(id) on delete cascade,
  status text not null default 'upcoming' check (status in ('current','upcoming','done')),
  added_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists club_goals (
  id bigserial primary key,
  club_id bigint not null references book_clubs(id) on delete cascade,
  club_book_id bigint references club_books(id) on delete set null,
  description text not null,
  week_start date not null,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists club_goal_progress (
  id bigserial primary key,
  goal_id bigint not null references club_goals(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  completed_at timestamptz not null default now(),
  unique (goal_id, user_id)
);

-- One row per user per calendar day they made reading progress on some book
-- (see server.js PATCH /api/user-books/:id) — powers the daily reading
-- streak on the Home dashboard. unique(user_id, activity_date) means
-- updating progress multiple times in the same day only ever counts once.
create table if not exists reading_activity (
  id bigserial primary key,
  user_id uuid not null references profiles(id) on delete cascade,
  activity_date date not null,
  created_at timestamptz not null default now(),
  unique (user_id, activity_date)
);

-- Auto-create a profile row whenever someone signs up via Supabase Auth.
-- The frontend passes `name` and `username` as signup metadata; falls back
-- to the part of the email before "@" if no name was given.
create or replace function handle_new_user() returns trigger as $$
begin
  insert into public.profiles (id, name, username, avatar_seed)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data->>'username',
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function handle_new_user();
