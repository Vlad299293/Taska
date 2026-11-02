-- Итоговая схема (эквивалентна миграциям, применённым к проекту)

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Личное',
  created_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner','member')),
  primary key (workspace_id, user_id)
);
create index workspace_members_user_idx on public.workspace_members(user_id);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  estimate_min int not null check (estimate_min between 5 and 600 and estimate_min % 5 = 0),
  priority text not null default 'medium' check (priority in ('high','medium','low')),
  deadline date,
  description text,
  status text not null default 'backlog' check (status in ('backlog','in_progress','paused','done')),
  spent_min int not null default 0 check (spent_min >= 0),
  created_at timestamptz not null default now()
);
create index tasks_workspace_status_idx on public.tasks(workspace_id, status);

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  window_min int not null check (window_min between 30 and 720 and window_min % 5 = 0),
  started_at timestamptz not null default now(),
  ended_at timestamptz
);
create index sessions_workspace_idx on public.sessions(workspace_id);
create unique index sessions_one_active_per_user on public.sessions(user_id) where ended_at is null;

create table public.session_blocks (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  task_id uuid references public.tasks(id) on delete set null,
  position int not null,
  kind text not null check (kind in ('work','break')),
  planned_min int not null check (planned_min > 0),
  started_at timestamptz,
  ended_at timestamptz,
  unique (session_id, position)
);
create index session_blocks_task_idx on public.session_blocks(task_id);

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create function private.is_member(wid uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = wid and m.user_id = (select auth.uid())
  )
$$;
revoke execute on function private.is_member(uuid) from public, anon;
grant execute on function private.is_member(uuid) to authenticated;

create function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare wid uuid;
begin
  insert into public.workspaces (name) values ('Личное') returning id into wid;
  insert into public.workspace_members (workspace_id, user_id, role) values (wid, new.id, 'owner');
  return new;
end;
$$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.tasks enable row level security;
alter table public.sessions enable row level security;
alter table public.session_blocks enable row level security;

create policy workspaces_select on public.workspaces for select to authenticated using (private.is_member(id));
create policy workspaces_update on public.workspaces for update to authenticated using (private.is_member(id)) with check (private.is_member(id));
create policy members_select on public.workspace_members for select to authenticated using (private.is_member(workspace_id));
create policy tasks_all on public.tasks for all to authenticated using (private.is_member(workspace_id)) with check (private.is_member(workspace_id));
create policy sessions_select on public.sessions for select to authenticated using (private.is_member(workspace_id));
create policy sessions_insert on public.sessions for insert to authenticated with check (private.is_member(workspace_id) and user_id = (select auth.uid()));
create policy sessions_update on public.sessions for update to authenticated using (private.is_member(workspace_id) and user_id = (select auth.uid())) with check (private.is_member(workspace_id) and user_id = (select auth.uid()));
create policy sessions_delete on public.sessions for delete to authenticated using (private.is_member(workspace_id) and user_id = (select auth.uid()));
create policy blocks_all on public.session_blocks for all to authenticated
  using (exists (select 1 from public.sessions s where s.id = session_id and private.is_member(s.workspace_id)))
  with check (exists (select 1 from public.sessions s where s.id = session_id and private.is_member(s.workspace_id)));

alter publication supabase_realtime add table public.tasks, public.sessions, public.session_blocks;

-- Завершение рабочего блока: учёт потраченного времени, задача может перейти в «Готово»
create function public.complete_block(p_block_id uuid)
returns void language plpgsql security invoker set search_path = ''
as $$
declare b public.session_blocks;
begin
  update public.session_blocks set ended_at = now()
  where id = p_block_id and ended_at is null
  returning * into b;
  if found and b.kind = 'work' and b.task_id is not null then
    update public.tasks
    set spent_min = spent_min + b.planned_min,
        status = case when spent_min + b.planned_min >= estimate_min then 'done' else status end
    where id = b.task_id;
  end if;
end;
$$;

-- Завершение сессии: недоделанные задачи уходят в «Пауза» (если над ними работали) или в Backlog
create function public.finish_session(p_session_id uuid)
returns void language plpgsql security invoker set search_path = ''
as $$
declare wid uuid;
begin
  update public.sessions set ended_at = now()
  where id = p_session_id and ended_at is null
  returning workspace_id into wid;
  if wid is not null then
    update public.tasks
    set status = case when spent_min > 0 then 'paused' else 'backlog' end
    where workspace_id = wid and status = 'in_progress';
  end if;
end;
$$;

revoke execute on function public.complete_block(uuid) from public, anon;
revoke execute on function public.finish_session(uuid) from public, anon;
grant execute on function public.complete_block(uuid) to authenticated;
grant execute on function public.finish_session(uuid) to authenticated;
