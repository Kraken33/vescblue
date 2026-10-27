import asyncio
import sys
import os
import time
import argparse
from bleak import BleakClient, BleakScanner

TARGETS = {
    "vescblue": {
        "device_name": "Scooter-ESP32",
        "svc_uuid": "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
        "console_uuid": "6e400003-b5a3-f393-e0a9-e50e24dcca9e",
        "ota_uuid": "6e400002-b5a3-f393-e0a9-e50e24dcca9e",
        "default_bins": [
            "build/vescblue.ino.bin",
            os.path.join(os.path.dirname(__file__), "..", "build", "vescblue.ino.bin"),
            os.path.join(os.path.dirname(__file__), "build", "vescblue.ino.bin"),
        ],
    },
    "antispark": {
        "device_name": "Scooter-Antispark",
        "svc_uuid": "6e400010-b5a3-f393-e0a9-e50e24dcca9e",
        "console_uuid": "6e400011-b5a3-f393-e0a9-e50e24dcca9e",
        "ota_uuid": "6e400012-b5a3-f393-e0a9-e50e24dcca9e",
        "default_bins": [
            "build/antispark/antispark.ino.bin",
            os.path.join(os.path.dirname(__file__), "..", "build", "antispark", "antispark.ino.bin"),
            os.path.join(os.path.dirname(__file__), "build", "antispark", "antispark.ino.bin"),
        ],
    },
}

ota_error = False
ota_ready = False
ota_done = False

def notification_handler(sender, data):
    global ota_error, ota_ready, ota_done
    msg = data.decode('utf-8', errors='ignore')
    print(f"\n[ESP32] {msg}")
    if "OTA:ERROR" in msg:
        ota_error = True
    elif "OTA:READY" in msg:
        ota_ready = True
    elif "OTA:OK" in msg:
        ota_done = True

async def flash_firmware(bin_path, target_key="vescblue"):
    global ota_error, ota_ready, ota_done
    cfg = TARGETS.get(target_key, TARGETS["vescblue"])
    device_name = cfg["device_name"]
    console_uuid = cfg["console_uuid"]
    ota_uuid = cfg["ota_uuid"]

    if not os.path.exists(bin_path):
        print(f"Error: Binary file {bin_path} not found!")
        return False

    with open(bin_path, 'rb') as f:
        firmware_bytes = f.read()

    total_len = len(firmware_bytes)
    print(f"Target: {target_key} ({device_name})")
    print(f"Firmware file: {bin_path}")
    print(f"Firmware size: {total_len:,} bytes ({total_len / 1024:.1f} KB)")

    print(f"Scanning for {device_name}...")
    device = await BleakScanner.find_device_by_name(device_name, timeout=10.0)
    if not device:
        print(f"Could not find BLE device named '{device_name}'!")
        return False

    print(f"Connecting to {device.name} ({device.address})...")
    async with BleakClient(device) as client:
        print("Connected! Subscribing to console notifications...")
        await client.start_notify(console_uuid, notification_handler)
        await asyncio.sleep(0.5)

        # 1. Send OTA:BEGIN:<len>
        ota_ready = False
        cmd_begin = f"OTA:BEGIN:{total_len}".encode('utf-8')
        print(f"Sending start command: OTA:BEGIN:{total_len}...")
        await client.write_gatt_char(console_uuid, cmd_begin, response=True)

        # Wait up to 3s for OTA:READY
        for _ in range(30):
            if ota_ready or ota_error:
                break
            await asyncio.sleep(0.1)

        if ota_error:
            print("OTA failed to start on ESP32!")
            return False

        print("ESP32 is ready to receive firmware stream.")

        # 2. Stream firmware chunks
        chunk_size = 512
        offset = 0
        start_time = time.time()
        last_progress_print = 0

        print("Streaming firmware...")
        while offset < total_len:
            if ota_error:
                print("\nOTA error received from ESP32 during transfer!")
                return False

            chunk = firmware_bytes[offset:offset + chunk_size]
            await client.write_gatt_char(ota_uuid, chunk, response=True)
            offset += len(chunk)

            now = time.time()
            if now - last_progress_print > 0.3 or offset == total_len:
                last_progress_print = now
                pct = (offset / total_len) * 100.0
                elapsed = now - start_time
                speed_kbs = (offset / 1024.0) / (elapsed + 0.001)
                remaining_s = ((total_len - offset) / (offset + 1)) * elapsed
                print(f"  Transfer: {offset:,}/{total_len:,} B [{pct:5.1f}%] @ {speed_kbs:4.1f} KB/s (ETA: {remaining_s:.0f}s)", end='\r')

        print(f"\n100% transferred in {time.time() - start_time:.1f}s!")
        await asyncio.sleep(0.5)

        # 3. Send OTA:END
        print("Finalizing update: Sending OTA:END...")
        try:
            await client.write_gatt_char(console_uuid, b"OTA:END", response=True)
        except Exception as e:
            print(f"Device disconnected on reboot ({e})")
            ota_done = True

        # Wait for reboot confirmation
        for _ in range(30):
            if ota_done or ota_error:
                break
            await asyncio.sleep(0.1)

        if ota_error:
            print("ESP32 reported an error during OTA finalization!")
            return False

        print(f"Firmware flashed successfully! {device_name} is rebooting into the new firmware.")
        return True

def main():
    parser = argparse.ArgumentParser(description="Flash ESP32 scooter firmware over BLE (OTA).")
    parser.add_argument("binary", nargs="?", help="Path to compiled .bin firmware file")
    parser.add_argument(
        "-t", "--target",
        choices=["vescblue", "antispark"],
        default=None,
        help="Target device: 'vescblue' (Scooter-ESP32) or 'antispark' (Scooter-Antispark)"
    )
    args = parser.parse_args()

    # Auto-detect target based on binary path or flag
    target = args.target
    bin_file = args.binary

    if target is None:
        if bin_file and "antispark" in bin_file.lower():
            target = "antispark"
        else:
            target = "vescblue"

    if not bin_file:
        candidates = TARGETS[target]["default_bins"]
        bin_file = next((c for c in candidates if os.path.exists(c)), candidates[0])

    success = asyncio.run(flash_firmware(bin_file, target))
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()
