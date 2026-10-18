#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FW_DIR="$(dirname "$SCRIPT_DIR")"
OPENOCD_DIR="$FW_DIR/openocd"
BACKUP_ROOT="$FW_DIR/backups"

STAMP="$(date +%Y%m%d_%H%M%S)"
TARGET_DIR="$BACKUP_ROOT/$STAMP"
mkdir -p "$TARGET_DIR"

OUT_PREFIX="$TARGET_DIR/display"

echo "=== Dumping Display Flash via ST-Link ==="
echo "Target directory: $TARGET_DIR"

openocd -f "$OPENOCD_DIR/ft32f030.cfg" \
  -c "init; halt; set OUT \"$OUT_PREFIX\"; source \"$OPENOCD_DIR/dump.tcl\"; shutdown"

DUMP_FILE="${OUT_PREFIX}.bin"

# Assemble chunks
rm -f "$DUMP_FILE"
for off in $(seq 0 2048 63488); do
  HEX_OFF=$(printf "%05X" "$off")
  PART="${OUT_PREFIX}_${HEX_OFF}.part"
  if [ ! -f "$PART" ]; then
    echo "Error: Missing chunk $PART!"
    exit 1
  fi
  cat "$PART" >> "$DUMP_FILE"
  rm -f "$PART"
done

if [ ! -f "$DUMP_FILE" ]; then
  echo "Error: Dump file $DUMP_FILE was not created!"
  exit 1
fi

FILE_SIZE=$(wc -c < "$DUMP_FILE" | tr -d ' ')
if [ "$FILE_SIZE" -ne 65536 ]; then
  echo "Error: Dump size is $FILE_SIZE bytes, expected 65536 bytes!"
  exit 1
fi

echo "=== Dump successful! ==="
echo "File: $DUMP_FILE"
echo "MD5 : $(md5 -q "$DUMP_FILE" 2>/dev/null || md5sum "$DUMP_FILE" | cut -d' ' -f1)"
echo "Size: $FILE_SIZE bytes"
