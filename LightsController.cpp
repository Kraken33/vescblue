#include "LightsController.h"

LightsController::LightsController()
    : frontLightOn(false),
      backLightOn(false),
      turnL_active(false),
      turnL_startTime(0),
      turnL_lastBlink(0),
      turnL_ledState(false),
      lastRawL(HIGH),
      stableL(HIGH),
      lastDebounceL(0),
      turnR_active(false),
      turnR_startTime(0),
      turnR_lastBlink(0),
      turnR_ledState(false),
      lastRawR(HIGH),
      stableR(HIGH),
      lastDebounceR(0),
      lastRawLightBtn(HIGH),
      stableLightBtn(HIGH),
      lastDebounceLight(0) {}

void LightsController::begin() {
    // Inputs (Active LOW with internal pull-ups, switches connect to Common GND)
    pinMode(PIN_IN_TURN_L, INPUT_PULLUP);
    pinMode(PIN_IN_TURN_R, INPUT_PULLUP);
    pinMode(PIN_IN_LIGHT, INPUT_PULLUP);
    pinMode(PIN_IN_DDM, INPUT_PULLUP);

    // Outputs (Active HIGH - MOSFET / Relay triggers)
    pinMode(PIN_OUT_BRAKE, OUTPUT);
    pinMode(PIN_OUT_LIGHT, OUTPUT);
    pinMode(PIN_OUT_TURN_L, OUTPUT);
    pinMode(PIN_OUT_TURN_R, OUTPUT);

    digitalWrite(PIN_OUT_BRAKE, LOW);
    digitalWrite(PIN_OUT_LIGHT, LOW);
    digitalWrite(PIN_OUT_TURN_L, LOW);
    digitalWrite(PIN_OUT_TURN_R, LOW);
}


void LightsController::setFrontLight(bool state) {
    frontLightOn = state;
    digitalWrite(PIN_OUT_LIGHT, frontLightOn ? HIGH : LOW);
}

void LightsController::toggleFrontLight() {
    setFrontLight(!frontLightOn);
}

void LightsController::startTurnLeft() {
    turnL_active = true;
    turnL_startTime = millis();
    turnL_lastBlink = millis();
    turnL_ledState = true;
    digitalWrite(PIN_OUT_TURN_L, HIGH);

    // Cancel Right
    turnR_active = false;
    digitalWrite(PIN_OUT_TURN_R, LOW);
}

void LightsController::stopTurnLeft() {
    turnL_active = false;
    digitalWrite(PIN_OUT_TURN_L, LOW);
}

void LightsController::startTurnRight() {
    turnR_active = true;
    turnR_startTime = millis();
    turnR_lastBlink = millis();
    turnR_ledState = true;
    digitalWrite(PIN_OUT_TURN_R, HIGH);

    // Cancel Left
    turnL_active = false;
    digitalWrite(PIN_OUT_TURN_L, LOW);
}

void LightsController::stopTurnRight() {
    turnR_active = false;
    digitalWrite(PIN_OUT_TURN_R, LOW);
}

void LightsController::toggleTurnLeft() {
    if (turnL_active) {
        stopTurnLeft();
    } else {
        startTurnLeft();
    }
}

void LightsController::toggleTurnRight() {
    if (turnR_active) {
        stopTurnRight();
    } else {
        startTurnRight();
    }
}

void LightsController::toggleHazard() {
    if (turnL_active && turnR_active) {
        stopAllTurn();
    } else {
        turnL_active = true;
        turnR_active = true;
        turnL_startTime = millis();
        turnL_lastBlink = millis();
        turnL_ledState = true;
        turnR_ledState = true;
        digitalWrite(PIN_OUT_TURN_L, HIGH);
        digitalWrite(PIN_OUT_TURN_R, HIGH);
    }
}

void LightsController::stopAllTurn() {
    turnL_active = false;
    turnR_active = false;
    digitalWrite(PIN_OUT_TURN_L, LOW);
    digitalWrite(PIN_OUT_TURN_R, LOW);
}

void LightsController::update(bool brakePressed) {
    // 1. Rear Light Output (Solid ON when front light is ON or brake is engaged)
    backLightOn = (frontLightOn || brakePressed);
    digitalWrite(PIN_OUT_BRAKE, backLightOn ? HIGH : LOW);

    // 2. Physical Front Light Switch Debounce (Momentary push button)
    bool lightReading = digitalRead(PIN_IN_LIGHT);
    if (lightReading != lastRawLightBtn) {
        lastDebounceLight = millis();
    }
    lastRawLightBtn = lightReading;
    if ((millis() - lastDebounceLight) > DEBOUNCE_DELAY_MS) {
        if (lightReading != stableLightBtn) {
            stableLightBtn = lightReading;
            if (stableLightBtn == LOW) { // Button pressed (Active LOW)
                toggleFrontLight();
            }
        }
    }

    // 3. Turn Signals (Momentary push buttons)
    // Synchronous Hazard mode if both are active:
    if (turnL_active && turnR_active) {
        if (millis() - turnL_startTime >= AUTO_OFF_TIME_MS) {
            stopAllTurn();
            return;
        }

        if (millis() - turnL_lastBlink >= BLINK_INTERVAL_MS) {
            turnL_lastBlink = millis();
            turnL_ledState = !turnL_ledState;
            turnR_ledState = turnL_ledState;
            digitalWrite(PIN_OUT_TURN_L, turnL_ledState ? HIGH : LOW);
            digitalWrite(PIN_OUT_TURN_R, turnR_ledState ? HIGH : LOW);
        }

        // Check if either button is pressed to cancel hazard
        bool rawL = digitalRead(PIN_IN_TURN_L);
        bool rawR = digitalRead(PIN_IN_TURN_R);
        if (rawL == LOW || rawR == LOW) {
            stopAllTurn();
            lastRawL = rawL;
            lastRawR = rawR;
            stableL = rawL;
            stableR = rawR;
            lastDebounceL = millis();
            lastDebounceR = millis();
        }
    } else {
        handleTurn(PIN_IN_TURN_L, PIN_OUT_TURN_L, turnL_active, turnL_startTime,
                   turnL_lastBlink, turnL_ledState, lastRawL, stableL, lastDebounceL,
                   turnR_active, PIN_OUT_TURN_R);

        handleTurn(PIN_IN_TURN_R, PIN_OUT_TURN_R, turnR_active, turnR_startTime,
                   turnR_lastBlink, turnR_ledState, lastRawR, stableR, lastDebounceR,
                   turnL_active, PIN_OUT_TURN_L);
    }
}


void LightsController::handleTurn(int buttonPin, int outputPin, bool &active,
                                  unsigned long &startTime, unsigned long &lastBlink,
                                  bool &ledState, bool &lastRaw, bool &stable,
                                  unsigned long &lastDebounce, bool &otherActive,
                                  int otherOutputPin) {
    bool reading = digitalRead(buttonPin);

    if (reading != lastRaw) {
        lastDebounce = millis();
    }
    lastRaw = reading;

    if ((millis() - lastDebounce) > DEBOUNCE_DELAY_MS) {
        if (reading != stable) {
            stable = reading;

            if (stable == LOW) { // Button pressed (Active LOW)
                if (active) {
                    active = false;
                    digitalWrite(outputPin, LOW);
                } else {
                    active = true;
                    startTime = millis();
                    lastBlink = millis();
                    ledState = true;
                    digitalWrite(outputPin, HIGH);

                    otherActive = false;
                    digitalWrite(otherOutputPin, LOW);
                }
            }
        }
    }

    if (active) {
        if (millis() - startTime >= AUTO_OFF_TIME_MS) {
            active = false;
            digitalWrite(outputPin, LOW);
            return;
        }

        if (millis() - lastBlink >= BLINK_INTERVAL_MS) {
            lastBlink = millis();
            ledState = !ledState;
            digitalWrite(outputPin, ledState ? HIGH : LOW);
        }
    }
}
