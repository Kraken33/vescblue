#pragma once
#include <Arduino.h>
#include "Config.h"
#include "VescUart.h"
#include "DisplayProtocol.h"

class MotorController {
public:
    MotorController();
    void begin();
    void update(VescUart &vesc, const DriveProfile &profile);

    // Getters for status / telemetry
    float getThrottlePercent() const { return throttlePercent; }
    float getTargetCurrentAmps() const { return targetCurrentAmps; }
    bool isBrakeEngaged() const { return brakeActive; }
    bool isThrottleFault() const { return throttleFault; }

private:
    float throttlePercent;     // 0.0 to 100.0%
    float targetCurrentAmps;   // Calculated current per motor
    bool brakeActive;
    bool throttleFault;
    uint32_t lastControlTime;

    float readThrottleRatio();
    float applySpeedLimit(float requestedCurrent, float currentSpeedKmH, float maxSpeedKmH);
};
