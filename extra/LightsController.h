#pragma once
#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include "Config.h"
#include "VescUart.h"
#include "DisplayProtocol.h"
#include "MotorController.h"

class LightsController {
public:
    LightsController();
    void begin();
    void update(bool brakePressed);
    void handleWebClient();

    // Light toggles
    void setFrontLight(bool state);
    void toggleFrontLight();
    void startTurnLeft();
    void stopTurnLeft();
    void startTurnRight();
    void stopTurnRight();

    // Getters
    bool isFrontLightOn() const { return frontLightOn; }
    bool isTurnLeftActive() const { return turnL_active; }
    bool isTurnRightActive() const { return turnR_active; }

    // External status references for Web UI
    void setContext(const VescUart *vescPtr, const DisplayProtocol *dispPtr, const MotorController *motorPtr) {
        vesc = vescPtr;
        display = dispPtr;
        motor = motorPtr;
    }

private:
    WebServer server;
    bool frontLightOn;

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

    // Optional physical light button
    bool lastRawLightBtn;
    bool stableLightBtn;
    unsigned long lastDebounceLight;

    // Pointers for Web UI status rendering
    const VescUart *vesc;
    const DisplayProtocol *display;
    const MotorController *motor;

    void setupWebServer();
    void handleRoot();
    void handleStatusJson();
    void handleTurn(int buttonPin, int outputPin, bool &active,
                    unsigned long &startTime, unsigned long &lastBlink,
                    bool &ledState, bool &lastRaw, bool &stable,
                    unsigned long &lastDebounce, bool &otherActive,
                    int otherOutputPin);
};
