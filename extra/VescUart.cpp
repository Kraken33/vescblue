#include "VescUart.h"

// VESC Packet IDs
enum {
    COMM_FW_VERSION = 0,
    COMM_JUMP_TO_BOOTLOADER = 1,
    COMM_ERASE_NEW_APP = 2,
    COMM_WRITE_NEW_APP_DATA = 3,
    COMM_GET_VALUES = 4,
    COMM_SET_DUTY = 5,
    COMM_SET_CURRENT = 6,
    COMM_SET_CURRENT_BRAKE = 7,
    COMM_SET_RPM = 8,
    COMM_SET_POS = 9,
    COMM_SET_HANDBRAKE = 10,
    COMM_SET_DETECT = 11,
    COMM_FORWARD_CAN = 34
};

// Helper read functions
static inline int16_t readInt16(const uint8_t *b, int &idx) {
    int16_t v = (int16_t)(((uint16_t)b[idx] << 8) | (uint16_t)b[idx + 1]);
    idx += 2;
    return v;
}

static inline int32_t readInt32(const uint8_t *b, int &idx) {
    int32_t v = (int32_t)(((uint32_t)b[idx] << 24) |
                          ((uint32_t)b[idx + 1] << 16) |
                          ((uint32_t)b[idx + 2] << 8) |
                          ((uint32_t)b[idx + 3]));
    idx += 4;
    return v;
}

VescUart::VescUart()
    : serial(nullptr),
      rxIndex(0),
      expectedPayloadLength(0),
      lastRxByteTime(0),
      lastRequestTime(0) {
    memset(&telemetry, 0, sizeof(telemetry));
    telemetry.isConnected = false;
}

void VescUart::begin(HardwareSerial &serialPort) {
    serial = &serialPort;
    serial->begin(VESC_BAUD, SERIAL_8N1, PIN_VESC_RX, PIN_VESC_TX);
}

uint16_t VescUart::calculateCrc16(const uint8_t *data, size_t length) {
    uint16_t crc = 0;
    for (size_t i = 0; i < length; i++) {
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

void VescUart::sendPacket(const uint8_t *payload, size_t length) {
    if (!serial || length == 0 || length > 512) return;

    uint16_t crc = calculateCrc16(payload, length);
    uint8_t header[3];
    size_t headerLen = 0;

    if (length <= 256) {
        header[0] = 2; // Short packet marker
        header[1] = (uint8_t)length;
        headerLen = 2;
    } else {
        header[0] = 3; // Long packet marker
        header[1] = (uint8_t)((length >> 8) & 0xFF);
        header[2] = (uint8_t)(length & 0xFF);
        headerLen = 3;
    }

    uint8_t crcAndEnd[3];
    crcAndEnd[0] = (uint8_t)((crc >> 8) & 0xFF);
    crcAndEnd[1] = (uint8_t)(crc & 0xFF);
    crcAndEnd[2] = 3; // End of packet marker

    serial->write(header, headerLen);
    serial->write(payload, length);
    serial->write(crcAndEnd, 3);
}

void VescUart::sendForwardCanPacket(uint8_t canId, const uint8_t *payload, size_t length) {
    if (length + 2 > 256) return;
    uint8_t canForwardBuffer[256];
    canForwardBuffer[0] = COMM_FORWARD_CAN;
    canForwardBuffer[1] = canId;
    memcpy(&canForwardBuffer[2], payload, length);
    sendPacket(canForwardBuffer, length + 2);
}

void VescUart::requestValues() {
    uint8_t payload = COMM_GET_VALUES;
    sendPacket(&payload, 1);
}

void VescUart::setCurrent(float currentAmps) {
    int32_t currentMilliAmps = (int32_t)(currentAmps * 1000.0f);
    uint8_t payload[5];
    payload[0] = COMM_SET_CURRENT;
    payload[1] = (uint8_t)((currentMilliAmps >> 24) & 0xFF);
    payload[2] = (uint8_t)((currentMilliAmps >> 16) & 0xFF);
    payload[3] = (uint8_t)((currentMilliAmps >> 8) & 0xFF);
    payload[4] = (uint8_t)(currentMilliAmps & 0xFF);

    sendPacket(payload, 5);
}

void VescUart::setBrakeCurrent(float brakeCurrentAmps) {
    int32_t brakeMilliAmps = (int32_t)(brakeCurrentAmps * 1000.0f);
    uint8_t payload[5];
    payload[0] = COMM_SET_CURRENT_BRAKE;
    payload[1] = (uint8_t)((brakeMilliAmps >> 24) & 0xFF);
    payload[2] = (uint8_t)((brakeMilliAmps >> 16) & 0xFF);
    payload[3] = (uint8_t)((brakeMilliAmps >> 8) & 0xFF);
    payload[4] = (uint8_t)(brakeMilliAmps & 0xFF);

    sendPacket(payload, 5);
}

void VescUart::setDualCurrent(float masterAmps, float slaveAmps, uint8_t slaveCanId) {
    // 1. Send current to Master VESC
    setCurrent(masterAmps);

    // 2. Forward current to Slave VESC over CAN
    if (DUAL_MOTOR_ENABLED) {
        int32_t slaveMilliAmps = (int32_t)(slaveAmps * 1000.0f);
        uint8_t slavePayload[5];
        slavePayload[0] = COMM_SET_CURRENT;
        slavePayload[1] = (uint8_t)((slaveMilliAmps >> 24) & 0xFF);
        slavePayload[2] = (uint8_t)((slaveMilliAmps >> 16) & 0xFF);
        slavePayload[3] = (uint8_t)((slaveMilliAmps >> 8) & 0xFF);
        slavePayload[4] = (uint8_t)(slaveMilliAmps & 0xFF);

        sendForwardCanPacket(slaveCanId, slavePayload, 5);
    }
}

void VescUart::setDualBrakeCurrent(float masterBrakeAmps, float slaveBrakeAmps, uint8_t slaveCanId) {
    setBrakeCurrent(masterBrakeAmps);

    if (DUAL_MOTOR_ENABLED) {
        int32_t slaveMilliAmps = (int32_t)(slaveBrakeAmps * 1000.0f);
        uint8_t slavePayload[5];
        slavePayload[0] = COMM_SET_CURRENT_BRAKE;
        slavePayload[1] = (uint8_t)((slaveMilliAmps >> 24) & 0xFF);
        slavePayload[2] = (uint8_t)((slaveMilliAmps >> 16) & 0xFF);
        slavePayload[3] = (uint8_t)((slaveMilliAmps >> 8) & 0xFF);
        slavePayload[4] = (uint8_t)(slaveMilliAmps & 0xFF);

        sendForwardCanPacket(slaveCanId, slavePayload, 5);
    }
}

void VescUart::update() {
    if (!serial) return;

    // Polling telemetry every 50ms (20Hz)
    uint32_t now = millis();
    if (now - lastRequestTime >= 50) {
        lastRequestTime = now;
        requestValues();
    }

    // Process incoming stream
    while (serial->available()) {
        uint8_t b = serial->read();

        // Timeout check between bytes (> 20ms resets RX state)
        if (rxIndex > 0 && (now - lastRxByteTime) > 20) {
            rxIndex = 0;
        }
        lastRxByteTime = now;

        if (rxIndex == 0) {
            if (b == 2) { // Short frame header
                rxBuffer[rxIndex++] = b;
            }
        } else if (rxIndex == 1) {
            expectedPayloadLength = b;
            rxBuffer[rxIndex++] = b;
            if (expectedPayloadLength > 240) {
                rxIndex = 0; // Exceeded buffer size
            }
        } else {
            rxBuffer[rxIndex++] = b;

            // Total frame size for short packet = 2 (header + len) + payloadLen + 2 (crc) + 1 (end marker 0x03)
            int expectedTotalLength = 2 + expectedPayloadLength + 3;
            if (rxIndex >= expectedTotalLength) {
                if (rxBuffer[expectedTotalLength - 1] == 3) {
                    // Check CRC
                    const uint8_t *payloadPtr = &rxBuffer[2];
                    uint16_t expectedCrc = calculateCrc16(payloadPtr, expectedPayloadLength);
                    uint16_t receivedCrc = (uint16_t)((rxBuffer[2 + expectedPayloadLength] << 8) |
                                                      rxBuffer[2 + expectedPayloadLength + 1]);

                    if (expectedCrc == receivedCrc) {
                        processRxPacket(payloadPtr, expectedPayloadLength);
                    }
                }
                rxIndex = 0; // Reset for next packet
            }
        }
    }

    // Update connection status (timeout after 500ms without telemetry)
    if (millis() - telemetry.lastUpdateMs > 500) {
        telemetry.isConnected = false;
    }
}

void VescUart::processRxPacket(const uint8_t *payload, size_t length) {
    if (length == 0) return;

    uint8_t packetId = payload[0];
    if (packetId == COMM_GET_VALUES) {
        decodeTelemetry(payload, length);
    }
}

void VescUart::decodeTelemetry(const uint8_t *payload, size_t length) {
    if (length < 54) return; // Minimum standard COMM_GET_VALUES payload length

    int idx = 1; // Skip packet ID (0)
    telemetry.tempFet = readInt16(payload, idx) / 10.0f;
    telemetry.tempMotor = readInt16(payload, idx) / 10.0f;
    telemetry.currentMotor = readInt32(payload, idx) / 100.0f;
    telemetry.currentIn = readInt32(payload, idx) / 100.0f;

    idx += 8; // Skip id, iq (8 bytes)

    telemetry.dutyCycle = readInt16(payload, idx) / 1000.0f;
    telemetry.erpm = readInt32(payload, idx);
    telemetry.vIn = readInt16(payload, idx) / 10.0f;
    telemetry.ampHours = readInt32(payload, idx) / 10000.0f;
    telemetry.ampHoursCharged = readInt32(payload, idx) / 10000.0f;
    telemetry.wattHours = readInt32(payload, idx) / 10000.0f;
    telemetry.wattHoursCharged = readInt32(payload, idx) / 10000.0f;
    telemetry.tachometer = readInt32(payload, idx);
    idx += 4; // Skip tachometer abs (4 bytes)
    telemetry.faultCode = payload[idx++];

    // Calculate vehicle speed from ERPM
    // RPM = ERPM / MOTOR_POLE_PAIRS
    // Speed (m/s) = (RPM / 60) * (WHEEL_DIAMETER_INCH * PI * 0.0254)
    float rpm = (float)telemetry.erpm / (float)MOTOR_POLE_PAIRS;
    float wheelCircumferenceMeters = WHEEL_DIAMETER_INCH * 3.14159265f * 0.0254f;
    telemetry.speedMps = (rpm / 60.0f) * wheelCircumferenceMeters;
    if (telemetry.speedMps < 0) telemetry.speedMps = -telemetry.speedMps; // Absolute linear speed

    telemetry.speedKmH = telemetry.speedMps * 3.6f;

    telemetry.lastUpdateMs = millis();
    telemetry.isConnected = true;
}
