#!/usr/bin/env python3
"""Build a mod catalogue a page can browse, and the parts it downloads.

A folder of mods in, a directory a static host can serve out:

    catalogue.json      what the browser lists and searches
    m/<id>.<n>.bin      one mod, zipped, cut into parts

The parts exist because jsDelivr refuses a file over 20 MB, so nothing here is
allowed past 19. The page joins them back, unzips the result and stores the mod
in the browser (mods.mjs fetchMod/install). None of it is in the build: the page
fetches the catalogue when the browser is opened and a mod only when it is asked
for.

A mod bigger than the page's seed budget is listed but cannot be installed, so by
default one is left out entirely rather than served for nothing; --max-mb 0 keeps
everything.

Round 95: dependencies. Every entry records its Steam Workshop id ("workshop", from
its metadata <id>, else the folder's _<id> suffix). --requires names a JSON file
{workshop id: [required workshop ids]} (a Workshop page's Required items); each entry
then carries "requires", the catalogue ids of those mods, which the page installs
first. A mod that needs one the catalogue cannot list -- not in the folder, left out,
too big -- is left out itself, and so is anything that needs it in turn. --select
names a file of folder names (one a line) to pack instead of the whole folder.
--keep <dir> carries every entry (and its parts) of an earlier catalogue that this
build does not make itself, so a catalogue can grow without its source mods.

usage:
  modpack.py <mods-dir> <out-dir> [--max-mb 96] [--part-mb 19] [--base URL]
             [--requires FILE] [--select FILE] [--keep DIR]
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import shutil
import sys
import zipfile

MIB = 1 << 20
SKIP_NAMES = {"disable.it", ".ds_store", "thumbs.db", "desktop.ini"}


def human(n: int) -> str:
    return "%.2f MB" % (n / float(MIB)) if n >= MIB else "%d KB" % max(1, n // 1024)


def read_metadata(path: str) -> dict:
    """name, directory, description and version out of a mod's metadata.xml.

    Read with a regex rather than a parser on purpose: mods ship malformed XML --
    a bare ampersand, a BOM, a tag left open -- and a mod with a broken metadata
    file should lose its description, not its place in the catalogue.
    """
    out = {"name": None, "directory": None, "description": None, "version": None}
    try:
        with io.open(path, encoding="utf-8", errors="replace") as f:
            text = f.read()
    except OSError:
        return out
    for tag in out:
        m = re.search(r"<%s\s*>([\s\S]*?)</%s\s*>" % (tag, tag), text, re.I)
        if not m:
            continue
        v = re.sub(r"<!\[CDATA\[([\s\S]*?)\]\]>", r"\1", m.group(1)).strip()
        v = re.sub(r"\s+", " ", v)
        if v:
            # a description is shown whole (the browser scrolls it); the rest are labels
            out[tag] = v[:8000] if tag == "description" else v[:400]
    return out


def mod_id(name: str) -> str:
    s = re.sub(r"[^a-z0-9._-]+", "-", (name or "").lower()).strip("-.")
    return s[:64]


def zip_mod(folder: str) -> tuple[bytes, int, int]:
    """The mod's own tree, zipped, entries relative to the mod folder."""
    blob, files, skipped, _unpacked = zip_mod_sized(folder)
    return blob, files, skipped


def long_path(path: str) -> str:
    """On Windows, the extended-length form of a path: a workshop folder nests past
    MAX_PATH (260) -- "animated items" ships a 270-character sprite path -- and the
    plain form makes os.stat fail."""
    if os.name != "nt":
        return path
    path = os.path.abspath(path)
    return path if path.startswith("\\\\?\\") else "\\\\?\\" + path


def zip_mod_sized(folder: str) -> tuple[bytes, int, int, int]:
    """zip_mod, and the bytes it unpacks to."""
    folder = long_path(folder)
    buf = io.BytesIO()
    files = skipped = unpacked = 0
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for dp, dn, fn in os.walk(folder):
            dn[:] = sorted(d for d in dn if not d.startswith("."))
            for f in sorted(fn):
                if f.lower() in SKIP_NAMES:
                    skipped += 1
                    continue
                full = os.path.join(dp, f)
                rel = os.path.relpath(full, folder).replace("\\", "/")
                z.write(full, rel)
                files += 1
                unpacked += os.path.getsize(full)
    return buf.getvalue(), files, skipped, unpacked


def workshop_id(folder_name: str, metadata_path: str) -> str | None:
    """The mod's Steam Workshop id: its metadata's <id>, else the folder's _<id>."""
    try:
        with io.open(metadata_path, encoding="utf-8", errors="replace") as f:
            m = re.search(r"<id>\s*(\d+)\s*</id>", f.read())
        if m:
            return m.group(1)
    except OSError:
        pass
    m = re.search(r"_(\d{6,})$", folder_name)
    return m.group(1) if m else None


def resolve_requires(entries: list[dict], needs: dict[str, list[str]]) -> tuple[list[dict], list[tuple[str, str]]]:
    """Each entry's required workshop ids as catalogue ids, and the entries that
    cannot have theirs. A requirement nothing in `entries` carries leaves the mod
    out; leaving it out can strand another, so this runs until nothing changes.
    Returns (kept, [(name, why)])."""
    kept = list(entries)
    dropped: list[tuple[str, str]] = []
    while True:
        by_ws = {e["workshop"]: e["id"] for e in kept if e.get("workshop")}
        still, changed = [], False
        for e in kept:
            req = [w for w in needs.get(e.get("workshop") or "", []) if w != e.get("workshop")]
            lost = [w for w in req if w not in by_ws]
            if lost:
                dropped.append((e["name"], "needs workshop item(s) %s, not in this catalogue" % ", ".join(lost)))
                changed = True
                continue
            ids = sorted({by_ws[w] for w in req})
            if ids:
                e["requires"] = ids
            else:
                e.pop("requires", None)
            still.append(e)
        kept = still
        if not changed:
            return kept, dropped


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mods")
    ap.add_argument("out")
    ap.add_argument("--part-mb", type=int, default=19, help="largest part (default 19; jsDelivr refuses 20)")
    ap.add_argument("--max-mb", type=int, default=96,
                    help="leave out a mod bigger than this, which the page could not seed anyway (0 keeps every mod)")
    ap.add_argument("--base", help="where the catalogue will be served from, recorded in it for reference")
    ap.add_argument("--requires", help="JSON {workshop id: [required workshop ids]} (round 95)")
    ap.add_argument("--select", help="a file of folder names, one a line, to pack instead of every folder")
    ap.add_argument("--keep", help="an earlier catalogue dir whose entries this build does not make are carried over")
    args = ap.parse_args(argv)
    needs = {}
    if args.requires:
        with io.open(args.requires, encoding="utf-8") as f:
            needs = {str(k): [str(x) for x in v] for k, v in json.load(f).items()}
    select = None
    if args.select:
        with io.open(args.select, encoding="utf-8") as f:
            select = {line.strip() for line in f if line.strip()}

    part = args.part_mb * MIB
    cap = args.max_mb * MIB
    if not os.path.isdir(args.mods):
        print("no such folder: %s" % args.mods)
        return 2
    os.makedirs(os.path.join(args.out, "m"), exist_ok=True)
    for f in os.listdir(os.path.join(args.out, "m")):
        os.remove(os.path.join(args.out, "m", f))

    entries, seen, left_out, total, blobs = [], {}, [], 0, {}
    for name in sorted(os.listdir(args.mods)):
        folder = os.path.join(args.mods, name)
        if not os.path.isdir(folder) or (select is not None and name not in select):
            continue
        meta = read_metadata(os.path.join(folder, "metadata.xml"))
        # the folder name carries the workshop id after an underscore; the mod's
        # own <directory> is what the game would call it, so that wins
        base = meta["directory"] or re.sub(r"_\d{6,}$", "", name)
        mid = mod_id(base) or mod_id(name)
        if not mid or mid in seen:
            mid = mod_id("%s-%d" % (mid or "mod", len(entries)))
        blob, files, skipped, unpacked = zip_mod_sized(folder)
        if cap and len(blob) > cap:
            left_out.append((meta["name"] or name, "%s (over the %d MB the page can seed)" % (human(len(blob)), args.max_mb)))
            continue
        seen[mid] = True
        blobs[mid] = (blob, skipped)
        entry = {
            "id": mid,
            "name": meta["name"] or base,
            "description": meta["description"] or "",
            "version": meta["version"] or "",
            "bytes": len(blob),
            "unpacked": unpacked,
            "files": files,
            "parts": max(1, (len(blob) + part - 1) // part),
        }
        ws = workshop_id(name, os.path.join(folder, "metadata.xml"))
        if ws:
            entry["workshop"] = ws
        entries.append(entry)

    # round 95: an earlier catalogue's entries this build does not make
    kept_from = []
    if args.keep:
        with io.open(os.path.join(args.keep, "catalogue.json"), encoding="utf-8") as f:
            old = json.load(f)
        have = {e["id"] for e in entries}
        have_ws = {e.get("workshop") for e in entries if e.get("workshop")}
        for e in old.get("mods", []):
            if e["id"] in have or (e.get("workshop") and e["workshop"] in have_ws):
                continue
            kept_from.append(dict(e))
        entries.extend(kept_from)

    entries, stranded = resolve_requires(entries, needs)
    left_out.extend(stranded)
    for e in sorted(entries, key=lambda e: e["id"]):
        mid, n = e["id"], e["parts"]
        if mid in blobs:
            blob, skipped = blobs[mid]
            for i in range(n):
                with open(os.path.join(args.out, "m", "%s.%d.bin" % (mid, i)), "wb") as f:
                    f.write(blob[i * part:(i + 1) * part])
            note = ", %d skipped" % skipped if skipped else ""
        else:
            for i in range(n):
                shutil.copyfile(os.path.join(args.keep, "m", "%s.%d.bin" % (mid, i)),
                                os.path.join(args.out, "m", "%s.%d.bin" % (mid, i)))
            note = ", kept from %s" % args.keep
        total += e["bytes"]
        print("  %-46s %-10s %2d part(s), %d file(s)%s%s"
              % (e["name"][:46], human(e["bytes"]), n, e.get("files", 0),
                 " requires %s" % ",".join(e["requires"]) if e.get("requires") else "", note))
    entries.sort(key=lambda e: e["id"])

    catalogue = {"version": 1, "base": args.base or None, "mods": entries}
    with io.open(os.path.join(args.out, "catalogue.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(catalogue, f, indent=1, ensure_ascii=False)
        f.write("\n")
    biggest = max((os.path.getsize(os.path.join(args.out, "m", f))
                   for f in os.listdir(os.path.join(args.out, "m"))), default=0)
    print("catalogue: %d mod(s), %s in %d part(s), largest part %s"
          % (len(entries), human(total), sum(e["parts"] for e in entries), human(biggest)))
    if biggest > 20 * MIB:
        print("  WARNING: a part is over 20 MB and jsDelivr will refuse it")
        return 1
    for name, why in left_out:
        print("  left out: %-40s %s" % (name[:40], why))
    return 0


if __name__ == "__main__":
    sys.exit(main())
