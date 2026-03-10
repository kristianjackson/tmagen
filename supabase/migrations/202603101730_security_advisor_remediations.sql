alter function public.set_updated_at()
set search_path = public;

alter function public.match_episode_chunks(vector, integer, jsonb)
set search_path = public, extensions;

alter view public.episode_usage_stats
set (security_invoker = true);

alter view public.episode_story_references
set (security_invoker = true);

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'episodes'
      and policyname = 'episodes are explicitly server only'
  ) then
    create policy "episodes are explicitly server only"
    on public.episodes
    for all
    to anon, authenticated
    using (false)
    with check (false);
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'episode_chunks'
      and policyname = 'episode chunks are explicitly server only'
  ) then
    create policy "episode chunks are explicitly server only"
    on public.episode_chunks
    for all
    to anon, authenticated
    using (false)
    with check (false);
  end if;
end
$$;
