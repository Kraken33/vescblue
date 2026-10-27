.PHONY: all help build-vescblue build-antispark test-unit flash-ota flash-antispark-ota flash-antispark-usb flash-vescblue-usb clean

FQBN_VESC = esp32:esp32:esp32:PartitionScheme=min_spiffs
FQBN_ANTISPARK = esp32:esp32:esp32c3:PartitionScheme=min_spiffs
BUILD_DIR = ./build
PORT ?= $(shell ls /dev/cu.usbmodem* /dev/cu.usbserial* 2>/dev/null | head -n 1)

all: build-vescblue

help:
	@echo "Available targets:"
	@echo "  make build-vescblue        - Compile ESP32 VESC Blue firmware"
	@echo "  make build-antispark       - Compile Antispark & iBeacon firmware (ESP32-C3)"
	@echo "  make test-unit             - Build and run native C++ unit tests"
	@echo "  make flash-ota             - Flash built vescblue firmware via BLE OTA"
	@echo "  make flash-antispark-ota   - Flash built antispark firmware via BLE OTA"
	@echo "  make flash-antispark-usb   - Flash antispark via USB serial (PORT=$(PORT))"
	@echo "  make flash-vescblue-usb    - Flash vescblue via USB serial (PORT=$(PORT))"
	@echo "  make clean                 - Remove build artifacts"

build-vescblue:
	@mkdir -p $(BUILD_DIR)
	arduino-cli compile --fqbn $(FQBN_VESC) --build-path $(BUILD_DIR) firmware/vescblue

build-antispark:
	@mkdir -p $(BUILD_DIR)/antispark
	arduino-cli compile --fqbn $(FQBN_ANTISPARK) --build-path $(BUILD_DIR)/antispark firmware/antispark

test-unit:
	@mkdir -p $(BUILD_DIR)/tests
	@echo "==> Running Speed Governor Unit Test..."
	clang++ -std=c++17 tests/unit/test_speed_governor.cpp -o $(BUILD_DIR)/tests/test_speed_governor
	$(BUILD_DIR)/tests/test_speed_governor
	@echo ""
	@echo "==> Running Protocol Unit Test..."
	clang++ -std=c++17 tests/unit/test_protocol.cpp -o $(BUILD_DIR)/tests/test_protocol
	$(BUILD_DIR)/tests/test_protocol

flash-ota:
	python3 tools/ble_ota_flash.py

flash-antispark-ota:
	python3 tools/ble_ota_flash.py --target antispark

flash-antispark-usb: build-antispark
	@if [ -z "$(PORT)" ]; then echo "Error: No ESP32 USB serial port detected!"; exit 1; fi
	@echo "==> Uploading Antispark to $(PORT)..."
	arduino-cli upload -p $(PORT) --fqbn $(FQBN_ANTISPARK) --input-dir $(BUILD_DIR)/antispark firmware/antispark

flash-vescblue-usb: build-vescblue
	@if [ -z "$(PORT)" ]; then echo "Error: No ESP32 USB serial port detected!"; exit 1; fi
	@echo "==> Uploading VESC Blue to $(PORT)..."
	arduino-cli upload -p $(PORT) --fqbn $(FQBN_VESC) --input-dir $(BUILD_DIR) firmware/vescblue

clean:
	rm -rf $(BUILD_DIR)
