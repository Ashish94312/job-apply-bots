#!/usr/bin/env python3
"""Build the ZIP to upload to the Chrome Web Store: dist/sendoff-<version>.zip

  .venv/bin/python tools/package_extension.py

Takes the extension folder without its tests, and checks what the store rejects: the manifest's description
length, the icons, and files the manifest points to that aren't there. For an update, raise "version" in
extension/manifest.json first: the store only takes a higher version than the one it has.
"""
import argparse
import re
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


def main(argv=None):
    parser = argparse.ArgumentParser(description="Package the Sendoff extension")
    parser.add_argument("--billing-origin", help="Enable sandbox billing for this merchant origin")
    parser.add_argument("--live-billing", action="store_true", help="Label a billing build for production")
    args = parser.parse_args(argv)
    if args.live_billing and not (args.billing_origin or "").startswith("https://"):
        parser.error("--live-billing requires an HTTPS merchant origin")
    origin = args.billing_origin
    if origin and not (re.fullmatch(r"https://[a-z0-9.-]+", origin) or origin == "http://127.0.0.1:8766"):
        parser.error("Use an HTTPS origin or the local sandbox origin")
    manifest = json.loads((EXT / "manifest.json").read_text())
    if origin:
        manifest["permissions"].append("identity")
        manifest["host_permissions"].append(origin + "/*")
    problems = check(manifest)
    if problems:
        sys.exit("Not packaged:\n  " + "\n  ".join(problems))
    suffix = "-billing" if args.live_billing else "-billing-sandbox" if origin else ""
    out = ROOT / "dist" / f"sendoff-{manifest['version']}{suffix}.zip"
    out.parent.mkdir(exist_ok=True)
    files = sorted(p for p in EXT.rglob("*") if p.is_file() and not LEFT_OUT & set(p.relative_to(EXT).parts))
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for f in files:
            name = f.relative_to(EXT).as_posix()
            if origin and name == "manifest.json":
                z.writestr(name, json.dumps(manifest, indent=2))
            elif args.live_billing and name == "dashboard.html":
                z.writestr(name, f.read_text().replace("Sandbox billing", "Account and billing"))
            elif origin and name == "billing-config.js":
                z.writestr(name, "globalThis.SENDOFF_BILLING_ORIGIN = " + json.dumps(origin) + ";")
            else:
                z.write(f, name)  # manifest.json at the top of the ZIP, as the store wants
    print(f"Wrote {out.relative_to(ROOT)}: {len(files)} files, {out.stat().st_size // 1024} KB, version {manifest['version']}.")
    return out


if __name__ == "__main__":
    main()
