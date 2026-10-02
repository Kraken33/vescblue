#pragma once
#include <Arduino.h>
#include "Config.h"

// VESC Telemetry Data Structure
struct VescTelemetry {
    float vIn;              // Battery input voltage (V)
    float tempFet;          // MOSFET temperature (deg C)
    float tempMotor;        // Motor temperature (deg C)
    float currentMotor;     // Motor current (A)
    float currentIn;        // Battery current (A)
    int32_t erpm;           // Electrical RPM
    float dutyCycle;        // Duty cycle (0.0 to 1.0)
    float ampHours;         // Discharged Ah
    float ampHoursCharged;  // Charged Ah
    float wattHours;        // Discharged Wh
    float wattHoursCharged; // Charged Wh
    int32_t tachometer;     // Tachometer steps
    uint8_t faultCode;      // Fault code
    float speedMps;         // Calculated vehicle speed in m/s
    float speedKmH;         // Calculated vehicle speed in km/h
    uint32_t lastUpdateMs;  // Last valid telemetry timestamp
    bool isConnected;       // Connection status
};

class VescUart {
public:
    VescUart();
    void begin(HardwareSerial &serialPort);
    void update(); // Non-blocking polling & RX processor

    // VESC Commands
    void requestValues();
    void setCurrent(float currentAmps);
    void setBrakeCurrent(float brakeCurrentAmps);
    void setDualCurrent(float masterAmps, float slaveAmps, uint8_t slaveCanId = CAN_SLAVE_ID);
    void setDualBrakeCurrent(float masterBrakeAmps, float slaveBrakeAmps, uint8_t slaveCanId = CAN_SLAVE_ID);

    // Getters
    const VescTelemetry& getTelemetry() const { return telemetry; }
    bool isConnected() const { return telemetry.isConnected; }

private:
    HardwareSerial* serial;
    VescTelemetry telemetry;

    // Packet receiving buffer
    uint8_t rxBuffer[256];
    int rxIndex;
    int expectedPayloadLength;
    uint32_t lastRxByteTime;
    uint32_t lastRequestTime;

    // CRC16 CCITT Calculation
    uint16_t calculateCrc16(const uint8_t *data, size_t length);

    // Packet Encoding & Sending
    void sendPacket(const uint8_t *payload, size_t length);
    void sendForwardCanPacket(uint8_t canId, const uint8_t *payload, size_t length);

    // Packet Decoding
    void processRxPacket(const uint8_t *payload, size_t length);
    void decodeTelemetry(const uint8_t *payload, size_t length);
};
