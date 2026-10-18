import asyncio
from bleak import BleakClient, BleakScanner

BLE_CONSOLE_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
DEVICE_NAME = "Scooter-ESP32"

async def test_zero_start():
    print(f"Connecting to {DEVICE_NAME}...")
    device = await BleakScanner.find_device_by_name(DEVICE_NAME, timeout=8.0)
    if not device:
        print("Device not found.")
        return

    def on_notify(sender, data):
        print(f"[Live] {data.decode('utf-8', errors='ignore')}")

    async with BleakClient(device) as client:
        await client.start_notify(BLE_CONSOLE_UUID, on_notify)
        await asyncio.sleep(0.5)

        print("\n--- Setting Kick-start to 0 (Zero Start / Bench Mode) ---")
        await client.write_gatt_char(BLE_CONSOLE_UUID, b"K 0", response=True)
        await asyncio.sleep(1.0)

        print("\n--- Testing Throttle Override (T 2.5 0) ---")
        await client.write_gatt_char(BLE_CONSOLE_UUID, b"T 2.5 0", response=True)
        await asyncio.sleep(2.0)

        print("\n--- Disabling Throttle Override (T) ---")
        await client.write_gatt_char(BLE_CONSOLE_UUID, b"T", response=True)
        await asyncio.sleep(1.0)

if __name__ == "__main__":
    asyncio.run(test_zero_start())
