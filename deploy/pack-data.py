"""서버에 올릴 DB 묶음: commerce.sqlite 는 일관된 사본(VACUUM INTO)을 zstd 로 압축, api.sqlite 는 사본.

    ml/.venv/Scripts/python.exe deploy/pack-data.py      (Python 3.14: 표준 라이브러리 compression.zstd)

결과는 data/deploy/ 에 둔다. WAL 이 남아 있어도 VACUUM INTO 사본에는 모두 반영된다.
"""
import shutil
import sqlite3
import sys
import time
from compression import zstd
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = DATA / "deploy"
OUT.mkdir(exist_ok=True)


def snapshot(name: str) -> Path:
    dst = OUT / name
    dst.unlink(missing_ok=True)
    t = time.time()
    con = sqlite3.connect(DATA / name)
    con.execute("VACUUM INTO ?", (str(dst),))
    con.close()
    print(f"{name}: 사본 {dst.stat().st_size / 2**30:.2f} GB ({time.time() - t:.0f}s)", flush=True)
    return dst


def main() -> None:
    db = snapshot("commerce.sqlite")
    t = time.time()
    zst = OUT / "commerce.sqlite.zst"
    opts = {zstd.CompressionParameter.compression_level: 6, zstd.CompressionParameter.nb_workers: 4}
    with db.open("rb") as src, zstd.open(zst, "wb", options=opts) as dst:
        shutil.copyfileobj(src, dst, 16 << 20)
    db.unlink()
    print(f"commerce.sqlite.zst: {zst.stat().st_size / 2**30:.2f} GB ({time.time() - t:.0f}s)", flush=True)
    snapshot("api.sqlite")


if __name__ == "__main__":
    sys.exit(main())
