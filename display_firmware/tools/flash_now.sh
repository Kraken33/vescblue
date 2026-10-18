#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FW_DIR="$(dirname "$SCRIPT_DIR")"
OPENOCD_DIR="$FW_DIR/openocd"
PLAN_FILE="$FW_DIR/plan.tcl"

echo "=========================================================="
echo "  Flashing Speed Unlock to Display MCU...                 "
echo "=========================================================="

ATTEMPTS=0
MAX_ATTEMPTS=90

while [ $ATTEMPTS -lt $MAX_ATTEMPTS ]; do
  ATTEMPTS=$((ATTEMPTS + 1))
  echo -n "Attempt $ATTEMPTS: "
  OUT=$(openocd -f "$OPENOCD_DIR/ft32f030.cfg" \
    -c "init; halt; source \"$PLAN_FILE\"; source \"$OPENOCD_DIR/flash_blocks.tcl\"; reset run; shutdown" 2>&1 || true)
  if echo "$OUT" | grep -q "FLASH OK - locked"; then
    echo ""
    echo "$OUT"
    echo ""
    echo "=========================================================="
    echo "  SUCCESS! Speed unlock flashed and verified!             "
    echo "=========================================================="
    exit 0
  fi
  if echo "$OUT" | grep -q "FLASH FAILED"; then
    echo "Flash error occurred!"
    echo "$OUT"
    exit 1
  fi
  echo "waiting for target..."
  sleep 1
done

echo "Timed out waiting for target."
exit 1
