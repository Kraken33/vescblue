import asyncio
from bleak import BleakClient, BleakScanner

BLE_CONSOLE_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
DEVICE_NAME = "Scooter-ESP32"

def notification_handler(sender, data):
    print(f"[Notify] {data.decode('utf-8', errors='ignore')}")

async def test_status():
    print(f"Scanning for {DEVICE_NAME}...")
    device = await BleakScanner.find_device_by_name(DEVICE_NAME, timeout=8.0)
    if not device:
        print(f"Device '{DEVICE_NAME}' not found.")
        return

    print(f"Connecting to {device.name}...")
    async with BleakClient(device) as client:
        print("Connected! Subscribing to notifications...")
        await client.start_notify(BLE_CONSOLE_UUID, notification_handler)
        
        # Send status command 'S'
        await client.write_gatt_char(BLE_CONSOLE_UUID, b"S", response=True)
        await asyncio.sleep(2.0)

asyncio.run(test_status())
