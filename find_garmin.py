import asyncio
import sys
from bleak import BleakScanner

GARMIN_COMPANY_IDS = {
    0x0087: "Garmin International",
    0x006B: "Ant / Garmin",
}

GARMIN_KEYWORDS = [
    "garmin", "forerunner", "fenix", "epix", "venu", "instinct",
    "vivo", "enduro", "tactix", "marq", "approach", "descent", "d2"
]

async def scan_for_garmin(duration=10):
    print("=" * 60)
    print(f" Scanning for BLE Devices ({duration} seconds)...")
    print(" Please keep your Garmin watch on your wrist / nearby.")
    print("=" * 60)

    garmin_candidates = []
    all_devices = []

    def detection_callback(device, advertisement_data):
        name = advertisement_data.local_name or device.name or "(Unknown/Hidden Name)"
        rssi = advertisement_data.rssi
        mfg_data = advertisement_data.manufacturer_data
        service_uuids = advertisement_data.service_uuids

        is_garmin = False
        reason = []

        # Check name
        lower_name = name.lower()
        for kw in GARMIN_KEYWORDS:
            if kw in lower_name:
                is_garmin = True
                reason.append(f"Name match: '{kw}'")
                break

        # Check manufacturer company IDs
        for company_id, raw_bytes in mfg_data.items():
            if company_id in GARMIN_COMPANY_IDS:
                is_garmin = True
                reason.append(f"Garmin SIG Company ID: 0x{company_id:04X} ({GARMIN_COMPANY_IDS[company_id]}) - Data: {raw_bytes.hex()}")

        # Check service UUIDs
        for uuid in service_uuids:
            if "6a4e" in uuid.lower():
                is_garmin = True
                reason.append(f"Garmin Service UUID: {uuid}")
            elif "180d" in uuid.lower():
                reason.append(f"Heart Rate Service UUID: {uuid}")

        dev_entry = {
            "address": device.address,
            "name": name,
            "rssi": rssi,
            "mfg": {f"0x{k:04X}": v.hex() for k, v in mfg_data.items()},
            "services": service_uuids,
            "is_garmin": is_garmin,
            "reason": reason
        }

        # Deduplicate
        existing = next((d for d in all_devices if d["address"] == device.address), None)
        if existing:
            existing.update(dev_entry)
        else:
            all_devices.append(dev_entry)

        if is_garmin and not any(g["address"] == device.address for g in garmin_candidates):
            garmin_candidates.append(dev_entry)
            print(f"\n🎯 [FOUND GARMIN CANDIDATE!]")
            print(f"   Name:     {name}")
            print(f"   Address:  {device.address}")
            print(f"   RSSI:     {rssi} dBm")
            print(f"   Reason:   {', '.join(reason)}")
            print(f"   Mfg Data: {dev_entry['mfg']}")
            print(f"   Services: {service_uuids}\n")

    scanner = BleakScanner(detection_callback=detection_callback)
    await scanner.start()
    
    for i in range(duration):
        sys.stdout.write(f"\rScanning... {i+1}/{duration}s | Total devices found: {len(all_devices)} | Garmin matches: {len(garmin_candidates)}")
        sys.stdout.flush()
        await asyncio.sleep(1)
        
    await scanner.stop()
    print("\n\n" + "=" * 60)
    print(" SCAN RESULTS SUMMARY")
    print("=" * 60)

    if garmin_candidates:
        print(f"\n✅ SUCCESS: Detected {len(garmin_candidates)} Garmin Device(s) even while connected to phone:")
        for idx, g in enumerate(garmin_candidates, 1):
            print(f"\n  #{idx} Device: {g['name']}")
            print(f"     Identifier: {g['address']}")
            print(f"     Signal:     {g['rssi']} dBm")
            print(f"     Match:      {', '.join(g['reason'])}")
            print(f"     Mfg Data:   {g['mfg']}")
            print(f"     Services:   {g['services']}")
    else:
        print("\n⚠️ No explicit Garmin name or 0x0087 company ID was found in standard public advertisements.")
        print("\nHere are ALL nearby BLE devices detected:")
        for d in sorted(all_devices, key=lambda x: x["rssi"], reverse=True):
            print(f"  • [{d['rssi']} dBm] {d['name']} | ID: {d['address']} | Mfg: {d['mfg']} | Services: {d['services']}")

if __name__ == "__main__":
    dur = 10
    if len(sys.argv) > 1:
        try:
            dur = int(sys.argv[1])
        except ValueError:
            pass
    asyncio.run(scan_for_garmin(dur))
