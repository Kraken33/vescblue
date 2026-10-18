#!/usr/bin/env python3
"""Build an OpenOCD flash plan: which 2 KiB blocks differ between what is on
the display now (fresh dump) and the image we want, with full block contents.

  python3 tools/make_plan.py current.bin target.bin plan.tcl

Exit code 3 = nothing to do (images identical).
"""
import struct
import sys

BASE, SIZE, BLOCK = 0x08000000, 0x10000, 0x800

cur, tgt, out = sys.argv[1:4]
a, b = open(cur, "rb").read(), open(tgt, "rb").read()
if len(a) != SIZE or len(b) != SIZE:
    sys.exit("both images must be 64 KiB")

blocks = [o for o in range(0, SIZE, BLOCK) if a[o:o + BLOCK] != b[o:o + BLOCK]]
if 0 in blocks:
    sys.exit("REFUSING: block 0 (vector table) differs - not supported by this flasher")
if not blocks:
    print("images identical - nothing to flash")
    sys.exit(3)

with open(out, "w") as f:
    f.write("set PLAN {\n")
    for o in blocks:
        words = struct.unpack("<512I", b[o:o + BLOCK])
        f.write("  {0x%08X {%s}}\n" % (BASE + o, " ".join("0x%08X" % w for w in words)))
    f.write("}\n")
print("blocks to flash: " + ", ".join("0x%08X" % (BASE + o) for o in blocks))
