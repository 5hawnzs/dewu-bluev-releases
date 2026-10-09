-- 在应用使用的 rywurhpkovyjpjyvfjdz 项目 SQL Editor 一次性执行。
-- 幂等：再次执行不会移动清零时间、不会删除清零后的新记录。
begin;
create table if not exists public.publish_history_control (
  org text primary key,
  before_ts bigint not null
);
alter table public.publish_history_control enable row level security;
drop policy if exists publish_history_read on public.publish_history_control;
create policy publish_history_read on public.publish_history_control for select to anon using (org = 'bluev');
grant select on public.publish_history_control to anon;
revoke insert, update, delete on public.publish_history_control from anon, authenticated;
insert into public.publish_history_control(org, before_ts)
values ('bluev', floor(extract(epoch from clock_timestamp()) * 1000)::bigint)
on conflict (org) do nothing;
-- 旧设备继续补传时，静默丢弃清零前的记录，让旧同步游标正常前进。
create or replace function public.skip_cleared_publish_history()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.ts < coalesce((select before_ts from public.publish_history_control where org = new.org), 0) then
    return null;
  end if;
  return new;
end;
$$;
revoke all on function public.skip_cleared_publish_history() from public;
drop trigger if exists skip_cleared_publish_history on public.publish_log;
create trigger skip_cleared_publish_history before insert on public.publish_log
for each row execute function public.skip_cleared_publish_history();
delete from public.publish_log p using public.publish_history_control c
where p.org = c.org and p.org = 'bluev' and p.ts < c.before_ts;
commit;
select c.before_ts, count(p.id) as remaining_publish_records
from public.publish_history_control c left join public.publish_log p on p.org = c.org
where c.org = 'bluev' group by c.before_ts;
