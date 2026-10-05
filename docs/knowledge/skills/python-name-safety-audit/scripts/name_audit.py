# -*- coding: utf-8 -*-
"""静态体检：Python 源码里「名字未初始化就被读」这类必崩 bug。

检查两类：
  C1 NameError          —— 读到某个名字，但本作用域没赋值过、外层与模块级也没有
  C2 UnboundLocalError  —— 某个名字**只有 `+=` / `-=` 这类增广赋值，没有一次普通赋值**
                           → 它被当成局部变量，而第一次 `+=` 自己就要先读旧值 → 必炸

用法：
  python name_audit.py                     # 扫当前目录（递归，跳过常见临时件）
  python name_audit.py src/ app.py         # 扫指定目录/文件
  python name_audit.py --all src/          # 不跳过 test_/_bak_ 等
  python name_audit.py --quiet src/        # 只打印有问题的
  python name_audit.py --self-test         # 只跑反向自证

退出码：0 = 全通过；1 = 有 C1/C2（或自证失败）。

⚠️ 有意为之的保守处理（宁可漏报，不可误报）：
   · 推导式（comprehension）的循环变量也算进外层作用域 → 少数真错会漏，但不会误报
   · 函数内 `global X` 声明过的名字按全局处理
   · `del X` 不看（它不产生「已赋值」）
"""
import argparse
import ast
import builtins
import io
import os
import sys

DEFAULT_SKIP_PREFIX = ("test_", "_bak_", "_diag_", "_fix_", "_probe_", "_eval_",
                       "_build_", "_chk_", "_oneshot", ".")
SKIP_DIRS = {".git", "__pycache__", "node_modules", ".venv", "venv", ".idea", ".vscode"}

SAFE_GLOBALS = set(dir(builtins)) | {"__name__", "__file__", "__doc__", "self", "cls"}


def target_names(node):
    """把赋值目标里的所有 Name 抠出来（含元组/星号解包）。"""
    out = []
    if isinstance(node, ast.Name):
        out.append(node)
    elif isinstance(node, (ast.Tuple, ast.List)):
        for e in node.elts:
            out.extend(target_names(e))
    elif isinstance(node, ast.Starred):
        out.extend(target_names(node.value))
    return out


class ScopeCollector(ast.NodeVisitor):
    """收集单个函数作用域里的「存」与「读」，**不下钻嵌套函数/类**。"""

    def __init__(self):
        self.plains = {}      # name -> 首次普通赋值行号
        self.augs = {}        # name -> 首次增广赋值行号
        self.loads = {}       # name -> 首次读行号
        self.globals = set()

    def _plain(self, name, line):
        self.plains.setdefault(name, line)

    def visit_Name(self, node):
        if isinstance(node.ctx, ast.Load):
            self.loads.setdefault(node.id, node.lineno)
        elif isinstance(node.ctx, ast.Store):
            # 普通赋值 / for 目标 / with-as / except-as 都走这里
            self._plain(node.id, node.lineno)
        # Del 忽略

    def visit_AugAssign(self, node):
        # ★ 增广赋值：既是读（隐式）又是写。单独记账，
        #   因为「只有它」就等于「没有初始化」。
        for t in target_names(node.target):
            self.augs.setdefault(t.id, node.lineno)
            self.loads.setdefault(t.id, node.lineno)
        self.visit(node.value)

    def visit_AnnAssign(self, node):
        if node.value is not None:
            for t in target_names(node.target):
                self._plain(t.id, node.lineno)
            self.visit(node.value)
        self.visit(node.annotation)

    def visit_Import(self, node):
        for a in node.names:
            self._plain((a.asname or a.name).split(".")[0], node.lineno)

    def visit_ImportFrom(self, node):
        for a in node.names:
            if a.name == "*":
                continue
            self._plain(a.asname or a.name, node.lineno)

    def visit_Global(self, node):
        self.globals.update(node.names)

    def visit_ExceptHandler(self, node):
        # ⚠️ `except X as e:` 里的 e 在 AST 上是**字符串**字段（node.name），
        #    不是一个 Name 节点 —— 不显式处理就会把每个 `except ... as e` 都误报成
        #    「e 未定义」（首版 90 条误报里绝大多数是它）。
        if node.name:
            self._plain(node.name, node.lineno)
        if node.type is not None:
            self.visit(node.type)
        for st in node.body:
            self.visit(st)

    def visit_Nonlocal(self, node):
        for n in node.names:
            self.plains.setdefault(n, node.lineno)   # 外层局部 → 当作已绑定

    def visit_FunctionDef(self, node):
        self._plain(node.name, node.lineno)          # 函数名是外层的一个「存」
        self._visit_defaults(node)

    def visit_AsyncFunctionDef(self, node):
        self.visit_FunctionDef(node)

    def visit_Lambda(self, node):
        # lambda 形参也算进**外层**作用域（保守）：否则 `key=lambda n: ...` 会被
        # 误报成「n 未定义」（首版 43 条误报里有 3 条是它）。
        a = node.args
        for x in list(a.posonlyargs) + list(a.args) + list(a.kwonlyargs):
            self._plain(x.arg, node.lineno)
        if a.vararg:
            self._plain(a.vararg.arg, node.lineno)
        if a.kwarg:
            self._plain(a.kwarg.arg, node.lineno)
        for d in list(a.defaults) + [d for d in a.kw_defaults if d is not None]:
            self.visit(d)
        self.visit(node.body)

    def _visit_defaults(self, node):
        a = node.args
        for d in list(a.defaults) + [d for d in a.kw_defaults if d is not None]:
            self.visit(d)
        for dec in node.decorator_list:
            self.visit(dec)

    def visit_ClassDef(self, node):
        self._plain(node.name, node.lineno)
        for dec in node.decorator_list:
            self.visit(dec)

    def visit_comprehension_scope(self, node):
        # 保守：推导式里的循环变量也算进外层（宁可漏报，不可误报）
        for gen in node.generators:
            for t in target_names(gen.target):
                self._plain(t.id, gen.target.lineno)
            self.visit(gen.iter)
            for f in gen.ifs:
                self.visit(f)
        rt = getattr(node, "elt", None) or getattr(node, "key", None)
        if rt is not None:
            self.visit(rt)
        if getattr(node, "value", None) is not None:
            self.visit(node.value)

    visit_ListComp = visit_comprehension_scope
    visit_SetComp = visit_comprehension_scope
    visit_DictComp = visit_comprehension_scope
    visit_GeneratorExp = visit_comprehension_scope


def collect_scope(fn):
    c = ScopeCollector()
    args = fn.args
    for a in list(args.posonlyargs) + list(args.args) + list(args.kwonlyargs):
        c.plains.setdefault(a.arg, fn.lineno)
    if args.vararg:
        c.plains.setdefault(args.vararg.arg, fn.lineno)
    if args.kwarg:
        c.plains.setdefault(args.kwarg.arg, fn.lineno)
    for st in fn.body:
        c.visit(st)
    return c


def iter_scopes(tree):
    """按作用域递归收集 (函数节点, 该作用域的读写账, 可见的外层名字集合)。

    ★ 必须带「外层环境」—— 嵌套函数读外层局部变量（闭包）是合法的。
      没做这件事会把 `text_embed` 里读外层 `tok/txt` 一律报成「未定义」。
    """
    mod = ScopeCollector()
    for st in tree.body:
        mod.visit(st)
    module_names = set(mod.plains) | set(mod.augs) | set(mod.globals) | SAFE_GLOBALS

    out = []

    def walk(node, enclosing):
        for ch in ast.iter_child_nodes(node):
            if isinstance(ch, (ast.FunctionDef, ast.AsyncFunctionDef)):
                c = collect_scope(ch)
                out.append((ch, c, enclosing | module_names))
                # 进到这一层之后，内层能看到的 = 原有外层 + 本层所有绑定
                inner_env = set(enclosing) | set(c.plains) | set(c.augs) | set(c.globals)
                walk(ch, inner_env)
            elif isinstance(ch, ast.ClassDef):
                walk(ch, enclosing | {ch.name})
            elif isinstance(ch, ast.Lambda):
                walk(ch, enclosing)
            else:
                walk(ch, enclosing)

    walk(tree, set())
    return out, module_names


def analyse(path):
    """返回 failures 列表 [(文件, 行号, 消息), ...]。"""
    src = io.open(path, encoding="utf-8", errors="replace").read()
    try:
        tree = ast.parse(src, filename=path)
    except SyntaxError as e:
        return [(os.path.basename(path), 0, "语法错误: %s" % e)]

    scopes, _module_names = iter_scopes(tree)
    fails = []
    name = os.path.basename(path)

    for node, c, visible in scopes:
        for nm, line in sorted(c.loads.items(), key=lambda kv: kv[1]):
            if nm in c.globals or nm in visible:
                continue
            has_plain = nm in c.plains
            has_aug = nm in c.augs
            if has_plain:
                # C2：有增广赋值，但它出现在**第一次普通赋值之前**
                if has_aug and c.augs[nm] < c.plains[nm]:
                    fails.append((name, line,
                                  "C2 %s.%s：`%s` 在 L%d 被增广赋值，但第一次普通赋值在 L%d "
                                  "→ 先读后写，必 UnboundLocalError"
                                  % (name, node.name, nm, c.augs[nm], c.plains[nm])))
                continue
            if has_aug:
                fails.append((name, c.augs[nm],
                              "C2 %s.%s：`%s` 只有增广赋值（L%d）、全函数没有一次普通赋值/形参 "
                              "→ 未初始化，必 UnboundLocalError"
                              % (name, node.name, nm, c.augs[nm])))
                continue
            fails.append((name, line,
                          "C1 %s.%s：`%s` 既不是形参、本函数也没赋值、外层作用域与模块级都没有 "
                          "→ 一执行就 NameError" % (name, node.name, nm)))
    return fails


def self_test():
    """自证：拿「真踩过的那个 bug 的最小复现」喂给自己，必须报出来。

    不然这个体检本身可能是坏的 —— 全绿只因为它什么都没查。
    """
    bad = (
        "def scan(mcfg):\n"
        "    n = 0\n"
        "    if mcfg:\n"
        "        n += 1\n"
        "        print('未达标 %d 条' % n)\n"
        "    for i in range(3):\n"
        "        n2 = i\n"
        "    print(n2)\n"
        "    return undefined_name\n"
    )
    good = (
        "def scan(mcfg):\n"
        "    total = 0\n"
        "    invalid_count = 0\n"
        "    aug_only = 0\n"
        "    aug_only += 1\n"
        "    if mcfg:\n"
        "        invalid_count += 1\n"
        "    for i in range(3):\n"
        "        total += i\n"
        "    try:\n"
        "        pass\n"
        "    except Exception as e:\n"
        "        print(e)\n"
        "    return total, invalid_count, aug_only, len(str(total))\n"
    )
    import tempfile
    d = tempfile.mkdtemp(prefix="pyname_")
    fb = os.path.join(d, "bad.py")
    fg = os.path.join(d, "good.py")
    io.open(fb, "w", encoding="utf-8").write(bad)
    io.open(fg, "w", encoding="utf-8").write(good)
    rb = analyse(fb)
    rg = analyse(fg)
    msgs = " | ".join(m for _n, _l, m in rb)
    return (len(rb) >= 1 and "undefined_name" in msgs and len(rg) == 0), msgs, rg


def gather(paths, skip_all):
    out = []
    for p in paths:
        if os.path.isfile(p):
            if p.endswith(".py"):
                out.append(p)
            continue
        for root, dirs, files in os.walk(p):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
            for f in files:
                if not f.endswith(".py"):
                    continue
                if not skip_all and f.startswith(DEFAULT_SKIP_PREFIX):
                    continue
                out.append(os.path.join(root, f))
    return sorted(set(out))


def main():
    ap = argparse.ArgumentParser(description="Python 名字安全静态体检（C1 NameError / C2 UnboundLocalError）")
    ap.add_argument("paths", nargs="*", default=["."], help="要扫的目录或文件（默认当前目录）")
    ap.add_argument("--all", action="store_true", help="不跳过 test_/_bak_/_diag_ 等临时件")
    ap.add_argument("--quiet", action="store_true", help="只打印有问题的文件")
    ap.add_argument("--self-test", action="store_true", help="只跑反向自证")
    a = ap.parse_args()

    st_ok, st_msgs, st_good = self_test()
    if not a.self_test:
        targets = gather(a.paths or ["."], a.all)
        print("名字安全静态体检：%d 个 .py 文件" % len(targets))
        ok_files, problems = 0, []
        for f in targets:
            fails = analyse(f)
            if fails:
                print("  ✗ %s" % f)
                for _n, line, msg in fails:
                    print("      L%-6d %s" % (line, msg))
                    problems.append(msg)
            else:
                ok_files += 1
                if not a.quiet:
                    print("  ✓ %s" % f)
        print()
    else:
        ok_files, problems = 0, []

    print("反向验证（喂进真 bug 的最小复现）: %s"
          % ("✓ 抓到了" if st_ok else "✗ 没抓到 —— 体检本身失效"))
    if not st_ok:
        print("     bad.py 报出: %s" % (st_msgs or "（空）"))
        print("     good.py 误报: %s" % ([m for _n, _l, m in st_good] or "（无）"))

    npass = ok_files + (1 if st_ok else 0)
    nfail = len(problems) + (0 if st_ok else 1)
    print()
    print("PASS=%d FAIL=%d" % (npass, nfail))
    return 1 if nfail else 0


if __name__ == "__main__":
    sys.exit(main())
