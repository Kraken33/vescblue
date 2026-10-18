import asyncio
from bleak import BleakClient, BleakScanner

BLE_CONSOLE_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
DEVICE_NAME = "Scooter-ESP32"

async def test_full_throttle():
    device = await BleakScanner.find_device_by_name(DEVICE_NAME, timeout=8.0)
    if not device: return

    def on_notify(s, d):
        print(f"[Telemetry] {d.decode('utf-8', errors='ignore')}")

    async with BleakClient(device) as client:
        await client.start_notify(BLE_CONSOLE_UUID, on_notify)
        await asyncio.sleep(0.5)

        print("\n--- Test Full Throttle in Gear 1 (Target: 10.0 km/h / 3133 ERPM) ---")
        await client.write_gatt_char(BLE_CONSOLE_UUID, b"T 3.0 0", response=True)
        await asyncio.sleep(3.0)

        print("\n--- Test Throttle Release ---")
        await client.write_gatt_char(BLE_CONSOLE_UUID, b"T", response=True)
        await asyncio.sleep(1.5)

if __name__ == "__main__":
    asyncio.run(test_full_throttle())
