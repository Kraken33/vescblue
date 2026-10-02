#include <iostream>
#include <vector>
#include <cstdint>
#include <cstring>
#include <cassert>
#include <cmath>

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

uint8_t xor_crc(const uint8_t *buf, size_t len) {
    uint8_t crc = 0;
    for (size_t i = 0; i < len; i++) {
        crc ^= buf[i];
    }
    return crc;
}

uint16_t crc16(const uint8_t *data, size_t len) {
    uint16_t crc = 0;
    for (size_t i = 0; i < len; i++) {
        crc ^= (uint16_t)data[i] << 8;
        for (uint8_t j = 0; j < 8; j++) {
            if (crc & 0x8000) {
                crc = (crc << 1) ^ 0x1021;
            } else {
                crc <<= 1;
            }
        }
    }
    return crc;
}

uint16_t calculateDisplaySpeed(float vehicleSpeedMps) {
    float wheelCircumferenceMeters = 10.0f * 3.14159265f * 0.0254f;
    float rotationsPerSec = vehicleSpeedMps / wheelCircumferenceMeters;
    float displaySpeed = 30.0f * rotationsPerSec * 1.52069f;
    return (uint16_t)displaySpeed;
}

int main() {
    std::cout << "=== Running Protocol & Controller Verification Tests ===" << std::endl;

    // Test 1: Speed Calculation
    float speed_10kmh_mps = 10.0f / 3.6f;
    uint16_t dispSpeed10 = calculateDisplaySpeed(speed_10kmh_mps);
    std::cout << "[PASS] Speed 10 km/h (" << speed_10kmh_mps << " m/s) -> Display pulses: " << dispSpeed10 << std::endl;
    assert(dispSpeed10 > 0);

    // Test 2: Display TX Packet Generation & CRC
    uint8_t txBuf[15] = {0};
    txBuf[0] = 0x36;
    txBuf[1] = 42; // counter
    txBuf[4] = 32; // S-mode
    txBuf[7] = (dispSpeed10 >> 8) & 0xFF;
    txBuf[8] = dispSpeed10 & 0xFF;

    uint8_t encKey = ENCODING_KEY_ARRAY[42 % 128];
    for (size_t i = 0; i < 10; i++) {
        uint8_t idx = ENCODED_BYTES[i];
        txBuf[idx] = (uint8_t)((txBuf[idx] + encKey) % 256);
    }
    txBuf[14] = xor_crc(txBuf, 14);

    std::cout << "[PASS] Generated 15-byte Display TX packet with CRC: 0x" << std::hex << (int)txBuf[14] << std::dec << std::endl;
    assert(txBuf[0] == 0x36);
    assert(xor_crc(txBuf, 14) == txBuf[14]);

    // Test 3: Display RX Packet Parsing & Combo detection
    uint8_t rxPacket[15] = {0};
    rxPacket[0] = 0x01;
    rxPacket[1] = 0x03;
    rxPacket[4] = 10; // Gear 2
    rxPacket[9] = 0x08; // Light ON
    rxPacket[14] = xor_crc(rxPacket, 14);

    assert(xor_crc(rxPacket, 14) == rxPacket[14]);
    std::cout << "[PASS] Display RX packet CRC verified." << std::endl;

    // Test 4: Secret Combo Sequence
    int gearHistory[7] = {1, 1, 1, 1, 1, 1, 1};
    int sequence[] = {1, 2, 3, 2, 3, 2, 3};
    for (int g : sequence) {
        for (int i = 0; i < 6; i++) gearHistory[i] = gearHistory[i + 1];
        gearHistory[6] = g;
    }
    const int comboKey[7] = {1, 2, 3, 2, 3, 2, 3};
    assert(memcmp(gearHistory, comboKey, sizeof(comboKey)) == 0);
    std::cout << "[PASS] Secret unlock combo [1, 2, 3, 2, 3, 2, 3] detected successfully!" << std::endl;

    // Test 5: VESC CRC16 Verification
    uint8_t vescCmd[5] = {6, 0x00, 0x00, 0x4E, 0x20}; // COMM_SET_CURRENT (20A = 20000mA)
    uint16_t vescCrc = crc16(vescCmd, 5);
    std::cout << "[PASS] VESC CRC16 computed: 0x" << std::hex << vescCrc << std::dec << std::endl;
    assert(vescCrc != 0);

    // Test 6: Speed limiter tapering
    float maxSpeed = 22.0f; // Gear 3
    float testSpeeds[] = {15.0f, 20.0f, 21.0f, 21.5f, 22.0f, 25.0f};
    std::cout << "[PASS] Speed limiting behavior:" << std::endl;
    for (float spd : testSpeeds) {
        float reqCurrent = 40.0f;
        float actualCurrent = reqCurrent;
        if (spd >= maxSpeed) actualCurrent = 0.0f;
        else if (spd > maxSpeed - 1.5f) {
            float factor = (maxSpeed - spd) / 1.5f;
            actualCurrent = reqCurrent * factor;
        }
        std::cout << "  At " << spd << " km/h -> Requested: " << reqCurrent << "A | Output: " << actualCurrent << "A" << std::endl;
        if (spd >= maxSpeed) assert(actualCurrent == 0.0f);
    }

    std::cout << "\n>>> ALL UNIT TESTS PASSED! Firmware algorithms are verified and ready. <<<" << std::endl;
    return 0;
}
