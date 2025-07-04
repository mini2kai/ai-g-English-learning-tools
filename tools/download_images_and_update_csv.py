"""Download images for words and update CSV to local asset links.

Usage (run each command separately on Windows PowerShell):
  cd <project root>
  python tools/download_images_and_update_csv.py

Behavior:
- Reads data/words.csv with header: id,en,cn,pinyin,img,sent,sent_cn (extra columns kept).
- For each row, saves an image to assets/words/ and writes a local relative path to img.
- Priority per row:
  1) If img is already a local path under assets/words/ and exists -> keep
  2) If img is a remote http(s) URL -> download and replace with local path
  3) Try Wikimedia thumbnail by English en
  4) If still missing and cn exists -> try Wikimedia thumbnail by Chinese cn
  5) Try Unsplash Source by English en
  6) If still missing and cn exists -> try Unsplash Source by Chinese cn
- Adds/updates column img_flag to mark how image was obtained (e.g. "新获取", "新获取(中文)").

Notes:
- No third-party dependencies required (uses urllib).
- Creates assets/words/ if it does not exist.
"""

from __future__ import annotations

import csv
import io
import json
import mimetypes
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple


USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)


@dataclass
class DownloadResult:
    ok: bool
    reason: str = ""
    local_rel_path: str = ""
    origin: str = ""


def project_paths() -> Tuple[Path, Path, Path]:
    script_path = Path(__file__).resolve()
    root = script_path.parent.parent
    csv_path = root / "data" / "words.csv"
    assets_dir = root / "assets" / "words"
    return root, csv_path, assets_dir


def read_csv(csv_file: Path) -> Tuple[List[str], List[Dict[str, str]]]:
    with csv_file.open("r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = [dict(r) for r in reader]
        fieldnames = list(reader.fieldnames or [])
    return fieldnames, rows


def write_csv(csv_file: Path, fieldnames: List[str], rows: List[Dict[str, str]]) -> None:
    # Ensure UNIX newlines to avoid diffs across OS
    with csv_file.open("w", encoding="utf-8", newline="\n") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for r in rows:
            writer.writerow(r)


def normalize_name(text: str) -> str:
    lower = (text or "").strip().lower()
    # Replace non-alnum with dash, trim dashes
    name = re.sub(r"[^a-z0-9]+", "-", lower).strip("-")
    return name or "word"


def ensure_ext_from_mime(url: str, content_type: str | None) -> str:
    # Prefer mime type mapping; fallback to URL suffix; default jpg
    guessed: Optional[str] = None
    if content_type:
        guessed = mimetypes.guess_extension(content_type.split(";")[0].strip())
    if not guessed:
        path = urllib.parse.urlparse(url).path
        _, ext = os.path.splitext(path)
        guessed = ext if ext else ".jpg"
    # Normalize jpeg extension
    if guessed == ".jpe":
        guessed = ".jpg"
    return guessed or ".jpg"


def unique_file_path(directory: Path, base: str, ext: str) -> Path:
    i = 0
    while True:
        name = f"{base}{'' if i == 0 else f'-{i}'}{ext}"
        p = directory / name
        if not p.exists():
            return p
        i += 1


def urlopen_bytes(url: str, timeout: float = 15.0) -> Tuple[bytes, str]:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read()
        ctype = resp.headers.get("Content-Type", "")
        return data, ctype


def save_bytes(fp: Path, data: bytes) -> None: 
    fp.parent.mkdir(parents=True, exist_ok=True)
    with fp.open("wb") as f:
        f.write(data)


def fetch_wikimedia_thumb(term: str, lang: str) -> str:
    if not term:
        return ""
    base = f"https://{lang}.wikipedia.org/api/rest_v1/page/summary/"
    url = base + urllib.parse.quote(term)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.load(io.TextIOWrapper(resp, encoding="utf-8"))
        thumb = (data or {}).get("thumbnail", {}).get("source")
        return thumb or ""
    except Exception:
        return ""


def build_unsplash_source(term: str) -> str:
    if not term:
        return ""
    return f"https://source.unsplash.com/600x400/?{urllib.parse.quote(term)}"


def try_download_to_assets(
    url: str, assets_dir: Path, base_name: str
) -> Tuple[bool, str]:
    if not url:
        return False, ""
    try:
        data, ctype = urlopen_bytes(url)
        ext = ensure_ext_from_mime(url, ctype)
        fp = unique_file_path(assets_dir, base_name, ext)
        save_bytes(fp, data)
        rel = Path("assets") / "words" / fp.name
        # Use forward slashes in CSV
        return True, rel.as_posix()
    except Exception:
        return False, ""


def process_row(row: Dict[str, str], assets_dir: Path) -> DownloadResult:
    english = (row.get("en") or "").strip()
    chinese = (row.get("cn") or "").strip()
    img = (row.get("img") or "").strip()
    base_name = normalize_name(english or chinese or row.get("id") or "word")

    # Case 1: already local and exists
    if img and not img.lower().startswith("http") and img.replace("\\", "/").startswith("assets/words/"):
        local_path = Path(assets_dir.parent.parent) / img  # root/assets/words/..
        if local_path.exists():
            return DownloadResult(True, "already_local", img, origin="local")

    # Case 2: CSV remote url provided
    if img and img.lower().startswith("http"):
        ok, rel = try_download_to_assets(img, assets_dir, base_name)
        if ok:
            return DownloadResult(True, "downloaded_from_csv", rel, origin="csv")

    # Case 3: Wikimedia EN
    wiki_en = fetch_wikimedia_thumb(english, "en")
    if wiki_en:
        ok, rel = try_download_to_assets(wiki_en, assets_dir, base_name)
        if ok:
            return DownloadResult(True, "downloaded_wikimedia_en", rel, origin="wikimedia_en")

    # Case 4: Wikimedia ZH by Chinese name
    wiki_zh = fetch_wikimedia_thumb(chinese, "zh") if chinese else ""
    if wiki_zh:
        ok, rel = try_download_to_assets(wiki_zh, assets_dir, base_name)
        if ok:
            return DownloadResult(True, "downloaded_wikimedia_zh", rel, origin="wikimedia_zh")

    # Case 5: Unsplash EN
    uns_en = build_unsplash_source(english)
    if uns_en:
        ok, rel = try_download_to_assets(uns_en, assets_dir, base_name)
        if ok:
            return DownloadResult(True, "downloaded_unsplash_en", rel, origin="unsplash_en")

    # Case 6: Unsplash ZH
    uns_zh = build_unsplash_source(chinese)
    if uns_zh:
        ok, rel = try_download_to_assets(uns_zh, assets_dir, base_name)
        if ok:
            return DownloadResult(True, "downloaded_unsplash_zh", rel, origin="unsplash_zh")

    return DownloadResult(False, "no_image_source")


def main() -> int:
    root, csv_path, assets_dir = project_paths()
    if not csv_path.exists():
        print(f"CSV 不存在: {csv_path}")
        return 2
    assets_dir.mkdir(parents=True, exist_ok=True)

    fieldnames, rows = read_csv(csv_path)
    if "img_flag" not in fieldnames:
        fieldnames = [*fieldnames, "img_flag"]

    updated = 0
    skipped = 0
    failed = 0

    for row in rows:
        result = process_row(row, assets_dir)
        if result.ok:
            row["img"] = result.local_rel_path
            # Flag: 新获取 (+中文) | 本地已存在
            if result.origin == "local":
                row["img_flag"] = ""
                skipped += 1
            elif result.origin.endswith("_zh"):
                row["img_flag"] = "新获取(中文)"
                updated += 1
            elif result.origin == "csv":
                row["img_flag"] = "新获取(原csv)"
                updated += 1
            else:
                row["img_flag"] = "新获取"
                updated += 1
        else:
            # Keep as-is, mark empty flag to retry next time
            row.setdefault("img", "")
            row.setdefault("img_flag", "")
            failed += 1

    write_csv(csv_path, fieldnames, rows)

    print(
        f"完成。更新 {updated} 条，保留本地 {skipped} 条，仍未获取 {failed} 条。\n"
        f"已写入: {csv_path}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())


