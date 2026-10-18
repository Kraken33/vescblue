.PHONY: all help build-vescblue build-antispark test-unit flash-ota clean

FQBN_VESC = esp32:esp32:esp32:PartitionScheme=min_spiffs
FQBN_ANTISPARK = esp32:esp32:esp32
BUILD_DIR = ./build

all: build-vescblue

help:
	@echo "Available targets:"
	@echo "  make build-vescblue   - Compile ESP32 VESC Blue firmware"
	@echo "  make build-antispark  - Compile Antispark & iBeacon firmware"
	@echo "  make test-unit        - Build and run native C++ unit tests"
	@echo "  make flash-ota        - Flash built vescblue firmware via BLE OTA"
	@echo "  make clean            - Remove build artifacts"

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

clean:
	rm -rf $(BUILD_DIR)
