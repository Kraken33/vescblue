import asyncio
from bleak import BleakClient, BleakScanner

BLE_CONSOLE_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
DEVICE_NAME = "Scooter-ESP32"

async def test_commands():
    print(f"Connecting to {DEVICE_NAME} to run interactive checks...")
    device = await BleakScanner.find_device_by_name(DEVICE_NAME, timeout=8.0)
    if not device:
        print("Device not found.")
        return

    def on_notify(sender, data):
        print(f"[Live Line] {data.decode('utf-8', errors='ignore')}")

    async with BleakClient(device) as client:
        await client.start_notify(BLE_CONSOLE_UUID, on_notify)
        await asyncio.sleep(0.5)

        # 1. Query help
        print("\n--- Sending '?' (Help) ---")
        await client.write_gatt_char(BLE_CONSOLE_UUID, b"?", response=True)
        await asyncio.sleep(0.8)

        # 2. Query status
        print("\n--- Sending 'S' (Status) ---")
        await client.write_gatt_char(BLE_CONSOLE_UUID, b"S", response=True)
        await asyncio.sleep(0.8)

        # 3. Test Throttle Override (2.0V)
        print("\n--- Sending 'T 2.0 0' (Override Throttle to 2.0V) ---")
        await client.write_gatt_char(BLE_CONSOLE_UUID, b"T 2.0 0", response=True)
        await asyncio.sleep(0.8)

        # 4. Turn Test Override Off
        print("\n--- Sending 'T' (Disable Test Override) ---")
        await client.write_gatt_char(BLE_CONSOLE_UUID, b"T", response=True)
        await asyncio.sleep(0.8)

        print("\nAll interactive checks completed successfully!")

if __name__ == "__main__":
    asyncio.run(test_commands())
