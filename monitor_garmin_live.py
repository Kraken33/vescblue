import asyncio
import sys
from bleak import BleakScanner

GARMIN_KEYWORDS = [
    "garmin", "forerunner", "fenix", "epix", "venu", "instinct",
    "vivo", "enduro", "tactix", "marq", "approach", "descent", "d2"
]

known_devices = {}

def on_detected(device, ad):
    name = ad.local_name or device.name or "(Unknown/Hidden)"
    mfg = {f"0x{k:04X}": v.hex() for k, v in ad.manufacturer_data.items()}
    services = ad.service_uuids
    rssi = ad.rssi

    is_garmin = False
    notes = []

    # Check for Garmin name
    for kw in GARMIN_KEYWORDS:
        if kw in name.lower():
            is_garmin = True
            notes.append(f"Name '{name}'")
            break

    # Check Garmin manufacturer ID
    if 0x0087 in ad.manufacturer_data or 0x006B in ad.manufacturer_data:
        is_garmin = True
        notes.append("Garmin Mfg ID (0x0087/0x006B)")

    # Check standard BLE Heart Rate broadcast (180d)
    for s in services:
        if "180d" in s.lower():
            is_garmin = True
            notes.append("BLE Heart Rate Service (0x180D)")
        elif "6a4e" in s.lower():
            is_garmin = True
            notes.append(f"Garmin Service ({s})")

    # Check for Apple / iPhone
    if 0x004C in ad.manufacturer_data:
        if "iphone" in name.lower():
            notes.append("iPhone")

    is_new = device.address not in known_devices
    known_devices[device.address] = {"name": name, "rssi": rssi, "mfg": mfg, "services": services}

    if is_garmin:
        print(f"\n🎉 [GARMIN WATCH DETECTED!]")
        print(f"   Name:     {name}")
        print(f"   Signal:   {rssi} dBm")
        print(f"   Address:  {device.address}")
        print(f"   Matches:  {', '.join(notes)}")
        print(f"   Mfg Data: {mfg}")
        print(f"   Services: {services}\n")
    elif is_new:
        print(f"  [+] Discovered: {name} (RSSI: {rssi} dBm) | ID: {device.address} | Mfg: {mfg} | Svc: {services}")

async def main():
    print("=" * 65)
    print(" LIVE BLE LISTENER (Listening for 20s...)")
    print(" Try enabling 'Broadcast Heart Rate' on your Garmin watch")
    print(" or start a workout/activity on your watch!")
    print("=" * 65)

    scanner = BleakScanner(detection_callback=on_detected)
    await scanner.start()
    for _ in range(20):
        await asyncio.sleep(1)
    await scanner.stop()
    print("\nScan completed.")

if __name__ == "__main__":
    asyncio.run(main())
