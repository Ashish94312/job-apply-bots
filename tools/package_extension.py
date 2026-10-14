#!/usr/bin/env python3
"""Build the ZIP to upload to the Chrome Web Store: dist/sendoff-<version>.zip

  .venv/bin/python tools/package_extension.py

Takes the extension folder without its tests, and checks what the store rejects: the manifest's description
length, the icons, and files the manifest points to that aren't there. For an update, raise "version" in
extension/manifest.json first: the store only takes a higher version than the one it has.
"""
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "extension"
LEFT_OUT = {"tests", ".DS_Store", "README.md"}


def check(manifest):
    problems = []
    if len(manifest.get("description", "")) > 132:
        problems.append(f"description is {len(manifest['description'])} characters; the store allows 132")
    if len(manifest.get("name", "")) > 75:
        problems.append("name is longer than 75 characters")
    named = [manifest.get("background", {}).get("service_worker", "")]
    named += list(manifest.get("icons", {}).values()) + list(manifest.get("action", {}).get("default_icon", {}).values())
    problems += [f"manifest names {f}, which isn't there" for f in named if f and not (EXT / f).exists()]
    if "128" not in manifest.get("icons", {}):
        problems.append("no 128 px icon")
    return problems


def main():
    manifest = json.loads((EXT / "manifest.json").read_text())
    problems = check(manifest)
    if problems:
        sys.exit("Not packaged:\n  " + "\n  ".join(problems))
    out = ROOT / "dist" / f"sendoff-{manifest['version']}.zip"
    out.parent.mkdir(exist_ok=True)
    files = sorted(p for p in EXT.rglob("*") if p.is_file() and not LEFT_OUT & set(p.relative_to(EXT).parts))
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for f in files:
            z.write(f, f.relative_to(EXT).as_posix())  # manifest.json at the top of the ZIP, as the store wants
    print(f"Wrote {out.relative_to(ROOT)}: {len(files)} files, {out.stat().st_size // 1024} KB, version {manifest['version']}.")


if __name__ == "__main__":
    main()
