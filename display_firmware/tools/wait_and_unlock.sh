#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=========================================================="
echo "  Waiting for ST-Link / Display to connect...             "
echo "  Please unplug and replug the 3.3V wire or ST-Link USB!  "
echo "=========================================================="

ATTEMPTS=0
MAX_ATTEMPTS=60

while [ $ATTEMPTS -lt $MAX_ATTEMPTS ]; do
  ATTEMPTS=$((ATTEMPTS + 1))
  echo -n "Attempt $ATTEMPTS: "
  if /bin/bash "$SCRIPT_DIR/unlock_all.sh"; then
    echo ""
    echo "SUCCESS: Display speed unlock complete!"
    exit 0
  fi
  echo "waiting for reconnect..."
  sleep 1
done

echo ""
echo "Timed out waiting for target connection."
exit 1
