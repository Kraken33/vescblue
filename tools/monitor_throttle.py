import asyncio
from bleak import BleakClient, BleakScanner

BLE_CONSOLE_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
DEVICE_NAME = "Scooter-ESP32"

async def monitor():
    print(f"Connecting to {DEVICE_NAME} for live throttle monitor...")
    device = await BleakScanner.find_device_by_name(DEVICE_NAME, timeout=8.0)
    if not device:
        print("Device not found.")
        return

    def on_notify(sender, data):
        print(f"[Telemetry] {data.decode('utf-8', errors='ignore')}")

    async with BleakClient(device) as client:
        print("Connected! Press the physical throttle lever to test:")
        await client.start_notify(BLE_CONSOLE_UUID, on_notify)
        try:
            while True:
                await asyncio.sleep(1.0)
        except KeyboardInterrupt:
            print("Stopped monitoring.")

if __name__ == "__main__":
    asyncio.run(monitor())
