import asyncio
from bleak import BleakClient, BleakScanner

BLE_CONSOLE_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

async def test():
    print("Connecting to Scooter-ESP32...")
    device = await BleakScanner.find_device_by_name("Scooter-ESP32", timeout=5.0)
    if not device:
        print("Device not found")
        return
    async with BleakClient(device) as client:
        def on_notify(s, d):
            print(f"[LIVE] {d.decode('utf-8', errors='ignore')}")
        await client.start_notify(BLE_CONSOLE_UUID, on_notify)
        
        print("\n--- Test Brake via Override: T 0.7 1 ---")
        await client.write_gatt_char(BLE_CONSOLE_UUID, b"T 0.7 1", response=True)
        await asyncio.sleep(2.0)
        
        print("\n--- Test Brake Release: T 0.7 0 ---")
        await client.write_gatt_char(BLE_CONSOLE_UUID, b"T 0.7 0", response=True)
        await asyncio.sleep(1.0)
        
        print("\n--- Test Mode OFF (Live physical pins) ---")
        await client.write_gatt_char(BLE_CONSOLE_UUID, b"T", response=True)
        await asyncio.sleep(1.0)
        
        print("\n--- Final Status ---")
        await client.write_gatt_char(BLE_CONSOLE_UUID, b"S", response=True)
        await asyncio.sleep(1.0)

if __name__ == "__main__":
    asyncio.run(test())
