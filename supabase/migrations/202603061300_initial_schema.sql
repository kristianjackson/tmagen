create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists vector with schema extensions;

create type public.story_visibility as enum ('private', 'unlisted', 'public');
create type public.canon_mode as enum ('strict', 'adjacent', 'au');
create type public.cast_policy as enum ('none', 'cameo', 'full');
create type public.story_status as enum ('draft', 'published', 'archived');

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  handle text unique,
  display_name text not null,
  bio text,
  avatar_url text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint profiles_handle_format check (handle is null or handle ~ '^[a-z0-9_]{3,24}$')
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(coalesce(new.email, ''), '@', 1), 'Archivist')
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

create table public.fears (
  slug text primary key,
  name text not null unique,
  description text not null,
  sort_order smallint not null unique
);

create table public.episodes (
  id uuid primary key default gen_random_uuid(),
  episode_number integer not null unique,
  title text not null,
  slug text not null unique,
  source_filename text not null,
  storage_path text,
  transcript_text text not null,
  page_count integer,
  word_count integer,
  character_count integer,
  import_status text not null default 'pending',
  content_warnings text[] not null default '{}',
  primary_fear_slug text references public.fears(slug),
  secondary_fear_slugs text[] not null default '{}',
  generated_metadata jsonb not null default '{}'::jsonb,
  deterministic_metadata jsonb not null default '{}'::jsonb,
  summary text,
  hook text,
  search_vector tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(hook, '')), 'B')
  ) stored,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.episode_chunks (
  id uuid primary key default gen_random_uuid(),
  episode_id uuid not null references public.episodes(id) on delete cascade,
  chunk_index integer not null,
  token_estimate integer,
  content text not null,
  speaker_labels text[] not null default '{}',
  character_names text[] not null default '{}',
  fear_slugs text[] not null default '{}',
  embedding vector(1536),
  metadata jsonb not null default '{}'::jsonb,
  search_vector tsvector generated always as to_tsvector('english', coalesce(content, '')) stored,
  created_at timestamptz not null default timezone('utc', now()),
  unique (episode_id, chunk_index)
);

create table public.story_projects (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  slug text not null,
  summary text,
  seed_prompt text,
  canon_mode public.canon_mode not null default 'adjacent',
  cast_policy public.cast_policy not null default 'cameo',
  selected_fear_slugs text[] not null default '{}',
  visibility public.story_visibility not null default 'private',
  status public.story_status not null default 'draft',
  published_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (creator_id, slug)
);

create table public.story_versions (
  id uuid primary key default gen_random_uuid(),
  story_project_id uuid not null references public.story_projects(id) on delete cascade,
  parent_version_id uuid references public.story_versions(id) on delete set null,
  version_number integer not null,
  model_name text,
  system_prompt_version text,
  visibility public.story_visibility not null default 'private',
  published_at timestamptz,
  prompt_snapshot jsonb not null default '{}'::jsonb,
  retrieval_snapshot jsonb not null default '[]'::jsonb,
  generation_metadata jsonb not null default '{}'::jsonb,
  revision_notes text,
  content_markdown text not null,
  created_at timestamptz not null default timezone('utc', now()),
  unique (story_project_id, version_number)
);

create table public.story_feedback (
  id uuid primary key default gen_random_uuid(),
  story_project_id uuid not null references public.story_projects(id) on delete cascade,
  story_version_id uuid references public.story_versions(id) on delete set null,
  author_id uuid not null references auth.users(id) on delete cascade,
  feedback_text text not null,
  applied boolean not null default false,
  created_at timestamptz not null default timezone('utc', now())
);

create table public.story_episode_links (
  story_version_id uuid not null references public.story_versions(id) on delete cascade,
  episode_id uuid not null references public.episodes(id) on delete cascade,
  chunk_ids uuid[] not null default '{}',
  relevance_score double precision,
  usage_reason text,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (story_version_id, episode_id)
);

create index episodes_search_idx on public.episodes using gin (search_vector);
create index episode_chunks_search_idx on public.episode_chunks using gin (search_vector);
create index episode_chunks_episode_idx on public.episode_chunks (episode_id, chunk_index);
create index episode_chunks_embedding_idx
  on public.episode_chunks
  using hnsw (embedding vector_cosine_ops);
create index story_projects_public_idx on public.story_projects (visibility, published_at desc);
create index story_versions_project_idx on public.story_versions (story_project_id, version_number desc);
create index story_feedback_project_idx on public.story_feedback (story_project_id, created_at desc);

create or replace function public.match_episode_chunks(
  query_embedding vector(1536),
  match_count integer default 8,
  filter jsonb default '{}'::jsonb
)
returns table (
  id uuid,
  episode_id uuid,
  episode_number integer,
  episode_title text,
  chunk_index integer,
  content text,
  similarity double precision
)
language sql
stable
as $$
  select
    c.id,
    c.episode_id,
    e.episode_number,
    e.title,
    c.chunk_index,
    c.content,
    1 - (c.embedding <=> query_embedding) as similarity
  from public.episode_chunks c
  join public.episodes e on e.id = c.episode_id
  where c.embedding is not null
    and (
      not (filter ? 'episode_id')
      or c.episode_id = (filter ->> 'episode_id')::uuid
    )
    and (
      not (filter ? 'fear_slug')
      or (filter ->> 'fear_slug') = any (c.fear_slugs)
    )
  order by c.embedding <=> query_embedding
  limit greatest(match_count, 1);
$$;

insert into storage.buckets (id, name, public)
values ('episode-pdfs', 'episode-pdfs', false)
on conflict (id) do nothing;

insert into public.fears (slug, name, description, sort_order)
values
  ('the-eye', 'The Eye', 'Surveillance, knowledge, exposure, and the terror of being watched.', 1),
  ('the-web', 'The Web', 'Manipulation, control, puppetry, and unseen influence.', 2),
  ('the-spiral', 'The Spiral', 'Madness, distortion, confusion, and warped perception.', 3),
  ('the-stranger', 'The Stranger', 'The uncanny, false faces, replacement, and the not-quite-human.', 4),
  ('the-lonely', 'The Lonely', 'Isolation, abandonment, emotional distance, and solitude.', 5),
  ('the-buried', 'The Buried', 'Confinement, suffocation, pressure, and being trapped.', 6),
  ('the-slaughter', 'The Slaughter', 'War, violence, bloodshed, and senseless killing.', 7),
  ('the-flesh', 'The Flesh', 'Meat, bodily transformation, appetite, and consumption.', 8),
  ('the-corruption', 'The Corruption', 'Rot, infestation, sickness, and invasive decay.', 9),
  ('the-hunt', 'The Hunt', 'Predation, pursuit, prey instincts, and the thrill of the chase.', 10),
  ('the-dark', 'The Dark', 'Blindness, obscurity, unseen threats, and lightless spaces.', 11),
  ('the-vast', 'The Vast', 'Heights, scale, insignificance, and endless expanse.', 12),
  ('the-desolation', 'The Desolation', 'Fire, pain, loss, ruin, and cruel devastation.', 13),
  ('the-end', 'The End', 'Death, inevitability, and the certainty of endings.', 14),
  ('the-extinction', 'The Extinction', 'Civilizational collapse, replacement, and the fear of what comes after humanity.', 15)
on conflict (slug) do update
set
  name = excluded.name,
  description = excluded.description,
  sort_order = excluded.sort_order;

create trigger set_profiles_updated_at
before update on public.profiles
for each row
execute function public.set_updated_at();

create trigger set_episodes_updated_at
before update on public.episodes
for each row
execute function public.set_updated_at();

create trigger set_story_projects_updated_at
before update on public.story_projects
for each row
execute function public.set_updated_at();

create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.fears enable row level security;
alter table public.episodes enable row level security;
alter table public.episode_chunks enable row level security;
alter table public.story_projects enable row level security;
alter table public.story_versions enable row level security;
alter table public.story_feedback enable row level security;
alter table public.story_episode_links enable row level security;

create policy "profiles are publicly readable"
on public.profiles
for select
using (true);

create policy "users can insert their own profile"
on public.profiles
for insert
to authenticated
with check (auth.uid() = id);

create policy "users can update their own profile"
on public.profiles
for update
to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

create policy "fears are publicly readable"
on public.fears
for select
using (true);

create policy "owners can read their own story projects"
on public.story_projects
for select
using (auth.uid() = creator_id or visibility = 'public');

create policy "owners can create story projects"
on public.story_projects
for insert
to authenticated
with check (auth.uid() = creator_id);

create policy "owners can update their own story projects"
on public.story_projects
for update
to authenticated
using (auth.uid() = creator_id)
with check (auth.uid() = creator_id);

create policy "owners can delete their own story projects"
on public.story_projects
for delete
to authenticated
using (auth.uid() = creator_id);

create policy "story versions are readable to owners and public readers"
on public.story_versions
for select
using (
  exists (
    select 1
    from public.story_projects p
    where p.id = story_project_id
      and (
        p.creator_id = auth.uid()
        or (visibility = 'public' and p.visibility = 'public')
      )
  )
);

create policy "owners can create story versions"
on public.story_versions
for insert
to authenticated
with check (
  exists (
    select 1
    from public.story_projects p
    where p.id = story_project_id
      and p.creator_id = auth.uid()
  )
);

create policy "owners can update story versions"
on public.story_versions
for update
to authenticated
using (
  exists (
    select 1
    from public.story_projects p
    where p.id = story_project_id
      and p.creator_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.story_projects p
    where p.id = story_project_id
      and p.creator_id = auth.uid()
  )
);

create policy "owners can delete story versions"
on public.story_versions
for delete
to authenticated
using (
  exists (
    select 1
    from public.story_projects p
    where p.id = story_project_id
      and p.creator_id = auth.uid()
  )
);

create policy "owners can read story feedback"
on public.story_feedback
for select
using (
  exists (
    select 1
    from public.story_projects p
    where p.id = story_project_id
      and p.creator_id = auth.uid()
  )
);

create policy "owners can create story feedback"
on public.story_feedback
for insert
to authenticated
with check (
  auth.uid() = author_id
  and exists (
    select 1
    from public.story_projects p
    where p.id = story_project_id
      and p.creator_id = auth.uid()
  )
);

create policy "owners can update story feedback"
on public.story_feedback
for update
to authenticated
using (
  exists (
    select 1
    from public.story_projects p
    where p.id = story_project_id
      and p.creator_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.story_projects p
    where p.id = story_project_id
      and p.creator_id = auth.uid()
  )
);

create policy "owners can read provenance links"
on public.story_episode_links
for select
using (
  exists (
    select 1
    from public.story_versions v
    join public.story_projects p on p.id = v.story_project_id
    where v.id = story_version_id
      and (
        p.creator_id = auth.uid()
        or (v.visibility = 'public' and p.visibility = 'public')
      )
  )
);

create policy "owners can create provenance links"
on public.story_episode_links
for insert
to authenticated
with check (
  exists (
    select 1
    from public.story_versions v
    join public.story_projects p on p.id = v.story_project_id
    where v.id = story_version_id
      and p.creator_id = auth.uid()
  )
);
