-- ============================================================
-- 待清理：2026-10-08 误插进线上库的 2 条演示记录
-- ============================================================
-- 背景（如实记录）：我在做「云端同步失败会留下什么」的演示时，想用坏域名把请求拦下来，
-- 但我拦错了配置读取点（代码读的是 store.get('cloud') 整个对象，我只拦了 'cloud.url'），
-- 于是 url 回退到**内置的真实地址**，那 2 条演示数据**真的写进了线上库**。
--
-- 已确认的事实：
--   · 云端 publish_log 里确实多了 2 行：
--       id = 418   ts = 1760000000001   item_id = DEMO1
--       id = 419   ts = 1760000000002   item_id = DEMO2
--     （machine_id = m_279f89ac，kind = 图文，result = 发布成功，其余字段为空）
--   · 用 anon key 发 DELETE → HTTP 200 但**影响 0 行**（RLS 静默拦截）；
--     本机全盘扫描只有 anon 密钥、**没有 service_role**，所以我删不掉。
--   · 这 2 行的 ts 落在 **2025-10-09**（不是今天），只污染那一天的统计。
--   · 除此之外没有其它脏数据：以 (ts,seq) 为键的全量体检无重复、台账 184→193 行全为本机真实记录。
--
-- 怎么清（任选一种）：
--   ① Supabase 控制台 → Table Editor → 表 publish_log → 勾掉 id 为 418、419 两行 → Delete。
--   ② SQL Editor 里执行下面这句。
--   ③ 如果你手头有 service_role key，把它给我，我用 REST 带着这条 SQL 同样的条件删掉并复查（用完不留）。
--
-- ★ 删之前先看一眼：确认 item_id 确实是 DEMO1 / DEMO2，不要误伤真实记录。
-- ============================================================

-- 先看（建议先跑这条确认）
select id, ts, item_id, machine_id, kind, result
from public.publish_log
where id in (418, 419);

-- 再删
delete from public.publish_log
where id in (418, 419)
  and item_id in ('DEMO1', 'DEMO2');   -- 双保险：只删演示数据

-- 删完复查，应返回 0 行
select count(*) as remain
from public.publish_log
where item_id in ('DEMO1', 'DEMO2');
