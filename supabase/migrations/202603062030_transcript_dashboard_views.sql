create or replace view public.episode_usage_stats as
select
  e.id as episode_id,
  count(distinct l.story_version_id)::integer as story_version_count,
  count(distinct v.story_project_id)::integer as story_project_count,
  max(l.created_at) as last_used_at
from public.episodes e
left join public.story_episode_links l on l.episode_id = e.id
left join public.story_versions v on v.id = l.story_version_id
group by e.id;

create or replace view public.episode_story_references as
select
  e.id as episode_id,
  p.id as story_project_id,
  p.title as story_title,
  p.slug as story_slug,
  p.visibility as story_visibility,
  v.id as story_version_id,
  v.version_number,
  v.visibility as version_visibility,
  l.relevance_score,
  l.usage_reason,
  l.created_at as linked_at
from public.story_episode_links l
join public.episodes e on e.id = l.episode_id
join public.story_versions v on v.id = l.story_version_id
join public.story_projects p on p.id = v.story_project_id;
