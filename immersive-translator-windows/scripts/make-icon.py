"""
纯标准库生成 ImmersiveTranslator 应用图标（PNG + ICO）。
无需第三方库，可被 EDR 等受限环境下使用。

设计：圆角方形靛蓝→紫渐变 + 中央白色"双向交换"箭头，呼应「沉浸式翻译」。
输出到 src-tauri/icons/，覆盖以下文件以匹配 tauri.conf.json 的 bundle.icon：
    32x32.png, 128x128.png, 128x128@2x.png (256),
    icon.png (1024 master), icon.ico (16/32/48/64/128/256 PNG-embedded),
    tray-icon.png (32, 保持文件名以兼容旧引用)

依赖：仅 Python 3.8+ 标准库（struct, zlib, math）。
"""
from __future__ import annotations
import os
import struct
import zlib
import math
from pathlib import Path

# ---------- 颜色与几何参数（与 src/styles.css 设计令牌保持一致） ----------
C1 = (79, 70, 229)   # 渐变起点：#4f46e5 (indigo-600)
C2 = (217, 70, 239)  # 渐变终点：#d946ef (fuchsia-500) — 同色系，区分度更明显
WHITE = (255, 255, 255)
ROUND = 224          # 圆角半径（1024 画布上的 21.875%）

# 双向交换箭头：上下各一条矩形主体 + 三角箭头，垂直间距 24px，水平错位 60
# 主体 r=0（直角），让三角形底边与主体右边严丝合缝衔接
TOP_BODY = (512, 460, 210, 40, 0)   # roundrect: cx, cy, hw, hh, r  → y 420-500
TOP_HEAD = ((722, 420), (722, 500), (822, 460))                  # 三角形向右
BOT_BODY = (572, 564, 210, 40, 0)   # 右移 60（cx 572），y 524-604
BOT_HEAD = ((362, 524), (362, 604), (262, 564))                  # 三角形向左

SHAPES = [
    ("rr", TOP_BODY),
    ("tr", TOP_HEAD),
    ("rr", BOT_BODY),
    ("tr", BOT_HEAD),
]


# ---------- 数学工具 ----------
def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t

def clamp(x: float, lo: float, hi: float) -> float:
    return lo if x < lo else hi if x > hi else x

def dist_rr(px, py, cx, cy, hw, hh, r):
    """rounded-rect 符号距离（负值在内部）。"""
    dx = abs(px - cx) - (hw - r)
    dy = abs(py - cy) - (hh - r)
    if dx <= 0 and dy <= 0:
        return -r  # 严格在内部中心区（最常见路径，无 sqrt）
    out_x = dx if dx > 0 else 0
    out_y = dy if dy > 0 else 0
    return math.hypot(out_x, out_y) - r

def dist_tri(px, py, a, b, c):
    """三角形符号距离。"""
    p = (px, py)
    # 边方向符号（判断内外）
    s1 = (a[0] - p[0]) * (b[1] - a[1]) - (a[1] - p[1]) * (b[0] - a[0])
    s2 = (b[0] - p[0]) * (c[1] - b[1]) - (b[1] - p[1]) * (c[0] - b[0])
    s3 = (c[0] - p[0]) * (a[1] - c[1]) - (c[1] - p[1]) * (a[0] - c[0])
    inside = (s1 >= 0 and s2 >= 0 and s3 >= 0) or (s1 <= 0 and s2 <= 0 and s3 <= 0)

    def seg(p, a, b):
        dx, dy = b[0] - a[0], b[1] - a[1]
        l2 = dx * dx + dy * dy
        if l2 == 0:
            return math.hypot(p[0] - a[0], p[1] - a[1])
        t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2
        t = max(0.0, min(1.0, t))
        qx, qy = a[0] + t * dx, a[1] + t * dy
        return math.hypot(p[0] - qx, p[1] - qy)

    d = min(seg(p, a, b), seg(p, b, c), seg(p, c, a))
    return -d if inside else d

def shape_bbox(s):
    """包围盒 (xmin, xmax, ymin, ymax)，用于早退剪枝。"""
    kind, p = s
    if kind == "rr":
        cx, cy, hw, hh, _ = p
        return cx - hw, cx + hw, cy - hh, cy + hh
    xs = [p[0][0], p[1][0], p[2][0]]
    ys = [p[0][1], p[1][1], p[2][1]]
    return min(xs), max(xs), min(ys), max(ys)

def shape_dist(px, py, s):
    kind, p = s
    return dist_rr(px, py, *p) if kind == "rr" else dist_tri(px, py, *p)

def coverage(d):
    """d ≤ 0 → 内部（1.0），d ≥ 1 → 外部（0.0），之间用 smoothstep 抗锯齿。"""
    if d <= 0:
        return 1.0
    if d >= 1:
        return 0.0
    x = 1.0 - d
    return x * x * (3.0 - 2.0 * x)


# ---------- 渲染主图 ----------
def render(size: int):
    """返回 size×size 的 RGBA 像素列表（每像素 4 字节元组）。"""
    pixels = bytearray(size * size * 4)
    bboxes = [shape_bbox(s) for s in SHAPES]
    hw = size / 2.0
    rr_half = size / 2.0  # 背景圆角矩形与画布同大
    r = ROUND * size / 1024.0
    # 预计算: 背景 = 圆角矩形覆盖
    for py in range(size):
        for px in range(size):
            # 背景圆角矩形符号距离
            d_bg = dist_rr(px + 0.5, py + 0.5, hw, hw, hw, hw, r)
            bg_cov = coverage(d_bg)
            if bg_cov <= 0:
                # 完全在圆角外 → 透明，跳过 4 字节默认 0
                continue
            # 背景渐变（对角）
            t = (px + py) / (2.0 * (size - 1))
            br = lerp(C1[0], C2[0], t)
            bg = lerp(C1[1], C2[1], t)
            bb = lerp(C1[2], C2[2], t)
            # 顶部高光（极轻，保留现代哑光感）
            gloss = (1.0 - py / (size - 1)) ** 2 * 7.0
            br = clamp(br + gloss, 0, 255)
            bg = clamp(bg + gloss, 0, 255)
            bb = clamp(bb + gloss, 0, 255)
            # 前景覆盖
            fg_cov = 0.0
            for i, s in enumerate(SHAPES):
                bx0, bx1, by0, by1 = bboxes[i]
                if px < bx0 or px > bx1 or py < by0 or py > by1:
                    continue
                d = shape_dist(px + 0.5, py + 0.5, s)
                c = coverage(d)
                if c > fg_cov:
                    fg_cov = c
            if fg_cov > 0:
                br = lerp(br, 255, fg_cov)
                bg = lerp(bg, 255, fg_cov)
                bb = lerp(bb, 255, fg_cov)
            a = bg_cov  # 整体 alpha 由背景圆角决定
            idx = (py * size + px) * 4
            pixels[idx] = int(br)
            pixels[idx + 1] = int(bg)
            pixels[idx + 2] = int(bb)
            pixels[idx + 3] = int(a * 255)
    return bytes(pixels)


# ---------- PNG 编码 ----------
def write_png(path: Path, w: int, h: int, rgba: bytes):
    sig = b"\x89PNG\r\n\x1a\n"
    def chunk(typ: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + typ
            + data
            + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)
        )
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)  # 8-bit RGBA
    # 一行 = 1 个 filter byte(0) + w*4 字节
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)
        raw.extend(rgba[y * stride : (y + 1) * stride])
    idat = zlib.compress(bytes(raw), 9)
    with open(path, "wb") as f:
        f.write(sig)
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", idat))
        f.write(chunk(b"IEND", b""))


# ---------- 降采样（盒形平均） ----------
def downscale(src_w: int, src_h: int, src: bytes, dst_w: int, dst_h: int) -> bytes:
    if dst_w == src_w and dst_h == src_h:
        return src
    out = bytearray(dst_w * dst_h * 4)
    x_ratio = src_w / dst_w
    y_ratio = src_h / dst_h
    for dy in range(dst_h):
        sy0 = int(dy * y_ratio)
        sy1 = max(sy0 + 1, int((dy + 1) * y_ratio))
        for dx in range(dst_w):
            sx0 = int(dx * x_ratio)
            sx1 = max(sx0 + 1, int((dx + 1) * x_ratio))
            rs = gs = bs = a_s = 0
            count = 0
            for sy in range(sy0, sy1):
                for sx in range(sx0, sx1):
                    i = (sy * src_w + sx) * 4
                    rs += src[i]
                    gs += src[i + 1]
                    bs += src[i + 2]
                    a_s += src[i + 3]
                    count += 1
            j = (dy * dst_w + dx) * 4
            out[j] = rs // count
            out[j + 1] = gs // count
            out[j + 2] = bs // count
            out[j + 3] = a_s // count
    return bytes(out)


# ---------- ICO 编码（PNG 嵌入；Windows Vista+ 支持） ----------
def write_ico(path: Path, entries: list[tuple[int, bytes]]):
    """entries: list of (size, png_bytes) — 同一 PNG 数据可重用。"""
    n = len(entries)
    header = struct.pack("<HHH", 0, 1, n)
    # 计算每个 entry 的数据起始偏移
    dir_size = 6 + n * 16
    offsets = []
    cur = dir_size
    for _, png in entries:
        offsets.append(cur)
        cur += len(png)
    # 写目录
    out = bytearray()
    out.extend(header)
    for (size, png), off in zip(entries, offsets):
        w = 0 if size >= 256 else size
        h = 0 if size >= 256 else size
        # 16-byte ICONDIRENTRY: w,h,colors,reserved,planes,bitcount,size,offset
        out.extend(struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, len(png), off))
    for _, png in entries:
        out.extend(png)
    with open(path, "wb") as f:
        f.write(bytes(out))


# ---------- 主流程 ----------
def main():
    icons_dir = Path(__file__).resolve().parent.parent / "src-tauri" / "icons"
    icons_dir.mkdir(parents=True, exist_ok=True)
    print(f"渲染 1024×1024 主图到 {icons_dir} ...")
    rgba1024 = render(1024)
    png1024 = bytearray()
    # 直接将 1024 写入，再降采样
    print("  - icon.png (1024)")
    write_png(icons_dir / "icon.png", 1024, 1024, rgba1024)
    # 缓存 PNG 字节以便 ICO 嵌入
    def png_bytes(w, h, rgba):
        from io import BytesIO
        buf = BytesIO()
        # 临时写到内存：复用 write_png 逻辑（重定向 file）
        import tempfile, os as _os
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tf:
            tmp = tf.name
        try:
            write_png(Path(tmp), w, h, rgba)
            with open(tmp, "rb") as f:
                return f.read()
        finally:
            _os.unlink(tmp)

    sizes = [256, 128, 64, 48, 32, 16]
    downs = {s: downscale(1024, 1024, rgba1024, s, s) for s in sizes}

    print("  - 128x128@2x.png (256)")
    write_png(icons_dir / "128x128@2x.png", 256, 256, downs[256])
    print("  - 128x128.png (128)")
    write_png(icons_dir / "128x128.png", 128, 128, downs[128])
    print("  - 32x32.png (32)")
    write_png(icons_dir / "32x32.png", 32, 32, downs[32])
    print("  - tray-icon.png (32)")
    write_png(icons_dir / "tray-icon.png", 32, 32, downs[32])

    print("  - icon.ico (16/32/48/64/128/256)")
    ico_entries = [(s, png_bytes(s, s, downs[s])) for s in [16, 32, 48, 64, 128, 256]]
    write_ico(icons_dir / "icon.ico", ico_entries)

    # 清理旧 Square* / StoreLogo (Microsoft Store 旧模板图标，不再使用)
    for stale in [
        "Square30x30Logo.png",
        "Square44x44Logo.png",
        "Square71x71Logo.png",
        "Square89x89Logo.png",
        "Square107x107Logo.png",
        "Square142x142Logo.png",
        "Square150x150Logo.png",
        "Square284x284Logo.png",
        "Square310x310Logo.png",
        "StoreLogo.png",
    ]:
        p = icons_dir / stale
        if p.exists():
            p.unlink()
            print(f"  - 删除旧图标 {stale}")

    print("完成。")


if __name__ == "__main__":
    main()
