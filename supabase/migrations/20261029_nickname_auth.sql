-- Профили: уникальный никнейм без учёта регистра
create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  nickname text not null check (nickname ~ '^[A-Za-zА-Яа-яЁё0-9_-]{3,20}$'),
  created_at timestamptz not null default now()
);
create unique index profiles_nickname_lower_key on public.profiles (lower(nickname));
alter table public.profiles enable row level security;
create policy profiles_select_own on public.profiles for select to authenticated
  using (user_id = (select auth.uid()));

-- Служебные функции: доступны только серверной функции входа (service_role)
create function public.nickname_available(p_nickname text)
returns boolean language sql stable security definer set search_path = ''
as $$ select not exists (select 1 from public.profiles where lower(nickname) = lower(p_nickname)) $$;

create function public.email_for_nickname(p_nickname text)
returns text language sql stable security definer set search_path = ''
as $$
  select u.email::text from public.profiles p
  join auth.users u on u.id = p.user_id
  where lower(p.nickname) = lower(p_nickname)
  limit 1
$$;

revoke execute on function public.nickname_available(text) from public, anon, authenticated;
revoke execute on function public.email_for_nickname(text) from public, anon, authenticated;
grant execute on function public.nickname_available(text) to service_role;
grant execute on function public.email_for_nickname(text) to service_role;

-- При создании пользователя: профиль с никнеймом и личное рабочее пространство
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare wid uuid; nick text;
begin
  nick := new.raw_user_meta_data ->> 'nickname';
  if nick is null then
    raise exception 'nickname is required';
  end if;
  insert into public.profiles (user_id, nickname) values (new.id, nick);
  insert into public.workspaces (name) values ('Личное') returning id into wid;
  insert into public.workspace_members (workspace_id, user_id, role) values (wid, new.id, 'owner');
  return new;
end;
$$;
