#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <BLEBeacon.h>
#include <Preferences.h>
#include <Update.h>


// =========================================================================
// Hardware Configuration (Auto-selects pins based on target architecture)
// =========================================================================
#if defined(CONFIG_IDF_TARGET_ESP32C3) || defined(ARDUINO_ESP32C3_DEV)
  // ESP32-C3 has pins GPIO 0 to 21 (GPIO 23 does not exist on C3)
  #define ANTISPARK_PIN      10   // Optocoupler Anode (+) trigger pin on ESP32-C3
  #define ANTISPARK_GND_PIN  20   // Optocoupler Cathode (-) ground sink pin on ESP32-C3
  #define STATUS_LED_PIN     8    // Onboard Blue LED on ESP32-C3 SuperMini
  #define LED_ACTIVE_LOW     true // SuperMini blue LED is active LOW (LOW = ON)
#else
  // Classic ESP32 (WROOM / WROVER)
  #define ANTISPARK_PIN      23   // Optocoupler Anode (+) trigger pin
  #define ANTISPARK_GND_PIN  22   // Optocoupler Cathode (-) ground sink pin
  #define STATUS_LED_PIN     2    // Onboard ESP32 LED (blue) for bench visual verification
  #define LED_ACTIVE_LOW     false// Classic ESP32 LED is active HIGH (HIGH = ON)
#endif

// =========================================================================
// BLE Service & Characteristic UUIDs
// =========================================================================
#define BLE_DEVICE_NAME     "Scooter-Antispark"
#define BLE_SVC_UUID        "6e400010-b5a3-f393-e0a9-e50e24dcca9e"
#define BLE_CTRL_UUID       "6e400011-b5a3-f393-e0a9-e50e24dcca9e"
#define BLE_OTA_UUID        "6e400012-b5a3-f393-e0a9-e50e24dcca9e"

// =========================================================================
// Apple iBeacon Configuration (Target: FDA50693-A4E2-4FB1-AFCF-C6EB07647825)
// ESP32 BLEUUID reverses bytes on parse; passing byte-reversed string ensures
// transmitted payload is the exact Big-Endian byte order required by iOS CoreLocation.
#define IBEACON_UUID_STR    "25786407-ebc6-cfaf-b14f-e2a49306a5fd"
#define IBEACON_MAJOR       1
#define IBEACON_MINOR       1
#define IBEACON_TX_POWER    -59 // Measured RSSI at 1m in dBm (0xC5)

// =========================================================================
// Global State & Watchdog
// =========================================================================
static BLEServer *pServer = nullptr;
static BLECharacteristic *pCtrlChar = nullptr;
static BLECharacteristic *pOtaChar = nullptr;
static Preferences prefs;

static bool antisparkState = false;    // false = OFF (LOW), true = ON (HIGH)
static bool beaconActive = true;       // false when manually turned OFF via app
static bool autoCutoffEnabled = false; // false = stays ON on BLE disconnect for Park Mode, true = auto power cut

static bool bleOtaActive = false;
static size_t bleOtaExpected = 0;
static size_t bleOtaReceived = 0;

static bool isClientConnected = false;
static bool oldClientConnected = false;
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
void notifyMsg(const String &msg);
void handleCommand(const String &cmd);
void updateAdvertising(bool enableBeacon);

// =========================================================================
// BLE Server Callbacks
// =========================================================================
class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *pServer) override {
    isClientConnected = true;
    Serial.println(F("[ANTISPARK] Phone connected via BLE"));
  }

  void onDisconnect(BLEServer *pServer) override {
    isClientConnected = false;
    if (bleOtaActive) {
      Update.abort();
      bleOtaActive = false;
    }
    if (autoCutoffEnabled) {
      Serial.println(F("[ANTISPARK] Signal lost - turning Antispark OFF automatically"));
      setAntisparkState(false, "BLE Signal Lost (Auto-off)");
    } else {
      Serial.println(F("[ANTISPARK] Signal lost - Power kept ON for Park Mode"));
    }
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

class OtaCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *c) override {
    if (!bleOtaActive)
      return;
    size_t n = c->getLength();
    if (n == 0)
      return;
    if (Update.write((uint8_t *)c->getData(), n) != n) {
      notifyMsg("OTA:ERROR write-failed");
      Update.abort();
      bleOtaActive = false;
      return;
    }
    bleOtaReceived += n;
  }
};

// =========================================================================
// Antispark Output Controller
// =========================================================================
void setAntisparkState(bool state, const char *reason) {
  antisparkState = state;
  digitalWrite(ANTISPARK_PIN, antisparkState ? HIGH : LOW);
  digitalWrite(ANTISPARK_GND_PIN, LOW); // Optocoupler Cathode (-) constant 0V sink
  writeStatusLed(antisparkState);

  Serial.printf("[ANTISPARK] STATE -> %s (GPIO %d=%s, GPIO %d=LOW (0V), LED %d=%s) [Reason: %s]\n",
                antisparkState ? "ON" : "OFF",
                ANTISPARK_PIN,
                antisparkState ? "HIGH (3.3V)" : "LOW (0V)",
                ANTISPARK_GND_PIN,
                STATUS_LED_PIN,
                antisparkState ? "ON" : "OFF",
                reason);

  notifyStatus();
}

// Format and send status packet: "PWR=1 UP=42"
void notifyStatus() {
  if (!pCtrlChar || !isClientConnected) return;

  unsigned long uptimeSec = (millis() - bootTimestamp) / 1000;
  char buf[64];
  snprintf(buf, sizeof(buf), "PWR=%d UP=%lu AUTO=%d",
           antisparkState ? 1 : 0,
           uptimeSec,
           autoCutoffEnabled ? 1 : 0);

  pCtrlChar->setValue((uint8_t *)buf, strlen(buf));
  pCtrlChar->notify();
}

void notifyMsg(const String &msg) {
  if (!pCtrlChar || !isClientConnected) return;
  pCtrlChar->setValue((uint8_t *)msg.c_str(), msg.length());
  pCtrlChar->notify();
}

// =========================================================================
// Command Parser
// =========================================================================
void handleCommand(const String &cmd) {
  Serial.printf("[ANTISPARK] CMD received: '%s'\n", cmd.c_str());

  if (cmd.startsWith("OTA:BEGIN:")) {
    bleOtaExpected = cmd.substring(10).toInt();
    bleOtaReceived = 0;
    bleOtaActive = true;
    if (Update.begin(bleOtaExpected)) {
      notifyMsg("OTA:READY " + String((unsigned long)bleOtaExpected));
      Serial.printf("[ANTISPARK] OTA started, expecting %u bytes\n", (unsigned int)bleOtaExpected);
    } else {
      notifyMsg("OTA:ERROR begin-failed");
      bleOtaActive = false;
      Serial.println(F("[ANTISPARK] OTA:ERROR begin-failed"));
    }
    return;
  }
  else if (cmd == "OTA:END") {
    if (bleOtaActive && Update.end(true)) {
      notifyMsg("OTA:OK rebooting");
      Serial.println(F("[ANTISPARK] OTA:OK rebooting into new firmware"));
      delay(300);
      ESP.restart();
    } else {
      notifyMsg("OTA:ERROR end-failed");
      Update.abort();
      Serial.println(F("[ANTISPARK] OTA:ERROR end-failed"));
    }
    bleOtaActive = false;
    return;
  }
  else if (cmd == "OTA:ABORT") {
    if (bleOtaActive) {
      Update.abort();
      bleOtaActive = false;
    }
    notifyMsg("OTA:ABORTED");
    return;
  }
  else if (cmd.equalsIgnoreCase("REBOOT") || cmd.equalsIgnoreCase("R")) {
    notifyMsg("REBOOTING");
    delay(200);
    ESP.restart();
    return;
  }
  else if (cmd.startsWith("PWR 1") || cmd.equalsIgnoreCase("ON")) {
    beaconActive = true;
    prefs.putBool("beacon", true);
    setAntisparkState(true, "BLE App Command");
  } 
  else if (cmd.startsWith("PWR 0") || cmd.equalsIgnoreCase("OFF")) {
    beaconActive = false;
    prefs.putBool("beacon", false);
    setAntisparkState(false, "BLE App Command");
  } 
  else if (cmd.startsWith("AUTO 1") || cmd.equalsIgnoreCase("AUTOCUTOFF 1")) {
    autoCutoffEnabled = true;
    prefs.putBool("autoCutoff", true);
    Serial.println(F("[ANTISPARK] Auto-cutoff on disconnect ENABLED"));
    notifyStatus();
  }
  else if (cmd.startsWith("AUTO 0") || cmd.equalsIgnoreCase("AUTOCUTOFF 0")) {
    autoCutoffEnabled = false;
    prefs.putBool("autoCutoff", false);
    Serial.println(F("[ANTISPARK] Auto-cutoff on disconnect DISABLED (Scooter stays ON when app disconnects)"));
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
// Dynamic Advertising Controller (Apple iBeacon vs Standard GATT Standby)
// =========================================================================
void updateAdvertising(bool enableBeacon) {
  beaconActive = enableBeacon;
  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->stop();
  delay(50);
  pAdvertising->reset();

  pAdvertising->addServiceUUID(BLE_SVC_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinInterval(0x20); // 20ms
  pAdvertising->setMaxInterval(0x40); // 40ms
  pAdvertising->setMinPreferred(0x06); // 7.5ms preferred
  pAdvertising->setMaxPreferred(0x12);

  BLEAdvertisementData advData;
  advData.setFlags(0x06); // 0x02 (LE General Discoverable) | 0x04 (BR/EDR Not Supported)

  if (enableBeacon) {
    BLEBeacon myBeacon;
    myBeacon.setManufacturerId(0x4C00); // Apple Inc. (0x004C)
    myBeacon.setMajor(IBEACON_MAJOR);
    myBeacon.setMinor(IBEACON_MINOR);
    myBeacon.setSignalPower(IBEACON_TX_POWER);
    BLEUUID bleUUID(IBEACON_UUID_STR);
    bleUUID = bleUUID.to128();
    myBeacon.setProximityUUID(bleUUID);
    advData.setManufacturerData(myBeacon.getData());
    Serial.println(F("[ANTISPARK] BLE Advertising: Apple iBeacon ACTIVE"));
  } else {
    // When manually powered off: advertise Antispark Service UUID directly without iBeacon payload
    advData.setCompleteServices(BLEUUID(BLE_SVC_UUID));
    Serial.println(F("[ANTISPARK] BLE Advertising: iBeacon INACTIVE (Manual Standby)"));
  }
  pAdvertising->setAdvertisementData(advData);

  // Scan Response Data: Device Name and Service UUID for iOS background scanning
  BLEAdvertisementData respData;
  respData.setName("Antispark");
  respData.setCompleteServices(BLEUUID(BLE_SVC_UUID));
  pAdvertising->setScanResponseData(respData);

  pAdvertising->start();
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
  pinMode(ANTISPARK_GND_PIN, OUTPUT);
  pinMode(STATUS_LED_PIN, OUTPUT);

  // Safe default: LOW (Antispark OFF, LED OFF)
  digitalWrite(ANTISPARK_PIN, LOW);
  digitalWrite(ANTISPARK_GND_PIN, LOW);
  writeStatusLed(false);

  bootTimestamp = millis();

  // Load preferences
  prefs.begin("antispark", false);
  beaconActive = prefs.getBool("beacon", true);
  autoCutoffEnabled = prefs.getBool("autoCutoff", false);

  Serial.printf("[ANTISPARK] Pins: Antispark +=GPIO %d, Antispark -=GPIO %d, LED=GPIO %d\n", ANTISPARK_PIN, ANTISPARK_GND_PIN, STATUS_LED_PIN);
  Serial.printf("[ANTISPARK] Config: Beacon=%d, AutoCutoff=%d\n", beaconActive, autoCutoffEnabled);

  // Initialize BLE
  BLEDevice::init(BLE_DEVICE_NAME);
  BLEDevice::setMTU(517);
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

  pOtaChar = pService->createCharacteristic(
    BLE_OTA_UUID,
    BLECharacteristic::PROPERTY_WRITE |
    BLECharacteristic::PROPERTY_WRITE_NR
  );
  pOtaChar->setCallbacks(new OtaCallbacks());

  // Default initial status
  char initBuf[64];
  snprintf(initBuf, sizeof(initBuf), "PWR=0 UP=0");
  pCtrlChar->setValue((uint8_t *)initBuf, strlen(initBuf));

  pService->start();

  // Configure Fast BLE Advertising intervals
  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(BLE_SVC_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinInterval(0x20); // 20ms
  pAdvertising->setMaxInterval(0x40); // 40ms
  pAdvertising->setMinPreferred(0x06); // 7.5ms preferred
  pAdvertising->setMaxPreferred(0x12);

  // Start initial advertising based on saved beaconActive state
  updateAdvertising(beaconActive);

  // Visual boot signal: 3 fast blinks on onboard LED (Pin 8)
  for (int i = 0; i < 3; i++) {
    writeStatusLed(true);
    delay(100);
    writeStatusLed(false);
    delay(100);
  }

  Serial.println(F("[ANTISPARK] Ready. Output=LOW"));
}

// =========================================================================
// Main Loop
// =========================================================================
void loop() {
  unsigned long now = millis();

  // Auto-cutoff: If disconnected while Antispark is ON and autoCutoff is active, turn OFF
  if (autoCutoffEnabled && !isClientConnected && antisparkState) {
    setAntisparkState(false, "Disconnected Safety Cutoff");
  }

  // Handle disconnection & clean advertising restart
  if (!isClientConnected && oldClientConnected) {
    oldClientConnected = false;
    delay(100);
    updateAdvertising(beaconActive);
    Serial.printf("[ANTISPARK] Resumed BLE Advertising after disconnect (iBeacon: %s)\n", beaconActive ? "ON" : "OFF");
  }
  // Handle new connection
  if (isClientConnected && !oldClientConnected) {
    oldClientConnected = true;
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

  // Periodic status heartbeat when connected (every 3 seconds, suppressed during OTA)
  if (isClientConnected && !bleOtaActive && (now - lastStatusNotify >= 3000)) {
    lastStatusNotify = now;
    notifyStatus();
  }

  delay(5);
}
