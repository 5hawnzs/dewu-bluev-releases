-- AI API 用量统计：在已部署 run_log 的 Supabase 项目 SQL Editor 执行一次。
-- 仅新增任务级 JSON 汇总，不含提示词、生成正文、图片、商品名、路径或 API key。
-- 重复执行安全。

alter table public.run_log add column if not exists api_usage jsonb;

-- 自检：应返回 api_usage / jsonb。
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'run_log' and column_name = 'api_usage';
