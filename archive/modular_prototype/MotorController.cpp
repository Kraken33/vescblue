#include "MotorController.h"

MotorController::MotorController()
    : throttlePercent(0.0f),
      targetCurrentAmps(0.0f),
      brakeActive(false),
      throttleFault(false),
      lastControlTime(0) {}

void MotorController::begin() {
    pinMode(PIN_IN_BRAKE, INPUT_PULLUP);
    pinMode(PIN_THROTTLE, INPUT);

    // ESP32 ADC setup
    analogReadResolution(12); // 0-4095
    analogSetAttenuation(ADC_11db); // Full scale ~3.3V
}

float MotorController::readThrottleRatio() {
    // Take multiple fast samples to reduce ADC noise
    uint32_t adcSum = 0;
    const int SAMPLES = 8;
    for (int i = 0; i < SAMPLES; i++) {
        adcSum += analogRead(PIN_THROTTLE);
        delayMicroseconds(50);
    }
    int rawAdc = adcSum / SAMPLES;

    // Safety checks for disconnected / damaged sensor
    if (rawAdc < THROTTLE_FAULT_LOW || rawAdc > THROTTLE_FAULT_HIGH) {
        throttleFault = true;
        throttlePercent = 0.0f;
        return 0.0f;
    }
    throttleFault = false;

    // Apply min deadband
    int minThreshold = THROTTLE_ADC_MIN + THROTTLE_DEADBAND;
    if (rawAdc <= minThreshold) {
        throttlePercent = 0.0f;
        return 0.0f;
    }

    if (rawAdc >= THROTTLE_ADC_MAX) {
        throttlePercent = 100.0f;
        return 1.0f;
    }

    // Normalized ratio 0.0 to 1.0
    float ratio = (float)(rawAdc - minThreshold) / (float)(THROTTLE_ADC_MAX - minThreshold);
    if (ratio < 0.0f) ratio = 0.0f;
    if (ratio > 1.0f) ratio = 1.0f;

    // Optional exponential throttle curve for smooth low-speed modulation
    // ratio = ratio * ratio * 0.3f + ratio * 0.7f;

    throttlePercent = ratio * 100.0f;
    return ratio;
}

float MotorController::applySpeedLimit(float requestedCurrent, float currentSpeedKmH, float maxSpeedKmH) {
    if (requestedCurrent <= 0.0f) return 0.0f;

    // If already exceeding max speed, cutoff acceleration immediately
    if (currentSpeedKmH >= maxSpeedKmH) {
        return 0.0f;
    }

    // Soft taper over the last 1.5 km/h
    float taperMargin = 1.5f;
    float taperStart = maxSpeedKmH - taperMargin;
    if (currentSpeedKmH > taperStart) {
        float factor = (maxSpeedKmH - currentSpeedKmH) / taperMargin;
        if (factor < 0.0f) factor = 0.0f;
        if (factor > 1.0f) factor = 1.0f;
        return requestedCurrent * factor;
    }

    return requestedCurrent;
}

void MotorController::update(VescUart &vesc, const DriveProfile &profile) {
    uint32_t now = millis();
    // Run motor control loop at 50Hz (20ms)
    if (now - lastControlTime < 20) {
        return;
    }
    lastControlTime = now;

    // 1. Check Brake Sensor (Active LOW)
    brakeActive = (digitalRead(PIN_IN_BRAKE) == LOW);

    if (brakeActive) {
        targetCurrentAmps = 0.0f;
        throttlePercent = 0.0f;

        // Apply regen brake current if configured, otherwise coast / 0A
        if (REGEN_BRAKE_CURRENT_AMPS > 0.0f) {
            vesc.setDualBrakeCurrent(REGEN_BRAKE_CURRENT_AMPS, REGEN_BRAKE_CURRENT_AMPS, CAN_SLAVE_ID);
        } else {
            vesc.setDualCurrent(0.0f, 0.0f, CAN_SLAVE_ID);
        }
        return;
    }

    // 2. Read Throttle
    float throttleRatio = readThrottleRatio();

    if (throttleFault || throttleRatio <= 0.001f) {
        targetCurrentAmps = 0.0f;
        vesc.setDualCurrent(0.0f, 0.0f, CAN_SLAVE_ID);
        return;
    }

    // 3. Compute Target Motor Current
    float rawTargetCurrent = throttleRatio * profile.maxCurrentAmps;

    // 4. Apply Speed Limiting
    float vehicleSpeedKmH = vesc.getTelemetry().speedKmH;
    targetCurrentAmps = applySpeedLimit(rawTargetCurrent, vehicleSpeedKmH, profile.maxSpeedKmH);

    // 5. Send to Dual VESCs
    vesc.setDualCurrent(targetCurrentAmps, targetCurrentAmps, CAN_SLAVE_ID);
}
