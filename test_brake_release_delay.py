import asyncio
from bleak import BleakClient, BleakScanner

BLE_CONSOLE_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

async def test_brake_flow():
    device = await BleakScanner.find_device_by_name("Scooter-ESP32", timeout=8.0)
    if not device:
        print("Device not found")
        return

    def on_notify(s, d):
        print(f"[LIVE] {d.decode('utf-8', errors='ignore').strip()}")

    async with BleakClient(device) as client:
        await client.start_notify(BLE_CONSOLE_UUID, on_notify)
        await asyncio.sleep(0.5)

        print("\n=== 1. Test Mode: Engage Brake (T 0.7 1) ===")
        await client.write_gatt_char(BLE_CONSOLE_UUID, b"T 0.7 1", response=True)
        await asyncio.sleep(1.0)
        await client.write_gatt_char(BLE_CONSOLE_UUID, b"S", response=True)
        await asyncio.sleep(0.5)

        print("\n=== 2. Test Mode: Release Brake (T 0.7 0) ===")
        await client.write_gatt_char(BLE_CONSOLE_UUID, b"T 0.7 0", response=True)
        await asyncio.sleep(0.5)
        await client.write_gatt_char(BLE_CONSOLE_UUID, b"S", response=True)
        await asyncio.sleep(1.0)

        print("\n=== 3. Disable Test Mode (T) ===")
        await client.write_gatt_char(BLE_CONSOLE_UUID, b"T", response=True)
        await asyncio.sleep(0.5)
        await client.write_gatt_char(BLE_CONSOLE_UUID, b"S", response=True)
        await asyncio.sleep(0.5)

if __name__ == "__main__":
    asyncio.run(test_brake_flow())
