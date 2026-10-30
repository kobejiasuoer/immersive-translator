"""从正式 SVG 母版生成 Windows 图标，并同步官网品牌图。

用法：在 immersive-translator-windows/ 执行 python scripts/make-icon.py。
依赖：Python 3.8+ 标准库、Node.js，以及项目已安装的 @tauri-apps/cli。
先在临时目录生成和校验，再按固定清单更新资源；不清空正式图标目录。
"""
from __future__ import annotations

import os
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
PNG_SIZES = {
    "32x32.png": 32,
    "64x64.png": 64,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 512,
    "tray-icon.png": 32,
    "Square30x30Logo.png": 30,
    "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71,
    "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107,
    "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150,
    "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310,
    "StoreLogo.png": 50,
}


def png_dimensions(data: bytes, label: str) -> tuple[int, int]:
    if len(data) < 33 or data[:8] != PNG_SIGNATURE or data[12:16] != b"IHDR":
        raise ValueError(f"{label} 不是有效的 PNG")
    if struct.unpack_from(">I", data, 8)[0] != 13:
        raise ValueError(f"{label} 的 PNG 头长度无效")
    return struct.unpack_from(">II", data, 16)


def validate_ico(data: bytes) -> None:
    if len(data) < 6:
        raise ValueError("icon.ico 缺少文件头")
    reserved, kind, count = struct.unpack_from("<HHH", data)
    if reserved != 0 or kind != 1 or not count or len(data) < 6 + count * 16:
        raise ValueError("icon.ico 的文件头或目录无效")
    sizes = set()
    for index in range(count):
        width, height, _, _, _, _, length, offset = struct.unpack_from(
            "<BBBBHHII", data, 6 + index * 16
        )
        width, height = width or 256, height or 256
        if not length or offset < 6 + count * 16 or offset + length > len(data):
            raise ValueError("icon.ico 的图像范围无效")
        entry = data[offset:offset + length]
        if entry.startswith(PNG_SIGNATURE):
            dimensions = png_dimensions(entry, f"icon.ico 第 {index + 1} 个图像")
        else:
            # Tauri 为小尺寸写 DIB，其高度包含像素与透明掩码两部分。
            if len(entry) < 40 or struct.unpack_from("<I", entry)[0] < 40:
                raise ValueError("icon.ico 的 DIB 头无效")
            dib_width, dib_height = struct.unpack_from("<ii", entry, 4)
            dimensions = (dib_width, abs(dib_height) // 2)
        if dimensions != (width, height):
            raise ValueError("icon.ico 的目录尺寸与实际图像不一致")
        sizes.add(width)
    if not {16, 32, 48, 256}.issubset(sizes):
        raise ValueError("icon.ico 缺少必需的 16/32/48/256px 图像")


def normalize_icns(data: bytes) -> bytes:
    """固定 Tauri ICNS 图像块顺序，避免相同母版产生无内容变化的 diff。"""
    if len(data) < 8 or data[:4] != b"icns" or struct.unpack_from(">I", data, 4)[0] != len(data):
        raise ValueError("icon.icns 的文件头或长度无效")
    chunks = []
    offset = 8
    while offset < len(data):
        if offset + 8 > len(data):
            raise ValueError("icon.icns 的图像块缺少头部")
        length = struct.unpack_from(">I", data, offset + 4)[0]
        if length < 8 or offset + length > len(data):
            raise ValueError("icon.icns 的图像块范围无效")
        chunks.append(data[offset:offset + length])
        offset += length
    if not chunks:
        raise ValueError("icon.icns 缺少图像块")
    return data[:8] + b"".join(sorted(chunks))


def atomic_write(destination: Path, data: bytes) -> None:
    """用同目录临时文件替换单个资源，避免中断留下半写入文件。"""
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=destination.parent, prefix=f".{destination.name}.", suffix=".tmp", delete=False
        ) as output:
            temporary = Path(output.name)
            output.write(data)
        os.replace(temporary, destination)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main() -> None:
    project = Path(__file__).resolve().parent.parent
    source = project / "src-tauri" / "app-icon.svg"
    cli = project / "node_modules" / "@tauri-apps" / "cli" / "tauri.js"
    node = shutil.which("node")
    if not source.is_file():
        raise FileNotFoundError(f"找不到正式母版：{source}")
    if not node or not cli.is_file():
        raise FileNotFoundError("请先安装 Node.js，并在项目中执行 npm ci")

    with tempfile.TemporaryDirectory(prefix="immersive-speaking-icons-") as directory:
        staging = Path(directory)
        defaults = staging / "default"
        extra = staging / "extra"
        command = [node, str(cli), "icon", str(source)]
        subprocess.run(command + ["--output", str(defaults)], cwd=project, check=True)
        # --png 会关闭默认全套生成，因此补充尺寸写入独立目录。
        subprocess.run(
            command + ["--output", str(extra), "--png", "64,512"], cwd=project, check=True
        )

        assets = {}
        for name, size in PNG_SIZES.items():
            generated = defaults / name
            if name == "64x64.png":
                generated = extra / "64x64.png"
            elif name == "icon.png":
                generated = extra / "512x512.png"
            elif name == "tray-icon.png":
                generated = defaults / "32x32.png"
            data = generated.read_bytes()
            if png_dimensions(data, name) != (size, size):
                raise ValueError(f"{name} 的尺寸必须是 {size}×{size}")
            assets[name] = data

        assets["icon.ico"] = (defaults / "icon.ico").read_bytes()
        validate_ico(assets["icon.ico"])
        assets["icon.icns"] = normalize_icns((defaults / "icon.icns").read_bytes())

        # 全部校验完成后，只同步明确列出的 Windows 资源和官网品牌图。
        icons = project / "src-tauri" / "icons"
        for name, data in assets.items():
            atomic_write(icons / name, data)
        website_icon = project.parent / "website" / "assets" / "brand-icon.png"
        atomic_write(website_icon, assets["icon.png"])
        print(f"完成：{len(assets)} 个图标资源；官网与 icon.png 使用同一份 512px PNG。")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"生成失败：{error}", file=sys.stderr)
        sys.exit(1)
