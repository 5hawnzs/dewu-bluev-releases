# -*- coding: utf-8 -*-
"""把落盘的 SVG 原样内联成「聊天内可直接渲染」的 HTML 片段（技能 §7）。

为什么需要它：文件写对了 ≠ 用户看见了。预览面板和附件回传在某些客户端会静默不显示，
把矢量稿直接内联进对话是唯一确定能到达用户眼前的通道。

关键：**一个字符都不重写**。全部从磁盘读，重复的 d 串自动抽成 <use>。

用法：
    python inline_preview.py <svg目录> <out.html>            # 全部 *.svg 自动收录
    python inline_preview.py <svg目录> <out.html> 标题=描述...  # 自定义文案

输出后用 Read 读该 html，把内容作为 show_widget 的 widget_code 传入。
"""
import io, os, re, sys

DEFAULT_NOTE = ('同一套实测几何；主色沿用原稿，未替换品牌色。')
CARD_CSS = (
    '.ip{font-family:-apple-system,"Segoe UI",system-ui,sans-serif}'
    '.ip-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}'
    '.ip-card{border:1px solid #2C343C;border-radius:12px;padding:16px;background:#161A1F}'
    '.ip-art svg{display:block;width:100%;height:auto}'
    '.ip-ttl{color:#EDF1F4;font-size:15px;font-weight:500;margin-top:14px}'
    '.ip-tag{color:#2FD3A0;font-size:12px;margin-top:4px}'
    '.ip-desc{color:#98A5B0;font-size:12px;line-height:1.6;margin-top:8px}'
    '.ip-foot{color:#7A8794;font-size:12px;line-height:1.6;margin-top:14px}'
)


def build(srcdir, meta, note=DEFAULT_NOTE, cols=2):
    """meta: [(文件名, 标题, 标签, 描述), ...] -> HTML 片段字符串"""
    bodies, order = {}, []
    for fn, title, tag, desc in meta:
        raw = io.open(os.path.join(srcdir, fn), encoding='utf-8').read()
        m = re.search(r'<svg[^>]*>(.*)</svg>', raw, re.S)
        if not m:
            raise ValueError('不是 SVG：%s' % fn)
        bodies[title] = m.group(1)
        order.append(title)

    seen = {}
    for t in order:
        for d in re.findall(r'\bd="([^"]+)"', bodies[t]):
            seen[d] = seen.get(d, 0) + 1
    shared = {d: 'p%d' % i for i, (d, n) in enumerate(sorted(seen.items())) if n >= 2}
    print('唯一 d 串 %d，抽成 use 的 %d' % (len(seen), len(shared)))

    for t in order:
        b = bodies[t]
        for d, pid in shared.items():
            b = b.replace('<path d="%s"' % d, '<use href="#%s"' % pid)
        bodies[t] = b

    defs = '<defs>' + ''.join('<path id="%s" d="%s"/>' % (pid, d)
                              for d, pid in shared.items()) + '</defs>'
    hide = ('<svg width="0" height="0" style="position:absolute" '
            'xmlns="http://www.w3.org/2000/svg">' + defs + '</svg>')

    cards = []
    for fn, title, tag, desc in meta:
        cards.append(
            '<div class="ip-card"><div class="ip-art"><svg viewBox="0 0 1024 1024" '
            'xmlns="http://www.w3.org/2000/svg">' + bodies[title] + '</svg></div>'
            '<div class="ip-ttl">%s</div><div class="ip-tag">%s</div>'
            '<div class="ip-desc">%s</div></div>' % (title, tag, desc))

    return (
        '<style>' + CARD_CSS + '</style>'
        '<div class="ip">' + hide
        + '<div class="ip-grid" style="grid-template-columns:repeat(%d,1fr)">' % cols
        + ''.join(cards) + '</div>'
        + '<div class="ip-foot">%s</div></div>' % note)


def auto_meta(srcdir):
    names = sorted(n for n in os.listdir(srcdir) if n.lower().endswith('.svg'))
    return [(n, os.path.splitext(n)[0], '', '') for n in names]


if __name__ == '__main__':
    src = sys.argv[1]
    outf = sys.argv[2]
    meta = auto_meta(src)
    print('收录：', [m[0] for m in meta])
    html = build(src, meta)
    os.makedirs(os.path.dirname(outf), exist_ok=True)
    io.open(outf, 'w', encoding='utf-8', newline='').write(html)
    assert io.open(outf, 'rb').read().count(b'\r') == 0
    print('写入', outf, len(html), 'chars')
