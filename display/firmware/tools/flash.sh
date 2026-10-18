#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FW_DIR="$(dirname "$SCRIPT_DIR")"
OPENOCD_DIR="$FW_DIR/openocd"

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <current_or_stock_dump.bin> <target_patched.bin>"
  exit 1
fi

CUR_BIN="$1"
TGT_BIN="$2"
PLAN_FILE="$FW_DIR/flash_plan.tcl"

if [ ! -f "$CUR_BIN" ] || [ ! -f "$TGT_BIN" ]; then
  echo "Error: Input files not found."
  exit 1
fi

echo "=== Generating flash plan ==="
python3 "$SCRIPT_DIR/make_plan.py" "$CUR_BIN" "$TGT_BIN" "$PLAN_FILE"

echo "=== Flashing modified blocks via ST-Link ==="
openocd -f "$OPENOCD_DIR/ft32f030.cfg" \
  -c "init; halt; source \"$PLAN_FILE\"; source \"$OPENOCD_DIR/flash_blocks.tcl\"; reset run; shutdown"

echo "=== Flashing completed and verified successfully! ==="
