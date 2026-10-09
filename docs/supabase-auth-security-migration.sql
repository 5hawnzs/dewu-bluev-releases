-- 在现有云端账号项目执行。只更新安全函数，不重建账号、不重置密码、不生成初始化码。
BEGIN;

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

COMMIT;
