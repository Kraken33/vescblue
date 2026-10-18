import asyncio
from bleak import BleakClient, BleakScanner

BLE_CONSOLE_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
DEVICE_NAME = "Scooter-ESP32"

async def test_rpm():
    device = await BleakScanner.find_device_by_name(DEVICE_NAME, timeout=8.0)
    if not device: return

    def on_notify(s, d):
        print(f"[Telemetry] {d.decode('utf-8', errors='ignore')}")

    async with BleakClient(device) as client:
        await client.start_notify(BLE_CONSOLE_UUID, on_notify)
        await asyncio.sleep(0.5)

        print("\n--- Test RPM Command (KICK=ROLL) ---")
        # Let's test
        await asyncio.sleep(2.0)

if __name__ == "__main__":
    asyncio.run(test_rpm())
