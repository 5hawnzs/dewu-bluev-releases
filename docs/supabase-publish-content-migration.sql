-- 新增发布时实际使用的标题与文案；不修改历史记录，不改变权限。
begin;
alter table public.publish_log add column if not exists title text;
alter table public.publish_log add column if not exists body text;
notify pgrst, 'reload schema';
commit;
