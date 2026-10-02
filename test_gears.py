import asyncio
from bleak import BleakClient, BleakScanner

BLE_CONSOLE_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
DEVICE_NAME = "Scooter-ESP32"

async def test_gears():
    device = await BleakScanner.find_device_by_name(DEVICE_NAME, timeout=8.0)
    if not device: return

    def on_notify(s, d):
        print(f"[Telemetry] {d.decode('utf-8', errors='ignore')}")

    async with BleakClient(device) as client:
        await client.start_notify(BLE_CONSOLE_UUID, on_notify)
        await asyncio.sleep(0.5)

        # 1. Test Gear 2 (15 km/h limit -> 4699 ERPM)
        print("\n--- Testing Gear 2 (Target: 15.0 km/h / 4699 ERPM) ---")
        await client.write_gatt_char(BLE_CONSOLE_UUID, b"G 2", response=True)
        await asyncio.sleep(0.5)
        await client.write_gatt_char(BLE_CONSOLE_UUID, b"T 3.0 0", response=True)
        await asyncio.sleep(3.0)
        await client.write_gatt_char(BLE_CONSOLE_UUID, b"T", response=True)
        await asyncio.sleep(1.0)

        # 2. Test Gear 3 (22 km/h limit -> 6892 ERPM)
        print("\n--- Testing Gear 3 (Target: 22.0 km/h / 6892 ERPM) ---")
        await client.write_gatt_char(BLE_CONSOLE_UUID, b"G 3", response=True)
        await asyncio.sleep(0.5)
        await client.write_gatt_char(BLE_CONSOLE_UUID, b"T 3.0 0", response=True)
        await asyncio.sleep(3.0)
        await client.write_gatt_char(BLE_CONSOLE_UUID, b"T", response=True)
        await asyncio.sleep(1.0)

if __name__ == "__main__":
    asyncio.run(test_gears())
