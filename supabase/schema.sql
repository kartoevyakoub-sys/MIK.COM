-- ============================================================
-- MIK.COM — схема Supabase
-- Выполнить весь файл один раз в SQL Editor (Supabase Dashboard)
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- profiles
-- ------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  role text not null default 'user' check (role in ('user', 'admin')),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Вспомогательная функция: роль admin определяется ТОЛЬКО здесь
-- и на сервере (через RLS). Клиент доверять не должен.
-- Должна создаваться ПОСЛЕ таблицы profiles: PostgreSQL проверяет
-- тело SQL-функции прямо при создании.
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $fn$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$fn$;

drop policy if exists "profiles_select_auth" on public.profiles;
create policy "profiles_select_auth" on public.profiles
  for select to authenticated using (true);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles
  for insert to authenticated with check (auth.uid() = id);

-- Пользователь может менять только свой профиль. Сменить себе роль нельзя:
-- это решает не политика, а триггер (в политиках нельзя ссылаться на OLD/NEW,
-- поэтому сравниваем роли прямо в BEFORE UPDATE триггере).
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

create or replace function public.prevent_profile_role_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  -- Блокируем смену роли ТОЛЬКО для обычных пользователей (authenticated).
  -- Service_role (и SQL Editor) могут менять роль — это нужно для назначения admin.
  if new.role is distinct from old.role
     and current_setting('request.jwt.claims', true) <> ''
     and (current_setting('request.jwt.claims', true))::jsonb ->> 'role' = 'authenticated' then
    raise exception 'Сменить роль профиля нельзя.';
  end if;
  return new;
end;
$fn$;

drop trigger if exists prevent_profile_role_change on public.profiles;
create trigger prevent_profile_role_change
  before update on public.profiles
  for each row execute function public.prevent_profile_role_change();

-- Автосоздание профиля при регистрации.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  insert into public.profiles (id, email, display_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    'user'
  )
  on conflict (id) do nothing;
  return new;
end;
$fn$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Бэкафилл: если аккаунты появились до выполнения схемы, строка профиля уже не
-- создастся триггером — добавляем её сейчас (безопасно, on conflict).
insert into public.profiles (id, email, display_name, role)
select u.id, u.email,
       coalesce(u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1)),
       'user'
from auth.users u
on conflict (id) do nothing;

-- ------------------------------------------------------------
-- materials (все видят, автор добавляет, автор+admin правят/удаляют)
-- ------------------------------------------------------------
create table if not exists public.materials (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade default auth.uid(),
  title text not null,
  description text not null default '',
  subject text,
  file_url text,
  file_name text,
  file_type text,
  preview_url text,
  url text,
  size bigint,
  created_at timestamptz not null default now()
);

alter table public.materials enable row level security;

drop policy if exists "materials_select_auth" on public.materials;
create policy "materials_select_auth" on public.materials
  for select to authenticated using (true);

drop policy if exists "materials_insert_auth" on public.materials;
create policy "materials_insert_auth" on public.materials
  for insert to authenticated with check (author_id = auth.uid());

drop policy if exists "materials_update_author_or_admin" on public.materials;
create policy "materials_update_author_or_admin" on public.materials
  for update to authenticated
  using (author_id = auth.uid() or public.is_admin())
  with check (author_id = auth.uid() or public.is_admin());

drop policy if exists "materials_delete_author_or_admin" on public.materials;
create policy "materials_delete_author_or_admin" on public.materials
  for delete to authenticated
  using (author_id = auth.uid() or public.is_admin());

-- ------------------------------------------------------------
-- exams — append-only: только добавление, без edit/delete истории
-- ------------------------------------------------------------
create table if not exists public.exams (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade default auth.uid(),
  title text not null,
  description text not null default '',
  file_url text,
  file_name text,
  file_type text,
  size bigint,
  created_at timestamptz not null default now()
);

alter table public.exams enable row level security;

drop policy if exists "exams_select_auth" on public.exams;
create policy "exams_select_auth" on public.exams
  for select to authenticated using (true);

drop policy if exists "exams_insert_auth" on public.exams;
create policy "exams_insert_auth" on public.exams
  for insert to authenticated with check (author_id = auth.uid());

-- Намеренно НЕТ update политик: история экзаменов не редактируется.
-- Оставить возможность только админу удалить ошибочную запись.
drop policy if exists "exams_delete_admin" on public.exams;
create policy "exams_delete_admin" on public.exams
  for delete to authenticated
  using (public.is_admin());

-- ------------------------------------------------------------
-- schedule — одна строка, храним прежнюю структуру расписания
-- целиком в jsonb (weeks → days → lessons). Админ заменяет data.
-- ------------------------------------------------------------
create table if not exists public.schedule (
  id integer primary key check (id = 1),
  data jsonb not null,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);

alter table public.schedule enable row level security;

drop policy if exists "schedule_select_auth" on public.schedule;
create policy "schedule_select_auth" on public.schedule
  for select to authenticated using (true);

drop policy if exists "schedule_write_admin" on public.schedule;
create policy "schedule_write_admin" on public.schedule
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Начальное расписание — ровно текущее содержимое schedule.json.
insert into public.schedule (id, data)
values (1, '{
  "weeks": [
    {
      "weekNumber": 1,
      "days": [
        {
          "name": "ПОНЕДЕЛЬНИК",
          "lessons": [
            { "number": "1", "subject": "Молекулярная физика", "type": "Лекция", "teacher": "Торшхоева З.С.", "room": "117" },
            { "number": "2", "subject": "Молекулярная физика", "type": "Практика", "teacher": "Матиев А.Х.", "room": "05" },
            { "number": "3", "subject": "Русский язык и культура речи", "type": "Лекция", "teacher": "Хашиева Х.А.", "room": "(3D)304" },
            { "number": "4", "subject": "Молекулярная физика", "type": "Практика", "teacher": "Матиев А.Х.", "room": "05" }
          ]
        },
        {
          "name": "ВТОРНИК",
          "lessons": [
            { "number": "1", "subject": "Математический анализ", "type": "Лекция", "teacher": "Цурова Ф.Д.", "room": "115" },
            { "number": "2", "subject": "Аналит.геометрия", "type": "Лекция", "teacher": "Оздоева Е.В.", "room": "117" },
            { "number": "3", "subject": "Аналит.геометрия", "type": "Практика", "teacher": "Оздоева Е.В.", "room": "306" },
            { "number": "4", "subject": "Аналит.геометрия", "type": "Практика", "teacher": "Оздоева Е.В.", "room": "306" }
          ]
        },
        {
          "name": "СРЕДА",
          "lessons": [
            { "number": "1", "subject": "История России", "type": "Лекция", "teacher": "Тутаева Л.О.", "room": "(3D)314" },
            { "number": "2", "subject": "Иностранный язык", "type": "Лекция", "teacher": "Хашиева А.С.", "room": "(3D)319" },
            { "number": "3", "subject": "Математический анализ", "type": "Практика", "teacher": "Цурова Ф.Д.", "room": "108" },
            { "number": "4", "subject": "Молекулярная физика", "type": "Практика", "teacher": "Дудргов М.М.", "room": "305" }
          ]
        },
        {
          "name": "ЧЕТВЕРГ",
          "lessons": [
            { "number": "1", "subject": "История Ингушетии", "type": "Лекция", "teacher": "Аушев А.Б.", "room": "(3D)314" },
            { "number": "2", "subject": "Молекулярная физика", "type": "Практика", "teacher": "Дудргов М.М.", "room": "305" },
            { "number": "3", "subject": "История Ингушетии", "type": "Практика", "teacher": "Хамчиев М.И.", "room": "301" },
            { "number": "4", "subject": "Русский язык и культура речи", "type": "Практика", "teacher": "Гелисханова М.М.", "room": "117" }
          ]
        },
        {
          "name": "ПЯТНИЦА",
          "lessons": [
            { "number": "1", "subject": "Молекулярная физика", "type": "Лекция", "teacher": "Торшхоева З.С.", "room": "117" },
            { "number": "2", "subject": "Молекулярная физика", "type": "Лекция", "teacher": "Торшхоева З.С.", "room": "117" }
          ]
        },
        {
          "name": "СУББОТА",
          "lessons": [
            { "number": "1", "subject": "Молекулярная физика", "type": "Практика", "teacher": "Дудргов М.М.", "room": "03" },
            { "number": "2", "subject": "Молекулярная физика", "type": "Практика", "teacher": "Дудргов М.М.", "room": "03" }
          ]
        }
      ]
    },
    {
      "weekNumber": 2,
      "days": [
        {
          "name": "ПОНЕДЕЛЬНИК",
          "lessons": [
            { "number": "1", "subject": "Молекулярная физика", "type": "Лекция", "teacher": "Торшхоева З.С.", "room": "117" },
            { "number": "2", "subject": "Молекулярная физика", "type": "Практика", "teacher": "Матиев А.Х.", "room": "05" },
            { "number": "3", "subject": "История России", "type": "Практика", "teacher": "Тутаева Л.О.", "room": "(3D)209" },
            { "number": "4", "subject": "Молекулярная физика", "type": "Практика", "teacher": "Матиев А.Х.", "room": "05" }
          ]
        },
        {
          "name": "ВТОРНИК",
          "lessons": [
            { "number": "1", "subject": "Математический анализ", "type": "Лекция", "teacher": "Цурова Ф.Д.", "room": "115" },
            { "number": "2", "subject": "Аналит.геометрия", "type": "Лекция", "teacher": "Оздоева Е.В.", "room": "117" },
            { "number": "3", "subject": "Молекулярная физика", "type": "Практика", "teacher": "Матиев А.Х.", "room": "05" },
            { "number": "4", "subject": "Молекулярная физика", "type": "Практика", "teacher": "Матиев А.Х.", "room": "05" }
          ]
        },
        {
          "name": "СРЕДА",
          "lessons": [
            { "number": "1", "subject": "История России", "type": "Лекция", "teacher": "Тутаева Л.О.", "room": "(3D)314" },
            { "number": "2", "subject": "Иностранный язык", "type": "Лекция", "teacher": "Муталиева З.М.", "room": "(3D)319" },
            { "number": "3", "subject": "Математический анализ", "type": "Практика", "teacher": "Цурова Ф.Д.", "room": "108" },
            { "number": "4", "subject": "Иностранный язык", "type": "Лекция", "teacher": "Муталиева З.М.", "room": "(3D)319" }
          ]
        },
        {
          "name": "ЧЕТВЕРГ",
          "lessons": [
            { "number": "1", "subject": "Физ.культура", "type": "Футбол/Волейбол", "teacher": "Погоров Б.А.", "room": "Спортзал" }
          ]
        },
        {
          "name": "ПЯТНИЦА",
          "lessons": [
            { "number": "1", "subject": "Молекулярная физика", "type": "Лекция", "teacher": "Торшхоева З.С.", "room": "117" },
            { "number": "2", "subject": "Молекулярная физика", "type": "Лекция", "teacher": "Торшхоева З.С.", "room": "117" }
          ]
        },
        {
          "name": "СУББОТА",
          "lessons": [
            { "number": "1", "subject": "Молекулярная физика", "type": "Практика", "teacher": "Дудргов М.М.", "room": "03" },
            { "number": "2", "subject": "Молекулярная физика", "type": "Практика", "teacher": "Дудргов М.М.", "room": "03" }
          ]
        }
      ]
    }
  ]
}'::jsonb)
on conflict (id) do nothing;

-- ------------------------------------------------------------
-- Storage: бакет 'files' (public read), запись/удаление по правам
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('files', 'files', true)
on conflict (id) do nothing;

drop policy if exists "files_select_auth" on storage.objects;
create policy "files_select_auth" on storage.objects
  for select to authenticated using (bucket_id = 'files');

drop policy if exists "files_insert_own" on storage.objects;
create policy "files_insert_own" on storage.objects
  for insert to authenticated with check (bucket_id = 'files' and owner = auth.uid());

drop policy if exists "files_update_owner_or_admin" on storage.objects;
create policy "files_update_owner_or_admin" on storage.objects
  for update to authenticated using (bucket_id = 'files' and (owner = auth.uid() or public.is_admin()));

drop policy if exists "files_delete_owner_or_admin" on storage.objects;
create policy "files_delete_owner_or_admin" on storage.objects
  for delete to authenticated using (bucket_id = 'files' and (owner = auth.uid() or public.is_admin()));