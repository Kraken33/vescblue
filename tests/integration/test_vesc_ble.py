import asyncio
from bleak import BleakClient, BleakScanner

async def test_vesc_ble():
    print("Scanning for VESC BLE UART...")
    device = await BleakScanner.find_device_by_name("VESC BLE UART", timeout=8.0)
    if not device:
        print("VESC BLE UART not found.")
        return

    print(f"Connecting to VESC ({device.address})...")
    async with BleakClient(device) as client:
        print("Connected to VESC!")
        for s in client.services:
            print(f"Service: {s.uuid}")
            for c in s.characteristics:
                print(f"  Char: {c.uuid} ({c.properties})")

if __name__ == "__main__":
    asyncio.run(test_vesc_ble())
