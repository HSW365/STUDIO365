-- Run in Supabase SQL editor.
create extension if not exists "uuid-ossp";
create table if not exists profiles(id uuid primary key references auth.users(id) on delete cascade,display_name text,artist_name text,role_tags text[] default '{}',bio text,avatar_url text,created_at timestamptz default now());
create table if not exists subscriptions(user_id uuid primary key references auth.users(id) on delete cascade,stripe_customer_id text,stripe_sub_id text,status text, current_period_end timestamptz,plan text default 'pro');
create table if not exists projects(id uuid primary key default uuid_generate_v4(),owner_id uuid references auth.users(id) on delete cascade,title text not null,bpm int,key text,cover_url text,created_at timestamptz default now());
create table if not exists tracks(id uuid primary key default uuid_generate_v4(),project_id uuid references projects(id) on delete cascade,owner_id uuid references auth.users(id) on delete cascade,title text,wav_url text,mp3_url text,lufs numeric,status text,created_at timestamptz default now());
create table if not exists releases(id uuid primary key default uuid_generate_v4(),track_id uuid references tracks(id) on delete set null,owner_id uuid references auth.users(id) on delete cascade,metadata jsonb not null default '{}',distributor_ref text,status text default 'pending',submitted_at timestamptz);
create table if not exists rooms(id uuid primary key default uuid_generate_v4(),project_id uuid references projects(id) on delete cascade,name text,created_at timestamptz default now());
create table if not exists room_members(room_id uuid references rooms(id) on delete cascade,user_id uuid references auth.users(id) on delete cascade,primary key(room_id,user_id));
create table if not exists messages(id uuid primary key default uuid_generate_v4(),room_id uuid references rooms(id) on delete cascade,sender_id uuid references auth.users(id) on delete cascade,body text not null,created_at timestamptz default now());

alter table profiles enable row level security;alter table subscriptions enable row level security;alter table projects enable row level security;alter table tracks enable row level security;alter table releases enable row level security;alter table rooms enable row level security;alter table room_members enable row level security;alter table messages enable row level security;
drop policy if exists profiles_self on profiles;create policy profiles_self on profiles for all using(id=auth.uid()) with check(id=auth.uid());
drop policy if exists profiles_directory on profiles;create policy profiles_directory on profiles for select using(auth.uid() is not null);
drop policy if exists subs_self on subscriptions;create policy subs_self on subscriptions for select using(user_id=auth.uid());
drop policy if exists projects_self on projects;create policy projects_self on projects for all using(owner_id=auth.uid()) with check(owner_id=auth.uid());
drop policy if exists tracks_self on tracks;create policy tracks_self on tracks for all using(owner_id=auth.uid()) with check(owner_id=auth.uid());
drop policy if exists releases_self on releases;create policy releases_self on releases for all using(owner_id=auth.uid()) with check(owner_id=auth.uid());
drop policy if exists rooms_member_read on rooms;create policy rooms_member_read on rooms for select using(exists(select 1 from room_members rm where rm.room_id=id and rm.user_id=auth.uid()));
drop policy if exists rooms_owner_write on rooms;create policy rooms_owner_write on rooms for all using(exists(select 1 from projects p where p.id=project_id and p.owner_id=auth.uid())) with check(exists(select 1 from projects p where p.id=project_id and p.owner_id=auth.uid()));
drop policy if exists room_members_member on room_members;create policy room_members_member on room_members for all using(user_id=auth.uid() or exists(select 1 from rooms r join projects p on p.id=r.project_id where r.id=room_id and p.owner_id=auth.uid())) with check(user_id=auth.uid() or exists(select 1 from rooms r join projects p on p.id=r.project_id where r.id=room_id and p.owner_id=auth.uid()));
drop policy if exists messages_member on messages;create policy messages_member on messages for all using(exists(select 1 from room_members rm where rm.room_id=room_id and rm.user_id=auth.uid())) with check(sender_id=auth.uid() and exists(select 1 from room_members rm where rm.room_id=room_id and rm.user_id=auth.uid()));

alter publication supabase_realtime add table messages;

-- Create private storage buckets named masters and covers in the dashboard.
-- For production, add storage policies limiting paths to auth.uid() and do not make masters public.

-- STUDIO365 Pro early-access list (used by the landing page form).
-- Anyone can add their email; nobody can read the list through the public API.
create table if not exists studio365_waitlist(
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]{2,}$' and length(email) <= 254),
  source text default 'landing' check (length(source) <= 40),
  created_at timestamptz not null default now()
);
alter table studio365_waitlist enable row level security;
drop policy if exists waitlist_insert on studio365_waitlist;
create policy waitlist_insert on studio365_waitlist for insert to anon, authenticated with check (true);

-- STUDIO365 Pro payment notices (optional; used by the "I paid. Send my key" button).
-- Visitors can add a row; nobody can read the table through the public API. Read it in the dashboard.
create table if not exists studio365_pro_requests(
  id uuid primary key default gen_random_uuid(),
  email text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]{2,}$' and length(email) <= 254),
  cashtag text check (length(cashtag) <= 24),
  amount numeric check (amount >= 0 and amount <= 1000),
  created_at timestamptz not null default now()
);
alter table studio365_pro_requests enable row level security;
drop policy if exists pro_requests_insert on studio365_pro_requests;
create policy pro_requests_insert on studio365_pro_requests for insert to anon, authenticated with check (true);
