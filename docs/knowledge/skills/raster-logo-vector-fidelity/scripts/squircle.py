# -*- coding: utf-8 -*-
"""连续圆角(squircle) 路径生成器。

参数由原稿像素实测轮廓反拟合得到（见 fit_n.py）：
    256 画布：R = 52.75，超椭圆指数 n = 1.84   → 最大偏差 0.75 px
    1024 画布：R = 211.0，n = 1.84
角点曲线用「弧长等分 + Hermite」转成三次贝塞尔；直接按解析参数 t 做 Hermite 会退化，
因为 t 参数在两端速度趋 0（见下方 raw() 的说明）。
"""
import math

def raw(t, R, n):
    """角点曲线，t ∈ [0, pi/2]：从 (0,R) 走到 (R,0)。
    x = R(1-cos^a t), y = R(1-sin^a t)，a = 2/n。两端速度趋 0，故不能直接做 Hermite。"""
    a = 2.0 / n
    return (R * (1.0 - math.cos(t) ** a), R * (1.0 - math.sin(t) ** a))


def corner_segments(R, n, K, samples=6000):
    """把一个角均分成 K 段，每段返回 (P0, P1, P2, P3) 三次贝塞尔控制点。"""
    pts = [raw(math.pi / 2 * i / samples, R, n) for i in range(samples + 1)]
    cum = [0.0]
    for i in range(1, samples + 1):
        cum.append(cum[-1] + math.dist(pts[i - 1], pts[i]))
    total = cum[-1]

    def at(u):
        d = u * total
        lo, hi = 0, samples
        while lo < hi:
            mid = (lo + hi) // 2
            if cum[mid] < d:
                lo = mid + 1
            else:
                hi = mid
        i = max(1, lo)
        seg = cum[i] - cum[i - 1]
        f = 0.0 if seg <= 0 else (d - cum[i - 1]) / seg
        return (pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f,
                pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f)

    def tan(u):
        e = 1e-4
        a, b = at(max(0.0, u - e)), at(min(1.0, u + e))
        dx, dy = b[0] - a[0], b[1] - a[1]
        L = math.hypot(dx, dy) or 1.0
        return (dx / L, dy / L)

    out = []
    for i in range(K):
        u0, u1 = i / K, (i + 1) / K
        P0, P3 = at(u0), at(u1)
        T0, T1 = tan(u0), tan(u1)
        L = total * (u1 - u0) / 3.0
        out.append((P0, (P0[0] + T0[0] * L, P0[1] + T0[1] * L),
                    (P3[0] - T1[0] * L, P3[1] - T1[1] * L), P3))
    return out


def build(R=211.0, n=1.84, K=3, size=1024):
    """返回完整 squircle 的 SVG path（顺时针，从顶边左端出发）。"""
    segs = corner_segments(R, n, K)
    C = size / 2.0

    def rot(p, k):
        x, y = p[0] - C, p[1] - C
        for _ in range(k):
            x, y = -y, x
        return (x + C, y + C)

    def f(v):
        s = '%.1f' % v
        return s[:-2] if s.endswith('.0') else s

    def corner(k):
        out = []
        for sg in segs:
            P1, P2, P3 = rot(sg[1], k), rot(sg[2], k), rot(sg[3], k)
            out.append('C%s %s %s %s %s %s' % (f(P1[0]), f(P1[1]), f(P2[0]),
                                               f(P2[1]), f(P3[0]), f(P3[1])))
        return ''.join(out)

    X = size - R
    return ('M%s 0' % f(R) + 'H%s' % f(X) + corner(1)
            + 'V%s' % f(X) + corner(2)
            + 'H%s' % f(R) + corner(3)
            + 'V%s' % f(R) + corner(0) + 'Z')


if __name__ == '__main__':
    import re
    R, N, K = 211.0, 1.84, 3
    d = build(R, N, K)
    segs = corner_segments(R, N, K, samples=6000)

    def bez(sg, t):
        p0, p1, p2, p3 = sg
        mt = 1 - t
        return (mt**3*p0[0] + 3*mt*mt*t*p1[0] + 3*mt*t*t*p2[0] + t**3*p3[0],
                mt**3*p0[1] + 3*mt*mt*t*p1[1] + 3*mt*t*t*p2[1] + t**3*p3[1])

    pts = [raw(math.pi / 2 * i / 4000, R, N) for i in range(4001)]
    worst = max(min(math.dist(bez(sg, j / 200.0), q) for q in pts[::3])
                for sg in segs for j in range(201))
    print('贝塞尔 vs 超椭圆曲线 最大偏差 = %.3f px (1024)' % worst)
    print('路径命令数 =', len(re.findall(r'[A-Za-z]', d)))
    print()
    print(d)
