#!/usr/bin/env python3
"""BiliLens 构建脚本：生成图标 → 产出 Chrome / Edge 两套 MV3 目录与 zip，
再产出一份 Bilibili Evolved 用户组件包。

用法：python build.py
扩展两端使用同一份 src 源码，差异仅在 manifest.description 的构建目标标注；
src/evolved/ 是组件的「源码」，只在 build-evolved.mjs 里被打包，不进入扩展目录。
"""
from __future__ import annotations

import json
import math
import shutil
import struct
import subprocess
import zlib
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
DIST = ROOT / "dist"
ASSETS = SRC / "assets"
VERSION = "1.5.4"
TARGETS = {"chrome": "Chrome 版", "edge": "Microsoft Edge 版"}
# 组件源码目录：只用于生成独立组件包，不复制进浏览器扩展
EXTENSION_EXCLUDES = {"evolved", "__pycache__"}

BG = (20, 22, 26, 255)
ACCENT = (240, 114, 154, 255)
TRANSPARENT = (0, 0, 0, 0)


def _sample(u: float, v: float):
    """归一化坐标下的图标采样，返回 RGBA。线性风格：圆环 + 中心点 + 四向刻度。"""
    r = 0.22
    cx = min(max(u, r), 1 - r)
    cy = min(max(v, r), 1 - r)
    inside_bg = (u - cx) ** 2 + (v - cy) ** 2 <= r * r
    if not inside_bg:
        return TRANSPARENT

    dx, dy = u - 0.5, v - 0.5
    d = math.hypot(dx, dy)
    ring_r, ring_w = 0.315, 0.035
    if abs(d - ring_r) <= ring_w / 2:
        return ACCENT
    if d <= 0.075:
        return ACCENT

    tick_half_w = 0.012
    inner, outer = ring_r + 0.055, ring_r + 0.125
    # 上 / 下刻度
    if abs(dx) <= tick_half_w and inner <= abs(dy) <= outer:
        return ACCENT
    # 左 / 右刻度
    if abs(dy) <= tick_half_w and inner <= abs(dx) <= outer:
        return ACCENT
    return BG


def _write_png(path: Path, size: int, supersample: int = 3) -> None:
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(supersample):
                for sx in range(supersample):
                    u = (x + (sx + 0.5) / supersample) / size
                    v = (y + (sy + 0.5) / supersample) / size
                    pixel = _sample(u, v)
                    for i in range(4):
                        acc[i] += pixel[i]
            n = supersample * supersample
            row.extend(bytes(round(a / n) for a in acc))
        rows.append(bytes(row))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + row for row in rows)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)


def ensure_icons() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    for size in (16, 48, 128):
        target = ASSETS / f"icon{size}.png"
        if not target.exists():
            _write_png(target, size)
            print(f"  generated {target.name} ({target.stat().st_size} bytes)")


def build(target: str, label: str) -> tuple[Path, Path]:
    dest = DIST / target / "BiliLens"
    if dest.exists():
        shutil.rmtree(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(
        SRC, dest,
        ignore=shutil.ignore_patterns(*EXTENSION_EXCLUDES),
    )

    manifest_path = dest / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["description"] = manifest["description"].replace("{{TARGET_LABEL}}", label)
    manifest["version"] = VERSION
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # 基础校验：所有 JSON 必须可解析
    for json_file in dest.rglob("*.json"):
        json.loads(json_file.read_text(encoding="utf-8"))

    zip_path = DIST / f"BiliLens-{target}-v{VERSION}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for file in sorted(dest.rglob("*")):
            if file.is_file():
                archive.write(file, file.relative_to(dest).as_posix())
    return dest, zip_path


def build_evolved() -> Path:
    """调用 node 打包器，生成单文件 UMD 组件并打成一个便于分发的 zip。"""
    script = ROOT / "build-evolved.mjs"
    subprocess.run(["node", str(script)], cwd=ROOT, check=True)
    component = DIST / "evolved" / "BiliLens.evolved.component.js"
    if not component.exists():
        raise FileNotFoundError(f"组件产物缺失: {component}")
    zip_path = DIST / f"BiliLens-evolved-v{VERSION}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.write(component, component.name)
    return zip_path


def main() -> None:
    print(f"BiliLens build v{VERSION}")
    ensure_icons()
    DIST.mkdir(parents=True, exist_ok=True)
    # 清掉旧版本 zip，避免 dist 里同时留着多个版本的交付包
    for stale in DIST.glob("BiliLens-*-v*.zip"):
        stale.unlink()
        print(f"  removed stale package {stale.name}")
    for target, label in TARGETS.items():
        dest, zip_path = build(target, label)
        files = [f for f in dest.rglob("*") if f.is_file()]
        print(f"  {target:6s} -> {dest}  ({len(files)} files)")
        print(f"           -> {zip_path.name} ({zip_path.stat().st_size:,} bytes)")
    evolved_zip = build_evolved()
    print(f"  evolved -> {DIST / 'evolved' / 'BiliLens.evolved.component.js'}")
    print(f"          -> {evolved_zip.name} ({evolved_zip.stat().st_size:,} bytes)")
    print("Done. Load the unpacked folder, or import the zip in the extension store workflow.")


if __name__ == "__main__":
    main()
