# -*- coding: utf-8 -*-
"""把 GitHub 侧的 commit 对象物化进本地对象库 —— `gh-sync.mjs` 复现失败时的兜底。

## 什么时候需要它

`gh-push.mjs` 走 API 推送后，远端 commit 的 sha 通常与本地不同（GitHub 会归一化提交字节）。
`gh-sync.mjs` 会尝试复现那个对象；复现成功才能安全地把本地分支/远端跟踪 ref 指过去。
复现失败时它只对齐 `refs/heads/main`，并打印一行建议 —— **此时千万不要手工把
`refs/remotes/origin/main` 指向远端 sha**：那个对象本地没有，git 会报
`error: refs/remotes/origin/main: invalid sha1 pointer <sha>`
且 `git status` 显示 `[gone]`（比不写这个 ref 还糟）。**先补对象，再写 ref。**

## 做法

拿一个**本地等价提交**（tree 与远端相同的那条，正常就是 `HEAD`）的原始字节当基准，
穷举「尾部换行数 × author 时区 × committer 时区」，逐个 `git hash-object -t commit --stdin`
比对目标 sha；命中后用 `-w` 写进对象库。

## 用法

    python gh-fix-ref-obj.py <repo目录> <目标远端sha> [本地等价提交，默认 HEAD]

成功时打印命中组合，并回读 `git cat-file -t <sha>` 应为 `commit`。

## 与 gh-sync 的分工（2026-09-24 实测）

gh-sync 的老 bug 是「author/committer 时间戳都用 committer 的」—— 一次 `git commit --amend`
之后两者会差若干秒（实测差 30 秒），于是**怎么穷举都不命中**。该 bug 已修，但本脚本仍值得留着：
遇到带 `gpgsig` / `encoding` 等额外 header 的提交、或 gh-sync 又出现新偏差时，它是最后的救生索。
"""
import io
import subprocess
import sys


def git(repo, *args, data=None):
    return subprocess.run(["git"] + list(args), input=data, capture_output=True, cwd=repo).stdout


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    repo = sys.argv[1]
    target = sys.argv[2]
    local = sys.argv[3] if len(sys.argv) > 3 else "HEAD"

    raw = git(repo, "cat-file", "commit", local)
    if not raw:
        print("拿不到本地提交 %s 的原始字节（提交不存在？）" % local)
        sys.exit(1)
    head, sep, msg = raw.partition(b"\n\n")
    if not sep:
        print("本地提交格式异常，找不到 header/message 分隔")
        sys.exit(1)
    body = msg.rstrip(b"\n")
    lines = head.split(b"\n")

    def with_tz(line, tz):
        parts = line.rsplit(b" ", 1)
        return parts[0] + b" " + tz

    tzs = (b"+0800", b"+0000", b"-0000")
    for atz in tzs:
        for ctz in tzs:
            new_lines = []
            for ln in lines:
                if ln.startswith(b"author "):
                    ln = with_tz(ln, atz)
                elif ln.startswith(b"committer "):
                    ln = with_tz(ln, ctz)
                new_lines.append(ln)
            h = b"\n".join(new_lines)
            for k in range(0, 9):
                cand = h + b"\n\n" + body + b"\n" * k
                sha = subprocess.run(["git", "hash-object", "-t", "commit", "--stdin"],
                                     input=cand, capture_output=True, cwd=repo).stdout.strip().decode()
                if sha == target:
                    subprocess.run(["git", "hash-object", "-t", "commit", "-w", "--stdin"],
                                   input=cand, capture_output=True, cwd=repo)
                    print("命中：author tz=%s committer tz=%s 尾部换行=%d"
                          % (atz.decode(), ctz.decode(), k))
                    print("已写入本地对象库: " + target)
                    print("回读 cat-file -t: " + subprocess.run(
                        ["git", "cat-file", "-t", target], capture_output=True, cwd=repo).stdout.decode().strip())
                    return
    r = subprocess.run(["git", "cat-file", "-t", target], capture_output=True, cwd=repo)
    print("未复现。cat-file -t %s -> %s" % (target, (r.stdout or r.stderr).decode().strip()))
    print("提示：确认 %s 的 tree 是否等于本地 %s 的 tree；不等说明拿错了本地等价提交。" % (target, local))
    sys.exit(1)


main()
