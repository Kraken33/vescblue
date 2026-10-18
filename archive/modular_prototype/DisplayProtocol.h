#pragma once
#include <Arduino.h>
#include "Config.h"

class DisplayProtocol {
public:
    DisplayProtocol();
    void begin(HardwareSerial &serialPort);
    void update(float vehicleSpeedMps); // Call in loop regularly

    // Getters for current state
    int getGear() const { return currentGear; }
    bool isLightOn() const { return displayLightOn; }
    bool isSModeActive() const { return profileSSwitch; }
    const DriveProfile& getActiveProfile() const { return activeProfile; }

    // Callbacks or listeners if needed
    void setLightCallback(void (*callback)(bool lightState)) { lightCallback = callback; }

private:
    HardwareSerial* serial;
    
    // Packet buffers
    uint8_t rxBuffer[15];
    int rxIndex;
    uint32_t lastRxByteTime;

    uint8_t txBuffer[15];
    uint8_t txCounter;
    uint32_t lastTxTime;

    // State variables
    int currentGear;        // 1, 2, or 3
    int lastRawGear;
    bool displayLightOn;
    bool lastLightState;
    bool profileSSwitch;
    DriveProfile activeProfile;

    // Gear history for secret unlock combo [1, 2, 3, 2, 3, 2, 3]
    uint8_t gearHistory[7];

    void (*lightCallback)(bool lightState);

    // Helpers
    uint8_t calculateCrc(const uint8_t *buffer, size_t length);
    void parseRxPacket(const uint8_t *packet);
    void handleGearAndLight(int rawGear, bool lightState);
    void updateActiveProfile();
    void sendDisplayPacket(float vehicleSpeedMps);
    uint16_t calculateDisplaySpeed(float vehicleSpeedMps);
};
