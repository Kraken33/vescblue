import asyncio
from bleak import BleakClient, BleakScanner

BLE_CONSOLE_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

async def main():
    print("Scanning for Scooter-ESP32...")
    device = await BleakScanner.find_device_by_name("Scooter-ESP32", timeout=10.0)
    if not device:
        print("Searching all devices...")
        devs = await BleakScanner.discover(timeout=5.0)
        for d in devs:
            if d.name and "Scooter" in d.name:
                device = d
                break
    if not device:
        print("Device not found")
        return

    def on_notify(s, d):
        text = d.decode('utf-8', errors='ignore').strip()
        print(f"[ESP32] {text}")

    async with BleakClient(device) as client:
        await client.start_notify(BLE_CONSOLE_UUID, on_notify)
        print("Connected! Streaming live status. Pull and release the brake lever now to observe...")
        print("Running for 15 seconds...")
        for i in range(15):
            await asyncio.sleep(1.0)
            await client.write_gatt_char(BLE_CONSOLE_UUID, b"S", response=True)

if __name__ == "__main__":
    asyncio.run(main())
