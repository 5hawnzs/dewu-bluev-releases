#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
记忆重构的「零丢失反查」基座。

用法：
    python zero_loss_check.py --old <重构前副本> --index MEMORY.md --ref REFERENCE-<项目>.md

做什么：
    从「重构前副本」里逐条抽出**硬约束指纹**（绝不 / 不许 / 不能 / 只能 / 唯一 / 缺一不可 …），
    再到「新索引 + 参考资料」里找落点，分三档输出：
        ✓ exact / 剥情态    —— 直接命中（剥情态 = 压缩把「必须 X」写回成「X」）
        ~ 砍尾（需人工复核）—— 削掉尾部标点 / 跨句污染后命中
        ✗ 丢失              —— 找不到落点（**必须补回**）
    退出码：有 ✗ ⇒ 1；否则 0。

⚠️ 三个「假绿」坑（都实测踩过，改这个脚本前先读一遍）：
    ① **不要剥括号** —— 压缩常把细节挪进括号里（`（唯一写入口，不许裸调）`），
       剥了就把「命中」判成「丢失」（实测一口气**误报 6 条**）。
    ② **`range(0, len(c) - 3)` 在 `len(c) == 3` 时是空循环** ⇒ 全长一次都不试 ⇒ 假「丢失」。
       ⇒ 上界写 `max(1, len(c) - 3)`。
    ③ **别把「脚本说命中」当成零丢失** —— 匹配只会越调越宽。
       宽松的匹配必须**单独列出来给人复核**（就是上面的 `~` 档），不能混进 `✓` 里一起报「全过」。
"""
import argparse
import io
import re
import sys

# 只盯「不遵守就出事」的硬约束：否定式 + 唯一性。
# 这类句子被压掉或压反，读者会照着**错的规则**去干（实测：「三处缺一不可」→「三处缺一」= 语义反了）。
HARD = re.compile(
    r"(绝不[^，。；\s]{2,12}|不许[^，。；\s]{2,12}|不能[^，。；\s]{2,12}|"
    r"别再[^，。；\s]{2,12}|不许裸调|缺一不可|唯一[^，。；\s]{1,8}|"
    r"只能[^，。；\s]{2,10}|必须[^，。；\s]{2,10})"
)
MODAL = re.compile(r"^(绝不能|绝不|不许|不能|别再|只能|必须|唯一|缺一不可)")
WS = re.compile(r"\s+")


def norm(s):
    """去 markdown 标记与空白。⚠️ **不剥括号**（见文件头 ①）。"""
    return WS.sub("", re.sub(r"[*`>]", "", s))


def find(finger, texts):
    """返回 (落点名, 级别)。级别 = exact / 剥情态 / 砍尾 / None。"""
    texts_n = [(n, norm(t)) for n, t in texts]
    cands = [(finger, "exact")]
    m = MODAL.match(finger)
    if m:
        cands.append((finger[m.end():], "剥情态"))
    for c, lvl in cands:
        c = norm(c.strip("*`，。、：;"))
        if len(c) < 3:
            continue
        for cut in range(0, max(1, len(c) - 3)):   # ⚠️ max(1, …)（见文件头 ②）
            sub = c[: len(c) - cut]
            for name, t in texts_n:
                if sub in t:
                    return name, (lvl if cut == 0 else "砍尾")
    return None, None


def items_of(text):
    """把「以 `- ` 开头的条目 + 其 2 空格缩进的续行」拼成一条规则。"""
    out, lines, i = [], text.splitlines(), 0
    while i < len(lines):
        if lines[i].startswith("- ") or lines[i].startswith("  "):
            buf = [lines[i].strip()]
            while (i + 1 < len(lines) and lines[i + 1].startswith("  ")
                   and not lines[i + 1].startswith("  -")):
                i += 1
                buf.append(lines[i].strip())
            out.append((i + 1, " ".join(buf)))
        i += 1
    return out


def main():
    ap = argparse.ArgumentParser(description="记忆重构的零丢失反查")
    ap.add_argument("--old", required=True, help="重构前的记忆文件（副本）")
    ap.add_argument("--index", required=True, help="重构后的索引（如 MEMORY.md）")
    ap.add_argument("--ref", required=True, help="完整版参考资料（如 REFERENCE-<项目>.md）")
    a = ap.parse_args()

    old = io.open(a.old, encoding="utf-8").read()
    idx = io.open(a.index, encoding="utf-8").read()
    ref = io.open(a.ref, encoding="utf-8").read()
    texts = [("index", idx), ("REFERENCE", ref)]

    items = items_of(old)
    print("=== 旧版条目 = %d 条 ===" % len(items))
    print()
    lost, review, ok = [], [], 0
    for ln, txt in items:
        for fp in sorted(set(HARD.findall(txt))):
            where, lvl = find(fp, texts)
            if not where:
                print("  ✗ %-12s ← L%-3d … %s" % ("【丢失】", ln, fp))
                lost.append((ln, fp, txt[:70]))
            elif lvl == "砍尾":
                print("  ~ %-12s ← L%-3d … %s   [砍尾 → 需人工复核]" % (where, ln, fp))
                review.append((ln, fp))
            else:
                print("  ✓ %-12s ← L%-3d … %s   [%s]" % (where, ln, fp, lvl))
                ok += 1

    print()
    print("=== 统计：直接命中 %d · 需人工复核 %d · 丢失 %d ===" % (ok, len(review), len(lost)))
    if review:
        print()
        print("== 需人工复核（砍尾命中）== 逐条确认「语义没丢、只是措辞变了」")
        for ln, fp in review:
            print("   L%d  [%s]" % (ln, fp))
    if lost:
        print()
        print("!! 丢失 %d 条（必须补回后再提交）：" % len(lost))
        for ln, fp, ctx in lost:
            print("   L%d  [%s]" % (ln, fp))
            print("       %s" % ctx)
        return 1
    print()
    print("结论：硬约束**零丢失**（没有一条找不到落点；砍尾命中的已单列在上面，需人工复核）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
