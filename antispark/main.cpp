#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <Preferences.h>


// =========================================================================
// Hardware Configuration (Auto-selects pins based on target architecture)
// =========================================================================
#if defined(CONFIG_IDF_TARGET_ESP32C3) || defined(ARDUINO_ESP32C3_DEV)
  // ESP32-C3 has pins GPIO 0 to 21 (GPIO 23 does not exist on C3)
  #define ANTISPARK_PIN   10   // General-purpose trigger pin on ESP32-C3
  #define STATUS_LED_PIN  8    // Onboard Blue LED on ESP32-C3 SuperMini
  #define LED_ACTIVE_LOW  true // SuperMini blue LED is active LOW (LOW = ON)
#else
  // Classic ESP32 (WROOM / WROVER)
  #define ANTISPARK_PIN   23   // Primary trigger pin to antispark switch/relay
  #define STATUS_LED_PIN  2    // Onboard ESP32 LED (blue) for bench visual verification
  #define LED_ACTIVE_LOW  false// Classic ESP32 LED is active HIGH (HIGH = ON)
#endif

// =========================================================================
// BLE Service & Characteristic UUIDs
// =========================================================================
#define BLE_DEVICE_NAME     "Scooter-Antispark"
#define BLE_SVC_UUID        "6e400010-b5a3-f393-e0a9-e50e24dcca9e"
#define BLE_CTRL_UUID       "6e400011-b5a3-f393-e0a9-e50e24dcca9e"

// =========================================================================
// Global State & Watchdog
// =========================================================================
static BLEServer *pServer = nullptr;
static BLECharacteristic *pCtrlChar = nullptr;
static Preferences prefs;

static bool antisparkState = false;    // false = OFF (LOW), true = ON (HIGH)
static bool autoWatchdog = true;       // Auto turn off when disconnected > timeout
static uint32_t watchdogTimeoutSec = 10; // Grace period before disconnect cutoff (seconds)

static bool isClientConnected = false;
static bool oldClientConnected = false;
static unsigned long disconnectTimestamp = 0;
static unsigned long lastStatusNotify = 0;
static unsigned long bootTimestamp = 0;

// Helper for status LED
static inline void writeStatusLed(bool on) {
  #if LED_ACTIVE_LOW
    digitalWrite(STATUS_LED_PIN, on ? LOW : HIGH);
  #else
    digitalWrite(STATUS_LED_PIN, on ? HIGH : LOW);
  #endif
}

// Forward Declarations
void setAntisparkState(bool state, const char *reason);
void notifyStatus();
void handleCommand(const String &cmd);

// =========================================================================
// BLE Server Callbacks
// =========================================================================
class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *pServer) override {
    isClientConnected = true;
    disconnectTimestamp = 0;
    Serial.println(F("[ANTISPARK] Phone connected via BLE"));

    // Keyless ignition: Turn ON immediately when phone connects
    setAntisparkState(true, "BLE Phone Connected");
  }

  void onDisconnect(BLEServer *pServer) override {
    isClientConnected = false;
    disconnectTimestamp = 0;
    Serial.println(F("[ANTISPARK] Signal lost - turning Antispark OFF automatically"));
    setAntisparkState(false, "BLE Signal Lost (Auto-off)");
  }
};

// =========================================================================
// BLE Characteristic Callbacks
// =========================================================================
class ControlCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *pChar) override {
    String cmd = pChar->getValue();
    cmd.trim();
    if (cmd.length() > 0) {
      handleCommand(cmd);
    }
  }
};

// =========================================================================
// Antispark Output Controller
// =========================================================================
void setAntisparkState(bool state, const char *reason) {
  antisparkState = state;
  digitalWrite(ANTISPARK_PIN, antisparkState ? HIGH : LOW);
  writeStatusLed(antisparkState);

  Serial.printf("[ANTISPARK] STATE -> %s (GPIO %d=%s, LED %d=%s) [Reason: %s]\n",
                antisparkState ? "ON" : "OFF",
                ANTISPARK_PIN,
                antisparkState ? "HIGH (3.3V)" : "LOW (0V)",
                STATUS_LED_PIN,
                antisparkState ? "ON" : "OFF",
                reason);

  notifyStatus();
}

// Format and send status packet: "PWR=1 AUTO=1 TO=10 UP=42"
void notifyStatus() {
  if (!pCtrlChar || !isClientConnected) return;

  unsigned long uptimeSec = (millis() - bootTimestamp) / 1000;
  char buf[64];
  snprintf(buf, sizeof(buf), "PWR=%d AUTO=%d TO=%u UP=%lu",
           antisparkState ? 1 : 0,
           autoWatchdog ? 1 : 0,
           watchdogTimeoutSec,
           uptimeSec);

  pCtrlChar->setValue((uint8_t *)buf, strlen(buf));
  pCtrlChar->notify();
}

// =========================================================================
// Command Parser
// =========================================================================
void handleCommand(const String &cmd) {
  Serial.printf("[ANTISPARK] CMD received: '%s'\n", cmd.c_str());

  if (cmd.startsWith("PWR 1") || cmd.equalsIgnoreCase("ON")) {
    setAntisparkState(true, "BLE App Command");
  } 
  else if (cmd.startsWith("PWR 0") || cmd.equalsIgnoreCase("OFF")) {
    setAntisparkState(false, "BLE App Command");
  } 
  else if (cmd.startsWith("AUTO ")) {
    autoWatchdog = (cmd.substring(5).toInt() > 0);
    prefs.putBool("auto", autoWatchdog);
    Serial.printf("[ANTISPARK] Auto-watchdog set to: %d\n", autoWatchdog);
    notifyStatus();
  } 
  else if (cmd.startsWith("TIMEOUT ")) {
    int to = cmd.substring(8).toInt();
    if (to >= 1 && to <= 300) {
      watchdogTimeoutSec = (uint32_t)to;
      prefs.putUInt("timeout", watchdogTimeoutSec);
      Serial.printf("[ANTISPARK] Watchdog timeout set to: %u s\n", watchdogTimeoutSec);
    }
    notifyStatus();
  } 
  else if (cmd.equalsIgnoreCase("STATUS") || cmd.equalsIgnoreCase("S")) {
    notifyStatus();
  } 
  else {
    Serial.printf("[ANTISPARK] Unknown command: '%s'\n", cmd.c_str());
  }
}

// =========================================================================
// Setup
// =========================================================================
void setup() {
  Serial.begin(115200);
  delay(300);

  Serial.println(F("========================================"));
  Serial.println(F("  VESCBLUE - ANTISPARK KEYLESS CONTROLLER "));
  Serial.println(F("========================================"));

  // Initialize GPIOs
  pinMode(ANTISPARK_PIN, OUTPUT);
  pinMode(STATUS_LED_PIN, OUTPUT);

  // Safe default: LOW (Antispark OFF, LED OFF)
  digitalWrite(ANTISPARK_PIN, LOW);
  writeStatusLed(false);

  bootTimestamp = millis();

  // Load preferences (always enable watchdog by default)
  prefs.begin("antispark", false);
  autoWatchdog = true;
  prefs.putBool("auto", true);
  watchdogTimeoutSec = prefs.getUInt("timeout", 10);
  if (watchdogTimeoutSec < 1 || watchdogTimeoutSec > 300) {
    watchdogTimeoutSec = 10;
    prefs.putUInt("timeout", 10);
  }

  Serial.printf("[ANTISPARK] Pins: Antispark=GPIO %d, LED=GPIO %d\n", ANTISPARK_PIN, STATUS_LED_PIN);
  Serial.printf("[ANTISPARK] Config: AutoWatchdog=%d, Timeout=%us\n", autoWatchdog, watchdogTimeoutSec);

  // Initialize BLE
  BLEDevice::init(BLE_DEVICE_NAME);
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new ServerCallbacks());

  BLEService *pService = pServer->createService(BLE_SVC_UUID);

  pCtrlChar = pService->createCharacteristic(
    BLE_CTRL_UUID,
    BLECharacteristic::PROPERTY_READ |
    BLECharacteristic::PROPERTY_WRITE |
    BLECharacteristic::PROPERTY_WRITE_NR |
    BLECharacteristic::PROPERTY_NOTIFY
  );

  pCtrlChar->addDescriptor(new BLE2902());
  pCtrlChar->setCallbacks(new ControlCallbacks());

  // Default initial status
  char initBuf[64];
  snprintf(initBuf, sizeof(initBuf), "PWR=0 AUTO=%d TO=%u UP=0", autoWatchdog ? 1 : 0, watchdogTimeoutSec);
  pCtrlChar->setValue((uint8_t *)initBuf, strlen(initBuf));

  pService->start();

  // Start Fast BLE Advertising (20ms to 40ms intervals)
  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(BLE_SVC_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinInterval(0x20); // 20ms
  pAdvertising->setMaxInterval(0x40); // 40ms
  pAdvertising->setMinPreferred(0x06); // 7.5ms preferred
  pAdvertising->setMaxPreferred(0x12);

  BLEAdvertisementData advData;
  advData.setFlags(0x06);
  advData.setCompleteServices(BLEUUID(BLE_SVC_UUID));
  advData.setName(BLE_DEVICE_NAME);
  pAdvertising->setAdvertisementData(advData);

  BLEAdvertisementData respData;
  respData.setName(BLE_DEVICE_NAME);
  pAdvertising->setScanResponseData(respData);

  BLEDevice::startAdvertising();

  // Visual boot signal: 3 fast blinks on onboard LED (Pin 8)
  for (int i = 0; i < 3; i++) {
    writeStatusLed(true);
    delay(100);
    writeStatusLed(false);
    delay(100);
  }

  Serial.println(F("[ANTISPARK] BLE Advertising started: 'Scooter-Antispark'"));
  Serial.println(F("[ANTISPARK] Ready. Output=LOW"));
}

// =========================================================================
// Main Loop
// =========================================================================
void loop() {
  unsigned long now = millis();

  // Auto-cutoff: If disconnected while Antispark is ON, turn OFF immediately
  if (!isClientConnected && antisparkState) {
    setAntisparkState(false, "Disconnected Safety Cutoff");
  }

  // Handle disconnection & clean advertising restart
  if (!isClientConnected && oldClientConnected) {
    oldClientConnected = false;
    delay(100);
    BLEDevice::startAdvertising();
    Serial.println(F("[ANTISPARK] Resumed BLE Advertising after disconnect"));
  }
  // Handle new connection
  if (isClientConnected && !oldClientConnected) {
    oldClientConnected = true;
  }

  // Advertising Liveness Watchdog: When disconnected, ensure advertising is actively broadcasting
  static unsigned long lastAdvLiveness = 0;
  if (!isClientConnected && (now - lastAdvLiveness >= 2000)) {
    lastAdvLiveness = now;
    BLEDevice::startAdvertising();
  }

  // Standby Heartbeat: subtle blip every 2.5s when disconnected to indicate active BLE advertising
  static unsigned long lastHeartbeat = 0;
  if (!isClientConnected && !antisparkState) {
    if (now - lastHeartbeat >= 2500) {
      lastHeartbeat = now;
      writeStatusLed(true);
      delay(25);
      writeStatusLed(false);
    }
  }

  // Periodic status heartbeat when connected (every 3 seconds)
  if (isClientConnected && (now - lastStatusNotify >= 3000)) {
    lastStatusNotify = now;
    notifyStatus();
  }

  delay(5);
}
