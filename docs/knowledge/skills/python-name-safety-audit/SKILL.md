---
name: python-name-safety-audit
description: 用 AST 静态体检找出「变量没初始化就被读」这类必崩 bug（C1 NameError / C2 UnboundLocalError），跨文件一次扫完并带反向自证。当出现「某功能整个不生效但测试全绿」「每轮/每次调用在收尾处崩溃」「代码里某个变量只被 += 过、从没赋值」「UnboundLocalError: cannot access local variable」「NameError: name X is not defined」，或要给项目加一条「名字对不上」的产线守卫时使用。含三条必须处理的误报源（except-as 的 e / 闭包 / lambda 形参）和「行为级验证」方法（把真实代码块抠出来 exec，而不是只断言源码里有那行字）；并覆盖静态分析看不到的两个假绿：抠出来的**切片被撑大**后在测试基座里 UnboundLocalError（整个文件崩掉、一条断言都不打）、以及回归 runner 把「崩溃文件」当成 0 个失败（于是 FAIL 0 是假的）。
agent_created: true
---

# Python 名字安全静态体检（C1 NameError / C2 UnboundLocalError）

## 何时用

有些 bug **运行时才炸、但所有测试都是绿的**，因为没有任何一条断言在查它：

- 「某个功能整个不生效，可单元测试全过」
- 「每一轮 / 每次调用都在**收尾处**崩，前面都正常」
- 日志里出现 `UnboundLocalError: cannot access local variable 'x'`
- 代码里某个变量**只被 `+=` 过，从来没赋过初值**
- 某个名字是**拼错/改过名**的（前端同源家族：`closeCtFix()` 调了个叫 `ctFixClose()` 的函数）

真实案例（2026-09-21）：`app_scan.py` 的 `invalid_count` **只被引用、从未初始化**。
后果不是「一个数字少了」，而是：每轮收尾汇总一读它就 `UnboundLocalError` → 进程 `exit=1`
→ 上层监听器按「异常退出」`break` → 「最多 4 轮」永远只跑 1 轮 → **一整天的产出砍到 1/4**。
而当时的全部测试（1600+ 条断言）都是绿的。

> **同一个 bug 家族**：名字对不上 / 变量没初始化。一律用静态分析提前拦，别等线上。

## 怎么跑

```bash
python <skill>/scripts/name_audit.py src/ app.py      # 扫指定目录/文件（可递归）
python <skill>/scripts/name_audit.py                  # 扫当前目录
python <skill>/scripts/name_audit.py --self-test      # 只跑反向自证
python <skill>/scripts/name_audit.py --quiet --all .  # 只报问题、且不跳过 test_/_bak_
```

退出码 `0` = 全通过；`1` = 有 C1/C2（或自证失败）。可直接接进 CI / 回归脚本。

两条判据：

| 判据 | 含义 | 后果 |
|---|---|---|
| **C1** | 读到某名字，本作用域没赋值、外层与模块级也没有 | `NameError` |
| **C2** | 某名字**只有增广赋值**（`+=`），没有一次普通赋值/形参 | `UnboundLocalError`（`+=` 自己就要先读旧值）|

C2 还有一个变体：**有普通赋值，但它出现在第一次增广赋值之后** → 同样是先读后写。
脚本两种都报。

## ★ 三条必须处理的误报源（首版 90+ 条误报全是它们）

1. **`except X as e:` 里的 `e`**
   在 AST 上是 `ExceptHandler.name`，是个**字符串字段，不是 `Name` 节点**。
   不显式处理 → 每个 `except ... as e` 都误报「`e` 未定义」。
   处理：写 `visit_ExceptHandler`，把 `node.name` 手动记成一次「存」。

2. **闭包变量是合法的**
   嵌套函数读外层的局部变量完全合法。**作用域递归必须带「外层环境」**，
   且每进一层要把「本层所有绑定」加进内层可见集。
   处理：`iter_scopes(tree)` 里 `walk(node, enclosing)`，进函数时传
   `enclosing | module_names`，再往下传 `enclosing | 本层所有 plains/augs/globals`。
   不做这件事 → 一个大文件里几十条误报，体检直接废掉。

3. **lambda 形参要算进外层**
   `sorted(xs, key=lambda n: n.k)` —— `n` 是 lambda 的形参，但写 `visit_Lambda`
   时如果不把它记进外层账本，就会误报 `n` 未定义。

另外两条**有意为之的保守**（宁漏不误报，写在脚本 docstring 里）：
推导式的循环变量也算进外层；`del X` 不产生「已赋值」。

## ★★ 加进项目后必须先做「反向自证」

一个全绿的体检**可能只是因为它什么都没查**。所以脚本内置 `self_test()`：
临时造两个文件喂给自己 ——
一个含**真 bug 的最小复现**（必须报出来），一个含各种**合法写法**（必须零误报）。
跑不过就说明体检本身失效，别信它的绿。

同类教训：一条只查「某个字符串出现过没」的断言，真正出错时照样绿；
一条只锚公共类名的浏览器断言，分支一改就假红。**双向量具才可信。**

## ★★ 行为级验证：抠真实代码块 `exec`，而不是断言「源码里有那行字」

加完修复之后，不要停在「源码里出现了 `x = 0`」。把**那段真实代码**从产线文件里抠出来
`exec`，在「有修复 / 无修复」两种环境各跑一次：

```python
src = open('app_scan.py', encoding='utf-8').read()
# 用**唯一文案**反查，别用可能多次出现的关键字
k = src.index('其中未达标 {invalid_count} 条')
i = src.rindex('elif mcfg is not None:', 0, k)
start = src.rindex('\n', 0, i) + 1          # ★ 退到行首，否则抠出来的块没缩进
end = ...
block = textwrap.dedent(src[start:end])
# 无初始化 → 必须抛 UnboundLocalError 且消息含 invalid_count
# 有初始化 → 必须返回 ok
```

两个坑：

- `str.index("elif mcfg is not None:")` 会命中**行中间**，抠出来的是没缩进的半行 →
  必须 `rindex("\n", 0, i) + 1` 退到行首。
- 同一个关键字在文件里**可能出现多次**（嵌套函数、多个分支）→ 先用**唯一文案**定位，
  再用 `rindex` 反查最近的锚点。

## ★★ 「抠出来跑」的第 4 个坑：切片被**撑大** ⇒ 崩在基座里，回归还报 FAIL 0

抠函数跑有个静态分析**看不到**的失败面：抠的是一段**字符串区间**，端点不是语义边界。
只要有人往这个区间里插代码，抠出来的块就换了个东西 —— 而 AST 工具扫的是**源文件**、
不是那个块，所以本技能完全查不到它。

实测（2026-09-24，`test_watch_device.py`）：切片本来是「设备门禁 → `if busy:`」。
后来在两者之间插进了整段「📥 刷新数据」分支，那段末尾有一句
`pend = [r for r in pend if ...]` ⇒ 被一起抠进 `def gate():` ⇒ `pend` 在该函数里
变成**局部变量**、却读在赋值之前 ⇒ `UnboundLocalError`。后果不是「一条断言红」：

- 整个文件**一条断言都不打**（执行期抛异常，连汇总行都没机会打印）；
- 回归表里只显示 `解析失败`，而 runner 又把「没解析到汇总行」当 0 个失败 ⇒
  **「断言合计：FAIL 0」照样打出来**。两个假绿叠在一起，这文件坏一个月也没人知道。

四个固定件（照抄）：

1. **切片端点用「语义标记」，别用「碰巧排在后面的那句」**：本例端点改到刷新分支的注释头。
2. **给切片加守卫**：`'is_refresh_run' not in SLICE and len(SLICE) < 900` —— 撑大就红。
3. **`try` 必须连「调用」一起包住**：
   ```python
   try:
       exec('def gate():\n    global _last_dev_log\n' + body + '\n    return "CONTINUE"\n', ns)
       return ns['gate'](), logs, hb        # ★ UnboundLocalError 在**这一行**才抛
   except Exception as e:
       return '<EXC:%s>' % type(e).__name__, logs, hb
   ```
   `pend` 是不是局部变量是**编译期**决定的、异常在**调用**时抛出 ⇒ 只包 `exec` 包不住
   （实测又踩一次）。兜住之后坏版变成「D 段几条红」，而不是「文件消失」。
4. **runner 必须把「整个文件崩掉」计入失败** —— 见下一节。

## ★★ 回归 runner 的假绿：崩掉的测试文件不算失败

```python
bad = int(m.group(2)) if m else -1      # -1 = 没解析到汇总行 = 这个文件崩了
total_ok += ok
if bad > 0:                             # ← ← ← 就是这里
    total_bad += bad
```
`-1` 恒不满足 `> 0` ⇒ 崩掉的文件贡献「0 断言 / 0 失败」⇒ 报告里的 `FAIL 0` 是**假的**。
实测：`test_watch_device.py` 崩掉时，回归表只显示「解析失败」，总结行仍写 `FAIL 0`。

```python
if bad < 0:
    crashed.append(f); total_bad += 1   # 崩掉的算 1 个失败，并单独列出文件名
elif bad > 0:
    total_bad += bad
...
sys.exit(1 if total_bad else 0)         # 有失败时退出码非 0，CI/自动化才看得见
```

自证方法（可复算）：临时放一个 `raise` 的 `test_zzz_xxx.py`，跑 runner ——
旧版报 `FAIL 0`，新版报 `FAIL 1` 并列出文件名。**先证「工具会红」，再谈「结果是绿」。**

## 跨语言对照

| 语言 | 工具 | 能查 C1 | 能查 C2 |
|---|---|---|---|
| Python | 本脚本（AST） | ✅ | ✅ |
| Python | `pyflakes` / `ruff F821,F823` | ✅ | F823 部分覆盖 |
| JavaScript | ESLint `no-undef` / `no-use-before-define` | ✅ | ⚠️ TDZ 需 `no-use-before-define` 配 `temporalDeadZone` |
| JavaScript | `node --check` | ❌ | ❌ |

⚠️ **`node --check` 查不出这类问题**（它只查语法）。前端若不想上 ESLint，
可退一步做「**悬空引用体检**」：正则扫内联 `<script>` 段，把 `foo(` 形式的调用名与
`function foo` / `const foo =` 的声明名做差集。
⚠️ 必须**只扫 `<script>` 段**，否则 CSS 里的 `minmax(` / `rgba(` 会满屏误报。

## 接到项目回归里

- 单独一个文件（如 `test_py_name_safety.py`），被全量回归 runner 自动收集；
  **断言数要计入总盘**（本例：108 条），全量回归的总数随之更新。
- 脚本的 `--quiet` 不要用在产线断言里（保留逐文件 ✓ 便于定位）。
- 扫的范围**排除临时件**（`test_` / `_bak_` / `_diag_` / `_fix_` / `_probe_`），
  否则扫到故意留的坏样本会一直红。

## 实测记录（可复算）

- `app_scan.py` 修前：本体检报出 `invalid_count` C2；修后 0。
- `run_rounds.py`：**顺手抓到第三个真 bug** —— 风控熔断路径引用从未定义的
  `timedelta` 与 `ABORT_COOLDOWN_H`，一执行就 `NameError`；更糟的是中止标志还没落盘
  进程就退了 → 下次唤醒**继续跑**，在风控已触发时继续撞验证码（账号风险）。
- 该项目最终：`test_py_name_safety.py` **PASS 108 / FAIL 0**，反向自证 ✓；
  全量回归 **PASS 1816 / FAIL 0 / 49 文件**。
- 得物项目（2026-09-24）：本技能查不到的那一半家族真的发生了 —— 切片撑大 ⇒ 基座里
  `UnboundLocalError` ⇒ `test_watch_device.py` 整个文件崩、回归仍报 `FAIL 0`。
  修完两处（切片端点 + runner 计崩溃）后：该文件 **PASS 33 / FAIL 0**，
  全量回归 **PASS 2581 / FAIL 0（68 文件）**，且故意造崩的文件能被 runner 报成 `FAIL 1`。
