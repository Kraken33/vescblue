#!/usr/bin/env python3
"""Apply the blogger's display patches (display_docs/patchNotes.txt) to a dump
of YOUR display. Pure host-side tool: it never talks to the hardware.

  python3 tools/patch_fw.py backups/<stamp>/display.bin -o patched.bin
  python3 tools/patch_fw.py in.bin -o out.bin --no-pmenu --nvram-profile none

Safety:
  * the code area 0x0000-0xF7FF must be byte-identical to the blogger's stock
    image (the patches were found for exactly that build). --force-sites relaxes
    this to only checking the 2-byte "before" values plus 16 bytes of context
  * every patch checks its "before" bytes and refuses to run if they don't match
  * the settings area 0xF800-0xFFFF is device-specific and is only touched by
    the NVRAM profile patch (byte 1 of each valid 0xAA record)
"""
import argparse
import hashlib
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STOCK = os.path.join(os.path.dirname(ROOT), "display_docs", "FMD FT32F030C8AT7_fullDump.bin.pdf")
FLASH_BASE = 0x08000000
SIZE = 0x10000
CODE_END = 0xF800  # 0xF800..0xFFFF = per-device settings / NVRAM
NVRAM = (0xFE00, 0x10000)

# (name, offset, before, after, description)
SPEED = [("speed", 0x63FA, b"\x52\x48", b"\xC9\xE0",
          "b 0x08006590: bypass display speed clamp (live speed 0-199 km/h)")]
GEAR_CTRL = [
    ("gear-hook-call", 0x6D12, bytes.fromhex("d5488478"), bytes.fromhex("fff775fb"),
     "bl 0x08006400: hook 0x36 UART RX handler to apply gear from rxBuf[4] (bit 2 valid, bits 0..1 gear 0..3)"),
    ("gear-hook-body", 0x6400,
     bytes.fromhex("49d045480078002822d04d480078012804d002280ad0032818d10fe04a480088052802dd06204849088010e046480088082802dd"),
     bytes.fromhex("08480279d3080cd303231a40064b1a700022064b1a80064b1a88202002431a800048704768020020f4000020e2010020ae010020"),
     "gear_hook at 0x08006400: if (rxBuf[4] & 4) != 0 -> *(0x200000f4) = rxBuf[4] & 3 (0=Park, 1..3=Gear), reset idle timer"),
]
BT_ICON = [
    ("bt-icon-branch", 0x634A, bytes.fromhex("022803d07648"), bytes.fromhex("012803d008e0"),
     "show solid BT icon when *(0x20000109)==1 (rxBuf[4] & 0x80), hide when 0"),
    ("bt-icon-ptr", 0x6538, bytes.fromhex("a601"), bytes.fromhex("0901"),
     "point BT icon check at 0x20000109 (set by rxBuf[4] & 0x80) instead of inner BLE 0x200001a6"),
]
PMENU = [
    ("pmenu-skip", 0x3506, b"\x1C\x48", b"\x70\x47", "bx lr: no hidden P-entries, P01..P23 continuous"),
    ("pmenu-wrap", 0x3502, b"\x03\x20", b"\x01\x20", "after P23 wrap to P01 instead of P03"),
    ("pmenu-boot", 0x5120, b"\x03\x20", b"\x01\x20", "P-menu starts at P01 instead of P03"),
]
PROFILES = {"0": 0x00, "open": 0x00, "1": 0x01, "eu": 0x01, "2": 0x02, "abe": 0x02, "3": 0x03}


def md5(b):
    return hashlib.md5(b).hexdigest()


def disasm(img, off, n=6):
    tool = shutil.which("arm-none-eabi-objdump")
    if not tool:
        return ""
    tmp = os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), ".disasm.bin")
    with open(tmp, "wb") as f:
        f.write(img)
    try:
        out = subprocess.run(
            [tool, "-D", "-b", "binary", "-marm", "-Mforce-thumb", f"--adjust-vma={FLASH_BASE:#x}",
             f"--start-address={FLASH_BASE + off:#x}", f"--stop-address={FLASH_BASE + off + 2 * n:#x}", tmp],
            capture_output=True, text=True).stdout
    finally:
        os.remove(tmp)
    return "\n".join("      " + l.strip() for l in out.splitlines() if l.strip().startswith("80"))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dump", help="64 KiB dump of YOUR display (from tools/dump.sh)")
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--no-speed", action="store_true", help="skip the speed clamp bypass")
    ap.add_argument("--no-gear", action="store_true", help="skip the UART gear control hook")
    ap.add_argument("--no-bt", action="store_true", help="skip the UART Bluetooth icon patch")
    ap.add_argument("--no-pmenu", action="store_true", help="skip the 3 P-menu patches")
    ap.add_argument("--nvram-profile", default="0",
                    help="0/open (default), 1/eu, 2/abe, 3, or 'none' to leave NVRAM untouched")
    ap.add_argument("--force-sites", action="store_true",
                    help="allow a non-identical code area if every patch site + context matches")
    a = ap.parse_args()

    img = bytearray(open(a.dump, "rb").read())
    stock = open(STOCK, "rb").read()
    if len(img) != SIZE:
        sys.exit(f"dump is {len(img)} bytes, expected {SIZE}")

    print(f"input : {a.dump}  md5={md5(img)}")
    code_same = img[:CODE_END] == stock[:CODE_END]
    if code_same:
        print("code  : 0x0000-0xF7FF identical to the blogger's stock firmware -> patches apply exactly")
    else:
        ndiff = sum(1 for i in range(CODE_END) if img[i] != stock[i])
        print(f"code  : {ndiff} bytes differ from the blogger's stock firmware")
        if not a.force_sites:
            sys.exit("REFUSING: different firmware build. Offsets must be ported, not copied "
                     "(re-run with --force-sites only if you know what you are doing).")

    orig_img = bytes(img)
    patches = ([] if a.no_speed else SPEED) + ([] if a.no_gear else GEAR_CTRL) + ([] if a.no_bt else BT_ICON) + ([] if a.no_pmenu else PMENU)
    for name, off, before, after, desc in patches:
        plen = len(before)
        cur = bytes(img[off:off + plen])
        if cur == after:
            print(f"  [{name}] 0x{off:05X} already patched")
            continue
        if cur != before:
            sys.exit(f"REFUSING: [{name}] 0x{off:05X} has {cur.hex(' ')}, expected {before.hex(' ')}")
        if not code_same and orig_img[off - 16:off + plen + 16] != stock[off - 16:off + plen + 16]:
            sys.exit(f"REFUSING: [{name}] context around 0x{off:05X} differs from stock")
        img[off:off + plen] = after
        print(f"  [{name}] 0x{off:05X} ({plen}B)  {desc}")
        print(disasm(img, off, max(3, plen // 2)))

    prof = a.nvram_profile.lower()
    if prof != "none":
        if prof not in PROFILES:
            sys.exit(f"unknown profile {a.nvram_profile}")
        val = PROFILES[prof]
        n = changed = 0
        for o in range(*NVRAM, 4):
            if img[o + 3] == 0xAA:  # valid record: [seq][profile][00][AA]
                n += 1
                if img[o + 1] != val:
                    img[o + 1] = val
                    changed += 1
        if n == 0:
            sys.exit("REFUSING: no valid NVRAM records (0xAA marker) at 0xFE00 - layout differs")
        print(f"  [nvram] {n} records at 0xFE00, profile byte -> 0x{val:02X} ({changed} changed)")

    orig = open(a.dump, "rb").read()
    changed_bytes = [i for i in range(SIZE) if img[i] != orig[i]]
    blocks = sorted({i & ~0x7FF for i in changed_bytes})
    with open(a.out, "wb") as f:
        f.write(img)
    print(f"output: {a.out}  md5={md5(img)}")
    print(f"        {len(changed_bytes)} bytes changed in 2 KiB blocks: "
          + ", ".join(f"0x{FLASH_BASE + b:08X}" for b in blocks))


if __name__ == "__main__":
    main()
