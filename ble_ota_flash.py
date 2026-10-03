import asyncio
import sys
import os
import time
from bleak import BleakClient, BleakScanner

BLE_SVC_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
BLE_CONSOLE_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
BLE_OTA_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
DEVICE_NAME = "Scooter-ESP32"

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

async def flash_firmware(bin_path):
    global ota_error, ota_ready, ota_done
    if not os.path.exists(bin_path):
        print(f"Error: Binary file {bin_path} not found!")
        return False

    with open(bin_path, 'rb') as f:
        firmware_bytes = f.read()

    total_len = len(firmware_bytes)
    print(f"Firmware file: {bin_path}")
    print(f"Firmware size: {total_len:,} bytes ({total_len / 1024:.1f} KB)")

    print(f"Scanning for {DEVICE_NAME}...")
    device = await BleakScanner.find_device_by_name(DEVICE_NAME, timeout=6.0)
    if not device:
        devs = await BleakScanner.discover(timeout=5.0)
        for d in devs:
            if (d.name and (DEVICE_NAME.lower() in d.name.lower() or "scooter" in d.name.lower())) or d.address == "C8B428FF-57B8-F106-DD38-D3C71AAC8EAE":
                device = d
                break
    if not device:
        print(f"Could not find BLE device named '{DEVICE_NAME}'!")
        return False

    print(f"Connecting to {device.name} ({device.address})...")
    async with BleakClient(device) as client:
        print("Connected! Subscribing to console notifications...")
        await client.start_notify(BLE_CONSOLE_UUID, notification_handler)
        await asyncio.sleep(0.5)

        # 1. Send OTA:BEGIN:<len>
        ota_ready = False
        cmd_begin = f"OTA:BEGIN:{total_len}".encode('utf-8')
        print(f"Sending start command: OTA:BEGIN:{total_len}...")
        await client.write_gatt_char(BLE_CONSOLE_UUID, cmd_begin, response=True)

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
        # Standard BLE chunk size (256 or 512 bytes)
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
            await client.write_gatt_char(BLE_OTA_UUID, chunk, response=True)
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
            await client.write_gatt_char(BLE_CONSOLE_UUID, b"OTA:END", response=True)
            for _ in range(30):
                if ota_done or ota_error:
                    break
                await asyncio.sleep(0.1)
        except Exception:
            pass # ESP32 reboots immediately on OTA:END

        if ota_error:
            print("ESP32 reported an error during OTA finalization!")
            return False

        print("Firmware flashed successfully! ESP32 rebooted into the new firmware.")
        return True

if __name__ == "__main__":
    bin_file = sys.argv[1] if len(sys.argv) > 1 else "build/vescblue.ino.bin"
    success = asyncio.run(flash_firmware(bin_file))
    sys.exit(0 if success else 1)
