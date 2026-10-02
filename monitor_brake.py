import asyncio
from bleak import BleakClient, BleakScanner

BLE_CONSOLE_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

async def monitor():
    print("Connecting to Scooter-ESP32...")
    device = await BleakScanner.find_device_by_name("Scooter-ESP32", timeout=5.0)
    if not device:
        print("Device not found")
        return
    async with BleakClient(device) as client:
        def on_notify(s, d):
            print(f"[LIVE] {d.decode('utf-8', errors='ignore')}")
        await client.start_notify(BLE_CONSOLE_UUID, on_notify)
        
        # Test BP 19
        print("\n--- Setting Brake Pin to GPIO 19 ---")
        await client.write_gatt_char(BLE_CONSOLE_UUID, b"BP 19", response=True)
        await asyncio.sleep(1.0)
        
        print("\n--- Requesting S ---")
        for _ in range(5):
            await client.write_gatt_char(BLE_CONSOLE_UUID, b"S", response=True)
            await asyncio.sleep(1.0)

if __name__ == "__main__":
    asyncio.run(monitor())
