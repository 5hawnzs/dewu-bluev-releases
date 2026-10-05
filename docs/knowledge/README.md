# docs/knowledge —— 交接知识库

> **这是一份快照，不是活文档。** 导出时间：**2026-10-05 18:3x**。
> 内容是 WorkBuddy 会话里累积的规则、技能与历史文档；仓库外的「活文档」仍在
> `E:\WORKBUDDY\2026-09-30-17-35-35\.workbuddy\memory\`（若还要继续用那边，改一份记得同步回来）。
>
> **为什么在这里**：这些内容原本全在仓库之外（WorkBuddy 的私有目录里），
> clone 仓库拿不到 ⇒ 交接会漏。现在收进 `docs/knowledge/`，
> 且 **`docs/` 不在 `build.files` 白名单里**（只有 `src/**` + `package.json` 进安装包），
> 所以放进仓库**不会**被打进 exe、也不会被终端用户看到。

---

## 一、先读哪几份（别整读）

| 顺序 | 文件 | 什么时候看 |
| --- | --- | --- |
| 1 | `../HANDOFF.md`（仓库内） | 全部交接内容：硬约束、已完成、待办、真机口径、发版 SOP、回归套件表 |
| 2 | `../HANDOFF-CODEX.md`（仓库内） | 一页纸：怎么开工、git 里已有什么、git 外还缺什么 |
| 3 | `../HANDOFF-NEW-MACHINE.md`（仓库内） | **换机**才看：目标机前提、通道总表、`config.json` 怎么搬（§3.1）、新机必做重置、验收清单 |
| 4 | `RULES-得物蓝V.md`（4300+ 行） | **本项目规则圣经**。按 `§A`~`§CC` 分节，每节一个坑 + 实测数字。**按需查，别从头上读** |
| 5 | `MEMORY-INDEX.md` | 硬规则的索引（祈使句 + `§指针`）—— 先扫这一页，再决定翻哪节 |
| 6 | `RULES-通用.md` + `USER-PREFERENCES.md` | 跨项目工作规范：诚实性、证据标准、反向验证的坑、环境约定 |
| 7 | `docs/发版流程SOP.md` | 要发版时必读 |
| 8 | `skills/bilateral-fix-verification/SKILL.md` | 说「修好了」之前必读（怎么反证断言真的在查东西） |
| 9 | `skills/repo-handoff-to-external-agent/SKILL.md` | 再交接一次（换机 / 换工具 / 换人）时必读 |

---

## 二、这个包里有什么

| 路径 | 内容 | 体量 |
| --- | --- | --- |
| `RULES-得物蓝V.md` | 项目规则圣经（原 `REFERENCE-得物蓝V.md`），`§A`~`§CC` | 4300+ 行 / ≈370 KB |
| `MEMORY-INDEX.md` | 项目规则索引（祈使句 + §指针） | 5.6 KB |
| `RULES-通用.md` | 跨项目工作规范（原 `~/.workbuddy/REFERENCE-通用.md`） | 40 KB |
| `USER-PREFERENCES.md` | 用户级偏好（原 `~/.workbuddy/MEMORY.md`） | 8 KB |
| `docs/` | 工作区根的 **90 份**成品文档：发版 SOP、UI 定位表与实测 dump、真机发布流程记录、各版本交付报告、诊断报告、改动说明、diff、功能全景 HTML | 1.5 MB |
| `skills/` | **29 个**技能（`SKILL.md` + 附带脚本）：反证验证、并发工作区发版、外部代理交接、MediaStore 相册、多模态文案审计、mp4 视频轨可解性、Android UI 提速/采集诊断、Electron 自动更新、Supabase 迁移核对、Windows 沙箱规范… | 900 KB |
| `archive/worklog/` | **6 份**每日工作日志（2026-09-30 ~ 10-05），原始流水，**排查「为什么这么改」时查，别整读** | 548 KB |
| `deployed-sites/` | 已部署站点源码：`board-site`（发布看板）、`pluginhub-site`（插件中心，**不含 `dl/` 里的 109 MB 安装包**） | 436 KB |

**没进这个包的**（体积大或是二进制，仍留在工作区）：

| 留在哪 | 是什么 |
| --- | --- |
| `E:\WORKBUDDY\2026-09-30-17-35-35\_*` 共 411 个文件 | 逐次运行的取证原件（回归输出、定点破坏结果、真机 dump xml、截图） |
| 同上 `_mainimg\` 39 MB · `logo-验收\` 40 KB | 主图对照照、logo 验收图（png/jpg） |
| 同上 `*.png` `*.xlsx` 23 MB | 截图与真机实测报告表 |
| `pluginhub-site\dl\` 110 MB | 109 MB 安装包 + zip —— 按 `.gitignore` 的口径，二进制一律不进 git |

---

## 三、两条口径（很重要）

1. **这个包里的规则是「截至 2026-10-05 的结论」，不是当前事实。**
   规则里写的数字（断言数、体积、耗时）**每次都要实测重取** —— 同一天内就变过好几轮。
2. **`docs/` 下的一切都只是文档**，不参与构建、不进包、不影响运行。
   要删/要改随时可以，删了不影响产品。

---

## 四、包里已知的一处「非红线」凭据

`deployed-sites/pluginhub-site/dashboard*.html` 里含一个 **Supabase `anon` key**
（已解出 JWT 载荷确认 `role: anon`，**不是 `service_role`**）。
它与 `web/board.html` 一样是**随公开看板发布过**的公开端凭据，只受行级策略约束；
项目红线是「**`service_role` / secret key 绝不许进任何前端文件**」，这条没被破。
`docs/得物蓝V-COS开通操作指引.md` 里的 `AKIDxxxx…` 是**待用户填写的占位符**，不是真 key。

---

## 五、这个包里**没有**的东西（别指望它有）

| 没有 | 在哪 / 怎么拿 |
| --- | --- |
| 运行时的 `config.json`（含模型密钥 + 真机 UI 定位表）、`auth.json`、`.env` | **刻意不进 git**（含密钥，进了历史删不干净）。换机用 `node tools/config-portable.js` 单独搬 —— 见 `../HANDOFF-NEW-MACHINE.md` §3 |
| 安装包、归档、`dl/` 安装件、截图原件 | 二进制，按需索取 |
| `node_modules` | 新机 `npm install` + `npm run addon:win` |
