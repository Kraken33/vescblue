import asyncio
from bleak import BleakClient, BleakScanner

BLE_CONSOLE_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
DEVICE_NAME = "Scooter-ESP32"

async def diagnose():
    print(f"Connecting to {DEVICE_NAME} for diagnostics...")
    device = await BleakScanner.find_device_by_name(DEVICE_NAME, timeout=8.0)
    if not device:
        print("Device not found.")
        return

    def on_notify(sender, data):
        print(f"[ESP32] {data.decode('utf-8', errors='ignore')}")

    async with BleakClient(device) as client:
        await client.start_notify(BLE_CONSOLE_UUID, on_notify)
        await asyncio.sleep(0.5)

        print("\n--- Requesting detailed status ('S') ---")
        await client.write_gatt_char(BLE_CONSOLE_UUID, b"S", response=True)
        await asyncio.sleep(2.0)

        # Let's also monitor raw values for 5 seconds
        print("\n--- Monitoring live stream for 5 seconds ---")
        await asyncio.sleep(5.0)

if __name__ == "__main__":
    asyncio.run(diagnose())
