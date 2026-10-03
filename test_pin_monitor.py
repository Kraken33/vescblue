import asyncio
from bleak import BleakClient, BleakScanner

BLE_CONSOLE_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

async def test_pins():
    device = await BleakScanner.find_device_by_name("Scooter-ESP32", timeout=8.0)
    if not device:
        print("Device not found")
        return

    def on_notify(s, d):
        text = d.decode('utf-8', errors='ignore').strip()
        if "PINS[" in text or "BRK=" in text:
            print(f"[PIN MONITOR] {text}")

    async with BleakClient(device) as client:
        await client.start_notify(BLE_CONSOLE_UUID, on_notify)
        print("Connected! Polling status at 10Hz...")
        print("Please PULL and HOLD the brake lever for 3 seconds, then RELEASE it...")
        for _ in range(30):
            await client.write_gatt_char(BLE_CONSOLE_UUID, b"S", response=True)
            await asyncio.sleep(0.3)

if __name__ == "__main__":
    asyncio.run(test_pins())
