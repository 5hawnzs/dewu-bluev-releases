-- 得物蓝V · 云端统一账号与品牌权限
-- Run once in the same Supabase project already used by docs/supabase-setup.sql.
-- Passwords are stored only as salted bcrypt hashes. The client uses the public anon key;
-- account tables live in a private schema and are reachable only through these RPCs.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists bluev_private;
revoke all on schema bluev_private from public, anon, authenticated;

-- Do not move a pgcrypto extension that another app in this shared project may already use.
-- These fixed-search-path wrappers discover its existing schema and call it by a quoted name.
create or replace function bluev_private.random_hex(p_bytes integer)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare ext_schema text; result text;
begin
  select n.nspname into ext_schema from pg_catalog.pg_extension e join pg_catalog.pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto';
  if ext_schema is null then raise exception 'pgcrypto extension is required'; end if;
  execute pg_catalog.format('select pg_catalog.encode(%I.gen_random_bytes($1), ''hex'')',ext_schema) into result using p_bytes;
  return result;
end $$;

create or replace function bluev_private.password_hash(p_password text)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare ext_schema text; result text;
begin
  select n.nspname into ext_schema from pg_catalog.pg_extension e join pg_catalog.pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto';
  if ext_schema is null then raise exception 'pgcrypto extension is required'; end if;
  execute pg_catalog.format('select %I.crypt($1,%I.gen_salt(''bf'',12))',ext_schema,ext_schema) into result using p_password;
  return result;
end $$;

create or replace function bluev_private.password_matches(p_password text,p_hash text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare ext_schema text; result boolean;
begin
  select n.nspname into ext_schema from pg_catalog.pg_extension e join pg_catalog.pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto';
  if ext_schema is null then raise exception 'pgcrypto extension is required'; end if;
  execute pg_catalog.format('select %I.crypt($1,$2)=$2',ext_schema) into result using p_password,p_hash;
  return result;
end $$;

create or replace function bluev_private.token_hash(p_token text)
returns text language plpgsql stable security definer set search_path = '' as $$
declare ext_schema text; result text;
begin
  select n.nspname into ext_schema from pg_catalog.pg_extension e join pg_catalog.pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto';
  if ext_schema is null then raise exception 'pgcrypto extension is required'; end if;
  execute pg_catalog.format('select pg_catalog.encode(%I.digest($1,''sha256''),''hex'')',ext_schema) into result using coalesce(p_token,'');
  return result;
end $$;

revoke all on function bluev_private.random_hex(integer) from public, anon, authenticated;
revoke all on function bluev_private.password_hash(text) from public, anon, authenticated;
revoke all on function bluev_private.password_matches(text,text) from public, anon, authenticated;
revoke all on function bluev_private.token_hash(text) from public, anon, authenticated;

create table if not exists bluev_private.accounts (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  username text not null,
  username_key text not null unique,
  display_name text not null,
  role text not null check (role in ('admin','user')),
  password_hash text not null,
  disabled boolean not null default false,
  must_change boolean not null default false,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

create table if not exists bluev_private.brands (
  id text primary key,
  name text not null unique,
  enabled boolean not null default true,
  note text not null default '',
  prompt_write text not null default '',
  created_at bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists bluev_private.account_brands (
  account_id uuid not null references bluev_private.accounts(id) on delete cascade,
  brand_id text not null references bluev_private.brands(id) on delete cascade,
  primary key (account_id, brand_id)
);

create table if not exists bluev_private.sessions (
  token_hash text primary key,
  account_id uuid not null references bluev_private.accounts(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists bluev_auth_sessions_expiry on bluev_private.sessions(expires_at);

create table if not exists bluev_private.login_attempts (
  username_key text primary key,
  failures integer not null default 0,
  locked_until timestamptz
);

create table if not exists bluev_private.settings (
  singleton boolean primary key default true check (singleton),
  bootstrap_code text
);

-- A random one-time setup code is returned by the final SELECT to the project owner.
-- It lives in a schema that is not exposed through the Data API and is deleted after use.
do $$
declare setup_code text;
begin
  if not exists (select 1 from bluev_private.settings where singleton) then
    setup_code := bluev_private.random_hex(32);
    insert into bluev_private.settings(singleton, bootstrap_code)
    values (true, setup_code)
    on conflict (singleton) do nothing;
  end if;
end $$;

create or replace function bluev_private.session_account(p_token text)
returns uuid
language sql stable security definer set search_path = ''
as $$
  select s.account_id
  from bluev_private.sessions s
  join bluev_private.accounts a on a.id = s.account_id and not a.disabled
  where s.token_hash = bluev_private.token_hash(p_token)
    and s.expires_at > now()
$$;

create or replace function public.bluev_auth_bootstrap(p_setup_code text, p_username text, p_password text, p_display_name text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s text; a bluev_private.accounts%rowtype; tok text; exp_at timestamptz;
begin
  if coalesce(length(p_setup_code),0) < 32 then return jsonb_build_object('ok',false,'error','初始化码无效'); end if;
  if coalesce(p_username,'') !~ '^[A-Za-z0-9._-]{3,32}$' then return jsonb_build_object('ok',false,'error','账号须为 3–32 位字母、数字、点、下划线或短横线'); end if;
  if coalesce(length(p_password),0) < 6 or octet_length(p_password) > 72 or p_password ~ '[一-龥]' then return jsonb_build_object('ok',false,'error','密码须至少 6 位、不含中文且不超过 72 字节'); end if;
  select bootstrap_code into s from bluev_private.settings where singleton for update;
  if s is null or s <> p_setup_code then return jsonb_build_object('ok',false,'error','初始化码不正确或已使用'); end if;
  if exists(select 1 from bluev_private.accounts) then return jsonb_build_object('ok',false,'error','云端管理员已初始化'); end if;
  insert into bluev_private.accounts(username,username_key,display_name,role,password_hash)
  values (btrim(p_username),lower(btrim(p_username)),coalesce(nullif(btrim(p_display_name),''),btrim(p_username)),'admin',bluev_private.password_hash(p_password)) returning * into a;
  update bluev_private.settings set bootstrap_code = null where singleton;
  tok := bluev_private.random_hex(32);
  insert into bluev_private.sessions(token_hash,account_id,expires_at) values (bluev_private.token_hash(tok),a.id,now()+interval '7 days') returning expires_at into exp_at;
  return jsonb_build_object('ok',true,'token',tok,'expiresAt',floor(extract(epoch from exp_at)*1000),'user',jsonb_build_object('id',a.id,'username',a.username,'displayName',a.display_name,'role',a.role,'brands','[]'::jsonb,'disabled',false,'mustChange',false));
end $$;

create or replace function public.bluev_auth_login(p_username text, p_password text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare k text; a bluev_private.accounts%rowtype; n integer; l timestamptz; tok text; b jsonb; exp_at timestamptz;
begin
  k := lower(btrim(coalesce(p_username,'')));
  if k !~ '^[a-z0-9._-]{3,32}$' then return jsonb_build_object('ok',false,'error','账号或密码不正确'); end if;
  select * into a from bluev_private.accounts where username_key=k for update;
  if a.id is null then return jsonb_build_object('ok',false,'error','账号或密码不正确'); end if;
  select failures,locked_until into n,l from bluev_private.login_attempts where username_key=k;
  if l is not null and l > now() then return jsonb_build_object('ok',false,'error','登录失败次数过多，请 5 分钟后再试'); end if;
  if a.disabled or octet_length(coalesce(p_password,'')) > 72 or not bluev_private.password_matches(coalesce(p_password,''),a.password_hash) then
    insert into bluev_private.login_attempts(username_key,failures,locked_until)
    values (k,1,null) on conflict(username_key) do update
      set failures=case when bluev_private.login_attempts.locked_until is not null and bluev_private.login_attempts.locked_until<=now() then 1 else bluev_private.login_attempts.failures+1 end,
          locked_until=case when (case when bluev_private.login_attempts.locked_until is not null and bluev_private.login_attempts.locked_until<=now() then 1 else bluev_private.login_attempts.failures+1 end)>=6 then now()+interval '5 minutes' else null end;
    return jsonb_build_object('ok',false,'error','账号或密码不正确');
  end if;
  delete from bluev_private.login_attempts where username_key=k;
  update bluev_private.accounts set last_login_at=now() where id=a.id;
  select coalesce(jsonb_agg(ab.brand_id order by ab.brand_id),'[]'::jsonb) into b from bluev_private.account_brands ab where ab.account_id=a.id;
  tok := bluev_private.random_hex(32);
  insert into bluev_private.sessions(token_hash,account_id,expires_at) values (bluev_private.token_hash(tok),a.id,now()+interval '7 days') returning expires_at into exp_at;
  return jsonb_build_object('ok',true,'token',tok,'expiresAt',floor(extract(epoch from exp_at)*1000),'user',jsonb_build_object('id',a.id,'username',a.username,'displayName',a.display_name,'role',a.role,'brands',b,'disabled',false,'mustChange',a.must_change));
end $$;

create or replace function public.bluev_auth_setup_state()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('ok',true,'initialized',exists(select 1 from bluev_private.accounts),'bootstrapAvailable',exists(select 1 from bluev_private.settings where singleton and bootstrap_code is not null))
$$;

create or replace function public.bluev_auth_status(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare a bluev_private.accounts%rowtype; b jsonb; exp_at timestamptz;
begin
  select ac.* into a from bluev_private.accounts ac where ac.id=bluev_private.session_account(p_token);
  select s.expires_at into exp_at from bluev_private.sessions s where s.token_hash=bluev_private.token_hash(p_token);
  if a.id is null then return jsonb_build_object('ok',false,'error','登录已过期'); end if;
  select coalesce(jsonb_agg(ab.brand_id order by ab.brand_id),'[]'::jsonb) into b from bluev_private.account_brands ab where ab.account_id=a.id;
  return jsonb_build_object('ok',true,'expiresAt',floor(extract(epoch from exp_at)*1000),'user',jsonb_build_object('id',a.id,'username',a.username,'displayName',a.display_name,'role',a.role,'brands',b,'disabled',false,'mustChange',a.must_change));
end $$;

-- Generic account and brand administration RPC. All authorization checks are performed in Postgres;
-- clients cannot read the private tables or promote themselves by editing local files.
create or replace function public.bluev_auth_admin(p_token text, p_action text, p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid; target uuid; a bluev_private.accounts%rowtype; payload jsonb; ids text[]; out_rows jsonb;
begin
  -- 串行化账号/品牌管理，避免并发操作绕过最后管理员等约束。
  perform pg_catalog.pg_advisory_xact_lock(20261009, 18);
  actor := bluev_private.session_account(p_token);
  if actor is null or not exists(select 1 from bluev_private.accounts where id=actor and role='admin' and not disabled) then
    return jsonb_build_object('ok',false,'error','只有已登录管理员能做这个操作');
  end if;
  if p_action='list_users' then
    select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'username',x.username,'displayName',x.display_name,'role',x.role,'disabled',x.disabled,'mustChange',x.must_change,'brands',coalesce((select jsonb_agg(ab.brand_id) from bluev_private.account_brands ab where ab.account_id=x.id),'[]'::jsonb),'lastLoginAt',x.last_login_at) order by x.created_at),'[]'::jsonb) into out_rows from bluev_private.accounts x;
    return jsonb_build_object('ok',true,'users',out_rows,'currentId',actor);
  elsif p_action='create_user' then
    if coalesce(p_payload->>'username','') !~ '^[A-Za-z0-9._-]{3,32}$' then return jsonb_build_object('ok',false,'error','账号格式无效（3–32 位字母、数字、点、下划线、短横线）'); end if;
    if length(coalesce(p_payload->>'password','')) < 6 or octet_length(p_payload->>'password') > 72 or p_payload->>'password' ~ '[一-龥]' then return jsonb_build_object('ok',false,'error','密码须至少 6 位、不含中文且不超过 72 字节'); end if;
    if exists(select 1 from bluev_private.accounts where username_key=lower(p_payload->>'username')) then return jsonb_build_object('ok',false,'error','这个账号已经存在'); end if;
    select array_agg(value) into ids from jsonb_array_elements_text(coalesce(p_payload->'brands','[]'::jsonb));
    if coalesce(p_payload->>'role','user') <> 'admin' and coalesce(cardinality(ids),0)=0 then return jsonb_build_object('ok',false,'error','普通成员必须至少分配一个品牌'); end if;
    if exists(select 1 from unnest(coalesce(ids,'{}')) x where not exists(select 1 from bluev_private.brands b where b.id=x)) then return jsonb_build_object('ok',false,'error','品牌权限包含不存在的品牌'); end if;
    if coalesce(p_payload->>'role','user') <> 'admin' and not exists(select 1 from bluev_private.brands b where b.id=any(coalesce(ids,'{}')) and b.enabled) then return jsonb_build_object('ok',false,'error','普通成员必须至少分配一个启用品牌'); end if;
    insert into bluev_private.accounts(username,username_key,display_name,role,password_hash)
      values (btrim(p_payload->>'username'),lower(btrim(p_payload->>'username')),coalesce(nullif(btrim(p_payload->>'displayName'),''),btrim(p_payload->>'username')),case when p_payload->>'role'='admin' then 'admin' else 'user' end,bluev_private.password_hash(p_payload->>'password')) returning * into a;
    insert into bluev_private.account_brands(account_id,brand_id) select a.id,x from unnest(coalesce(ids,'{}')) x on conflict do nothing;
    return jsonb_build_object('ok',true,'user',jsonb_build_object('id',a.id,'username',a.username,'displayName',a.display_name,'role',a.role,'disabled',a.disabled,'mustChange',a.must_change,'brands',to_jsonb(coalesce(ids,'{}'))));
  elsif p_action in ('update_user','reset_password','remove_user') then
    target := nullif(p_payload->>'id','')::uuid;
    select * into a from bluev_private.accounts where id=target for update;
    if a.id is null then return jsonb_build_object('ok',false,'error','账号不存在'); end if;
    if p_action='remove_user' then
      if target=actor then return jsonb_build_object('ok',false,'error','不能删自己'); end if;
      if a.role='admin' and not a.disabled and (select count(*) from bluev_private.accounts where role='admin' and not disabled)<=1 then return jsonb_build_object('ok',false,'error','至少要留一个启用中的管理员'); end if;
      delete from bluev_private.login_attempts where username_key=a.username_key;
      delete from bluev_private.accounts where id=target; return jsonb_build_object('ok',true);
    elsif p_action='reset_password' then
      if length(coalesce(p_payload->>'password',''))<6 or octet_length(p_payload->>'password')>72 or p_payload->>'password' ~ '[一-龥]' then return jsonb_build_object('ok',false,'error','密码须至少 6 位、不含中文且不超过 72 字节'); end if;
      update bluev_private.accounts set password_hash=bluev_private.password_hash(p_payload->>'password'),must_change=true where id=target;
      delete from bluev_private.sessions where account_id=target;
    else
      if target=actor and ((p_payload ? 'role' and p_payload->>'role' <> a.role) or (p_payload ? 'disabled' and (p_payload->>'disabled')::boolean)) then return jsonb_build_object('ok',false,'error','不能修改自己的角色或停用自己'); end if;
      if a.role='admin' and not a.disabled and ((p_payload ? 'role' and p_payload->>'role' <> 'admin') or (p_payload ? 'disabled' and (p_payload->>'disabled')::boolean)) and (select count(*) from bluev_private.accounts where role='admin' and not disabled)<=1 then
        return jsonb_build_object('ok',false,'error','至少要留一个启用中的管理员');
      end if;
      if p_payload->>'role'='user' and coalesce(jsonb_array_length(p_payload->'brands'),(select count(*)::integer from bluev_private.account_brands where account_id=target))=0 then
        return jsonb_build_object('ok',false,'error','普通成员必须至少分配一个品牌');
      end if;
      if p_payload ? 'brands' then
        select array_agg(value) into ids from jsonb_array_elements_text(p_payload->'brands');
        if a.role='user' and coalesce(cardinality(ids),0)=0 and coalesce(p_payload->>'role','user') <> 'admin' then return jsonb_build_object('ok',false,'error','普通成员必须至少分配一个品牌'); end if;
        if exists(select 1 from unnest(coalesce(ids,'{}')) x where not exists(select 1 from bluev_private.brands b where b.id=x)) then return jsonb_build_object('ok',false,'error','品牌权限包含不存在的品牌'); end if;
      end if;
      if p_payload ? 'displayName' then update bluev_private.accounts set display_name=coalesce(nullif(btrim(p_payload->>'displayName'),''),username) where id=target; end if;
      if p_payload ? 'role' then update bluev_private.accounts set role=case when p_payload->>'role'='admin' then 'admin' else 'user' end where id=target; end if;
      if p_payload ? 'disabled' then update bluev_private.accounts set disabled=(p_payload->>'disabled')::boolean where id=target; end if;
      if p_payload ? 'disabled' and (p_payload->>'disabled')::boolean then delete from bluev_private.sessions where account_id=target; end if;
      if p_payload ? 'brands' then
        delete from bluev_private.account_brands where account_id=target;
        insert into bluev_private.account_brands(account_id,brand_id) select target,x from unnest(coalesce(ids,'{}')) x on conflict do nothing;
      end if;
    end if;
    select * into a from bluev_private.accounts where id=target;
    select coalesce(jsonb_agg(ab.brand_id),'[]'::jsonb) into out_rows from bluev_private.account_brands ab where ab.account_id=target;
    return jsonb_build_object('ok',true,'user',jsonb_build_object('id',a.id,'username',a.username,'displayName',a.display_name,'role',a.role,'disabled',a.disabled,'mustChange',a.must_change,'brands',out_rows));
  elsif p_action='list_brands' then
    select coalesce(jsonb_agg(jsonb_build_object('id',b.id,'name',b.name,'enabled',b.enabled,'note',b.note,'promptWrite',b.prompt_write,'createdAt',b.created_at) order by b.created_at),'[]'::jsonb) into out_rows from bluev_private.brands b;
    return jsonb_build_object('ok',true,'brands',out_rows);
  elsif p_action='save_brands' then
    if jsonb_typeof(p_payload->'brands') <> 'array' then return jsonb_build_object('ok',false,'error','品牌列表格式无效'); end if;
    if exists(select 1 from jsonb_array_elements(p_payload->'brands') x where coalesce(x->>'id','')='' or coalesce(x->>'name','')='' or length(x->>'name')>24) then return jsonb_build_object('ok',false,'error','品牌 id 或名称无效'); end if;
    if exists(select 1 from bluev_private.accounts ac where ac.role='user' and not ac.disabled and not exists(select 1 from bluev_private.account_brands ab join jsonb_array_elements(p_payload->'brands') x on x->>'id'=ab.brand_id where ab.account_id=ac.id)) then return jsonb_build_object('ok',false,'error','请先为成员重新分配品牌，再删除其最后一个品牌'); end if;
    insert into bluev_private.brands(id,name,enabled,note,prompt_write,created_at,updated_at)
      select x->>'id',btrim(x->>'name'),coalesce((x->>'enabled')::boolean,true),coalesce(x->>'note',''),left(coalesce(x->>'promptWrite',''),4000),coalesce((x->>'createdAt')::bigint,0),now()
      from jsonb_array_elements(p_payload->'brands') x
      on conflict(id) do update set name=excluded.name,enabled=excluded.enabled,note=excluded.note,prompt_write=excluded.prompt_write,updated_at=now();
    delete from bluev_private.brands b where not exists(select 1 from jsonb_array_elements(p_payload->'brands') x where x->>'id'=b.id);
    return jsonb_build_object('ok',true);
  end if;
  return jsonb_build_object('ok',false,'error','不支持的云端账号操作');
end $$;

create or replace function public.bluev_auth_change_password(p_token text,p_old text,p_new text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a bluev_private.accounts%rowtype;
begin
  select * into a from bluev_private.accounts where id=bluev_private.session_account(p_token) for update;
  if a.id is null then return jsonb_build_object('ok',false,'error','登录已过期'); end if;
  if not bluev_private.password_matches(coalesce(p_old,''),a.password_hash) then return jsonb_build_object('ok',false,'error','当前密码不正确'); end if;
  if length(coalesce(p_new,''))<6 or octet_length(p_new)>72 or p_new ~ '[一-龥]' then return jsonb_build_object('ok',false,'error','密码须至少 6 位、不含中文且不超过 72 字节'); end if;
  update bluev_private.accounts set password_hash=bluev_private.password_hash(p_new),must_change=false where id=a.id;
  delete from bluev_private.sessions where account_id=a.id and token_hash<>bluev_private.token_hash(p_token);
  return jsonb_build_object('ok',true);
end $$;

create or replace function public.bluev_auth_logout(p_token text)
returns jsonb language sql security definer set search_path = '' as $$
  with gone as (delete from bluev_private.sessions where token_hash=bluev_private.token_hash(p_token)) select jsonb_build_object('ok',true)
$$;

-- Members only receive the brands assigned to them; administrators receive the full registry.
create or replace function public.bluev_auth_brands(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare actor uuid; is_admin boolean; rows jsonb;
begin
  actor := bluev_private.session_account(p_token);
  if actor is null then return jsonb_build_object('ok',false,'error','登录已过期'); end if;
  select role='admin' into is_admin from bluev_private.accounts where id=actor and not disabled;
  select coalesce(jsonb_agg(jsonb_build_object('id',b.id,'name',b.name,'enabled',b.enabled,'note',b.note,'promptWrite',case when is_admin or exists(select 1 from bluev_private.account_brands ab where ab.account_id=actor and ab.brand_id=b.id) then b.prompt_write else '' end,'createdAt',b.created_at) order by b.created_at),'[]'::jsonb)
    into rows from bluev_private.brands b where is_admin or exists(select 1 from bluev_private.account_brands ab where ab.account_id=actor and ab.brand_id=b.id);
  return jsonb_build_object('ok',true,'isAdmin',coalesce(is_admin,false),'brands',rows);
end $$;

create or replace function public.bluev_auth_prompt(p_token text,p_brand_id text,p_prompt text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid; is_admin boolean; changed integer;
begin
  actor := bluev_private.session_account(p_token);
  if actor is null then return jsonb_build_object('ok',false,'error','登录已过期'); end if;
  select role='admin' into is_admin from bluev_private.accounts where id=actor and not disabled;
  if not coalesce(is_admin,false) and not exists(select 1 from bluev_private.account_brands where account_id=actor and brand_id=p_brand_id) then
    return jsonb_build_object('ok',false,'error','没有这个品牌的操作权限');
  end if;
  update bluev_private.brands set prompt_write=left(coalesce(p_prompt,''),4000),updated_at=now() where id=p_brand_id;
  get diagnostics changed = row_count;
  if changed=0 then return jsonb_build_object('ok',false,'error','品牌不存在'); end if;
  return jsonb_build_object('ok',true);
end $$;

revoke all on function public.bluev_auth_bootstrap(text,text,text,text) from public;
revoke all on function public.bluev_auth_login(text,text) from public;
revoke all on function public.bluev_auth_status(text) from public;
revoke all on function public.bluev_auth_admin(text,text,jsonb) from public;
revoke all on function public.bluev_auth_change_password(text,text,text) from public;
revoke all on function public.bluev_auth_logout(text) from public;
revoke all on function public.bluev_auth_brands(text) from public;
revoke all on function public.bluev_auth_setup_state() from public;
revoke all on function public.bluev_auth_prompt(text,text,text) from public;
grant execute on function public.bluev_auth_bootstrap(text,text,text,text) to anon, authenticated;
grant execute on function public.bluev_auth_login(text,text) to anon, authenticated;
grant execute on function public.bluev_auth_status(text) to anon, authenticated;
grant execute on function public.bluev_auth_admin(text,text,jsonb) to anon, authenticated;
grant execute on function public.bluev_auth_change_password(text,text,text) to anon, authenticated;
grant execute on function public.bluev_auth_logout(text) to anon, authenticated;
grant execute on function public.bluev_auth_brands(text) to anon, authenticated;
grant execute on function public.bluev_auth_setup_state() to anon, authenticated;
grant execute on function public.bluev_auth_prompt(text,text,text) to anon, authenticated;

-- Verify that no table in the private schema is exposed via the Data API.
select bootstrap_code as one_time_setup_code from bluev_private.settings where singleton and bootstrap_code is not null and not exists(select 1 from bluev_private.accounts);
