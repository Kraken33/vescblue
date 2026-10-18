# VESC Blue Project

A smart controller system for electric scooters powered by VESC, featuring dual ESP32 firmwares, reverse-engineered display UART protocol synchronization, active anti-theft motor lock, e-ABS braking, and a React Native / Expo companion mobile application.

---

## Repository Structure

```
vescblue/
├── firmware/
│   ├── vescblue/               # Main ESP32 scooter controller firmware
│   │   ├── vescblue.ino        # Arduino sketch entrypoint (BLE, VESC UART, display UART, Park Lock, e-ABS)
│   │   ├── LightsController.h  # Lighting & turn signal subsystem header
│   │   └── LightsController.cpp# Lighting & turn signal subsystem implementation
│   └── antispark/              # Secondary ESP32/ESP32-C3 antispark switch & iBeacon
│       ├── antispark.ino       # Arduino sketch entrypoint
│       └── main.cpp            # Optocoupler control, BLE switch service & Apple iBeacon
│
├── mobile/                     # React Native / Expo companion app (iOS & Android)
│   ├── App.tsx                 # Main dashboard UI, BLE connection, controls
│   ├── modules/scooter-beacon/ # Native iOS CoreBluetooth / CoreLocation beacon module
│   └── ...
│
├── display/                    # Display firmware reverse engineering, tooling & VESC Lisp
│   ├── docs/                   # Datasheets, schematics, and patch notes
│   ├── firmware/               # OpenOCD configs, patchers, backups, and flash tools
│   ├── lisp/                   # VESC Lisp script (display.lisp)
│   └── emulator/               # UART speed & protocol emulator (emulate_display_speed.py)
│
├── tools/                      # Host-side utilities for device management & monitoring
│   ├── ble_ota_flash.py        # ESP32 BLE OTA firmware flasher
│   ├── ble_status.py           # BLE live status checker
│   ├── diagnose_esp32.py       # Hardware and sensor diagnostic utility
│   ├── monitor_brake.py        # Real-time brake sensor monitor
│   └── monitor_throttle.py     # Real-time throttle ADC monitor
│
├── tests/                      # Automated & hardware-in-the-loop tests
│   ├── integration/            # BLE hardware-in-the-loop Python tests
│   │   ├── test_ble_commands.py
│   │   ├── test_brake_strength.py
│   │   ├── test_control.py
│   │   ├── test_full_gear1.py
│   │   ├── test_gears.py
│   │   ├── test_rpm.py
│   │   ├── test_vesc_ble.py
│   │   └── test_zero_start.py
│   └── unit/                   # Host-compiled C++ algorithm & protocol unit tests
│       ├── test_speed_governor.cpp
│       └── test_protocol.cpp
│
├── archive/                    # Archived early prototypes / legacy modular code
│   └── modular_prototype/      # Earlier modular C++ classes (Config, MotorController, etc.)
│
├── Makefile                    # Unified developer shortcuts (build, test, flash, clean)
└── .gitignore                  # Git ignore rules for build artifacts and temporary files
```

---

## Quick Start & Developer Commands

A top-level `Makefile` provides standard shortcuts for building, testing, and flashing:

### Build Firmware
```bash
# Build main ESP32 controller firmware
make build-vescblue

# Build antispark & iBeacon firmware
make build-antispark
```

### Run Unit Tests
Host-compiled C++ unit tests verify the speed governor PI algorithm, VESC CRC calculations, and display packet encoding:
```bash
make test-unit
```

### Flash Firmware over BLE (OTA)
```bash
make flash-ota
# Or specify a custom binary:
python3 tools/ble_ota_flash.py path/to/firmware.bin
```

### Clean Build Output
```bash
make clean
```

---

## Subsystems Overview

### 1. Main Controller Firmware (`firmware/vescblue/`)
- Target: Classic ESP32 (WROOM / WROVER) with partition scheme `min_spiffs`.
- Connects to master VESC over UART (115200 Baud) and slave VESC over CAN bus (ID 37).
- Interfaces with IO-Hawk / VSETT LCD display over UART (1200 Baud).
- Features active anti-theft motor lock in Park mode (Gear 0), Dualtron-style e-ABS pulsating braking with synchronized brake strobe, profile switching, and OTA updates over BLE.

### 2. Antispark Firmware (`firmware/antispark/`)
- Target: ESP32 or ESP32-C3 SuperMini.
- Controls high-voltage battery connection via optocoupler switch.
- Broadcasts Apple iBeacon payload for automated proximity unlocking in iOS CoreLocation.

### 3. Display Subsystem (`display/`)
- `display/firmware/tools/`: Scripts to dump, patch, and flash unlocked firmware (FT32F030 MCU) via OpenOCD & ST-Link.
- `display/emulator/`: Run `python3 display/emulator/emulate_display_speed.py --mock` to simulate motor speed stream on UART.
- `display/lisp/`: VESC Lisp code for running directly inside VESC Tool.

### 4. Mobile Companion App (`mobile/`)
- Built with React Native and Expo (`expo start`).
- Manages real-time telemetry, gear selection, Park mode, dual-motor toggle, and background beacon proximity detection.
