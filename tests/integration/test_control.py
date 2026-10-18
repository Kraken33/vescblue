import asyncio
from bleak import BleakClient, BleakScanner

BLE_CONSOLE_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
DEVICE_NAME = "Scooter-ESP32"

async def test_control():
    device = await BleakScanner.find_device_by_name(DEVICE_NAME, timeout=8.0)
    if not device:
        print("Device not found")
        return

    def on_notify(s, d):
        print(f"[Telemetry] {d.decode('utf-8', errors='ignore')}")

    async with BleakClient(device) as client:
        await client.start_notify(BLE_CONSOLE_UUID, on_notify)
        await asyncio.sleep(0.5)

        # Test small gentle throttle (1.2V -> 10% throttle)
        print("\n--- Test Gentle Throttle 1.2V (10% throttle) ---")
        await client.write_gatt_char(BLE_CONSOLE_UUID, b"T 1.2 0", response=True)
        await asyncio.sleep(2.0)

        # Test 1.5V -> ~25% throttle
        print("\n--- Test Moderate Throttle 1.5V (25% throttle) ---")
        await client.write_gatt_char(BLE_CONSOLE_UUID, b"T 1.5 0", response=True)
        await asyncio.sleep(2.0)

        # Disable
        await client.write_gatt_char(BLE_CONSOLE_UUID, b"T", response=True)
        await asyncio.sleep(1.0)

if __name__ == "__main__":
    asyncio.run(test_control())
