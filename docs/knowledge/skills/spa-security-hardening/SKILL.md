---
name: spa-security-hardening
description: 审计并加固「单文件/纯前端 SPA」（尤其是自建后台、内部工具、static 部署的 index.html）的安全与稳定性。当用户提出「检查网站代码安全性/加固」「检查是否有闪退/白屏/卡顿」「XSS 防护」「剪贴板复制不生效」这类需求时使用。含速查清单、可直接复用的代码片段、以及必须写进回归测试的静态断言。
agent_created: true
---

# 单文件 SPA 安全与稳定性加固

适用对象：用 `innerHTML` 拼字符串渲染、数据来自后端表、直接静态部署的 `index.html`（含内联 JS）。
这类页面的通病：**转义靠自觉、URL 不做协议白名单、依赖走 CDN、异常无兜底、监听器不回收**。

## 一、审查顺序（按「真实可利用性」从高到低）

1. **伪协议注入**（最高危、最常被忽略）
   `esc()` 只转 `& < > "`，**不防 `javascript:`**。所以 `'<a href="' + esc(row.url) + '">'` 只要有一条数据被污染就能点击执行脚本。
   → 必须加协议白名单，见下面代码。
2. **越权兜底**：搜 `role = 'admin'` / `is_admin`，看有没有「查不到权限就放行」的容错分支。这类"怕锁死"的写法等于后门。
3. **权限只在 UI 层**：按钮 `disabled` 但函数挂在 `window` 上（`window.__xxx`）→ 控制台可直调。每个写入口都要自查权限。
4. **依赖外链**：`<script src="https://cdn...">` 无 SRI，且国内 CDN 超时会导致整站白屏。→ 本地化。
5. **`innerHTML` 拼接**：逐行检查插值项是否都过了 `esc()`；特别看 `data-*` 属性与 `title=`。
6. **第三方/公开密钥**：确认 `config.js` 里只有 anon/publishable key；service_role 绝不能进部署目录。同时确认后端表对 anon 角色**收回了权限**（公开 key + 宽松 RLS = 库裸奔）。
7. **`rel="noopener"`**：所有 `target="_blank"` 都要 `noopener noreferrer`（可直接用静态断言逐个对齐 count）。

## 二、稳定性（「闪退/白屏」）排查清单

| 症状 | 常见根因 | 修法 |
|---|---|---|
| 全站白屏，控制台一条 TypeError | IIFE 开头 `window.X.createClient()`，而依赖脚本没加载出来 | 先判 `typeof window.X === 'function'`，否则渲染兜底页 |
| 用一会儿越来越卡 | `window.addEventListener` 在渲染函数里注册、从不 `removeEventListener`；闭包持有已移除的 DOM | 改为「按下时挂、松手/失焦立即摘」；关闭弹层时清 DOM |
| 关掉弹窗后仍在跑 | `<video>` 未 `pause`，继续缓冲 | 关闭时 `pause()` + `removeAttribute('src')` + `load()` |
| 某个操作后整页无响应 | 异步函数无 try/catch，`await` 抛错后 UI 停在「加载中」 | 按钮加禁用态 + `try/catch/finally` 恢复 |
| 偶发字段类型报错 | `optSrc(x)` 里 `x.indexOf` 遇到数字（历史脏数据） | 一律 `String(x)` 保护 |
| 白屏但无提示 | 没有全局兜底 | 注册 `window.onerror` + `unhandledrejection`（去抖 + toast） |

## 三、可直接复用的代码

### 1) URL 白名单 + 转义（核心）

```js
function esc(s){ return s==null?'':String(s).replace(/[&<>"']/g, function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

function safeUrl(u){                       // 用于 href
  if (u == null) return '';
  var s = String(u).trim();
  if (!s) return '';
  if (/^(https?:)?\/\//i.test(s)) return s;         // http(s):// 或 //host
  if (/^\/(?!\/)/.test(s)) return s;                // 站内绝对路径
  if (/^\.{1,2}\//.test(s)) return s;               // ./a ../a
  if (/^[a-z0-9._-]+(\?|#|$)/i.test(s)) return s;   // 相对文件名
  return '';                                        // javascript: / data: / vbscript: / file:
}
function safeSrc(u){                       // 用于 img/video src
  if (u == null) return '';
  var s = String(u).trim();
  if (/^blob:/i.test(s)) return s;
  if (/^data:image\//i.test(s)) return s;
  return safeUrl(s);
}
function escUrl(u){ return esc(safeUrl(u)); }
function escSrc(u){ return esc(safeSrc(u)); }
```

要点：
- **别用黑名单**（`startsWith('javascript:')`）——`java\nscript:`、大小写、前导空白都能绕过；白名单才是对的。
- 相对路径分支要写全，否则会把站内相对链接一起拦掉。
- 用法：模板里**只有** `escUrl` / `escSrc` 出现，`href="' + esc(` / `src="' + esc(` 应当一条不剩（写成静态断言）。

### 2) CSP（meta 形式，静态部署可用）

```html
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self' https://*.yourbackend.com; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'none'; frame-src 'none'">
<meta name="referrer" content="strict-origin-when-cross-origin">
```

- 页面用内联事件处理器（`onclick="fn()"`）时必须带 `'unsafe-inline'`，否则全挂。
- **不要写 `frame-ancestors`**（meta 里无效，且页面可能被客户端嵌 iframe）。
- ⚠️ 加完必须把**所有**外部域名（图片 CDN、接口、字体）核对进对应指令，漏一个就是功能故障。

### 3) 权限闸门

```js
function canWrite(){ return state.role === 'admin' || state.role === 'operator'; }
function denyWrite(){ if (canWrite()) return false; toast('当前账号为只读权限，无法执行该操作', true); return true; }
function denyAdmin(){ if (state.role === 'admin') return false; toast('仅管理员可执行该操作', true); return true; }
```
每个写入口第一行 `if (denyWrite()) return;`（勾选框类入口要顺手 `el.checked = false` 回滚）。
**同时告知用户：前端只是第一道门，真正的边界必须在数据库侧（RLS）**，并给出可执行的迁移 SQL（见下）。

### 4) 全局兜底

```js
var _errAt = 0;
function fatal(msg, detail){
  var now = Date.now(); if (now - _errAt < 1500) return; _errAt = now;
  try { toast(msg, true, 6000); } catch(e){}
  try { console.error('[app]', msg, detail || ''); } catch(e){}
}
window.addEventListener('error', function(e){
  var el = e && e.target;
  if (el && el !== window && el.tagName && /^(IMG|VIDEO|SOURCE|SCRIPT|LINK)$/.test(el.tagName)) return; // 资源失败不打扰
  fatal('页面出现异常，若界面卡住请刷新重试', e && (e.message || e.error));
});
window.addEventListener('unhandledrejection', function(e){
  var r = e && e.reason;
  fatal('操作未完成：' + ((r && (r.message || r)) || '未知错误'), r);
});
```

### 5) 依赖本地化

```js
// fetch_vendor.js：下载 UMD 包到本地，避免 CDN 挂掉导致整站白屏 + 消除供应链风险
const r = await fetch('https://cdn.jsdelivr.net/npm/<pkg>@<ver>/dist/umd/<name>.js');
const t = await r.text();
if (t.length < 50000 || t.indexOf('<关键 API 名>') < 0) throw new Error('疑似错误页');
fs.writeFileSync('vendor/<name>.js', t, 'utf8');
// 记录 sha256 到 README/记忆，便于下次核对
```
优点：同源 = 不受 CSP `script-src 'self'` 限制、不怕 CDN 被墙/被篡改。记得把 `vendor/` 一起部署。

### 6) 双击/长按复制（可靠性核心）

```js
function legacyCopy(text){            // ① 用户手势内同步执行，成功率最高
  var ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly','readonly');
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0';
  var prev = document.activeElement;
  document.body.appendChild(ta);
  var ok = false;
  try { ta.focus(); ta.select(); ok = document.execCommand('copy'); } catch(e){ ok = false; }
  document.body.removeChild(ta);
  try { if (prev && prev.focus && prev !== document.body) prev.focus(); } catch(e){}
  return ok === true;                  // ⚠️ 必须校验！它失败时不抛异常
}
function copyText(text, node){
  text = (text == null ? '' : String(text)); if (!text) return;
  if (legacyCopy(text)) { toast('已复制'); return; }                    // ①
  if (navigator.clipboard && navigator.clipboard.writeText) {           // ②
    navigator.clipboard.writeText(text).then(function(){ toast('已复制'); }, function(){
      if (node) selectNodeText(node);
      toast('浏览器拦截了自动复制，已帮你选中内容，请按 Ctrl/⌘ + C', true, 4200);
    });
    return;
  }
  if (node) selectNodeText(node);                                        // ③
  toast('当前浏览器不支持自动复制，已帮你选中内容，请按 Ctrl/⌘ + C', true, 4200);
}
```

必查的 4 个坑：
1. **顺序**：先同步 `execCommand`（手势内），再异步 Clipboard API。反过来时若 `writeText` 被拒，回退时手势已过期 → 静默失败。
2. **`document.execCommand('copy')` 返回 false 不抛异常** → 不校验就会假报「已复制」。
3. **双击链接**：`dblclick` 里遇到 `closest('a')` 若直接 `return`，等于该单元格永远复制不了；而且 `target="_blank"` 会连开两个标签页。要 `preventDefault()` 后复制。
4. **手机端**：双击常被识别成缩放 → 必须补长按（620ms）+ 移动 8px 取消；链接和输入框不要抢系统菜单。
5. 取原始值：给单元格加 `data-copy`（复制 `1234` 而不是展示的 `1,234`）；图片加 `data-src-orig` 复制原图而非缩放图。

### 7) 就地放大（lightbox）—— 别再用 `target="_blank"` 看大图

「点图看大图」二开一个标签页是很常见的偷懒实现，用户的实际感受是**被打断**（尤其手机）。
正确形态是页内查看器。要点（本项目 `deploy/index.html` 的 `#zoomMask` 即此实现）：

- **入口用属性，不用特判**：`<div class="m-prof" data-zoom="<escSrc(url)>" role="button" tabindex="0">`，
  点击走**一个通用委托** `document.click → closest('[data-zoom]')`。以后想让别的图也能放大，只加属性、不改 JS。
  `role=button` 要补 Enter/Space 键处理；`data-zoom` 用白名单函数（`escSrc`）写，打开时再 `safeSrc` 二次校验。
- **缩放模型别用 `max-width`**：打开时把 `<img>` 的**布局尺寸定格为「适应窗口」尺寸**，
  之后的缩放/平移全部走 `transform: translate(tx,ty) scale(S/fitS)`。
  这样「显示尺寸 = 原始像素 × S」与视口无关，窗口 resize 时画面大小不会跳。
  只靠 `max-width:100%` 时，缩放的基准会随布局漂移，越缩越怪。
- **边界要夹**：`S ∈ [min(fitS,1), max(4,fitS)]`；平移 `|t| ≤ max(0,(显示尺寸-容器)/2)`（图比容器小则强制居中）。
- **手势冲突**：拖拽结束浏览器会补发 `click` → 用 `moved` 标志吞掉；
  「点空白关闭、点图不关」；`Esc` 要**先关查看器再关外层弹窗**（`if (closeZoom()) return;`），否则一次 Esc 全关掉。
- **刚打开时的双击**：点入口的那次连击，第二下会落到刚显示的图上触发 `dblclick`（导致一打开就跳倍率）
  → 记 `openedAt`，400ms 内的 `dblclick` 直接忽略。
- **关闭要真释放**：`img.removeAttribute('src')`（大图解码内存很大）+ 摘掉 window 上的拖拽监听 + 复位状态；
  打开下一条记录、关闭外层弹窗时也都要收掉它。
- **弹窗里的提示必须能看见（易漏）**：`.toast` 之类全局提示的 `z-index` 常常只有个位数，
  而弹窗是 50、查看器是 80 → 弹窗/查看器里的「已复制」提示**根本不会显示**。
  约定：**提示层 z-index 全场最高**（例：5000）。改完顺手写一条断言：从 CSS 里解析出三个层级做大小比较。
- **同一块图别同时挂两种手势**：如果这张图原来是「双击/长按复制地址」，现在又要「点击放大」，
  先把它从复制选择器里摘掉，复制改由查看器工具条上的显式按钮提供 —— 否则一次长按会「复制 + 打开」双响。

## 四、数据库侧加固（RLS，必须提醒用户手动执行）

前端加固只是第一道门。若后端是 Supabase/PostgREST：

```sql
-- 1) 公开 anon key 的场景：必须收回未登录权限
revoke all on public.<table> from anon;

-- 2) 角色判断函数（security definer 避免 RLS 自引用递归）
create or replace function public.my_role() returns text
language sql security definer stable set search_path = public as $$
  select role from public.<users_table> where email = auth.jwt() ->> 'email' $$;
-- 再派生 is_member() / can_write() / is_admin()

-- 3) 逐表策略：select 给 member，insert/update/delete 给 can_write()，删表/删人给 is_admin()
-- 4) 自检：rls_enabled_tables 应等于表数，anon_grants 应为 0
select (select count(*) from information_schema.role_table_grants
         where grantee='anon' and table_schema='public') as anon_grants;
```

⚠️ **DDL 无法通过 PostgREST/service key 执行**，只能让用户在 Dashboard SQL Editor 手动跑 → 交付时明确写「待你执行」。

## 五、交付前必须留的回归测试（静态断言 + 纯函数）

不要只跑一次就完事。把这次的每一条修复都变成断言，写进 `test_security_*.js`，从源文件里**抽取真实函数**运行（比手写复现靠谱）：

- 纯函数：`safeUrl` / `safeSrc` / `esc` 的正例与**绕过用例**（大小写、`java\nscript:`、前导空白、`data:text/html`）；取值函数（`data-copy` 优先、只取第一行、不带上标签）。
- 静态断言（直接 `indexOf` 源文件）：
  - `href="' + esc(` / `src="' + esc(` 的**出现次数必须为 0**；
  - `target="_blank"` 总数 == `target="_blank" rel="noopener noreferrer"` 总数；
  - CSP 里有 `object-src 'none'` / `base-uri` / `connect-src`；
  - 源码里搜不到第三方 CDN 域名；`vendor/` 文件存在且体积正常；
  - 搜不到越权兜底分支（如 `role = 'admin'` 的容错写法）；
  - 每个写函数名出现处 ±300 字符内必须能找到 `deny`；
  - 复制修复点（有 `preventDefault`、有 `ok === true`、有长按、有 `data-copy`）；
  - 内存修复点（有 `removeEventListener`、有 `closeDetail`、缓存有上限）。
- 静态断言的价值：**下次有人（包括未来的你）改回旧写法时会立刻红**。

## 六、表格 / 列表类改动：一处改了必须同步的地方（附布局陷阱）

单文件 SPA 里「加一列 / 挪一列 / 改一个单元格」是最高发的低级事故来源，因为同一份结构散落在 5~6 处。
**动手前先按这张表列清单，改完逐项打勾**：

| 位置 | 漏了会怎样 |
|---|---|
| `<thead>` 的 `<th>` 列表 | 表头少一列，整表右移错位 |
| 空态 `colspan` | 空数据时那一行宽度不对，表格塌陷 |
| 行模板的 `<td>` 顺序 | 数据整体错位（**最隐蔽**：页面不报错，看上去只是「数据怪怪的」） |
| 导出 CSV 的表头数组 + 行数组 | 用户拿去做二次分析时错列 |
| 提示文案 / tooltip | 说明与界面不符 |
| 回归测试里的列数断言 | 下次再漏时没人拦得住 |

**最省事的做法**：写完立刻补一个「结构断言测试」，别靠肉眼。最小可用断言集：

- `表头 <th> 个数 == 行模板里 '<td 出现次数 == 空态 colspan`（三者交叉校验）
- 列序写成期望数组逐项相等（比人眼可靠，且能防「挪错位置」）
- **反向断言**：被挪走的单元格的旧写法在源码里**搜不到**（证明真删了，而不是没改）
- **抽取自检**：断言「抽出来的片段长度合理 / 含预期特征」，否则锚点失配会让测试在空字符串上全绿

### 布局陷阱 ①：自动表格布局会把富余宽度「按内容长度」分配

`table{width:100%}` + 默认 `table-layout:auto` 时，浏览器把多余宽度按各列内容长度**成比例**分下去。
后果：内容最长的那列被撑得最开，与相邻列之间空出一大段 —— 用户的描述通常是「这两列间隔太远」。
典型触发场景：表里有个「精确到秒的时间戳」列，它永远是最长的那个。

修法二选一：

- **要整齐**（推荐）：`table-layout:fixed` + 在 `thead` 的每个 `<th>` 上写 `width`（固定布局只认第一行宽度）。
  留**一列不写宽度**当弹性列吸收剩余空间；给表一个 `min-width` 兜底，外层容器 `overflow-x:auto` 负责横向滚动。
  要点：**所有固定宽度的和必须 < `min-width`**，否则弹性列会被挤成 0。
- **要最小改动**：只给「最长的那个列」写 `width:1px`。自动布局下它会收缩到内容宽度，富余宽度转给其它列。
  缺点：结果不如固定布局可预期。

### 布局陷阱 ②：`vertical-align` 默认是 `top`

带头像 / 勾选框的行会顶部对齐，多行文本时错位明显。
**注意**：基础 `td{}` 规则是全局的，直接改会影响其它所有表。正确做法是**给目标表加类名再覆盖**
（`.<table类> th,.<table类> td{vertical-align:middle}`），并在测试里断言「基础规则没被改动」。

### 布局陷阱 ③：固定布局下 `white-space:nowrap` 不会撑开列

固定布局里内容超出列宽会**溢出到隔壁列**，不会被撑开。所以：

- 每列宽度要按**最长内容**留量（把「曾排除(已移出)」这类最长标签、`1.2w` 这类格式化结果都算进去）；
- 给 `th,td` 加 `overflow:hidden;text-overflow:ellipsis` 兜底；
- 单元格里是标签/胶囊元素时，还要给它自己加 `max-width:100%`，否则会从中间被硬切断。

### 顺手一条：别把两个语义塞进同一个单元格

「昵称 + 粉丝量」这种一格两行的写法，会让该列按最长的那部分被撑宽、挤压其它列，
而且粉丝量无法单独排序/筛选。**拆成独立列通常既好看又更好用** —— 代价只是上面那张清单要逐项走一遍。

### 离线视觉验收（不想为此装几百 MB 的浏览器时）

改完布局想「看一眼」，但线上要登录、装 headless 浏览器又太重：
写一个 `_make_preview.js`，从 `index.html` 里**抽真实的 `<style>` 和真实的 `<thead>`**，
配上几行手写的合成数据，输出一个离线 HTML（放在部署目录**之外**，避免污染线上）。
用真浏览器打开即可验收。

合成数据的要点：**故意放最长文案**（超长昵称、`w` 单位的数字、最长的状态标签、缺值的 `—` 分支），
否则验不出「宽度够不够」；再放一行**全字段正常**的和一行**多字段缺失**的，覆盖两种极端。

> 顺带说：本机 Chrome/Edge 其实可以直接无头跑（`--dump-dom` / `--screenshot`），
> 能顺便把**交互**也自动化验证掉（点击、拖拽、Esc 优先级、图片 onload 时序）——
> 见技能 **`headless-ui-selftest`**（含三件套脚本模板与 6 个实测坑）。

## 七、流程总结（照做即可）

1. 先读 `head`（依赖、CSP）→ 再读 `innerHTML` 拼接点 → 再读事件注册点 → 最后读写操作入口。
2. 用 `grep` 找全所有 URL 出口：`href="' +|src="' +|\.href =|\.src =|setAttribute\('poster'`。
3. 一次性替换为白名单函数，别留半途。
4. 加密/权限/兜底逐项改完，立刻 `node --check` 等价手段 + 跑全部回归。
5. 部署后**必须抓线上页面核验关键词**（本地对了不等于线上对了：缓存、漏传文件、部署目录搞错都可能）。
6. 给用户一份明确的「还需要你手动做的事」清单（例如执行 RLS 迁移 SQL）。
