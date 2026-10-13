"""WAV header overlays for windowed archives (round 99).

With round 98's lazy samples the game parses each WAV's header at boot and
reads its PCM only when the sound is first played. The header parse goes
through the archive stream, which reads the entry in 1 KB blocks from its
start (a version-0 archive's payload: per-dword XOR and byte swap, so a
block's bytes depend on nothing outside it). Its seeks decode forward, so
every block up to the one holding the end of the `data` chunk header is read.
Each such block made the page fetch and decode the whole 1 MiB window around
it.

An overlay holds exactly those blocks, raw, for one archive. The host
(host_shims_fs.c) answers a read lying inside one of them without a window,
while lazy samples are on and no fill is running; a fill reads through the
windows as before, so the PCM a sound plays never comes from here.

Format (little-endian): b"IOVL", u32 version (1), u32 count,
count x (u32 offset, u32 length) sorted and disjoint, then the blocks.

    python wav_overlay.py build <archive.a> <out.ovl>
    python wav_overlay.py check <archive.a> <out.ovl> <fs-reads.json>
"""
import json
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import archive as ar  # noqa: E402

BLOCK = 1024
MAGIC = b"IOVL"


def header_end(d: bytes) -> int | None:
    """The logical offset just past the `data` chunk header, as 0x00a9f630 walks
    the chunks (RIFF header, then chunk headers; it stops at `data`)."""
    if d[:4] != b"RIFF" or d[8:12] != b"WAVE":
        return None
    p = 12
    while p + 8 <= len(d):
        cid, size = d[p:p + 4], struct.unpack_from("<I", d, p + 4)[0]
        if cid == b"data":
            return p + 8
        p += 8 + size
    return None


def blocks(path: str) -> list[tuple[int, int]]:
    """(absolute offset, length) of every block a header parse reads, sorted."""
    out = []
    with ar.Archive(path) as a:
        if a.version != 0:
            raise ValueError(f"{path}: version {a.version}; overlays cover version-0 payloads")
        for e in a.entries:
            end = header_end(a.decode(e))
            if end is None:
                continue
            off, ln = a.raw_extent(e)
            for k in range((end + BLOCK - 1) // BLOCK):
                start = off + k * BLOCK
                n = min(BLOCK, off + ln - start)
                if n > 0:
                    out.append((start, n))
    out.sort()
    merged: list[tuple[int, int]] = []
    for s, n in out:                       # blocks of entries packed back to back may touch
        if merged and s < merged[-1][0] + merged[-1][1]:
            ps, pn = merged[-1]
            merged[-1] = (ps, max(ps + pn, s + n) - ps)
        else:
            merged.append((s, n))
    return merged


def build(path: str, out: str) -> dict:
    bl = blocks(path)
    raw = Path(path).read_bytes()
    body = b"".join(raw[s:s + n] for s, n in bl)
    head = MAGIC + struct.pack("<II", 1, len(bl)) + b"".join(struct.pack("<II", s, n) for s, n in bl)
    Path(out).write_bytes(head + body)
    return {"archive": Path(path).name, "blocks": len(bl), "bytes": len(body), "file": len(head) + len(body)}


def parse(blob: bytes) -> list[tuple[int, int, bytes]]:
    if blob[:4] != MAGIC:
        raise ValueError("not an overlay")
    ver, n = struct.unpack_from("<II", blob, 4)
    if ver != 1:
        raise ValueError(f"overlay version {ver}")
    idx = [struct.unpack_from("<II", blob, 12 + 8 * i) for i in range(n)]
    at = 12 + 8 * n
    res = []
    for s, ln in idx:
        res.append((s, ln, blob[at:at + ln]))
        at += ln
    return res


def check(path: str, ovl: str, reads_json: str) -> dict:
    """Every boot read of this archive that lies inside a WAV entry's header blocks
    must lie inside one overlay block, with the archive's bytes."""
    name = Path(path).name
    ov = parse(Path(ovl).read_bytes())
    raw = Path(path).read_bytes()
    bad_bytes = sum(1 for s, ln, b in ov if raw[s:s + ln] != b)
    starts = [s for s, _, _ in ov]
    import bisect
    covered = missed = 0
    with ar.Archive(path) as a:
        wav_spans = []
        for e in a.entries:
            if header_end(a.decode(e)) is None:
                continue
            off, ln = a.raw_extent(e)
            wav_spans.append((off, off + ln))
    wav_spans.sort()
    ws = [s for s, _ in wav_spans]
    for src, pos, want, fill in json.load(open(reads_json)):
        if not src.endswith(name) or fill:
            continue
        i = bisect.bisect_right(ws, pos) - 1
        if i < 0 or pos >= wav_spans[i][1]:
            continue                       # not a WAV entry's bytes
        j = bisect.bisect_right(starts, pos) - 1
        if j >= 0 and pos + want <= ov[j][0] + ov[j][1]:
            covered += 1
        else:
            missed += 1
    return {"archive": name, "overlayBlocks": len(ov), "blocksWithWrongBytes": bad_bytes,
            "wavReadsCovered": covered, "wavReadsMissed": missed}


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "build" and len(sys.argv) == 4:
        print(json.dumps(build(sys.argv[2], sys.argv[3])))
    elif cmd == "check" and len(sys.argv) == 5:
        print(json.dumps(check(sys.argv[2], sys.argv[3], sys.argv[4])))
    else:
        print(__doc__)
        sys.exit(2)
