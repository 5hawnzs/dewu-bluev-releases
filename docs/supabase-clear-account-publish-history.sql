-- 在 rywurhpkovyjpjyvfjdz 项目 SQL Editor 执行。
-- 仅修改下方 ARRAY 中的登录账号名；不是显示昵称。
-- 清除指定账号执行时刻之前的发布记录，保留账号、权限、运行排错日志和 token 账单。
-- App 升级到支持按账号清理的覆盖包后，联网查询统计或同步时也会清除本机旧发布台账。
begin;
create table if not exists public.publish_account_history_control (
  org text not null,
  user_id text not null,
  before_ts bigint not null,
  primary key (org, user_id)
);
alter table public.publish_account_history_control enable row level security;
drop policy if exists publish_account_history_read on public.publish_account_history_control;
create policy publish_account_history_read on public.publish_account_history_control
  for select to anon using (org = 'bluev');
grant select on public.publish_account_history_control to anon;
revoke insert, update, delete on public.publish_account_history_control from anon, authenticated;

create or replace function public.skip_cleared_account_publish_history()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.ts < coalesce((select before_ts from public.publish_account_history_control
    where org = new.org and user_id = new.user_id), 0) then
    return null;
  end if;
  return new;
end;
$$;
revoke all on function public.skip_cleared_account_publish_history() from public;
drop trigger if exists skip_cleared_account_publish_history on public.publish_log;
create trigger skip_cleared_account_publish_history before insert on public.publish_log
for each row execute function public.skip_cleared_account_publish_history();

do $$
declare
  names text[] := ARRAY['testbeta']; -- 修改这里：例如 ARRAY['testbeta', 'test2']
  before_time bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
begin
  if exists (select 1 from unnest(names) n where not exists
    (select 1 from bluev_private.accounts a where a.username = n)) then
    raise exception '账号名不存在：请填写登录账号名，而不是显示昵称。未执行清除。';
  end if;
  insert into public.publish_account_history_control (org, user_id, before_ts)
    select 'bluev', id::text, before_time from bluev_private.accounts where username = any(names)
  on conflict (org, user_id) do update
    set before_ts = greatest(public.publish_account_history_control.before_ts, excluded.before_ts);
end;
$$;

delete from public.publish_log p using public.publish_account_history_control c
where p.org = c.org and p.user_id = c.user_id and p.ts < c.before_ts;
commit;

select a.username, c.before_ts, count(p.id) as remaining_publish_records
from public.publish_account_history_control c
join bluev_private.accounts a on a.id::text = c.user_id
left join public.publish_log p on p.org = c.org and p.user_id = c.user_id
where c.org = 'bluev'
group by a.username, c.before_ts;
