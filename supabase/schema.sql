-- ============================================================
-- Bren & Gabo · esquema de base de datos y seguridad (Supabase)
-- Pegar completo en Supabase → SQL Editor → Run.
-- Reemplazar los dos mails de la sección 1 antes de correrlo.
-- ============================================================

-- 1) Quiénes pueden entrar (solo estos dos mails)
create table if not exists public.allowed (
  email text primary key,
  role  text not null check (role in ('gabo','brenda'))
);
alter table public.allowed enable row level security;
insert into public.allowed(email, role) values
  ('MAIL_DE_GABO',  'gabo'),
  ('MAIL_DE_BREN',  'brenda')
on conflict (email) do update set role = excluded.role;

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.allowed where email = lower(coalesce(auth.jwt()->>'email',''))
$$;
grant execute on function public.my_role() to authenticated;

-- 2) Documentos (misma forma que la app: colección + id + datos)
create table if not exists public.docs (
  col        text not null,
  id         text not null,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (col, id)
);
alter table public.docs enable row level security;
alter table public.docs replica identity full;

drop policy if exists docs_select on public.docs;
drop policy if exists docs_insert on public.docs;
drop policy if exists docs_update on public.docs;
drop policy if exists docs_delete on public.docs;
create policy docs_select on public.docs for select to authenticated using (public.my_role() is not null);
create policy docs_insert on public.docs for insert to authenticated with check (public.my_role() is not null);
create policy docs_update on public.docs for update to authenticated using (public.my_role() is not null) with check (public.my_role() is not null);
create policy docs_delete on public.docs for delete to authenticated using (public.my_role() is not null);

-- mezcla profunda de objetos (igual que "update" de la app)
create or replace function public.jsonb_deep_merge(a jsonb, b jsonb) returns jsonb
language plpgsql immutable as $$
declare k text; v jsonb; r jsonb;
begin
  if a is null or jsonb_typeof(a) <> 'object' or jsonb_typeof(b) <> 'object' then return b; end if;
  r := a;
  for k, v in select * from jsonb_each(b) loop
    if r ? k and jsonb_typeof(r->k) = 'object' and jsonb_typeof(v) = 'object' then
      r := jsonb_set(r, array[k], public.jsonb_deep_merge(r->k, v));
    else
      r := jsonb_set(r, array[k], v);
    end if;
  end loop;
  return r;
end $$;

create or replace function public.doc_update(p_col text, p_id text, p_data jsonb) returns void
language plpgsql security invoker set search_path = public as $$
begin
  update public.docs set data = public.jsonb_deep_merge(data, p_data), updated_at = now()
   where col = p_col and id = p_id;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
end $$;
grant execute on function public.doc_update(text,text,jsonb) to authenticated;

-- 3) Reglas de Bren (las aplica la base, no solo la pantalla)
create or replace function public.climax_ids(d jsonb) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_agg(c->>'id' order by c->>'id'), '[]'::jsonb)
  from jsonb_array_elements(coalesce(d->'chapters','[]'::jsonb)) c
  where coalesce((c->>'climax')::boolean, false)
$$;

create or replace function public.strip_seen(r jsonb) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_object_agg(k, case when jsonb_typeof(v)='object' then v - 'seen' else v end), '{}'::jsonb)
  from jsonb_each(coalesce(r,'{}'::jsonb)) as t(k, v)
$$;

create or replace function public.guard_docs() returns trigger
language plpgsql security definer set search_path = public as $$
declare role text := public.my_role(); k text;
  bren_settings text[] := array['nameB','bdayB','photoB','photo','coverMode','seen','quiz','release'];
begin
  if role is null then raise exception 'sin_permiso'; end if;
  if role = 'gabo' then return coalesce(new, old); end if;

  -- Bren: borrar solo lo suyo; nunca temporadas ni ajustes
  if tg_op = 'DELETE' then
    if old.col in ('seasons','meta','games') then raise exception 'sin_permiso'; end if;
    if old.col in ('posts','plans','letters','dates','invites') and coalesce(old.data->>'by','') <> 'brenda' then raise exception 'sin_permiso'; end if;
    return old;
  end if;

  if new.col = 'meta' then
    if new.id <> 'settings' then raise exception 'sin_permiso'; end if;
    if tg_op = 'INSERT' then raise exception 'sin_permiso'; end if;
    for k in select key from jsonb_each(new.data) union select key from jsonb_each(old.data) loop
      if (new.data->k) is distinct from (old.data->k) and not (k = any(bren_settings)) then raise exception 'sin_permiso: %', k; end if;
    end loop;
    if public.strip_seen(new.data->'release') is distinct from public.strip_seen(old.data->'release') then raise exception 'sin_permiso: release'; end if;
    if (new.data->'quiz'->'gabo') is distinct from (old.data->'quiz'->'gabo') then raise exception 'sin_permiso: quiz'; end if;
    return new;
  end if;

  if new.col = 'seasons' then
    if public.climax_ids(new.data) <> (case when tg_op='UPDATE' then public.climax_ids(old.data) else '[]'::jsonb end) then raise exception 'sin_permiso: climax'; end if;
    return new;
  end if;

  if new.col = 'games' then
    if new.id = 'ruleta' then
      if (coalesce(new.data->'lists','{}'::jsonb) - 'custom-brenda') is distinct from (case when tg_op='UPDATE' then coalesce(old.data->'lists','{}'::jsonb) - 'custom-brenda' else '{}'::jsonb end) then raise exception 'sin_permiso: ruleta'; end if;
    elsif new.id = 'estoaquello' then
      if (new.data->'extra') is distinct from (case when tg_op='UPDATE' then old.data->'extra' else null end) then raise exception 'sin_permiso: preguntas'; end if;
    end if;
    return new;
  end if;

  return new;
end $$;

drop trigger if exists guard_docs on public.docs;
create trigger guard_docs before insert or update or delete on public.docs
for each row execute function public.guard_docs();

-- tiempo real
do $$ begin
  begin alter publication supabase_realtime add table public.docs; exception when duplicate_object then null; end;
end $$;

-- 4) Fotos y videos (privados)
insert into storage.buckets (id, name, public, file_size_limit)
values ('media', 'media', false, 52428800)
on conflict (id) do update set public = false;

drop policy if exists media_read on storage.objects;
drop policy if exists media_insert on storage.objects;
drop policy if exists media_delete on storage.objects;
create policy media_read   on storage.objects for select to authenticated using (bucket_id = 'media' and public.my_role() is not null);
create policy media_insert on storage.objects for insert to authenticated with check (bucket_id = 'media' and public.my_role() is not null);
create policy media_delete on storage.objects for delete to authenticated using (bucket_id = 'media' and public.my_role() = 'gabo');

-- 5) Suscripciones a notificaciones
create table if not exists public.push_subs (
  endpoint   text primary key,
  role       text not null,
  sub        jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.push_subs enable row level security;
drop policy if exists push_own on public.push_subs;
create policy push_own on public.push_subs for all to authenticated
  using (role = public.my_role()) with check (role = public.my_role());
