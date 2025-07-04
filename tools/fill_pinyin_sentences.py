"""Fill missing pinyin (with tone marks) and optional sentences in data/words.csv

Usage (run each command separately in PowerShell):
  cd <project root>
  python -m pip install --upgrade pip
  python -m pip install pypinyin
  python tools/fill_pinyin_sentences.py

Effects:
- For rows with empty pinyin and non-empty Chinese `cn`, fill pinyin with tone marks (e.g., píng guǒ)
- If `--fill-sent` is provided, fill empty `sent`/`sent_cn` with simple templates
  (You can later refine them in CSV)
"""

from __future__ import annotations

import csv
from pathlib import Path
from typing import Dict, List, Tuple

try:
    from pypinyin import pinyin, Style
except Exception as e:
    raise SystemExit("请先安装 pypinyin：python -m pip install pypinyin")


def project_paths() -> Tuple[Path, Path]:
    root = Path(__file__).resolve().parent.parent
    csv_path = root / "data" / "words.csv"
    return root, csv_path


def read_csv(csv_file: Path) -> Tuple[List[str], List[Dict[str, str]]]:
    with csv_file.open("r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = [dict(r) for r in reader]
        fieldnames = list(reader.fieldnames or [])
    return fieldnames, rows


def write_csv(csv_file: Path, fieldnames: List[str], rows: List[Dict[str, str]]) -> None:
    with csv_file.open("w", encoding="utf-8", newline="\n") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for r in rows:
            writer.writerow(r)


def fill_pinyin(text: str) -> str:
    items = pinyin(text, style=Style.TONE, strict=False)
    return " ".join(s[0] for s in items if s and s[0])

def is_likely_pinyin(text: str) -> bool:
    if not text:
        return False
    s = str(text).strip()
    # 允许字母/空格/连字符/点号/带声调元音/ü
    import re
    return bool(re.fullmatch(r"[a-zA-Z\s\.\-āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü]+", s))


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--fill-sent", action="store_true", help="补全空缺的 sent/sent_cn")
    args = parser.parse_args()

    root, csv_path = project_paths()
    if not csv_path.exists():
        print(f"CSV 不存在: {csv_path}")
        return 2

    fieldnames, rows = read_csv(csv_path)
    need_cols = ["id","en","cn","pinyin","img","sent","sent_cn"]
    for c in need_cols:
        if c not in fieldnames:
            fieldnames.append(c)

    fixed_py = 0
    fixed_sent = 0

    for r in rows:
        cn = (r.get("cn") or "").strip()
        py = (r.get("pinyin") or "").strip()
        # 若拼音为空或不是拼音（包含中文等），则重算
        if cn and (not py or not is_likely_pinyin(py)):
            r["pinyin"] = fill_pinyin(cn)
            fixed_py += 1
        if args.fill_sent:
            en = (r.get("en") or "").strip()
            if not r.get("sent"):
                r["sent"] = f"This is {en}." if en else "This is it."
                fixed_sent += 1
            if not r.get("sent_cn"):
                r["sent_cn"] = f"这是{cn or '它'}。"
                fixed_sent += 1

    write_csv(csv_path, fieldnames, rows)
    print(f"完成：拼音补全 {fixed_py} 条，短句/翻译补全 {fixed_sent} 条。已写回 {csv_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


