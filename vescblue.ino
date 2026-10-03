#include <Arduino.h>
#include <VescUart.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <BLEScan.h>
#include <BLEAdvertisedDevice.h>
#include <Update.h>
#include <Preferences.h>

// =========================================================================
// Hardware & CAN Pin Configuration
// =========================================================================
#define THROTTLE_PIN 34

// Brake Sensor Configuration (GPIO 19 single pin default)
int brakePin = 19;          // Default GPIO 19 (Single brake pin)
bool brakeActiveLow = true; // true = Active LOW (pulls to GND when brake engaged)
bool brakeEnabled = true;   // Master software toggle to enable/disable e-brake sensor

// Display UART (UART1) on GPIO 22 (RX) and GPIO 23 (TX) at 1200 Baud
#define PIN_DISPLAY_RX 22
#define PIN_DISPLAY_TX 23
#define DISPLAY_BAUD 1200

HardwareSerial DisplaySerial(1);

// Target CAN ID for the secondary VESC (Display side: ID 61 from display.lisp)
uint8_t slaveCanId = 61;

// =========================================================================
// Scooter Wheel & Motor Constants (from display.lisp)
// =========================================================================
const float P06_WHEEL_DIAMETER_INCH = 10.0f;
const float P07_MAGNET_POLES = 30.0f; // 15 pole pairs
const float MOTOR_POLE_PAIRS = 15.0f;
const float SPEED_CALC_FACTOR = 1.52069f;

// ERPM to km/h and m/s conversion
const float ERPM_TO_KMH = 0.003191858f;
const float ERPM_TO_MPS = 0.000886627f;

// =========================================================================
// Drive Profiles matching VESC Tool profiles (40 / 25 / 15 / 10 km/h)
// =========================================================================
struct DriveProfile {
  float speedLimitKmH;
  float maxErpm;
  float maxCurrentAmps;
  const char *name;
};

// ERPM = speedKmH / 0.003191858
const DriveProfile PROFILE_1  = { 10.0f,  3133.0f,  25.0f, "10 km/h (Eco)" };
const DriveProfile PROFILE_2  = { 15.0f,  4699.0f,  40.0f, "15 km/h (City)" };
const DriveProfile PROFILE_3  = { 25.0f,  7832.0f,  65.0f, "25 km/h (Drive)" };
const DriveProfile PROFILE_S2 = { 25.0f,  7832.0f,  65.0f, "25 km/h (Drive)" };
const DriveProfile PROFILE_S3 = { 40.0f, 100000.0f, 120.0f, "40+ km/h (Sport)" };

// Tuning & Limits (Full authority regen braking)
float userBrakeAmps = 25.0f;           // Strong default brake current in Amps
const float MIN_VARIABLE_BRAKE = 10.0f;// Min brake amps when throttling while braking
const float MAX_VARIABLE_BRAKE = 35.0f;// Max brake amps when full throttle while braking

// Throttle ADC calibration (Idle ~0.67V = 830 counts, Full ~3.0V = 3720 counts)
const int THROTTLE_MIN_RAW = 950;  // Threshold above idle (~0.77V)
const int THROTTLE_MAX_RAW = 3700; // Full throttle (~3.0V)

const unsigned long BRAKE_DEBOUNCE_MS = 20;

HardwareSerial VescSerial(2);
VescUart UART;
Preferences prefs;

// =========================================================================
// BLE debug console + BLE firmware update ("Scooter-ESP32")
// =========================================================================
#define BLE_SVC_UUID "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
#define BLE_CONSOLE_UUID "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
#define BLE_OTA_UUID "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
#define BLE_DEVICE_NAME "Scooter-ESP32"

BLEServer *bleServer = nullptr;
BLECharacteristic *bleConsole = nullptr;
BLECharacteristic *bleOta = nullptr;
bool bleClientConnected = false;
bool bleOtaActive = false;
size_t bleOtaExpected = 0;
size_t bleOtaReceived = 0;
unsigned long lastBleNotify = 0;

// Kick-start gate (0.0 = Zero-start enabled by default)
float KICK_RPM_ERPM = 0.0f;
float vescRpm57 = 0.0f;
float vehicleSpeedKmH = 0.0f;
float vehicleSpeedMps = 0.0f;
unsigned long lastVescPoll = 0;
bool kickBlocked = false;

// Non-blocking VESC telemetry buffer
uint8_t vescRxBuf[256];
int vescRxIdx = 0;
unsigned long lastVescByteTime = 0;

// =========================================================================
// Display Protocol State & Encryption Table (1200 Baud)
// =========================================================================
static const uint8_t ENCODING_KEY_ARRAY[128] = {
    0x5e, 0x23, 0x5c, 0x21, 0x2a, 0x2f, 0x28, 0x2d, 0x26, 0x2b, 0x24, 0x29, 0x52, 0x57, 0x50, 0x55,
    0x4e, 0x53, 0x4c, 0x51, 0x5a, 0x5f, 0x58, 0x5d, 0x56, 0x5b, 0x54, 0x59, 0x02, 0x07, 0x00, 0x05,
    0x3e, 0x03, 0x3c, 0x01, 0x0a, 0x0f, 0x08, 0x0d, 0x06, 0x0b, 0x04, 0x09, 0x32, 0x37, 0x30, 0x35,
    0x2e, 0x33, 0x2c, 0x31, 0x3a, 0x3f, 0x38, 0x3d, 0x36, 0x3b, 0x34, 0x39, 0x62, 0x67, 0x60, 0x65,
    0x1e, 0x63, 0x1c, 0x61, 0x6a, 0x6f, 0x68, 0x6d, 0x66, 0x6b, 0x64, 0x69, 0x12, 0x17, 0x10, 0x15,
    0x0e, 0x13, 0x0c, 0x11, 0x1a, 0x1f, 0x18, 0x1d, 0x16, 0x1b, 0x14, 0x19, 0x42, 0x47, 0x40, 0x45,
    0x7e, 0x43, 0x7c, 0x41, 0x4a, 0x4f, 0x48, 0x4d, 0x46, 0x4b, 0x44, 0x49, 0x72, 0x77, 0x70, 0x75,
    0x6e, 0x73, 0x6c, 0x71, 0x7a, 0x7f, 0x78, 0x7d, 0x76, 0x7b, 0x74, 0x79, 0x22, 0x27, 0x20, 0x25
};

static const uint8_t ENCODED_BYTES[10] = { 3, 4, 5, 7, 8, 9, 10, 11, 12, 13 };
static const uint8_t COMBO_KEY[7] = { 1, 2, 3, 2, 3, 2, 3 };

uint8_t displayRxBuffer[15];
int displayRxIndex = 0;
unsigned long lastDisplayRxByteTime = 0;
uint32_t displayPacketsCount = 0;
uint32_t displayRxBytes = 0;
uint32_t displayCrcFailures = 0;

uint8_t displayTxCounter = 0;
unsigned long lastDisplayTxTime = 0;

int currentGear = 1;
int lastRawGear = 0;
bool displayLightState = false;
bool lastLightState = false;
bool profileSSwitch = false;
uint8_t gearHistory[7] = { 1, 1, 1, 1, 1, 1, 1 };

bool vescConfigured = false;
unsigned long lastProfileSyncTime = 0;

DriveProfile activeProfile = PROFILE_1;

// =========================================================================
// Battery & Power Telemetry
// =========================================================================
float batteryVoltage = 0.0f;       // Actual battery input voltage from VESC (V)
float batteryCurrent = 0.0f;       // Battery input current from VESC (A)
float throttleVoltage = 0.0f;      // Analog throttle voltage (0.0 - 3.3V)
int currentRawThrottle = 0;

// =========================================================================
// Garmin Watch Proximity & Anti-Theft Lock
// =========================================================================
bool garminLockEnabled = false;       // Master toggle for Garmin proximity auto-lock
String garminTargetMac = "";          // Target Garmin BLE MAC (e.g. "AA:BB:CC:DD:EE:FF" or "" for auto)
String garminTargetName = "";         // Target Garmin device name (e.g. "Forerunner" or "" for auto)
int garminRssiThreshold = -85;        // Distance sensitivity threshold in dBm (-95 = far, -70 = near)
int garminTimeoutSeconds = 6;         // Absence timeout before locking (3 - 15s)
bool isScooterLocked = false;         // Live lock state: disables throttle & locks wheels
bool manualOverrideUnlocked = false;  // App override toggle (UNLOCK command)
bool manualLocked = false;            // Explicit manual lock toggle (LOCK command)
bool garminNear = false;              // Watch detected within RSSI range and recent time
int lastGarminRssi = -120;            // Live RSSI
unsigned long lastGarminSeenMs = 0;   // Timestamp of last received Garmin advertisement
String lastGarminDetectedMac = "";
String lastGarminDetectedName = "";
bool garminLearnActive = false;
unsigned long garminLearnStartTime = 0;

// Throttle & Brake State
bool testModeActive = false;
float testVoltage = 1.0f;
bool testBrakeState = false;

bool rawBrakePinState = false;
bool debouncedBrakeState = false;
bool lastDebouncedBrakeState = false;
bool lastSentBrakeState = false;
uint8_t brakeHistory = 0x00;
unsigned long lastBrakeSampleTime = 0;

// Motor state machine for clean freewheeling & instantaneous brake release
enum MotorDriveState {
  STATE_IDLE,
  STATE_DRIVE,
  STATE_BRAKE
};
MotorDriveState currentMotorState = STATE_IDLE;
int idleFramesRemaining = 0; // Frames to send 0A before disabling PWM to freewheel

float targetAmps = 0.0f;
float targetBrakeAmps = 0.0f;
unsigned long lastMotorCmdTime = 0;

// =========================================================================
// Helper Functions & Protocol Framing
// =========================================================================
uint8_t xorCrc(const uint8_t *buf, size_t len) {
  uint8_t crc = 0;
  for (size_t i = 0; i < len; i++) {
    crc ^= buf[i];
  }
  return crc;
}

uint16_t crc16_vesc(const uint8_t *buf, uint32_t len) {
  uint16_t crc = 0;
  for (uint32_t i = 0; i < len; i++) {
    crc = (uint8_t)(crc >> 8) | (crc << 8);
    crc ^= buf[i];
    crc ^= (uint8_t)(crc & 0xff) >> 4;
    crc ^= (crc << 8) << 4;
    crc ^= ((crc & 0xff) << 4) << 1;
  }
  return crc;
}

// Sends native VESC profile configuration (COMM_SET_MCCONF_TEMP = 48) to RAM
void sendVescTempProfile(float maxErpm, float currentScale) {
  uint8_t payload[40];
  int32_t ind = 0;

  payload[ind++] = 48; // COMM_SET_MCCONF_TEMP
  payload[ind++] = 0;  // store = false (RAM temporary)
  payload[ind++] = 1;  // forward_can = true (broadcast to all CAN controllers)
  payload[ind++] = 0;  // ack = false
  payload[ind++] = 0;  // divide_by_controllers = false

  buffer_append_float32_auto(payload, 1.0f, &ind);         // l_current_min_scale
  buffer_append_float32_auto(payload, currentScale, &ind); // l_current_max_scale
  buffer_append_float32_auto(payload, -maxErpm, &ind);     // l_min_erpm
  buffer_append_float32_auto(payload, maxErpm, &ind);      // l_max_erpm
  buffer_append_float32_auto(payload, 0.005f, &ind);       // l_min_duty
  buffer_append_float32_auto(payload, 0.95f, &ind);        // l_max_duty
  buffer_append_float32_auto(payload, -150000.0f, &ind);   // l_watt_min
  buffer_append_float32_auto(payload, 150000.0f, &ind);    // l_watt_max

  // 1. Send to Master VESC directly
  uint16_t crc = crc16_vesc(payload, ind);
  uint8_t frame[50];
  frame[0] = 0x02;
  frame[1] = (uint8_t)ind;
  memcpy(&frame[2], payload, ind);
  frame[2 + ind] = (uint8_t)(crc >> 8);
  frame[2 + ind + 1] = (uint8_t)(crc & 0xFF);
  frame[2 + ind + 2] = 0x03;
  VescSerial.write(frame, ind + 5);

  // 2. Also explicitly forward to Slave VESC over CAN to guarantee dual sync
  if (slaveCanId > 0) {
    uint8_t canPayload[45];
    canPayload[0] = 34; // COMM_FORWARD_CAN
    canPayload[1] = slaveCanId;
    memcpy(&canPayload[2], payload, ind);
    uint16_t canCrc = crc16_vesc(canPayload, ind + 2);
    uint8_t canFrame[55];
    canFrame[0] = 0x02;
    canFrame[1] = (uint8_t)(ind + 2);
    memcpy(&canFrame[2], canPayload, ind + 2);
    canFrame[2 + ind + 2] = (uint8_t)(canCrc >> 8);
    canFrame[2 + ind + 3] = (uint8_t)(canCrc & 0xFF);
    canFrame[2 + ind + 4] = 0x03;
    VescSerial.write(canFrame, ind + 7);
  }
}

void sendBrakeFlagToSlave(bool isBraking) {
  if (slaveCanId == 0) return;
  uint8_t payload[5];
  payload[0] = 34;  // COMM_FORWARD_CAN
  payload[1] = slaveCanId;
  payload[2] = 36;  // COMM_CUSTOM_APP_DATA
  payload[3] = 0x42; // tag: brake state
  payload[4] = isBraking ? 1 : 0;
  uint16_t crc = crc16_vesc(payload, 5);
  uint8_t frame[10] = {0x02, 5, payload[0], payload[1], payload[2], payload[3], payload[4],
                      (uint8_t)(crc >> 8), (uint8_t)(crc & 0xFF), 0x03};
  VescSerial.write(frame, sizeof(frame));
}

// Fast non-blocking Current command sender (COMM_SET_CURRENT = 6)
void sendDualCurrent(float masterAmps, float slaveAmps) {
  // 1. Send to Master VESC (5 bytes payload)
  int32_t masterMilliAmps = (int32_t)(masterAmps * 1000.0f);
  uint8_t mPayload[5];
  mPayload[0] = 6; // COMM_SET_CURRENT
  mPayload[1] = (uint8_t)((masterMilliAmps >> 24) & 0xFF);
  mPayload[2] = (uint8_t)((masterMilliAmps >> 16) & 0xFF);
  mPayload[3] = (uint8_t)((masterMilliAmps >> 8) & 0xFF);
  mPayload[4] = (uint8_t)(masterMilliAmps & 0xFF);
  uint16_t mCrc = crc16_vesc(mPayload, 5);
  uint8_t mFrame[10] = {0x02, 5, mPayload[0], mPayload[1], mPayload[2], mPayload[3], mPayload[4],
                        (uint8_t)(mCrc >> 8), (uint8_t)(mCrc & 0xFF), 0x03};
  VescSerial.write(mFrame, 10);

  // 2. Forward to Slave VESC over CAN (7 bytes payload)
  if (slaveCanId > 0) {
    int32_t slaveMilliAmps = (int32_t)(slaveAmps * 1000.0f);
    uint8_t sPayload[7];
    sPayload[0] = 34; // COMM_FORWARD_CAN
    sPayload[1] = slaveCanId;
    sPayload[2] = 6;  // COMM_SET_CURRENT
    sPayload[3] = (uint8_t)((slaveMilliAmps >> 24) & 0xFF);
    sPayload[4] = (uint8_t)((slaveMilliAmps >> 16) & 0xFF);
    sPayload[5] = (uint8_t)((slaveMilliAmps >> 8) & 0xFF);
    sPayload[6] = (uint8_t)(slaveMilliAmps & 0xFF);
    uint16_t sCrc = crc16_vesc(sPayload, 7);
    uint8_t sFrame[12] = {0x02, 7, sPayload[0], sPayload[1], sPayload[2], sPayload[3], sPayload[4], sPayload[5], sPayload[6],
                          (uint8_t)(sCrc >> 8), (uint8_t)(sCrc & 0xFF), 0x03};
    VescSerial.write(sFrame, 12);
  }
}

// Fast non-blocking Brake command sender (COMM_SET_CURRENT_BRAKE = 7)
void sendDualBrakeCurrent(float masterBrakeAmps, float slaveBrakeAmps) {
  int32_t masterMilliAmps = (int32_t)(masterBrakeAmps * 1000.0f);
  uint8_t mPayload[5];
  mPayload[0] = 7; // COMM_SET_CURRENT_BRAKE
  mPayload[1] = (uint8_t)((masterMilliAmps >> 24) & 0xFF);
  mPayload[2] = (uint8_t)((masterMilliAmps >> 16) & 0xFF);
  mPayload[3] = (uint8_t)((masterMilliAmps >> 8) & 0xFF);
  mPayload[4] = (uint8_t)(masterMilliAmps & 0xFF);
  uint16_t mCrc = crc16_vesc(mPayload, 5);
  uint8_t mFrame[10] = {0x02, 5, mPayload[0], mPayload[1], mPayload[2], mPayload[3], mPayload[4],
                        (uint8_t)(mCrc >> 8), (uint8_t)(mCrc & 0xFF), 0x03};
  VescSerial.write(mFrame, 10);

  if (slaveCanId > 0) {
    int32_t slaveMilliAmps = (int32_t)(slaveBrakeAmps * 1000.0f);
    uint8_t sPayload[7];
    sPayload[0] = 34; // COMM_FORWARD_CAN
    sPayload[1] = slaveCanId;
    sPayload[2] = 7;  // COMM_SET_CURRENT_BRAKE
    sPayload[3] = (uint8_t)((slaveMilliAmps >> 24) & 0xFF);
    sPayload[4] = (uint8_t)((slaveMilliAmps >> 16) & 0xFF);
    sPayload[5] = (uint8_t)((slaveMilliAmps >> 8) & 0xFF);
    sPayload[6] = (uint8_t)(slaveMilliAmps & 0xFF);
    uint16_t sCrc = crc16_vesc(sPayload, 7);
    uint8_t sFrame[12] = {0x02, 7, sPayload[0], sPayload[1], sPayload[2], sPayload[3], sPayload[4], sPayload[5], sPayload[6],
                          (uint8_t)(sCrc >> 8), (uint8_t)(sCrc & 0xFF), 0x03};
    VescSerial.write(sFrame, 12);
  }
}

// Non-blocking telemetry request (fires in < 20 microseconds)
void requestVescTelemetryAsync() {
  uint8_t payload = 4; // COMM_GET_VALUES
  uint16_t crc = crc16_vesc(&payload, 1);
  uint8_t frame[6] = {0x02, 1, 4, (uint8_t)(crc >> 8), (uint8_t)(crc & 0xFF), 0x03};
  VescSerial.write(frame, 6);
}

// Process incoming telemetry bytes from VESC without blocking
void processVescIncoming() {
  while (VescSerial.available()) {
    uint8_t b = VescSerial.read();
    unsigned long now = millis();

    if (vescRxIdx > 0 && (now - lastVescByteTime) > 20) {
      vescRxIdx = 0;
    }
    lastVescByteTime = now;

    if (vescRxIdx == 0) {
      if (b == 0x02) vescRxBuf[vescRxIdx++] = b;
    } else if (vescRxIdx == 1) {
      vescRxBuf[vescRxIdx++] = b; // Payload length
    } else {
      vescRxBuf[vescRxIdx++] = b;
      int payloadLen = vescRxBuf[1];
      int totalFrameLen = 2 + payloadLen + 3; // header(2) + payload + crc(2) + end(1)

      if (vescRxIdx >= totalFrameLen && totalFrameLen <= 256) {
        if (vescRxBuf[totalFrameLen - 1] == 0x03) {
          uint16_t expectedCrc = crc16_vesc(&vescRxBuf[2], payloadLen);
          uint16_t receivedCrc = ((uint16_t)vescRxBuf[2 + payloadLen] << 8) | vescRxBuf[2 + payloadLen + 1];

          if (expectedCrc == receivedCrc && vescRxBuf[2] == 4 && payloadLen >= 27) {
            if (!vescConfigured) {
              vescConfigured = true;
              updateActiveProfile();
            }

            // Unpack ERPM (bytes 23-26 in COMM_GET_VALUES payload)
            // Payload starts at vescRxBuf[2], so ERPM is at index 2 + 23 = 25
            int32_t erpm = ((int32_t)vescRxBuf[25] << 24) |
                           ((int32_t)vescRxBuf[26] << 16) |
                           ((int32_t)vescRxBuf[27] << 8)  |
                           ((int32_t)vescRxBuf[28]);
            vescRpm57 = (float)erpm;
            vehicleSpeedMps = fabs(vescRpm57) * ERPM_TO_MPS;
            vehicleSpeedKmH = fabs(vescRpm57) * ERPM_TO_KMH;
            kickBlocked = (KICK_RPM_ERPM > 0.0f) && (fabs(vescRpm57) < KICK_RPM_ERPM);

            // Unpack Input Battery Voltage (bytes 27-28 in COMM_GET_VALUES payload)
            if (payloadLen >= 29) {
              int16_t vInRaw = (int16_t)(((uint16_t)vescRxBuf[29] << 8) | (uint16_t)vescRxBuf[30]);
              batteryVoltage = (float)vInRaw / 10.0f;
            }

            // Unpack Input Battery Current (bytes 9-12 in COMM_GET_VALUES payload)
            if (payloadLen >= 13) {
              int32_t currInRaw = ((int32_t)vescRxBuf[11] << 24) |
                                  ((int32_t)vescRxBuf[12] << 16) |
                                  ((int32_t)vescRxBuf[13] << 8)  |
                                  ((int32_t)vescRxBuf[14]);
              batteryCurrent = (float)currInRaw / 100.0f;
            }
          }
        }
        vescRxIdx = 0;
      }
    }
  }
}

void updateActiveProfile() {
  if (currentGear == 1) {
    activeProfile = PROFILE_1;
    profileSSwitch = false;
  } else if (currentGear == 2) {
    activeProfile = profileSSwitch ? PROFILE_S2 : PROFILE_2;
  } else if (currentGear == 3) {
    activeProfile = profileSSwitch ? PROFILE_S3 : PROFILE_3;
  } else if (currentGear == 4) {
    profileSSwitch = true;
    activeProfile = PROFILE_S3;
  }
  // Apply native VESC speed limit profile (COMM_SET_MCCONF_TEMP = 48) to both VESCs
  sendVescTempProfile(activeProfile.maxErpm, 1.0f);
}

void setGear(int newGear) {
  currentGear = constrain(newGear, 1, 4);

  // Shift gear history
  for (int i = 0; i < 6; i++) {
    gearHistory[i] = gearHistory[i + 1];
  }
  gearHistory[6] = (uint8_t)currentGear;

  if (currentGear == 1) {
    profileSSwitch = false;
  } else if (currentGear == 4) {
    profileSSwitch = true;
  }

  updateActiveProfile();

  char gbuf[120];
  snprintf(gbuf, sizeof(gbuf), "GEAR shifted -> Gear %d: %s (Limit: %.0f km/h, %.0f A)",
           currentGear, activeProfile.name, activeProfile.speedLimitKmH, activeProfile.maxCurrentAmps);
  blePushLine(String(gbuf));

  // Push immediate telemetry update line so connected App updates immediately with 0 latency
  if (bleClientConnected) {
    char buf[210];
    snprintf(buf, sizeof(buf), "SPD=%.1f G=%d S=%d V=%.1f RAW=%d BRK=%d BEN=%d AMP=%.1f KICK=%s KERPM=%.0f LOCK=%d GRSSI=%d GEN=%d",
             vehicleSpeedKmH, currentGear, profileSSwitch ? 1 : 0,
             batteryVoltage, currentRawThrottle, debouncedBrakeState ? 1 : 0, brakeEnabled ? 1 : 0,
             targetAmps, kickBlocked ? "HELD" : "ROLL", KICK_RPM_ERPM,
             isScooterLocked ? 1 : 0,
             (garminLockEnabled && (millis() - lastGarminSeenMs < 10000)) ? lastGarminRssi : -120,
             garminLockEnabled ? 1 : 0);
    blePushLine(String(buf));
  }
}

void handleDisplayRxPacket(const uint8_t *packet) {
  displayPacketsCount++;
  int rawGear = packet[4];
  bool light = (packet[9] & 0x08) != 0;

  // Handle Gear change with Display Priority
  if (rawGear != lastRawGear) {
    int mappedGear = 1;
    if (rawGear == 5 || rawGear == 1) mappedGear = 1;
    else if (rawGear == 10 || rawGear == 2) mappedGear = 2;
    else if (rawGear == 15 || rawGear == 3) mappedGear = 3;
    else if (rawGear == 20 || rawGear == 4) mappedGear = 4;
    else mappedGear = rawGear;

    setGear(mappedGear);
    lastRawGear = rawGear;
  }

  // Handle Light button change
  if (light != lastLightState) {
    displayLightState = light;

    // Secret combo unlock check: [1, 2, 3, 2, 3, 2, 3] + Light ON
    if (light && (memcmp(gearHistory, COMBO_KEY, 7) == 0)) {
      profileSSwitch = true;
      lastRawGear = 228; // Force re-evaluating active gear profile
      updateActiveProfile();
      blePushLine("SECRET UNLOCK: S-Mode (Sport 40+ km/h) activated!");
      // Push immediate update so App shows Sport mode
      if (bleClientConnected) {
        char buf[210];
        snprintf(buf, sizeof(buf), "SPD=%.1f G=%d S=1 V=%.1f RAW=%d BRK=%d BEN=%d AMP=%.1f KICK=%s KERPM=%.0f LOCK=%d GRSSI=%d GEN=%d",
                 vehicleSpeedKmH, currentGear,
                 batteryVoltage, currentRawThrottle, debouncedBrakeState ? 1 : 0, brakeEnabled ? 1 : 0,
                 targetAmps, kickBlocked ? "HELD" : "ROLL", KICK_RPM_ERPM,
                 isScooterLocked ? 1 : 0,
                 (garminLockEnabled && (millis() - lastGarminSeenMs < 10000)) ? lastGarminRssi : -120,
                 garminLockEnabled ? 1 : 0);
        blePushLine(String(buf));
      }
    }

    lastLightState = light;
  }
}

uint16_t calculateDisplaySpeed(float speedMps) {
  if (speedMps <= 0.05f) return 0;
  float wheelCircumferenceMeters = P06_WHEEL_DIAMETER_INCH * 3.14159265f * 0.0254f;
  float rotationsPerSec = speedMps / wheelCircumferenceMeters;
  float displaySpeed = P07_MAGNET_POLES * rotationsPerSec * SPEED_CALC_FACTOR;
  if (displaySpeed < 0) displaySpeed = 0;
  if (displaySpeed > 65535.0f) displaySpeed = 65535.0f;
  return (uint16_t)displaySpeed;
}

void sendDisplayTxPacket(float speedMps) {
  uint8_t txBuf[15] = {0};

  // Byte 0: Header
  txBuf[0] = 0x36;

  // Byte 1: Rolling counter
  displayTxCounter++;
  txBuf[1] = displayTxCounter;

  // Byte 4: S-Mode flag (32 if unlocked)
  if (profileSSwitch) {
    txBuf[4] = 32;
  }

  // Bytes 7 & 8: Speed in Big Endian
  uint16_t dispSpeed = calculateDisplaySpeed(speedMps);
  txBuf[7] = (dispSpeed >> 8) & 0xFF;
  txBuf[8] = dispSpeed & 0xFF;

  // Encryption
  uint8_t encKey = ENCODING_KEY_ARRAY[displayTxCounter % 128];
  for (size_t i = 0; i < sizeof(ENCODED_BYTES); i++) {
    uint8_t idx = ENCODED_BYTES[i];
    txBuf[idx] = (uint8_t)((txBuf[idx] + encKey) % 256);
  }

  // Byte 14: Checksum
  txBuf[14] = xorCrc(txBuf, 14);

  DisplaySerial.write(txBuf, 15);
}

void processDisplayUart(float speedMps) {
  // Read incoming from Display at 1200 Baud
  while (DisplaySerial.available()) {
    uint8_t b = DisplaySerial.read();
    displayRxBytes++;
    unsigned long now = millis();

    if (displayRxIndex > 0 && (now - lastDisplayRxByteTime) > 250) {
      displayRxIndex = 0;
    }
    lastDisplayRxByteTime = now;

    if (displayRxIndex == 0) {
      if (b == 0x01) {
        displayRxBuffer[displayRxIndex++] = b;
      }
    } else if (displayRxIndex == 1) {
      if (b == 0x03) {
        displayRxBuffer[displayRxIndex++] = b;
      } else if (b == 0x01) {
        displayRxBuffer[0] = 0x01;
        displayRxIndex = 1;
      } else {
        displayRxIndex = 0;
      }
    } else {
      displayRxBuffer[displayRxIndex++] = b;
      if (displayRxIndex >= 15) {
        uint8_t expectedCrc = xorCrc(displayRxBuffer, 14);
        if (displayRxBuffer[14] == expectedCrc) {
          displayPacketsCount++;
          handleDisplayRxPacket(displayRxBuffer);
        } else {
          displayCrcFailures++;
        }
        displayRxIndex = 0;
      }
    }
  }

  // Send packet to display every 150ms
  unsigned long now = millis();
  if (now - lastDisplayTxTime >= 150) {
    lastDisplayTxTime = now;
    sendDisplayTxPacket(speedMps);
  }
}

// =========================================================================
// Proximity Scanner & Anti-Theft Callbacks (iPhone Proximity Key)
// =========================================================================
static bool matchDeviceName(const String &advertisedName, const String &target) {
  if (advertisedName.length() == 0 || target.length() == 0) return false;
  String a = advertisedName;
  String t = target;
  a.toLowerCase();
  t.toLowerCase();
  a.replace("’", "'");
  t.replace("’", "'");
  return a.indexOf(t) >= 0;
}

class GarminScanCallbacks : public BLEAdvertisedDeviceCallbacks {
  void onResult(BLEAdvertisedDevice advertisedDevice) {
    bool isMatch = false;
    String devName = "";
    if (advertisedDevice.haveName()) {
      devName = String(advertisedDevice.getName().c_str());
    }
    String devMac = String(advertisedDevice.getAddress().toString().c_str());
    devMac.toUpperCase();

    // 1. Target MAC configured
    if (garminTargetMac.length() > 0 && garminTargetMac != "AUTO") {
      if (devMac.equalsIgnoreCase(garminTargetMac)) {
        isMatch = true;
      }
    }
    // 2. Target Name configured (e.g. "Kirill", "iPhone")
    else if (garminTargetName.length() > 0 && garminTargetName != "AUTO") {
      if (matchDeviceName(devName, garminTargetName)) {
        isMatch = true;
      }
    }
    // 3. AUTO Mode: Match "Kirill" or "iPhone" in advertised device name
    else {
      if (matchDeviceName(devName, "Kirill") || matchDeviceName(devName, "iPhone")) {
        isMatch = true;
      }
    }

    if (isMatch) {
      int rssi = advertisedDevice.getRSSI();
      lastGarminSeenMs = millis();
      lastGarminRssi = rssi;
      lastGarminDetectedMac = devMac;
      if (devName.length() > 0) {
        lastGarminDetectedName = devName;
      }

      // If Auto-Learn mode is active, lock onto this phone / device
      if (garminLearnActive) {
        garminTargetMac = devMac;
        if (devName.length() > 0) {
          garminTargetName = devName;
        }
        prefs.putString("garmin_mac", garminTargetMac);
        prefs.putString("garmin_name", garminTargetName);
        garminLearnActive = false;
        blePushLine("KEY:LEARNED MAC=" + garminTargetMac + " NAME=" + garminTargetName);
      }
    }
  }
};

void garminScanTaskLoop(void *param) {
  BLEScan *pBLEScan = BLEDevice::getScan();
  pBLEScan->setAdvertisedDeviceCallbacks(new GarminScanCallbacks(), true);
  pBLEScan->setActiveScan(true);
  pBLEScan->setInterval(100);
  pBLEScan->setWindow(80);

  while (true) {
    if (garminLockEnabled || garminLearnActive) {
      pBLEScan->start(2, false);
      pBLEScan->clearResults();
      vTaskDelay(pdMS_TO_TICKS(100)); // Brief 100ms yield between scans

      if (garminLearnActive && (millis() - garminLearnStartTime > 10000)) {
        garminLearnActive = false;
        blePushLine("KEY:LEARN_TIMEOUT");
      }
    } else {
      vTaskDelay(pdMS_TO_TICKS(1000));
    }
  }
}

void updateGarminLockState() {
  // 1. Explicit Manual Lock takes highest priority
  if (manualLocked) {
    isScooterLocked = true;
    return;
  }

  // 2. If Proximity Auto-Lock is disabled, scooter is unlocked
  if (!garminLockEnabled) {
    isScooterLocked = false;
    garminNear = true;
    return;
  }

  // 3. Proximity Auto-Lock is ENABLED:
  // If iPhone is actively connected over Web Bluetooth to dashboard, phone is present
  if (bleClientConnected) {
    lastGarminSeenMs = millis();
    garminNear = true;
    isScooterLocked = false;
    return;
  }

  // 4. Proximity Auto-Lock evaluation based on real scan data
  unsigned long now = millis();
  unsigned long timeoutMs = (unsigned long)garminTimeoutSeconds * 1000UL;
  bool recentlySeen = (lastGarminSeenMs > 0) && ((now - lastGarminSeenMs) <= timeoutMs);

  if (recentlySeen) {
    if (lastGarminRssi >= garminRssiThreshold) {
      garminNear = true;
    } else if (lastGarminRssi < (garminRssiThreshold - 5)) {
      garminNear = false;
    }
  } else {
    garminNear = false;
  }

  isScooterLocked = !garminNear;
}

// =========================================================================
// BLE Callbacks & Commands
// =========================================================================
void blePushLine(const String &line) {
  if (bleClientConnected && bleConsole) {
    bleConsole->setValue((uint8_t *)line.c_str(), line.length());
    bleConsole->notify();
  }
}

void bleHandleCommand(const String &cmd) {
  if (cmd == "S") {
    char buf[250];
    snprintf(buf, sizeof(buf), "SPD=%.1f G=%d S=%d V=%.1f RAW=%d BRK=%d BEN=%d AMP=%.1f PROF=%s LIM=%.0fkm/h PIN19=%d BPIN=%d BPOL=%s BC=%.1fA CAN=%d KERPM=%.0f LOCK=%d GEN=%d GRSSI=%d",
             vehicleSpeedKmH, currentGear, profileSSwitch ? 1 : 0,
             batteryVoltage, currentRawThrottle, debouncedBrakeState ? 1 : 0, brakeEnabled ? 1 : 0,
             targetAmps, activeProfile.name, activeProfile.speedLimitKmH,
             digitalRead(19), brakePin, brakeActiveLow ? "LOW" : "HIGH", userBrakeAmps, slaveCanId,
             KICK_RPM_ERPM, isScooterLocked ? 1 : 0, garminLockEnabled ? 1 : 0, (millis() - lastGarminSeenMs < 10000) ? lastGarminRssi : -120);
    blePushLine(String(buf));
  } else if (cmd.startsWith("G ") || cmd.startsWith("P ")) {
    int g = cmd.substring(2).toInt();
    if (g >= 1 && g <= 4) {
      setGear(g);
    } else {
      blePushLine("ERR profile 1..4 (1=10km/h, 2=15km/h, 3=25km/h, 4=40km/h)");
    }
  } else if (cmd.startsWith("BEN ")) {
    int en = cmd.substring(4).toInt();
    brakeEnabled = (en != 0);
    prefs.putBool("brake_en", brakeEnabled);
    if (!brakeEnabled) {
      debouncedBrakeState = false;
      rawBrakePinState = false;
      brakeHistory = 0x00;
      sendBrakeFlagToSlave(false);
      lastSentBrakeState = false;
    }
    blePushLine("BRAKE SENSOR " + String(brakeEnabled ? "ENABLED" : "DISABLED"));
  } else if (cmd.startsWith("BP ")) {
    int p = cmd.substring(3).toInt();
    if (p == 0 || p == 19 || p == 21 || p == 18 || p == 5 || p == 4) {
      brakePin = p;
      prefs.putInt("brake_pin", brakePin);
      if (brakePin > 0) {
        pinMode(brakePin, brakeActiveLow ? INPUT_PULLUP : INPUT_PULLDOWN);
        blePushLine("BRAKE PIN set to GPIO " + String(brakePin));
      } else {
        pinMode(19, brakeActiveLow ? INPUT_PULLUP : INPUT_PULLDOWN);
        pinMode(21, brakeActiveLow ? INPUT_PULLUP : INPUT_PULLDOWN);
        blePushLine("BRAKE PIN set to DUAL (both GPIO 19 and 21)");
      }
    } else {
      blePushLine("ERR valid pins: 19, 21, 18, 5, 4, 0 (dual)");
    }
  } else if (cmd.startsWith("BPOL ")) {
    int pol = cmd.substring(5).toInt();
    brakeActiveLow = (pol != 0);
    prefs.putBool("brake_low", brakeActiveLow);
    if (brakePin > 0) {
      pinMode(brakePin, brakeActiveLow ? INPUT_PULLUP : INPUT_PULLDOWN);
    } else {
      pinMode(19, brakeActiveLow ? INPUT_PULLUP : INPUT_PULLDOWN);
      pinMode(21, brakeActiveLow ? INPUT_PULLUP : INPUT_PULLDOWN);
    }
    blePushLine("BRAKE POLARITY set to " + String(brakeActiveLow ? "Active LOW (GND)" : "Active HIGH (3.3V)"));
  } else if (cmd.startsWith("BC ")) {
    float bc = cmd.substring(3).toFloat();
    if (bc >= 0.0f && bc <= 60.0f) {
      userBrakeAmps = bc;
      prefs.putFloat("brake_amps", userBrakeAmps);
      blePushLine("BRAKE CURRENT set to " + String(userBrakeAmps, 1) + " A");
    } else {
      blePushLine("ERR brake amps range 0..60");
    }
  } else if (cmd.startsWith("CAN ")) {
    int cid = cmd.substring(4).toInt();
    if (cid >= 0 && cid <= 255) {
      slaveCanId = (uint8_t)cid;
      prefs.putUChar("can_slave", slaveCanId);
      blePushLine("SLAVE CAN ID set to " + String(slaveCanId));
    } else {
      blePushLine("ERR CAN ID range 0..255 (0=disabled)");
    }
  } else if (cmd.startsWith("GEN ")) {
    int en = cmd.substring(4).toInt();
    garminLockEnabled = (en != 0);
    prefs.putBool("garmin_en", garminLockEnabled);
    manualOverrideUnlocked = false;
    if (!garminLockEnabled && !manualLocked) {
      isScooterLocked = false;
    }
    blePushLine("GARMIN LOCK " + String(garminLockEnabled ? "ENABLED" : "DISABLED"));
  } else if (cmd.startsWith("GMAC ")) {
    String mac = cmd.substring(5);
    mac.trim();
    mac.toUpperCase();
    if (mac == "0" || mac == "CLEAR" || mac == "NONE" || mac == "AUTO") {
      garminTargetMac = "";
    } else {
      garminTargetMac = mac;
    }
    prefs.putString("garmin_mac", garminTargetMac);
    blePushLine("GARMIN MAC set to " + (garminTargetMac.length() > 0 ? garminTargetMac : "AUTO"));
  } else if (cmd.startsWith("GNAME ")) {
    String gname = cmd.substring(6);
    gname.trim();
    if (gname == "0" || gname == "CLEAR" || gname == "NONE" || gname == "AUTO") {
      garminTargetName = "";
    } else {
      garminTargetName = gname;
    }
    prefs.putString("garmin_name", garminTargetName);
    blePushLine("GARMIN NAME set to " + (garminTargetName.length() > 0 ? garminTargetName : "AUTO"));
  } else if (cmd.startsWith("GRSSI ")) {
    int r = cmd.substring(6).toInt();
    if (r >= -110 && r <= -30) {
      garminRssiThreshold = r;
      prefs.putInt("garmin_rssi", garminRssiThreshold);
      blePushLine("GARMIN RSSI set to " + String(garminRssiThreshold) + " dBm");
    } else {
      blePushLine("ERR rssi range -110..-30");
    }
  } else if (cmd.startsWith("GTO ")) {
    int to = cmd.substring(4).toInt();
    if (to >= 2 && to <= 60) {
      garminTimeoutSeconds = to;
      prefs.putInt("garmin_to", garminTimeoutSeconds);
      blePushLine("GARMIN TIMEOUT set to " + String(garminTimeoutSeconds) + " s");
    } else {
      blePushLine("ERR timeout range 2..60");
    }
  } else if (cmd == "GLEARN") {
    garminLearnActive = true;
    garminLearnStartTime = millis();
    blePushLine("GARMIN AUTO-LEARN ACTIVE (Bring watch close for 10s...)");
  } else if (cmd == "GLOCK" || cmd == "LOCK") {
    manualLocked = true;
    manualOverrideUnlocked = false;
    isScooterLocked = true;
    blePushLine("SCOOTER MANUALLY LOCKED");
  } else if (cmd == "GUNLOCK" || cmd == "UNLOCK") {
    manualLocked = false;
    manualOverrideUnlocked = false;
    isScooterLocked = false;
    lastGarminSeenMs = millis();
    blePushLine("SCOOTER MANUALLY UNLOCKED");
  } else if (cmd == "GARMIN") {
    char gbuf[220];
    snprintf(gbuf, sizeof(gbuf), "GARMIN: EN=%d LOCK=%d NEAR=%d RSSI=%d THOLD=%d TO=%ds MAC=%s NAME=%s LAST_MAC=%s LAST_NAME=%s",
             garminLockEnabled ? 1 : 0, isScooterLocked ? 1 : 0, garminNear ? 1 : 0,
             (millis() - lastGarminSeenMs < 10000) ? lastGarminRssi : -120,
             garminRssiThreshold, garminTimeoutSeconds,
             garminTargetMac.length() > 0 ? garminTargetMac.c_str() : "AUTO",
             garminTargetName.length() > 0 ? garminTargetName.c_str() : "AUTO",
             lastGarminDetectedMac.c_str(), lastGarminDetectedName.c_str());
    blePushLine(String(gbuf));
  } else if (cmd == "T") {
    testModeActive = false;
    blePushLine("TEST off");
  } else if (cmd.startsWith("T ")) {
    float v = 1.0;
    int b = 0;
    sscanf(cmd.c_str() + 2, "%f %d", &v, &b);
    testModeActive = true;
    testVoltage = constrain(v, 0.5, 3.3);
    testBrakeState = (b != 0);
    blePushLine("TEST on V=" + String(testVoltage, 2) + " B=" + String(testBrakeState ? 1 : 0));
  } else if (cmd.startsWith("K ")) {
    float k = cmd.substring(2).toFloat();
    if (k >= 0 && k < 5000) {
      KICK_RPM_ERPM = k;
      prefs.putFloat("kick_erpm", KICK_RPM_ERPM);
      if (KICK_RPM_ERPM == 0.0f) {
        kickBlocked = false;
      }
      blePushLine("KICK " + String(KICK_RPM_ERPM, 0));
    } else {
      blePushLine("ERR kick range 0..5000");
    }
  } else if (cmd == "B") {
    sendBrakeFlagToSlave(debouncedBrakeState);
    lastSentBrakeState = debouncedBrakeState;
    blePushLine(String("BRAKE pushed ") + (debouncedBrakeState ? "1" : "0"));
  } else if (cmd == "SWAP") {
    static bool swapped = false;
    swapped = !swapped;
    DisplaySerial.end();
    if (swapped) {
      DisplaySerial.begin(DISPLAY_BAUD, SERIAL_8N1, 23, 22);
      blePushLine("DISPLAY UART swapped: RX=GPIO 23, TX=GPIO 22");
    } else {
      DisplaySerial.begin(DISPLAY_BAUD, SERIAL_8N1, 22, 23);
      blePushLine("DISPLAY UART default: RX=GPIO 22, TX=GPIO 23");
    }
  } else if (cmd == "R") {
    blePushLine("rebooting");
    delay(300);
    ESP.restart();
  } else if (cmd == "?") {
    blePushLine("S status | P [1-4] prof | G [1-4] gear | GEN [0/1] garmin_lock | GMAC [mac] | GLEARN | UNLOCK | BEN [0/1] brk_en | BP [pin] | BC [amps] | CAN [id] | K [kick] | R reboot");
  } else {
    blePushLine("ERR unknown, send ?");
  }
}

class ConsoleCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *c) {
    String v = String((const char *)c->getData(), c->getLength());
    v.trim();
    if (v.length() == 0) return;
    if (v.startsWith("OTA:BEGIN:")) {
      bleOtaExpected = v.substring(10).toInt();
      bleOtaReceived = 0;
      bleOtaActive = true;
      if (Update.begin(bleOtaExpected)) {
        blePushLine("OTA:READY " + String((unsigned long)bleOtaExpected));
      } else {
        blePushLine("OTA:ERROR begin-failed");
        bleOtaActive = false;
      }
      return;
    }
    if (v == "OTA:END") {
      if (bleOtaActive && Update.end(true)) {
        blePushLine("OTA:OK rebooting");
        delay(300);
        ESP.restart();
      } else {
        blePushLine("OTA:ERROR end-failed");
        Update.abort();
      }
      bleOtaActive = false;
      return;
    }
    bleHandleCommand(v);
  }
};

class OtaCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *c) {
    if (!bleOtaActive) return;
    size_t n = c->getLength();
    if (n == 0) return;
    if (Update.write((uint8_t *)c->getData(), n) != n) {
      blePushLine("OTA:ERROR write-failed");
      Update.abort();
      bleOtaActive = false;
      return;
    }
    bleOtaReceived += n;
  }
};

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *) {
    bleClientConnected = true;
    lastGarminSeenMs = millis();
  }
  void onDisconnect(BLEServer *) {
    bleClientConnected = false;
    bleOtaActive = false;
    lastGarminSeenMs = 0;
    lastGarminRssi = -120;
    garminNear = false;
    if (garminLockEnabled) {
      isScooterLocked = true;
    }
    bleServer->getAdvertising()->start();
  }
};

void bleInit() {
  BLEDevice::init(BLE_DEVICE_NAME);
  bleServer = BLEDevice::createServer();
  bleServer->setCallbacks(new ServerCallbacks());
  BLEService *svc = bleServer->createService(BLE_SVC_UUID);
  bleConsole = svc->createCharacteristic(
      BLE_CONSOLE_UUID, BLECharacteristic::PROPERTY_NOTIFY | BLECharacteristic::PROPERTY_WRITE);
  bleConsole->addDescriptor(new BLE2902());
  bleConsole->setCallbacks(new ConsoleCallbacks());
  bleOta = svc->createCharacteristic(BLE_OTA_UUID, BLECharacteristic::PROPERTY_WRITE);
  bleOta->setCallbacks(new OtaCallbacks());
  svc->start();
  BLEAdvertising *adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(BLE_SVC_UUID);
  adv->setScanResponse(true);
  adv->start();
}

// =========================================================================
// Setup & Loop
// =========================================================================
void setup() {
  // Display is on UART1 (DisplaySerial) at 1200 Baud (RX=GPIO 22, TX=GPIO 23)
  DisplaySerial.begin(DISPLAY_BAUD, SERIAL_8N1, PIN_DISPLAY_RX, PIN_DISPLAY_TX);

  pinMode(THROTTLE_PIN, INPUT);
  analogReadResolution(12);
  analogSetPinAttenuation(THROTTLE_PIN, ADC_11db);

  prefs.begin("scooter", false);
  KICK_RPM_ERPM = prefs.getFloat("kick_erpm", 0.0f); // Default 0 (Zero start)
  brakePin = prefs.getInt("brake_pin", 19);           // Default 19 (Single brake pin)
  brakeActiveLow = prefs.getBool("brake_low", true); // Default Active LOW
  brakeEnabled = prefs.getBool("brake_en", true);    // Default Enabled
  userBrakeAmps = prefs.getFloat("brake_amps", 25.0f);// Default 25A strong e-brake
  slaveCanId = prefs.getUChar("can_slave", 61);      // Default CAN ID 61

  garminLockEnabled = prefs.getBool("garmin_en", false);
  garminTargetMac = prefs.getString("garmin_mac", "");
  garminTargetName = prefs.getString("garmin_name", "Kirill");
  garminRssiThreshold = prefs.getInt("garmin_rssi", -85);
  garminTimeoutSeconds = prefs.getInt("garmin_to", 5);

  // Set internal pullup/pulldown on configured brake pin
  if (brakePin > 0) {
    pinMode(brakePin, brakeActiveLow ? INPUT_PULLUP : INPUT_PULLDOWN);
  } else if (brakePin == 0) {
    pinMode(19, brakeActiveLow ? INPUT_PULLUP : INPUT_PULLDOWN);
    pinMode(21, brakeActiveLow ? INPUT_PULLUP : INPUT_PULLDOWN);
  }

  bleInit();

  // Background Garmin BLE proximity scanner task on Core 0
  xTaskCreatePinnedToCore(garminScanTaskLoop, "garminScanTask", 4096, NULL, 1, NULL, 0);

  // UART2 connected to VESC Master at 115200 Baud (RX=16, TX=17)
  VescSerial.begin(115200, SERIAL_8N1, 16, 17);

  updateActiveProfile();
}

void loop() {
  unsigned long now = millis();

  // 1. Process Incoming VESC Telemetry Bytes (Non-blocking, < 20 microseconds)
  processVescIncoming();

  // 2. Poll VESC Telemetry asynchronously every 100ms
  if (now - lastVescPoll > 100) {
    lastVescPoll = now;
    requestVescTelemetryAsync();
  }

  // 3. Fast Brake Sensor Reading & Hardware Glitch Filter
  if (testModeActive) {
    debouncedBrakeState = testBrakeState && brakeEnabled;
    currentRawThrottle = (int)((testVoltage / 3.3f) * 4095.0f);
  } else {
    if (!brakeEnabled) {
      debouncedBrakeState = false;
      rawBrakePinState = false;
      brakeHistory = 0x00;
    } else {
      // Sample brake pin every 4ms into a rolling bit-history
      if (now - lastBrakeSampleTime >= 4) {
        lastBrakeSampleTime = now;
        bool rawReading = false;
        if (brakePin == 0) {
          // Dual-pin mode: Trigger if EITHER Pin 19 or Pin 21 is active
          bool p19 = (digitalRead(19) == (brakeActiveLow ? LOW : HIGH));
          bool p21 = (digitalRead(21) == (brakeActiveLow ? LOW : HIGH));
          rawReading = p19 || p21;
        } else if (brakePin > 0) {
          rawReading = (digitalRead(brakePin) == (brakeActiveLow ? LOW : HIGH));
        }

        rawBrakePinState = rawReading;
        brakeHistory = (brakeHistory << 1) | (rawReading ? 1 : 0);

        // Fast activation: 2 consecutive active samples (8ms)
        if ((brakeHistory & 0x03) == 0x03) {
          debouncedBrakeState = true;
        }
        // Instant guaranteed release: 3 consecutive released samples (12ms)
        else if ((brakeHistory & 0x07) == 0x00) {
          debouncedBrakeState = false;
        }
      }
    }

    // Fast 4-sample ADC read (takes ~80 microseconds total)
    int rawSum = 0;
    for (int i = 0; i < 4; i++) {
      rawSum += analogRead(THROTTLE_PIN);
    }
    currentRawThrottle = rawSum >> 2;
  }

  throttleVoltage = (currentRawThrottle / 4095.0f) * 3.3f;

  // Update Garmin Proximity & Anti-Theft Lock State
  updateGarminLockState();

  // 4. Push brake flag to Slave VESC immediately on change
  if (debouncedBrakeState != lastSentBrakeState) {
    sendBrakeFlagToSlave(debouncedBrakeState);
    lastSentBrakeState = debouncedBrakeState;
  }
  lastDebouncedBrakeState = debouncedBrakeState;

  // 5. Update Display UART (Non-blocking)
  processDisplayUart(vehicleSpeedMps);

  // 6. INSTANT ZERO-LATENCY Throttle Calculation
  float rawRatio = 0.0f;
  if (!isScooterLocked && currentRawThrottle > THROTTLE_MIN_RAW) {
    rawRatio = (currentRawThrottle - THROTTLE_MIN_RAW) /
               (float)(THROTTLE_MAX_RAW - THROTTLE_MIN_RAW);
    rawRatio = constrain(rawRatio, 0.0f, 1.0f);
  } else {
    rawRatio = 0.0f; // Instant cutoff when below deadband or when LOCKED!
  }

  // 7. Dispatch Motor Current at 50 Hz (every 20ms) with zero lag & pure freewheel
  if (now - lastMotorCmdTime >= 20) {
    lastMotorCmdTime = now;

    if (isScooterLocked) {
      // PROXIMITY ANTI-THEFT LOCK:
      // Throttle completely disabled!
      targetAmps = 0.0f;
      // Wheel Lock: If wheel moves or rolls, apply dual regenerative brake current to lock the wheels!
      if (vehicleSpeedKmH > 0.1f || fabs(vescRpm57) > 30.0f) {
        targetBrakeAmps = userBrakeAmps;
        currentMotorState = STATE_BRAKE;
        sendDualBrakeCurrent(targetBrakeAmps, targetBrakeAmps);
      } else {
        // Holding resistance
        targetBrakeAmps = 5.0f;
        currentMotorState = STATE_BRAKE;
        sendDualBrakeCurrent(targetBrakeAmps, targetBrakeAmps);
      }
    } else if (debouncedBrakeState && brakeEnabled) {
      // Full brake priority: Throttle is completely INACTIVE during braking
      targetAmps = 0.0f;
      targetBrakeAmps = userBrakeAmps;
      currentMotorState = STATE_BRAKE;
      idleFramesRemaining = 1; // Send 1 clean 0A current release frame on release
      sendDualBrakeCurrent(targetBrakeAmps, targetBrakeAmps);
    } else if (kickBlocked) {
      targetAmps = 0.0f;
      targetBrakeAmps = 0.0f;
      if (currentMotorState != STATE_IDLE || idleFramesRemaining > 0) {
        if (idleFramesRemaining > 0) idleFramesRemaining--;
        sendDualCurrent(0.0f, 0.0f);
        if (idleFramesRemaining == 0) {
          currentMotorState = STATE_IDLE;
        }
      }
    } else if (rawRatio > 0.01f) {
      // Accelerating
      currentMotorState = STATE_DRIVE;
      idleFramesRemaining = 1;
      targetBrakeAmps = 0.0f;

      float reqAmps = rawRatio * activeProfile.maxCurrentAmps;

      // Speed Limiter Governor:
      // Smoothly tapers motor current as vehicle speed approaches the active profile limit
      float speedLimit = activeProfile.speedLimitKmH;
      if (speedLimit < 40.0f) {
        if (vehicleSpeedKmH >= speedLimit) {
          reqAmps = 0.0f; // Cut driving current at or above speed limit
        } else if (vehicleSpeedKmH > (speedLimit - 2.0f)) {
          float scale = (speedLimit - vehicleSpeedKmH) / 2.0f;
          reqAmps = reqAmps * constrain(scale, 0.0f, 1.0f);
        }
      }

      targetAmps = reqAmps;
      sendDualCurrent(targetAmps, targetAmps);
    } else {
      // Coasting / Idle (0 throttle, 0 brake)
      targetAmps = 0.0f;
      targetBrakeAmps = 0.0f;
      if (currentMotorState != STATE_IDLE || idleFramesRemaining > 0) {
        if (idleFramesRemaining > 0) idleFramesRemaining--;
        // Cleanly cancel brake mode and zero out VESC current controller
        sendDualCurrent(0.0f, 0.0f);
        if (idleFramesRemaining == 0) {
          currentMotorState = STATE_IDLE;
        }
      }
      // When STATE_IDLE: DO NOT continuously spam 0A current packets.
      // This allows VESC to enter true MC_STATE_OFF (freewheel with zero drag)!
    }
  }

  // Periodic profile sync (every 3000ms) to ensure VESC RAM settings remain active
  if (vescConfigured && now - lastProfileSyncTime > 3000) {
    lastProfileSyncTime = now;
    sendVescTempProfile(activeProfile.maxErpm, 1.0f);
  }

  // 8. BLE notify live line at 5 Hz
  if (bleClientConnected && now - lastBleNotify > 200) {
    lastBleNotify = now;
    char buf[210];
    snprintf(buf, sizeof(buf), "SPD=%.1f G=%d S=%d V=%.1f RAW=%d BRK=%d BEN=%d AMP=%.1f KICK=%s KERPM=%.0f LOCK=%d GRSSI=%d GEN=%d",
             vehicleSpeedKmH, currentGear, profileSSwitch ? 1 : 0,
             batteryVoltage, currentRawThrottle, debouncedBrakeState ? 1 : 0, brakeEnabled ? 1 : 0,
             targetAmps, kickBlocked ? "HELD" : "ROLL", KICK_RPM_ERPM,
             isScooterLocked ? 1 : 0,
             (garminLockEnabled && (millis() - lastGarminSeenMs < 10000)) ? lastGarminRssi : -120,
             garminLockEnabled ? 1 : 0);
    blePushLine(String(buf));
  }

  // Yield to FreeRTOS scheduler (no delay)
  yield();
}
