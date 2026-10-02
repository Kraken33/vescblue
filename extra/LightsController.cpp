#include "LightsController.h"

LightsController::LightsController()
    : server(80),
      frontLightOn(false),
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
      lastDebounceLight(0),
      vesc(nullptr),
      display(nullptr),
      motor(nullptr) {}

void LightsController::begin() {
    // Inputs (Active Low)
    pinMode(PIN_IN_TURN_L, INPUT_PULLUP);
    pinMode(PIN_IN_TURN_R, INPUT_PULLUP);
    pinMode(PIN_IN_LIGHT, INPUT_PULLUP);

    // Outputs
    pinMode(PIN_OUT_BRAKE, OUTPUT);
    pinMode(PIN_OUT_LIGHT, OUTPUT);
    pinMode(PIN_OUT_TURN_L, OUTPUT);
    pinMode(PIN_OUT_TURN_R, OUTPUT);

    digitalWrite(PIN_OUT_BRAKE, LOW);
    digitalWrite(PIN_OUT_LIGHT, LOW);
    digitalWrite(PIN_OUT_TURN_L, LOW);
    digitalWrite(PIN_OUT_TURN_R, LOW);

    // Start WiFi Hotspot
    WiFi.softAP(WIFI_AP_SSID, WIFI_AP_PASSWORD);

    // Web Routes
    setupWebServer();
}

void LightsController::setupWebServer() {
    server.on("/", [this]() { handleRoot(); });
    server.on("/status", [this]() { handleStatusJson(); });

    server.on("/light", [this]() {
        toggleFrontLight();
        server.sendHeader("Location", "/");
        server.send(303);
    });

    server.on("/turnL", [this]() {
        startTurnLeft();
        server.sendHeader("Location", "/");
        server.send(303);
    });

    server.on("/stopL", [this]() {
        stopTurnLeft();
        server.sendHeader("Location", "/");
        server.send(303);
    });

    server.on("/turnR", [this]() {
        startTurnRight();
        server.sendHeader("Location", "/");
        server.send(303);
    });

    server.on("/stopR", [this]() {
        stopTurnRight();
        server.sendHeader("Location", "/");
        server.send(303);
    });

    server.begin();
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

void LightsController::handleWebClient() {
    server.handleClient();
}

void LightsController::update(bool brakePressed) {
    // 1. Brake Light Output
    digitalWrite(PIN_OUT_BRAKE, brakePressed ? HIGH : LOW);

    // 2. Physical Front Light Switch Debounce
    bool lightReading = digitalRead(PIN_IN_LIGHT);
    if (lightReading != lastRawLightBtn) {
        lastDebounceLight = millis();
    }
    lastRawLightBtn = lightReading;
    if ((millis() - lastDebounceLight) > DEBOUNCE_DELAY_MS) {
        if (lightReading != stableLightBtn) {
            stableLightBtn = lightReading;
            if (stableLightBtn == LOW) { // Button pressed
                toggleFrontLight();
            }
        }
    }

    // 3. Turn Signals
    handleTurn(PIN_IN_TURN_L, PIN_OUT_TURN_L, turnL_active, turnL_startTime,
               turnL_lastBlink, turnL_ledState, lastRawL, stableL, lastDebounceL,
               turnR_active, PIN_OUT_TURN_R);

    handleTurn(PIN_IN_TURN_R, PIN_OUT_TURN_R, turnR_active, turnR_startTime,
               turnR_lastBlink, turnR_ledState, lastRawR, stableR, lastDebounceR,
               turnL_active, PIN_OUT_TURN_L);
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

            if (stable == LOW) { // Button pressed
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

void LightsController::handleStatusJson() {
    float speed = vesc ? vesc->getTelemetry().speedKmH : 0.0f;
    float voltage = vesc ? vesc->getTelemetry().vIn : 0.0f;
    float motorCur = vesc ? vesc->getTelemetry().currentMotor : 0.0f;
    int gear = display ? display->getGear() : 1;
    bool sMode = display ? display->isSModeActive() : false;
    float throttle = motor ? motor->getThrottlePercent() : 0.0f;
    bool brake = motor ? motor->isBrakeEngaged() : false;

    String json = "{";
    json += "\"speed\":" + String(speed, 1) + ",";
    json += "\"voltage\":" + String(voltage, 1) + ",";
    json += "\"current\":" + String(motorCur, 1) + ",";
    json += "\"gear\":" + String(gear) + ",";
    json += "\"sMode\":" + String(sMode ? "true" : "false") + ",";
    json += "\"throttle\":" + String(throttle, 0) + ",";
    json += "\"brake\":" + String(brake ? "true" : "false") + ",";
    json += "\"frontLight\":" + String(frontLightOn ? "true" : "false") + ",";
    json += "\"turnL\":" + String(turnL_active ? "true" : "false") + ",";
    json += "\"turnR\":" + String(turnR_active ? "true" : "false");
    json += "}";

    server.send(200, "application/json", json);
}

void LightsController::handleRoot() {
    String html = R"rawliteral(
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
  <title>VESC Blue Controller</title>
  <style>
    :root {
      --bg: #0b0c10;
      --card-bg: #1f2833;
      --text: #c5c6c7;
      --accent: #66fcf1;
      --accent-dim: #45a29e;
      --green: #22c55e;
      --amber: #f59e0b;
      --blue: #3b82f6;
      --red: #ef4444;
      --dark-btn: #2d3748;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 16px;
      text-align: center;
    }
    h1 {
      margin: 8px 0 16px;
      color: var(--accent);
      font-size: 24px;
      font-weight: 700;
      letter-spacing: 0.5px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }
    .stat-card {
      background: var(--card-bg);
      border-radius: 14px;
      padding: 14px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      border: 1px solid rgba(255,255,255,0.05);
    }
    .stat-val {
      font-size: 28px;
      font-weight: 700;
      color: #fff;
    }
    .stat-unit {
      font-size: 14px;
      color: var(--accent);
      margin-left: 2px;
    }
    .stat-label {
      font-size: 12px;
      color: #8892b0;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-top: 4px;
    }
    .card {
      background: var(--card-bg);
      border-radius: 16px;
      padding: 16px;
      margin: 12px 0;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      border: 1px solid rgba(255,255,255,0.05);
    }
    .btn {
      display: block;
      width: 100%;
      padding: 14px;
      font-size: 16px;
      font-weight: 600;
      border: none;
      border-radius: 12px;
      margin: 8px 0;
      color: white;
      cursor: pointer;
      transition: transform 0.1s, opacity 0.2s;
    }
    .btn:active { transform: scale(0.98); }
    .btn-on    { background: var(--green); }
    .btn-off   { background: var(--dark-btn); }
    .btn-left  { background: var(--blue); }
    .btn-right { background: var(--amber); }
    .btn-stop  { background: var(--red); }
    .status {
      font-size: 13px;
      color: #8892b0;
      margin-top: 6px;
    }
    .badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: bold;
    }
    .badge-on { background: rgba(34, 197, 94, 0.2); color: #4ade80; }
    .badge-off { background: rgba(255, 255, 255, 0.1); color: #a1a1aa; }
    .badge-s { background: rgba(245, 158, 11, 0.3); color: #fbbf24; border: 1px solid #f59e0b; }
  </style>
</head>
<body>
  <h1>⚡ VESC Blue Control</h1>

  <div class="grid">
    <div class="stat-card">
      <div class="stat-val"><span id="speed">0.0</span><span class="stat-unit">km/h</span></div>
      <div class="stat-label">Speed</div>
    </div>
    <div class="stat-card">
      <div class="stat-val"><span id="voltage">0.0</span><span class="stat-unit">V</span></div>
      <div class="stat-label">Battery</div>
    </div>
    <div class="stat-card">
      <div class="stat-val"><span id="current">0.0</span><span class="stat-unit">A</span></div>
      <div class="stat-label">Motor Cur</div>
    </div>
    <div class="stat-card">
      <div class="stat-val">
        <span id="gear">1</span>
        <span id="smode_badge" class="badge badge-s" style="display:none;">S</span>
      </div>
      <div class="stat-label">Gear Mode</div>
    </div>
  </div>

  <!-- FRONT LIGHT -->
  <div class="card">
    <h3 style="margin-top:0;">💡 Front Light</h3>
    <button id="btn_light" class="btn btn-off" onclick="fetch('/light')">Toggle Light</button>
    <div class="status">Status: <span id="light_status" class="badge badge-off">OFF</span></div>
  </div>

  <!-- TURN SIGNALS -->
  <div class="card">
    <h3 style="margin-top:0;">🚦 Turn Signals</h3>
    <div style="display:flex; gap:10px;">
      <button class="btn btn-left" style="flex:1;" onclick="fetch('/turnL')">⬅ Left</button>
      <button class="btn btn-stop" style="flex:0.8;" onclick="fetch('/stopL')">Stop</button>
    </div>
    <div style="display:flex; gap:10px;">
      <button class="btn btn-right" style="flex:1;" onclick="fetch('/turnR')">Right ➡</button>
      <button class="btn btn-stop" style="flex:0.8;" onclick="fetch('/stopR')">Stop</button>
    </div>
  </div>

  <script>
    async function updateDashboard() {
      try {
        const res = await fetch('/status');
        if (res.ok) {
          const d = await res.json();
          document.getElementById('speed').innerText = d.speed.toFixed(1);
          document.getElementById('voltage').innerText = d.voltage.toFixed(1);
          document.getElementById('current').innerText = d.current.toFixed(1);
          document.getElementById('gear').innerText = d.gear;
          
          document.getElementById('smode_badge').style.display = d.sMode ? 'inline-block' : 'none';
          
          const btnLight = document.getElementById('btn_light');
          const statusLight = document.getElementById('light_status');
          if (d.frontLight) {
            btnLight.className = "btn btn-on";
            statusLight.className = "badge badge-on";
            statusLight.innerText = "ON";
          } else {
            btnLight.className = "btn btn-off";
            statusLight.className = "badge badge-off";
            statusLight.innerText = "OFF";
          }
        }
      } catch (err) {}
    }
    setInterval(updateDashboard, 500);
    updateDashboard();
  </script>
</body>
</html>
)rawliteral";

    server.send(200, "text/html", html);
}
