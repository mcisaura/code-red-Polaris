"""Fills music/ with every song in library.json, so the AI DJ and the queue play
them instantly. Each song is saved as music/<id>.m4a (id = YouTube video id).

Run:  python prefetch.py

Songs already in music/ are skipped; songs already downloaded into downloads/ are
copied over; the rest are downloaded with the same downloader as server.py.
"""

import json
import os
import shutil
import sys
from pathlib import Path

import server

MUSIC = server.ROOT / "music"


def install(source, target):
    """Copy source to target in one step, so an interrupted copy never leaves a truncated target."""
    temp = target.with_name(target.name + ".part")
    try:
        # Saved as .m4a whatever the container: browsers detect the format from the data.
        shutil.copyfile(source, temp)
        os.replace(temp, target)
    except BaseException:
        temp.unlink(missing_ok=True)
        raise


def main():
    if any(arg in ("-h", "--help") for arg in sys.argv[1:]):
        print(__doc__.strip())
        return
    library = json.loads((server.ROOT / "library.json").read_text(encoding="utf-8"))["songs"]
    MUSIC.mkdir(exist_ok=True)
    failed = 0
    for number, song in enumerate(library, 1):
        label = f"{number}/{len(library)} {song['artist']} - {song['title']}"
        target = MUSIC / f"{song['id']}.m4a"
        if target.exists():
            print(f"{label}: already in music/")
            continue
        # Already downloaded earlier (e.g. by the AI DJ)? Then just copy it.
        earlier = next((p for p in server.DOWNLOADS.glob(f"{song['id']}.*") if p.suffix != ".part"), None)
        if earlier is None:
            entry, error = server.get_song(f"https://www.youtube.com/watch?v={song['id']}")
            if not entry:
                print(f"{label}: FAILED ({error})")
                failed += 1
                continue
            earlier = server.ROOT / entry["file"]
        try:
            install(earlier, target)
        except OSError as error:
            print(f"{label}: FAILED ({error})")
            failed += 1
            continue
        print(f"{label}: ready")
    print(f"\n{len(library) - failed} of {len(library)} songs ready in music/.")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
