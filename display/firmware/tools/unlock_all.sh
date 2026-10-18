#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FW_DIR="$(dirname "$SCRIPT_DIR")"
OPENOCD_DIR="$FW_DIR/openocd"
BACKUP_ROOT="$FW_DIR/backups"

STAMP="$(date +%Y%m%d_%H%M%S)"
TARGET_DIR="$BACKUP_ROOT/$STAMP"
mkdir -p "$TARGET_DIR"

DUMP_PREFIX="$TARGET_DIR/display_stock"
DUMP_BIN="${DUMP_PREFIX}.bin"
PATCHED_BIN="$TARGET_DIR/display_unlocked.bin"
PLAN_FILE="$TARGET_DIR/flash_plan.tcl"

echo "=========================================================="
echo "    FMD FT32F030 Display Firmware Speed Unlocker          "
echo "=========================================================="
echo "1. Step 1: Dump current display firmware (backup)..."

openocd -f "$OPENOCD_DIR/ft32f030.cfg" \
  -c "init; halt; set OUT \"$DUMP_PREFIX\"; source \"$OPENOCD_DIR/dump.tcl\"; resume; shutdown"

# Assemble chunks
rm -f "$DUMP_BIN"
for off in $(seq 0 2048 63488); do
  HEX_OFF=$(printf "%05X" "$off")
  PART="${DUMP_PREFIX}_${HEX_OFF}.part"
  if [ ! -f "$PART" ]; then
    echo "Error: Missing chunk $PART!"
    exit 1
  fi
  cat "$PART" >> "$DUMP_BIN"
  rm -f "$PART"
done

if [ ! -f "$DUMP_BIN" ]; then
  echo "Error: Backup failed! Target dump not found."
  exit 1
fi

echo "Backup created at: $DUMP_BIN (Size: $(wc -c < "$DUMP_BIN" | tr -d ' ') bytes)"

echo ""
echo "2. Step 2: Applying speed unlock and P-menu patches..."
python3 "$SCRIPT_DIR/patch_fw.py" "$DUMP_BIN" -o "$PATCHED_BIN" --force-sites

echo ""
echo "3. Step 3: Generating minimal flash plan..."
python3 "$SCRIPT_DIR/make_plan.py" "$DUMP_BIN" "$PATCHED_BIN" "$PLAN_FILE"

echo ""
echo "4. Step 4: Flashing modified blocks and verifying..."
openocd -f "$OPENOCD_DIR/ft32f030.cfg" \
  -c "init; halt; source \"$PLAN_FILE\"; source \"$OPENOCD_DIR/flash_blocks.tcl\"; reset run; shutdown"

echo ""
echo "=========================================================="
echo "   Speed Unlock Applied Successfully! Display Rebooted.   "
echo "=========================================================="
