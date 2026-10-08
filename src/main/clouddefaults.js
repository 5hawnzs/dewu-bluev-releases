'use strict';
/**
 * 组织级云端默认值 —— **内置进包，装完即用**（各台机器不用再手填地址与 key）。
 *
 * ★★ 这个文件里只允许出现 **anon / publishable** key。
 *    **service_role（secret key）绝不许写在这里** —— 那个 key 绕过所有行级策略，
 *    一旦进了包，拿到包的任何人都能读写整张表。真正的收口在数据库的 RLS：
 *    anon 只有 insert + select，且 insert 要过 `org` 校验（见 docs/supabase-setup.sql）。
 *
 * ★ 为什么敢内置：anon / publishable key 本来就是设计成公开的（拓新系统的前端里也是明文放着），
 *    它本身不代表任何权限，权限完全由表上的 RLS 策略决定。
 *
 * ★ 真要换项目怎么办：**发新包** —— 各台升级后自动跟随新的内置值（config.json 里仍是空）。
 *    ★ 2026-10-08 起界面上已**没有**云端配置入口（用户要求：这块不给任何人看到）⇒
 *      想单独改某一台只能改它自己的 config.json，且**不推荐**：各台指向不同项目时，
 *      看板上会「少一个人」而且不报错。
 */
module.exports = {
  url: 'https://rywurhpkovyjpjyvfjdz.supabase.co',
  anonKey: 'sb_publishable_pAp0t-MpIyTn5GgAYOa6gA_IAahwJmr',
  // 组织标识：随每一行一起上行。表里 insert 策略会校验它，
  // 这样「拿着 key 但不知道 org 的人」灌不进数据（防君子不防拿到包的人，真正的防线仍是 RLS）
  org: 'bluev'
};
