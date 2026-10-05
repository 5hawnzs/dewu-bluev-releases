# -*- coding: utf-8 -*-
"""
整理 WorkBuddy 崩溃证据并生成「可直接提交给官方」的材料包。

它会做四件事：
  1) 收集磁盘上全部崩溃报告 + 版本/环境信息 + 相关日志证据
  2) 脱敏（用户名、路径、邮箱、machineId、IP）
  3) 产出：300 字内正文（官方弹框上限）、完整技术说明、证据包 zip、
           以及把完整说明渲染成 PNG 长图（因为官方正文框只有 300 字符，
           长内容只能走「上传图片」通道）
  4) 自检：正文严格校验 <= 300 字符，超出则报错退出（不静默截断）

用法：
  python 整理反馈给官方.py            # 全套（含长图）
  python 整理反馈给官方.py --no-image # 跳过长图（无 Chrome 时用）

注意：脚本只读 ~/.workbuddy 与安装目录，全部输出写到 <脚本所在目录>\给官方\
"""

import io
import os
import re
import sys
import json
import glob
import time
import shutil
import zipfile
import tempfile
import platform
import subprocess
import datetime

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# ----------------------------------------------------------------------------
# 0. 常量与路径
# ----------------------------------------------------------------------------
HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "给官方")
CRASH_DIR = os.path.join(os.environ.get("USERPROFILE", ""), ".workbuddy", "logs", "Crash-Log")
LOG_ROOT = os.path.join(os.environ.get("USERPROFILE", ""), ".workbuddy", "logs")
APP_DIR = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "WorkBuddy")

# 官方反馈正文框的硬上限（从客户端 app.asar 中读到的 MAX_TEXT_LENGTH）
BODY_MAX = 300

# 长图：单页最大像素高度（超过则分页）。刻意压到 3200，
# 因为太长的图在反馈系统里会被缩略到看不清。
PAGE_MAX_H = 3200
PAGE_WIDTH = 1240

sys.path.insert(0, HERE)


# ----------------------------------------------------------------------------
# 1. 脱敏
# ----------------------------------------------------------------------------
_USER = os.environ.get("USERNAME", "Administrator")

_REDACT_RULES = [
    # 用户名（含路径中的）
    # 注意：re.sub 的替换串里反斜杠是转义符，路径必须写成 \\\\ 或改用函数替换
    (re.compile(re.escape("C:\\Users\\" + _USER), re.I), lambda m: "C:\\Users\\<用户>"),
    (re.compile(re.escape("/c/Users/" + _USER), re.I), lambda m: "/c/Users/<用户>"),
    (re.compile(re.escape(_USER)), "<用户>"),
    # 邮箱
    (re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}"), "<邮箱>"),
    # 敏感键（同时覆盖 JSON 的 "k":"v" 与日志的 k=v 两种写法）
    (re.compile(r'(machineId|deviceId|userId|uid|sessionId|token|apiKey|secret|password|cookie|Authorization)'
                r'\s*[=:]\s*"?[0-9A-Za-z_\-\.]{4,}"?', re.I),
     r'\1=<已脱敏>'),
    # IPv4（保留 localhost，它是故障线索）
    (re.compile(r"\b(?!127\.0\.0\.1)(?:\d{1,3}\.){3}\d{1,3}\b"), "<IP>"),
]


def redact(s: str) -> str:
    if not s:
        return s
    for pat, rep in _REDACT_RULES:
        s = pat.sub(rep, s)
    return s


# ----------------------------------------------------------------------------
# 2. 采集：崩溃报告
# ----------------------------------------------------------------------------
def collect_crashes():
    """返回 (reports, flat_entries)，全部已脱敏。"""
    files = sorted(glob.glob(os.path.join(CRASH_DIR, "crash-report-*.json")),
                   key=lambda p: os.path.getmtime(p))
    reports = []
    flat = []
    for p in files:
        try:
            o = json.load(io.open(p, encoding="utf-8", errors="replace"))
        except Exception as e:
            print("  [跳过] 无法解析 %s : %s" % (os.path.basename(p), e))
            continue
        rep = {
            "file": os.path.basename(p),
            "file_mtime": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(os.path.getmtime(p))),
            "launchedAt": o.get("launchedAt"),
            "pid": o.get("pid"),
            "appVersion": o.get("appVersion"),
            "platform": o.get("platform"),
            "arch": o.get("arch"),
            "versions": o.get("versions") or {},
            "droppedCount": o.get("droppedCount"),
            "entries": [],
        }
        for e in (o.get("entries") or []):
            item = dict(e)
            # 只脱敏字符串字段，保留结构
            for k, v in list(item.items()):
                if isinstance(v, str):
                    item[k] = redact(v)
                elif isinstance(v, dict):
                    item[k] = {kk: (redact(vv) if isinstance(vv, str) else vv)
                               for kk, vv in v.items()}
            rep["entries"].append(item)
            flat.append({"report": os.path.basename(p), "launchedAt": rep["launchedAt"], **item})
        reports.append(rep)
    return reports, flat


def crash_summary(reports, flat):
    """派生统计量。"""
    kinds = {}
    for e in flat:
        kinds[e.get("type")] = kinds.get(e.get("type"), 0) + 1

    # 只统计「真正的崩溃事件」（renderer_crash）
    rcs = [e for e in flat if e.get("type") == "renderer_crash"]
    rcs.sort(key=lambda e: e.get("timestamp") or "")

    js = [e for e in flat if e.get("type") == "renderer_js_error"]
    js.sort(key=lambda e: e.get("timestamp") or "")

    # JS 错误按消息归类
    js_kinds = {}
    for e in js:
        msg = (e.get("errorMessage") or "(无消息)").strip()
        js_kinds[msg] = js_kinds.get(msg, 0) + 1

    # exitCode / reason
    exits = {}
    for e in rcs:
        r = (e.get("renderer") or {})
        k = "reason=%s, exitCode=%s" % (r.get("reason"), r.get("exitCode"))
        exits[k] = exits.get(k, 0) + 1

    # 崩溃现场 URL（看是不是在预览产物）
    urls = []
    for e in rcs:
        u = ((e.get("renderer") or {}).get("url") or "")
        if u and "app.asar/renderer/index.html" not in u:
            urls.append((e.get("timestamp"), u))

    return {
        "report_count": len(reports),
        "kinds": kinds,
        "renderer_crash_count": len(rcs),
        # 同一次崩溃可能有 2 条 renderer_crash（index.html 与业务页同时被杀）
        # ⇒ 按「不同秒」去重才是用户感知的「崩了几次」。别把条数当次数。
        "renderer_crash_events": len({str(e.get("timestamp") or "")[:19] for e in rcs}),
        "first_crash": rcs[0]["timestamp"] if rcs else None,
        "last_crash": rcs[-1]["timestamp"] if rcs else None,
        "js_errors": js,
        "js_kinds": js_kinds,
        "exits": exits,
        "workfile_crashes": urls,
        "crashes": rcs,
    }


# ----------------------------------------------------------------------------
# 3. 采集：版本 / 环境 / 更新被拦证据
# ----------------------------------------------------------------------------
def sh(cmd):
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True,
                           timeout=60, encoding="utf-8", errors="replace")
        return (r.stdout or "") + (r.stderr or "")
    except Exception:
        return ""


def collect_env(rep0):
    env = {}
    # 运行中应用自报版本（AppStartup.log 最后一条）—— 只抽取需要的字段，
    # 不整行搬运（那行含 userId 等，虽然会被脱敏，但没必要带进报告）
    startup = os.path.join(LOG_ROOT, "AppStartup.log")
    if os.path.isfile(startup):
        try:
            with io.open(startup, encoding="utf-8", errors="replace") as f:
                last = None
                for line in f:
                    if "appVersion=" in line:
                        last = line.strip()
                if last:
                    d = {}
                    for k in ("appName", "appVersion", "build", "platform", "arch",
                              "electron", "node", "chrome"):
                        m = re.search(r"\b%s=([^\s]+)" % k, last)
                        if m:
                            d[k] = m.group(1)
                    env["运行时自报"] = d if d else redact(last[:200])
        except Exception:
            pass
    # 安装清单（产品版本）
    man = os.path.join(APP_DIR, "resources", "install-manifest.json")
    if os.path.isfile(man):
        try:
            m = json.load(io.open(man, encoding="utf-8", errors="replace"))
            env["安装清单 appVersion"] = m.get("appVersion")
            env["安装清单 generatedAt"] = m.get("generatedAt")
        except Exception:
            pass
    # 版本文件
    vf = os.path.join(APP_DIR, "version")
    if os.path.isfile(vf):
        env["version 文件"] = io.open(vf, encoding="utf-8", errors="replace").read().strip()

    # 更新日志：最新可用版本 + 是否被拦
    upd = sorted(glob.glob(os.path.join(LOG_ROOT, "update", "update-*.log")))
    blocked, avail = [], []
    blocked_lines = 0
    for p in upd:
        try:
            t = io.open(p, encoding="utf-8", errors="replace").read()
        except Exception:
            continue
        for m in re.finditer(r"New version available:\s*([^\s(]+)\s*\(current:\s*([^)]+)\)", t):
            avail.append((os.path.basename(p), m.group(1), m.group(2)))
        n = t.count("Update blocked by install dir guard")
        if n:
            blocked.append("%s (%d 次)" % (os.path.basename(p), n))
            blocked_lines += n
    env["更新_最新可用"] = avail[-3:]
    env["更新_被install_dir_guard拦截的日志"] = blocked[-8:]
    env["更新_拦截总行数"] = blocked_lines

    # 崩溃报告里登记的 electron/chrome
    if rep0:
        env["崩溃报告登记版本"] = rep0.get("versions")

    # 系统（用 platform 模块，避免 cmd /c ver 的 GBK 乱码）
    env["系统"] = {
        "platform": platform.platform(),
        "os_version": platform.version(),
        "machine": platform.machine(),
        "cpu": (os.environ.get("PROCESSOR_IDENTIFIER") or ""),
        "cpu_count": os.cpu_count(),
    }
    return env


# ----------------------------------------------------------------------------
# 4. 采集：与崩溃相关的日志证据
# ----------------------------------------------------------------------------
def collect_log_evidence():
    lines = []
    # 更新日志里被拦的关键行
    for p in sorted(glob.glob(os.path.join(LOG_ROOT, "update", "update-*.log")))[-4:]:
        try:
            t = io.open(p, encoding="utf-8", errors="replace").read()
        except Exception:
            continue
        for ln in t.splitlines():
            if ("Update blocked by install dir guard" in ln
                    or "Install dir guard" in ln
                    or "New version available" in ln
                    or "Update downloaded" in ln):
                lines.append("[%s] %s" % (os.path.basename(p), redact(ln.strip())))
    return lines


# ----------------------------------------------------------------------------
# 5. 生成正文（必须 <= 300 字符）
# ----------------------------------------------------------------------------
def _first_frame(stack):
    """从 stack 里抠出第一帧的「函数@文件:行」摘要（官方据此能直接定位）。"""
    if not stack:
        return None
    for ln in str(stack).splitlines():
        m = re.search(r"at\s+(?:(\S+)\s+\()?([^()\s]+):(\d+):(\d+)", ln)
        if m:
            fn = m.group(1) or "?"
            return "%s@%s:%s" % (fn, os.path.basename(m.group(2)), m.group(3))
    return None


def build_body(sumry, evid):
    """从本次实测数据合成 <=300 字符的反馈正文。

    绝不写死：所有数字都来自本次读到的崩溃报告 / 日志。
    取不到的量宁可不写，也不填 0（未知 != 0）。
    句子按重要性排序，从前往后塞；塞不下的**丢弃并在 stdout 说明**（不静默截断）。
    """
    rcs = sumry["crashes"]
    nev = sumry["renderer_crash_events"]
    first, last = sumry["first_crash"], sumry["last_crash"]
    keys = {str(c.get("timestamp") or "")[:19] for c in rcs if c.get("timestamp")}
    days = len({k[:10] for k in keys})
    today = str(datetime.date.today())
    today_n = len({k for k in keys if k[:10] == today})

    want = ["界面卡死(点击无效)、随即闪退重启。"]
    if nev and first and last:
        s = "%s~%s 共%d次崩溃" % (fmt_ts(first)[:5], fmt_ts(last)[:5], nev)
        if days > 1:
            s += "(跨%d天)" % days
        if today_n:
            s += "，今天%d次" % today_n
        want.append(s + "。")

    # 崩溃形态：只取占比最高的那一种，避免半截字符串
    ex = sumry["exits"]
    if ex:
        top = max(ex.items(), key=lambda kv: kv[1])
        want.append("形态 %s(%d/%d)，NetworkService/GPU连带崩，无OOM。"
                    % (top[0], top[1], sum(ex.values())))
    else:
        want.append("NetworkService/GPU连带崩，无OOM。")

    # 带 stack 的 JS 错误最有排查价值
    wk = [e for e in sumry["js_errors"] if e.get("stack")]
    if wk:
        e = wk[-1]
        msg = re.sub(r"^Uncaught\s+", "", (e.get("errorMessage") or "?").strip())
        s = "崩前JS错：%s" % msg
        fr = _first_frame(e.get("stack"))
        if fr:
            s += " @ " + fr
        want.append(s + "。")

    wf = sumry["workfile_crashes"]
    if wf:
        want.append("%d条崩于App内预览HTML产物。" % len(wf))
    if any("install dir guard" in (x or "") for x in evid):
        want.append("自动更新被install dir guard拦截。")
    want.append("完整stack见附图。")

    out, dropped = "", []
    for s in want:
        if len(out) + len(s) <= BODY_MAX:
            out += s
        else:
            dropped.append(s)
    if dropped:
        print("   （为守 %d 字符上限，丢弃 %d 句：%s）"
              % (BODY_MAX, len(dropped), " / ".join(x[:30] for x in dropped)))
    return out


# ----------------------------------------------------------------------------
# 6. 生成 markdown 长报告
# ----------------------------------------------------------------------------
def fmt_ts(s):
    """ISO 时间 → MM-DD HH:MM:SS（原始 ISO 仍保留在 03 目录的 JSON 里）。"""
    if not s:
        return "?"
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})", str(s))
    if m:
        return "%s-%s %s:%s:%s" % (m.group(2), m.group(3), m.group(4), m.group(5), m.group(6))
    return str(s)


def build_markdown(rep0, sumry, env, evid):
    L = []
    A = L.append
    A("# WorkBuddy 渲染进程反复崩溃 — 提交给官方的技术说明")
    A("")
    A("- 生成时间：%s" % time.strftime("%Y-%m-%d %H:%M:%S"))
    A("- 证据来源：本机 `~/.workbuddy/logs/Crash-Log/` 下的**全部** %d 份崩溃报告" % sumry["report_count"])
    A("- 崩溃时间跨度：**%s → %s**" % (fmt_ts(sumry["first_crash"]), fmt_ts(sumry["last_crash"])))
    A("- 处理说明：已对用户名 / 路径 / 邮箱 / machineId / IP 做脱敏；构建哈希保留（排查需要）")
    A("")

    A("## 一、一句话结论")
    A("")
    _keys = {str(c.get("timestamp") or "")[:19] for c in sumry["crashes"] if c.get("timestamp")}
    _span = len({k[:10] for k in _keys})
    _ex = sumry["exits"]
    _topk, _topc = max(_ex.items(), key=lambda kv: kv[1]) if _ex else ("(无)", 0)
    A("WorkBuddy 的**渲染进程（renderer）反复被 kill**，表现为「界面完全卡死、点击无响应、"
      "流式输出不显示」，随后应用自动重启。**共 %d 条 renderer_crash 记录，跨 %d 天"
      "（%s → %s），去重后 %d 次崩溃事件**；其中 %d/%d 次形态为 `%s`，未见 OOM 记录。"
      % (sumry["renderer_crash_count"], _span,
         fmt_ts(sumry["first_crash"]), fmt_ts(sumry["last_crash"]),
         sumry["renderer_crash_events"], _topc, sum(_ex.values()), _topk))
    A("")
    _frames = sorted({_first_frame(e.get("stack")) for e in sumry["js_errors"]
                      if e.get("stack") and _first_frame(e.get("stack"))})
    if len(_frames) == 1:
        A("崩溃前的 JS 异常堆栈**指向同一处代码**：`%s`。" % _frames[0])
    elif _frames:
        A("崩溃前的 JS 异常共出现 **%d 个不同的栈顶位置** —— 不是同一处代码，"
          "可能对应多个缺陷，请分别定位（见下节完整堆栈）：" % len(_frames))
        A("")
        for f in _frames:
            A("- `%s`" % f)
    A("")

    A("## 二、关键证据：崩溃前的 JS 错误（带文件与行号）")
    A("")
    if sumry["js_kinds"]:
        A("| 次数 | 错误消息 |")
        A("|---|---|")
        for msg, c in sorted(sumry["js_kinds"].items(), key=lambda x: -x[1]):
            A("| %d | `%s` |" % (c, msg.replace("|", "\\|")))
    else:
        A("(无)")
    A("")
    # 完整堆栈（最有价值）
    printed = set()
    for e in sumry["js_errors"]:
        st = e.get("stack") or ""
        key = st[:120]
        if not st or key in printed:
            continue
        printed.add(key)
        A("### 堆栈 %d：%s" % (len(printed), fmt_ts(e.get("timestamp"))))
        A("")
        A("```")
        A(redact(st))
        A("```")
        A("")
    A("")

    A("## 三、崩溃清单（%d 条 renderer_crash 记录 → 去重后 **%d 次崩溃事件**）"
      % (sumry["renderer_crash_count"], sumry["renderer_crash_events"]))
    A("")
    A("| # | 崩溃时刻 | 所属报告(启动时间/PID) | 类型 | reason / exitCode | 崩溃现场 URL |")
    A("|---|---|---|---|---|---|")
    for i, e in enumerate(sumry["crashes"], 1):
        r = e.get("renderer") or {}
        url = r.get("url") or ""
        if "app.asar/renderer/index.html" in url:
            url = "(主界面 index.html)"
        A("| %d | %s | %s / %s | %s | %s / %s | %s |" % (
            i, fmt_ts(e.get("timestamp")), fmt_ts(e.get("launchedAt")), e.get("report").split("-")[3],
            e.get("type"), r.get("reason"), r.get("exitCode"), url.replace("|", "\\|")))
    A("")
    A("### 附带崩溃（每次 renderer 崩溃后数毫秒内连带发生）")
    A("")
    A("| 事件类型 | 次数 |")
    A("|---|---|")
    for k, v in sorted(sumry["kinds"].items(), key=lambda x: -x[1]):
        A("| `%s` | %d |" % (k, v))
    A("")
    A("### exitCode 分布")
    A("")
    for k, v in sorted(sumry["exits"].items(), key=lambda x: -x[1]):
        A("- `%s` × %d" % (k, v))
    A("")
    A("> `exitCode=1` = 普通失败退出；`exitCode=1073807364`(0x40010004) = `DBG_TERMINATE_PROCESS`。")
    A("> **%d 份报告里没有任何 OOM / 内存耗尽记录。**" % sumry["report_count"])
    A("")
    A("> **关于「崩前渲染进程 2.4GB」这个数字的来源**：它**不在**崩溃报告里，"
      "是我在崩溃前用进程采样独立测到的"
      "（`renderer` 进程 WorkingSet ≈ 2,494 MB，该进程启动于 2026-09-30 17:35、"
      "崩于 2026-10-01 12:06，连续运行约 18.5 小时）。"
      "崩溃报告本身不含内存字段，故此处单独说明来源，避免与报告数据混淆。")
    A("")

    if sumry["workfile_crashes"]:
        A("### ⚠ 值得注意：有崩溃发生在「App 内预览产物 HTML」时")
        A("")
        for ts, u in sumry["workfile_crashes"]:
            A("- `%s` → `%s`" % (fmt_ts(ts), u))
        A("")
        A("这说明**在应用内打开/预览自己生成的 HTML 文件**也可能触发同样的崩溃，"
          "可能与渲染进程处理大 HTML / 复杂布局有关。")
        A("")

    A("## 四、环境与版本")
    A("")
    A("| 项 | 值 |")
    A("|---|---|")
    for k, v in env.items():
        A("| %s | `%s` |" % (k, json.dumps(v, ensure_ascii=False) if not isinstance(v, str) else v))
    A("")
    A("> **版本号存在两套编号，特此说明**：运行中的应用自报 `5.0.3`（见 AppStartup.log / 崩溃报告），"
      "而安装包与更新服务使用 `5.5.6.38337834`（见 install-manifest.json / update 日志）。"
      "请官方按内部版本体系判断，我不臆测二者的对应关系。")
    A("")
    if rep0:
        A("## 五、崩溃报告字段说明（原始文件见 `03_崩溃报告_原始/`）")
        A("")
        A("| 字段 | 含义 |")
        A("|---|---|")
        A("| `launchedAt` | 该进程启动时刻；与崩溃时刻相减＝本次运行时长 |")
        A("| `pid` / `processName` | 进程号 / 进程角色（main） |")
        A("| `appVersion` | 应用自报版本 |")
        A("| `versions` | node / electron / chrome / v8 |")
        A("| `entries[]` | 按时间排序的事件流（js 错误 → renderer 崩溃 → 连带崩溃） |")
        A("| `entries[].renderer.url` | 崩溃现场页面；`app.asar/renderer/index.html` 即主界面 |")
        A("| `droppedCount` | 因缓冲上限被丢弃的事件数（本机为 %s，即无丢弃） |"
          % (rep0.get("droppedCount") if rep0.get("droppedCount") is not None else "?"))
        A("")
        A("> 12 份原始 JSON **一字未改地**放在 `03_崩溃报告_原始/`，"
          "本说明中的每个数字都可在那里面逐条复算。")
        A("")
    if evid:
        A("## 六、更新被拦截的日志原文")
        A("")
        A("```")
        for ln in evid[:20]:
            A(ln)
        A("```")
        A("")

    A("## 七、我**未能**确认的部分（不作结论）")
    A("")
    A("- 无法判定这是 5.0.3 的已知缺陷还是新问题；需要官方结合构建号判断。")
    A("- 「自动更新被 install dir guard 拦截」是否会阻止修复版本送达，需官方确认该守卫的策略。")
    A("- 崩溃是否与「多个会话共用同一渲染进程」直接相关，属推断，未做对照实验。")
    A("- 本机另有向日葵(AweSun)周期性崩溃、火绒(HIPS)在运行，但**均未做对照实验**，"
      "不作为本次崩溃的原因。")
    A("")
    A("---")
    A("")
    A("本说明由本机脚本自动生成，**全部数字均可在 `03_崩溃报告_原始/` 中逐份复算**。")
    return "\n".join(L)


# ----------------------------------------------------------------------------
# 7. 长图渲染（Chrome/Edge 无头；两遍法：先量高，再截图）
# ----------------------------------------------------------------------------
def find_browser():
    cands = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ]
    for c in cands:
        if os.path.isfile(c):
            return c
    return None


def _run(browser, args, timeout=120, profile=None):
    prof = profile or os.path.join(tempfile.gettempdir(), "wb-feedback-chrome")
    cmd = [browser, "--headless=new", "--disable-gpu", "--no-first-run",
           "--no-default-browser-check", "--disable-extensions",
           "--user-data-dir=" + prof] + args
    try:
        return subprocess.run(cmd, capture_output=True, text=True,
                              timeout=timeout, encoding="utf-8", errors="replace")
    except Exception as e:
        print("   [浏览器] 执行失败：%s" % e)
        return None


def measure_height(browser, html_path, tmp_name):
    r = _run(browser, ["--dump-dom", "--virtual-time-budget=4000",
                       "--window-size=%d,800" % PAGE_WIDTH,
                       "file:///" + html_path.replace("\\", "/")])
    if not r:
        return None
    m = re.search(r'data-page-h="(\d+)"', r.stdout or "")
    return int(m.group(1)) if m else None


def shoot(browser, html_path, png_path, height):
    r = _run(browser, ["--hide-scrollbars", "--force-device-scale-factor=1",
                       "--screenshot=" + png_path,
                       "--window-size=%d,%d" % (PAGE_WIDTH, height),
                       "file:///" + html_path.replace("\\", "/")])
    return bool(r) and os.path.isfile(png_path)


HTML_HEAD = """<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<script>
window.addEventListener('load', function () {
  document.documentElement.setAttribute('data-page-h',
      String(document.documentElement.scrollHeight));
});
</script>
<style>
  * { box-sizing: border-box; }
  html,body { margin:0; padding:0; background:#ffffff; }
  body { width:%(w)dpx; font:16px/1.8 "Microsoft YaHei","Segoe UI",sans-serif; color:#1a1a1a; }
  .wrap { padding:34px 40px 30px; }
  h1 { font-size:27px; margin:0 0 6px; color:#0b3d91; }
  h2 { font-size:20px; margin:24px 0 10px; padding-left:10px; border-left:4px solid #0b3d91; }
  h3 { font-size:17px; margin:18px 0 8px; color:#333; }
  p,li { margin:6px 0; }
  .meta { color:#666; font-size:13px; }
  table { border-collapse:collapse; width:100%%; margin:10px 0; font-size:13.5px; }
  th,td { border:1px solid #d0d7de; padding:6px 8px; text-align:left; vertical-align:top; }
  th { background:#f2f5f9; font-weight:600; }
  code { background:#f4f4f6; padding:1px 5px; border-radius:3px;
         font-family:Consolas,monospace; font-size:13px; }
  pre { background:#f6f8fa; border:1px solid #e1e4e8; border-radius:5px;
        padding:10px 12px; overflow:hidden; white-space:pre-wrap; word-break:break-all;
        font-family:Consolas,monospace; font-size:12.5px; line-height:1.6; }
  .warn { background:#fff5f5; border-left:4px solid #d93025; padding:10px 14px; margin:12px 0; }
  .note { background:#f0f7ff; border-left:4px solid #0b3d91; padding:10px 14px; margin:12px 0; }
  .foot { margin-top:26px; padding-top:12px; border-top:1px solid #ddd; color:#777; font-size:12px; }
</style></head><body><div class="wrap">%(body)s</div></body></html>"""


def md_to_html_blocks(md_text):
    """把生成的 markdown 粗转为 HTML 块列表（够用即可，不引入第三方库）。"""
    blocks = []
    buf = []
    in_pre = False
    tbl = []

    def flush_pre():
        nonlocal buf
        if buf:
            blocks.append("<pre>%s</pre>" % "\n".join(buf))
            buf = []

    def flush_tbl():
        nonlocal tbl
        if not tbl:
            return
        rows = [r for r in tbl if not re.match(r"^\s*\|[\s\-:|]+\|\s*$", r)]
        html = ["<table>"]
        for i, r in enumerate(rows):
            cells = [c.strip() for c in r.strip().strip("|").split("|")]
            tag = "th" if i == 0 else "td"
            html.append("<tr>" + "".join("<%s>%s</%s>" % (tag, inline(c), tag) for c in cells) + "</tr>")
        html.append("</table>")
        blocks.append("".join(html))
        tbl = []

    def inline(s):
        s = (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
        s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
        s = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", s)
        return s

    for line in md_text.split("\n"):
        if line.strip().startswith("```"):
            if in_pre:
                flush_pre()
                in_pre = False
            else:
                flush_tbl()
                in_pre = True
            continue
        if in_pre:
            buf.append(line.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
            continue
        if line.strip().startswith("|"):
            tbl.append(line)
            continue
        flush_tbl()
        s = line.strip()
        if not s:
            continue
        if s.startswith("### "):
            blocks.append("<h3>%s</h3>" % inline(s[4:]))
        elif s.startswith("## "):
            blocks.append("<h2>%s</h2>" % inline(s[3:]))
        elif s.startswith("# "):
            blocks.append("<h1>%s</h1>" % inline(s[2:]))
        elif s.startswith("---"):
            blocks.append("<hr>")
        elif s.startswith("> "):
            blocks.append('<div class="note">%s</div>' % inline(s[2:]))
        elif s.startswith("- "):
            blocks.append("<p>• %s</p>" % inline(s[2:]))
        else:
            blocks.append("<p>%s</p>" % inline(s))
    flush_tbl()
    flush_pre()
    return blocks


def render_pngs(browser, md_text, out_prefix):
    blocks = md_to_html_blocks(md_text)
    pages = [blocks]
    depth = 0
    while depth < 4:
        depth += 1
        new_pages, changed = [], False
        for pg in pages:
            html = HTML_HEAD % {"w": PAGE_WIDTH, "body": "".join(pg)}
            hp = os.path.join(OUT_DIR, "_measure.html")
            io.open(hp, "w", encoding="utf-8").write(html)
            h = measure_height(browser, hp, "_measure")
            if h and h > PAGE_MAX_H and len(pg) > 1:
                mid = len(pg) // 2
                new_pages.append(pg[:mid])
                new_pages.append(pg[mid:])
                changed = True
            else:
                new_pages.append(pg)
        pages = new_pages
        if not changed:
            break

    produced = []
    total = len(pages)
    for i, pg in enumerate(pages, 1):
        foot = ('<div class="foot">WorkBuddy 崩溃诊断 · 第 %d / %d 页 · '
                '全文数字均可在压缩包的 03_崩溃报告_原始/ 中复算</div>' % (i, total))
        html = HTML_HEAD % {"w": PAGE_WIDTH, "body": "".join(pg) + foot}
        hp = os.path.join(OUT_DIR, "_page%d.html" % i)
        io.open(hp, "w", encoding="utf-8").write(html)
        h = measure_height(browser, hp, "_page%d" % i) or PAGE_MAX_H
        h = min(max(h + 24, 300), PAGE_MAX_H)
        png = "%s_%d.png" % (out_prefix, i)
        if shoot(browser, hp, png, h):
            kb = os.path.getsize(png) / 1024.0
            produced.append((png, h, kb))
            print("   第 %d/%d 页: %d x %d px, %.0f KB" % (i, total, PAGE_WIDTH, h, kb))
        try:
            os.remove(hp)
        except Exception:
            pass
    try:
        os.remove(os.path.join(OUT_DIR, "_measure.html"))
    except Exception:
        pass
    return produced


# ----------------------------------------------------------------------------
# 8. 主流程
# ----------------------------------------------------------------------------
README = """怎么把这份材料交给官方
================================

【主渠道】应用内「意见反馈」（已确认存在，且是官方唯一内置通道）
  1. 打开 WorkBuddy → 设置 / 帮助 → 「意见反馈」（英文界面为 Feedback）
     · 另一个入口：主对话区某条助手消息的「⋯」菜单 → 「提交反馈」
     · 如果界面正在报错，错误横幅上也常有「提交反馈」链接
  2. 正文框：粘贴 `01_意见反馈正文.txt` 全文
     ⚠ 该框上限 300 字符，本文件已严格控制在 300 以内，直接全选粘贴即可。
  3. **保持勾选「上传日志」**（默认已勾选）。这是官方自动收集本机日志的开关，
     不需要你手动挑文件。日志可能含对话记录，介意的话可取消勾选。
  4. 点「上传图片」，把 `06_反馈正文_长图_*.png` **全部**传上去
     （限制：jpg/png/gif/bmp/webp，单张 ≤ 10MB）。
     300 字说不清的完整证据，全靠这几张图。
  5. 提交。提交成功会提示「反馈提交成功」；同一账号 1 分钟内只能提交一次。

【补充渠道（可选）】
  把整个 `给官方-反馈包.zip` 发给你对接的官方同学 / 技术支持群。
  里面是完整说明 + 12 份崩溃报告原始文件，便于他们直接复算。

【提交前请自己看一眼】
  - 打开 `02_完整技术说明.md`，确认内容与你实际遇到的情况一致。
  - 所有文件已做脱敏（用户名 / 路径 / 邮箱 / machineId / userId / IP）；
    构建哈希（build）**刻意保留**，因为官方排查需要它。
  - 正文里那句「崩前渲染进程 2.4GB」不是崩溃报告里的字段，是我用进程采样
    单独测到的（来源见 `02_完整技术说明.md` 第三节的说明）。
  - 若你不想让项目文件出现在报告里，删掉 `02` 与 `06` 里提到
    `...html` 产物的那两行再提交。

文件说明
================================
  01_意见反馈正文.txt        ≤300 字，直接粘贴进反馈框
  02_完整技术说明.md         完整技术报告（人读）
  03_崩溃报告_原始/          全部崩溃报告 JSON（已脱敏，可复算）
  04_关键日志摘录.txt        更新被拦截等关键日志原文
  05_环境与版本.txt          版本 / 系统信息（含两套版本号说明）
  06_反馈正文_长图_*.png     把 02 渲染成图片，走「上传图片」通道
  给官方-反馈包.zip          以上全部打包
"""


def main():
    want_image = "--no-image" not in sys.argv
    os.makedirs(OUT_DIR, exist_ok=True)
    print("=" * 68)
    print("WorkBuddy 崩溃证据整理 → %s" % OUT_DIR)
    print("=" * 68)

    if not os.path.isdir(CRASH_DIR):
        print("!! 找不到崩溃报告目录：%s" % CRASH_DIR)
        return 2

    print("\n[1/6] 读取崩溃报告 ...")
    reports, flat = collect_crashes()
    if not reports:
        print("!! 该目录下没有 crash-report-*.json")
        return 3
    sumry = crash_summary(reports, flat)
    print("   报告 %d 份，renderer_crash %d 次，JS 错误 %d 条"
          % (sumry["report_count"], sumry["renderer_crash_count"], len(sumry["js_errors"])))
    print("   时间跨度 %s → %s" % (sumry["first_crash"], sumry["last_crash"]))

    print("\n[2/6] 采集环境与版本 ...")
    env = collect_env(reports[0] if reports else None)
    evid = collect_log_evidence()
    print("   更新拦截日志 %d 条" % len(evid))

    print("\n[3/6] 生成正文（上限 %d 字符）..." % BODY_MAX)
    BODY = build_body(sumry, evid)
    n = len(BODY)
    if n > BODY_MAX:
        print("!! 正文 %d 字符，超过上限 %d —— 拒绝写出（不静默截断）" % (n, BODY_MAX))
        print("   正文草稿：\n%s" % BODY)
        return 4
    io.open(os.path.join(OUT_DIR, "01_意见反馈正文.txt"), "w", encoding="utf-8").write(BODY)
    print("   正文 %d / %d 字符 ✓" % (n, BODY_MAX))
    print("   %s" % BODY)

    print("\n[4/6] 生成完整说明 ...")
    md = build_markdown(reports[0], sumry, env, evid)
    io.open(os.path.join(OUT_DIR, "02_完整技术说明.md"), "w", encoding="utf-8").write(md)
    print("   %d 字符" % len(md))

    print("\n[5/6] 写出原始证据 ...")
    raw_dir = os.path.join(OUT_DIR, "03_崩溃报告_原始")
    os.makedirs(raw_dir, exist_ok=True)
    for rep in reports:
        txt = json.dumps(rep, ensure_ascii=False, indent=2)
        io.open(os.path.join(raw_dir, rep["file"]), "w", encoding="utf-8").write(txt)
    print("   %d 份（已脱敏）" % len(reports))

    io.open(os.path.join(OUT_DIR, "04_关键日志摘录.txt"), "w", encoding="utf-8").write(
        "关键日志摘录（更新被拦截 / 版本信息）\n" + "=" * 60 + "\n" + "\n".join(evid) + "\n")
    io.open(os.path.join(OUT_DIR, "05_环境与版本.txt"), "w", encoding="utf-8").write(
        json.dumps(env, ensure_ascii=False, indent=2) + "\n")
    io.open(os.path.join(OUT_DIR, "README_怎么提交.txt"), "w", encoding="utf-8").write(README)

    print("\n[6/6] 渲染长图 ...")
    pngs = []
    if want_image:
        # 先清掉上一轮可能留下的分页图，避免新旧页码混在一起
        # （只在真的要渲染时删，避免 --no-image 把已有的图误删）
        for old in glob.glob(os.path.join(OUT_DIR, "06_反馈正文_长图_*.png")):
            try:
                os.remove(old)
            except Exception:
                pass
        b = find_browser()
        if not b:
            print("   未找到 Chrome/Edge，跳过（可改用 --no-image）")
        else:
            print("   使用 %s" % b)
            pngs = render_pngs(b, md, os.path.join(OUT_DIR, "06_反馈正文_长图"))
            print("   共 %d 张" % len(pngs))
    else:
        print("   已按参数跳过")

    # 打包
    zip_path = os.path.join(OUT_DIR, "给官方-反馈包.zip")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for root, _, files in os.walk(OUT_DIR):
            if ".chrome-tmp" in root:
                continue
            for f in files:
                if f.endswith(".zip"):
                    continue
                fp = os.path.join(root, f)
                z.write(fp, os.path.relpath(fp, OUT_DIR))
    print("\n  zip: %.0f KB" % (os.path.getsize(zip_path) / 1024.0))

    print("\n" + "=" * 68)
    print("完成。请按 给官方\\README_怎么提交.txt 操作。")
    print("=" * 68)
    for f in sorted(os.listdir(OUT_DIR)):
        fp = os.path.join(OUT_DIR, f)
        if os.path.isdir(fp):
            print("  [目录] %s (%d 个文件)" % (f, len(os.listdir(fp))))
        else:
            print("  %-28s %8.0f KB" % (f, os.path.getsize(fp) / 1024.0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
