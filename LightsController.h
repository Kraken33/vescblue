#pragma once
#include <Arduino.h>

// ============================================================================
//                               PIN DEFINITIONS
// ============================================================================
// Physical Switch Inputs (Active LOW with internal pull-ups, Common GND)
#define PIN_IN_LIGHT        5    // Front light momentary button (GPIO 5)
#define PIN_IN_TURN_L       18   // Turn left momentary button (GPIO 18)
#define PIN_IN_TURN_R       21   // Turn right momentary button (GPIO 21)
#define PIN_IN_DDM          4    // DDM switch (GPIO 4, reserved)

// Light Outputs (Active HIGH - MOSFET / Relay triggers)
#define PIN_OUT_LIGHT       25   // Front light output (GPIO 25)
#define PIN_OUT_BRAKE       26   // Back light output (GPIO 26 - Tail + Brake)
#define PIN_OUT_BACK_LIGHT  26   // Alias for GPIO 26
#define PIN_OUT_TURN_L      14   // Turn left output (GPIO 14)
#define PIN_OUT_TURN_R      27   // Turn right output (GPIO 27)

// Timing Constants
#define BLINK_INTERVAL_MS   400  // Blinker flash period (400ms ON / 400ms OFF)
#define AUTO_OFF_TIME_MS    20000// Turn signal auto cancel after 20s
#define DEBOUNCE_DELAY_MS   50   // Switch debounce filter time

class LightsController {
public:
    LightsController();
    void begin();
    void update(bool brakePressed);

    // Light toggles & setters
    void setFrontLight(bool state);
    void toggleFrontLight();
    void startTurnLeft();
    void stopTurnLeft();
    void startTurnRight();
    void stopTurnRight();
    void toggleTurnLeft();
    void toggleTurnRight();
    void toggleHazard();
    void stopAllTurn();

    // Getters
    bool isFrontLightOn() const { return frontLightOn; }
    bool isBackLightOn() const { return backLightOn; }
    bool isTurnLeftActive() const { return turnL_active; }
    bool isTurnRightActive() const { return turnR_active; }
    bool isHazardActive() const { return turnL_active && turnR_active; }
    bool isDdmActive() const { return (digitalRead(PIN_IN_DDM) == LOW); }

private:
    bool frontLightOn;
    bool backLightOn;

    // Turn Left variables
    bool turnL_active;
    unsigned long turnL_startTime;
    unsigned long turnL_lastBlink;
    bool turnL_ledState;
    bool lastRawL;
    bool stableL;
    unsigned long lastDebounceL;

    // Turn Right variables
    bool turnR_active;
    unsigned long turnR_startTime;
    unsigned long turnR_lastBlink;
    bool turnR_ledState;
    bool lastRawR;
    bool stableR;
    unsigned long lastDebounceR;

    // Physical front light button debounce
    bool lastRawLightBtn;
    bool stableLightBtn;
    unsigned long lastDebounceLight;

    void handleTurn(int buttonPin, int outputPin, bool &active,
                    unsigned long &startTime, unsigned long &lastBlink,
                    bool &ledState, bool &lastRaw, bool &stable,
                    unsigned long &lastDebounce, bool &otherActive,
                    int otherOutputPin);
};
