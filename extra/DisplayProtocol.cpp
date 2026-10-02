#include "DisplayProtocol.h"

// 128-byte lookup key table from display.lisp
static const uint8_t ENCODING_KEY_ARRAY[128] = {
    0x5e, 0x23, 0x5c, 0x21, 0x2a, 0x2f, 0x28, 0x2d, 0x26, 0x2b, 0x24, 0x29, 0x52, 0x57, 0x50, 0x55,
    0x4e, 0x53, 0x4c, 0x51, 0x5a, 0x5f, 0x58, 0x5d, 0x56, 0x5b, 0x54, 0x59, 0x02, 0x07, 0x00, 0x05,
    0x3e, 0x03, 0x3c, 0x01, 0x0a, 0x0f, 0x08, 0x0d, 0x06, 0x0b, 0x04, 0x09, 0x32, 0x37, 0x30, 0x35,
    0x2e, 0x33, 0x2c, 0x31, 0x3a, 0x3f, 0x38, 0x3d, 0x36, 0x3b, 0x34, 0x39, 0x62, 0x67, 0x60, 0x65,
    0x1e, 0x63, 0x1c, 0x61, 0x6a, 0x6f, 0x68, 0x6d, 0x66, 0x6b, 0x64, 0x69, 0x12, 0x17, 0x10, 0x15,
    0x0e, 0x13, 0x0c, 0x11, 0x1a, 0x1f, 0x18, 0x1d, 0x16, 0x1b, 0x14, 0x19, 0x42, 0x47, 0x40, 0x45,
    0x7e, 0x43, 0x7c, 0x41, 0x4a, 0x4f, 0x48, 0x4d, 0x46, 0x4b, 0x44, 0x49, 0x72, 0x77, 0x70, 0x75,
    0x6e, 0x73, 0x6c, 0x71, 0x7a, 0x7f, 0x78, 0x7d, 0x76, 0x7b, 0x74, 0x79, 0x22, 0x27, 0x20, 0x25
};

static const uint8_t ENCODED_BYTES[10] = { 3, 4, 5, 7, 8, 9, 10, 11, 12, 13 };
static const uint8_t COMBO_KEY[7] = { 1, 2, 3, 2, 3, 2, 3 };

DisplayProtocol::DisplayProtocol()
    : serial(nullptr),
      rxIndex(0),
      lastRxByteTime(0),
      txCounter(0),
      lastTxTime(0),
      currentGear(1),
      lastRawGear(0),
      displayLightOn(false),
      lastLightState(false),
      profileSSwitch(false),
      activeProfile(PROFILE_1),
      lightCallback(nullptr) {
    memset(rxBuffer, 0, sizeof(rxBuffer));
    memset(txBuffer, 0, sizeof(txBuffer));
    for (int i = 0; i < 7; i++) {
        gearHistory[i] = 1;
    }
}

void DisplayProtocol::begin(HardwareSerial &serialPort) {
    serial = &serialPort;
    serial->begin(DISPLAY_BAUD, SERIAL_8N1, PIN_DISPLAY_RX, PIN_DISPLAY_TX);
}

uint8_t DisplayProtocol::calculateCrc(const uint8_t *buffer, size_t length) {
    uint8_t crc = 0;
    for (size_t i = 0; i < length; i++) {
        crc ^= buffer[i];
    }
    return crc;
}

void DisplayProtocol::update(float vehicleSpeedMps) {
    if (!serial) return;

    // --- Process Incoming RX Bytes from Display ---
    while (serial->available()) {
        uint8_t b = serial->read();
        uint32_t now = millis();

        // Reset buffer if timeout between bytes is too large (> 50ms at 1200 baud)
        if (rxIndex > 0 && (now - lastRxByteTime) > 50) {
            rxIndex = 0;
        }
        lastRxByteTime = now;

        if (rxIndex == 0) {
            if (b == 0x01) {
                rxBuffer[rxIndex++] = b;
            }
        } else if (rxIndex == 1) {
            if (b == 0x03) {
                rxBuffer[rxIndex++] = b;
            } else {
                rxIndex = 0; // Invalid second header byte, reset
            }
        } else {
            rxBuffer[rxIndex++] = b;
            if (rxIndex == 15) {
                // Check checksum
                uint8_t expectedCrc = calculateCrc(rxBuffer, 14);
                if (rxBuffer[14] == expectedCrc) {
                    parseRxPacket(rxBuffer);
                }
                rxIndex = 0; // Ready for next packet
            }
        }
    }

    // --- Transmit TX Packet to Display (~150ms intervals) ---
    uint32_t now = millis();
    if (now - lastTxTime >= 150) {
        lastTxTime = now;
        sendDisplayPacket(vehicleSpeedMps);
    }
}

void DisplayProtocol::parseRxPacket(const uint8_t *packet) {
    int rawGear = packet[4];
    bool lightState = (packet[9] & 0x08) != 0;

    handleGearAndLight(rawGear, lightState);
}

void DisplayProtocol::handleGearAndLight(int rawGear, bool lightState) {
    // Check if gear changed
    if (rawGear != lastRawGear) {
        int mappedGear = 1;
        if (rawGear == 5) {
            mappedGear = 1;
        } else if (rawGear == 10) {
            mappedGear = 2;
        } else if (rawGear == 15) {
            mappedGear = 3;
        }

        currentGear = mappedGear;

        // Shift gear history left and append new gear
        for (int i = 0; i < 6; i++) {
            gearHistory[i] = gearHistory[i + 1];
        }
        gearHistory[6] = (uint8_t)mappedGear;

        // If returned to Gear 1, reset S-mode switch (like in display.lisp)
        if (mappedGear == 1) {
            profileSSwitch = false;
        }

        updateActiveProfile();
        lastRawGear = rawGear;
    }

    // Check if light button changed
    if (lightState != lastLightState) {
        displayLightOn = lightState;

        // Check if light turned ON and combo matches [1, 2, 3, 2, 3, 2, 3]
        if (lightState && (memcmp(gearHistory, COMBO_KEY, 7) == 0)) {
            profileSSwitch = true;
            lastRawGear = 228; // Trigger re-evaluation of gear profile
            updateActiveProfile();
        }

        if (lightCallback) {
            lightCallback(lightState);
        }

        lastLightState = lightState;
    }
}

void DisplayProtocol::updateActiveProfile() {
    if (currentGear == 1) {
        activeProfile = PROFILE_1;
    } else if (currentGear == 2) {
        activeProfile = profileSSwitch ? PROFILE_S2 : PROFILE_2;
    } else if (currentGear == 3) {
        activeProfile = profileSSwitch ? PROFILE_S3 : PROFILE_3;
    }
}

uint16_t DisplayProtocol::calculateDisplaySpeed(float vehicleSpeedMps) {
    // Formula from display.lisp:
    // (* (* p07 (/ (get-speed) (* p06 3.1415 0.0254))) 1.52069)
    if (vehicleSpeedMps <= 0.05f) return 0;
    
    float wheelCircumferenceMeters = WHEEL_DIAMETER_INCH * 3.14159265f * 0.0254f;
    float rotationsPerSec = vehicleSpeedMps / wheelCircumferenceMeters;
    float displaySpeed = MOTOR_POLES * rotationsPerSec * SPEED_CALC_FACTOR;

    if (displaySpeed < 0) displaySpeed = 0;
    if (displaySpeed > 65535.0f) displaySpeed = 65535.0f;

    return (uint16_t)displaySpeed;
}

void DisplayProtocol::sendDisplayPacket(float vehicleSpeedMps) {
    memset(txBuffer, 0, 15);

    // Byte 0: ESC header
    txBuffer[0] = 0x36;

    // Byte 1: Rolling counter
    txCounter++;
    txBuffer[1] = txCounter;

    // Byte 4: S-Mode flag (32 if unlocked)
    if (profileSSwitch) {
        txBuffer[4] = 32;
    }

    // Bytes 7 & 8: Speed in calculated display units (Big Endian)
    uint16_t speedVal = calculateDisplaySpeed(vehicleSpeedMps);
    txBuffer[7] = (speedVal >> 8) & 0xFF;
    txBuffer[8] = speedVal & 0xFF;

    // Encryption Step:
    uint8_t encKey = ENCODING_KEY_ARRAY[txBuffer[1] % 128];
    for (size_t i = 0; i < sizeof(ENCODED_BYTES); i++) {
        uint8_t byteIndex = ENCODED_BYTES[i];
        txBuffer[byteIndex] = (uint8_t)((txBuffer[byteIndex] + encKey) % 256);
    }

    // Byte 14: Checksum
    txBuffer[14] = calculateCrc(txBuffer, 14);

    // Send packet over UART
    serial->write(txBuffer, 15);
}
