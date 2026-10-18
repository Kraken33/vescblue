#include <Arduino.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <Preferences.h>
#include <Update.h>
#include <VescUart.h>
#include "LightsController.h"

// Lights Controller Instance
LightsController lights;

// =========================================================================
// Hardware & CAN Pin Configuration
// =========================================================================
#define THROTTLE_PIN 34

// Default Brake Pin (GPIO 19 soldered brake pin)
int brakePin = 19;
bool brakeActiveLow =
    true; // true = Active LOW (pulls to GND when brake engaged)
bool brakeEnabled =
    true; // Master software toggle to enable/disable e-brake sensor

// Display UART (UART1) on GPIO 22 (RX) and GPIO 23 (TX) at 1200 Baud
#define PIN_DISPLAY_RX 22
#define PIN_DISPLAY_TX 23
#define DISPLAY_BAUD 1200

HardwareSerial DisplaySerial(1);

// Target CAN ID for the secondary VESC (Second motor: ID 37)
uint8_t slaveCanId = 37;
bool dualMotorEnabled = true;
int lastDdmRaw = HIGH;
unsigned long lastDdmDebounceTime = 0;

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
// Locked Profiles (Unlock Disabled: 5, 15, 20 km/h)
const DriveProfile PROFILE_1_LOCKED = {5.0f, 1566.0f, 25.0f, "5 km/h (Eco Lock)"};
const DriveProfile PROFILE_2_LOCKED = {15.0f, 4700.0f, 40.0f, "15 km/h (City)"};
const DriveProfile PROFILE_3_LOCKED = {20.0f, 6266.0f, 65.0f, "20 km/h (Legal Drive)"};

// Unlocked Profiles (Unlock Enabled: 25 km/h, Unlimited)
const DriveProfile PROFILE_2_UNLOCKED = {25.0f, 7832.0f, 65.0f, "25 km/h (Drive Unlocked)"};
const DriveProfile PROFILE_3_UNLOCKED = {40.0f, 100000.0f, 120.0f, "Unlimited (Sport)"};

// Backward-compatible aliases
const DriveProfile PROFILE_1 = PROFILE_1_LOCKED;
const DriveProfile PROFILE_2 = PROFILE_2_LOCKED;
const DriveProfile PROFILE_3 = PROFILE_3_LOCKED;
const DriveProfile PROFILE_3_STANDARD = PROFILE_3_LOCKED;
const DriveProfile PROFILE_3_SHIFTED = PROFILE_2_UNLOCKED;
const DriveProfile PROFILE_S2 = PROFILE_2_UNLOCKED;
const DriveProfile PROFILE_S3 = PROFILE_3_UNLOCKED;

// Tuning & Limits (Full authority regen braking)
float userBrakeAmps = 25.0f; // Strong default brake current in Amps
float parkBrakeAmps = 35.0f; // Configurable park lock strength in Amps (5..120A)
float parkErpmThreshold = 100.0f; // Configurable ERPM threshold to engage park brake (20..1000 ERPM)

// Active Park Mode & Anti-Theft Motor Lock State
bool parkMotionDetected = false;
int32_t vescTachometer = 0;
float testErpm = 0.0f;

// e-ABS (Anti-lock Braking System - Dualtron style pulsation)
bool absEnabled = false;                    // Master toggle for e-ABS (persisted in prefs)
bool absStrobeEnabled = true;               // Flash rear brake light during ABS (persisted in prefs)
int absFrequencyHz = 10;                    // Pulsation frequency in Hz (2..20 Hz, default 10)
const float ABS_MIN_SPEED_KMH = 3.0f;       // Below 3 km/h, apply solid brake to avoid standstill buzz
unsigned long absCycleStartTime = 0;        // Timestamp when brake was engaged for zero-latency bite

// Throttle ADC calibration (Idle ~0.67V = 830 counts, Full ~3.0V = 3720 counts)
const int THROTTLE_MIN_RAW = 950;  // Threshold above idle (~0.77V)
const int THROTTLE_MAX_RAW = 3700; // Full throttle (~3.0V)

// Brake filter timing: 4ms sample period, 5 consecutive samples = 20ms debounce
const unsigned long BRAKE_SAMPLE_INTERVAL_MS = 4;
const int BRAKE_FILTER_SAMPLES = 5;

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

// Kick-start configuration:
// Gears 1, 2, 3: Kick start enabled by default (400 ERPM ~ 1.3 km/h)
// Gear 4 (Sport): Zero start enabled by default (0 ERPM)
const float DEFAULT_KICK_ERPM = 400.0f;
float kickErpmThreshold = DEFAULT_KICK_ERPM;
float KICK_RPM_ERPM = DEFAULT_KICK_ERPM;
float vescRpm57 = 0.0f;
float vehicleSpeedKmH = 0.0f;
float vehicleSpeedMps = 0.0f;
unsigned long lastVescPoll = 0;
bool kickBlocked = true;

// Non-blocking VESC telemetry buffer
uint8_t vescRxBuf[256];
int vescRxIdx = 0;
unsigned long lastVescByteTime = 0;

// =========================================================================
// Display Protocol State & Encryption Table (1200 Baud)
// =========================================================================
static const uint8_t ENCODING_KEY_ARRAY[128] = {
    0x5e, 0x23, 0x5c, 0x21, 0x2a, 0x2f, 0x28, 0x2d, 0x26, 0x2b, 0x24, 0x29,
    0x52, 0x57, 0x50, 0x55, 0x4e, 0x53, 0x4c, 0x51, 0x5a, 0x5f, 0x58, 0x5d,
    0x56, 0x5b, 0x54, 0x59, 0x02, 0x07, 0x00, 0x05, 0x3e, 0x03, 0x3c, 0x01,
    0x0a, 0x0f, 0x08, 0x0d, 0x06, 0x0b, 0x04, 0x09, 0x32, 0x37, 0x30, 0x35,
    0x2e, 0x33, 0x2c, 0x31, 0x3a, 0x3f, 0x38, 0x3d, 0x36, 0x3b, 0x34, 0x39,
    0x62, 0x67, 0x60, 0x65, 0x1e, 0x63, 0x1c, 0x61, 0x6a, 0x6f, 0x68, 0x6d,
    0x66, 0x6b, 0x64, 0x69, 0x12, 0x17, 0x10, 0x15, 0x0e, 0x13, 0x0c, 0x11,
    0x1a, 0x1f, 0x18, 0x1d, 0x16, 0x1b, 0x14, 0x19, 0x42, 0x47, 0x40, 0x45,
    0x7e, 0x43, 0x7c, 0x41, 0x4a, 0x4f, 0x48, 0x4d, 0x46, 0x4b, 0x44, 0x49,
    0x72, 0x77, 0x70, 0x75, 0x6e, 0x73, 0x6c, 0x71, 0x7a, 0x7f, 0x78, 0x7d,
    0x76, 0x7b, 0x74, 0x79, 0x22, 0x27, 0x20, 0x25};

static const uint8_t ENCODED_BYTES[10] = {3, 4, 5, 7, 8, 9, 10, 11, 12, 13};
static const uint8_t COMBO_KEY[7] = {1, 2, 3, 2, 3, 2, 3};

uint8_t displayRxBuffer[15];
int displayRxIndex = 0;
unsigned long lastDisplayRxByteTime = 0;
uint32_t displayPacketsCount = 0;
uint32_t displayRxBytes = 0;
uint32_t displayCrcFailures = 0;

uint8_t displayTxCounter = 0;
unsigned long lastDisplayTxTime = 0;

int currentGear = 1;
int lastNonParkGear = 1;
int lastRawGear = -1;
uint8_t displayTargetGear = 0;
uint8_t displayGearSyncRemaining = 0;
bool displayLightState = false;
bool lastLightState = false;
bool profileSSwitch = false;
bool secretComboUnlocked = false;
bool unlockEnabled = false;
bool gearShiftEnabled = false; // Alias for backward compatibility
uint8_t gearHistory[7] = {1, 1, 1, 1, 1, 1, 1};

// Cruise Control State
bool cruiseControlEnabled = false;
bool cruiseControlActive = false;
unsigned long cruiseTopSpeedStartTime = 0;
const unsigned long CRUISE_HOLD_DURATION_MS = 5000;
const float CRUISE_SPEED_TOLERANCE_KMH = 2.0f;

DriveProfile activeProfile = PROFILE_1;

// =========================================================================
// Throttle & Brake State
// =========================================================================
bool testModeActive = false;
float testVoltage = 1.0f;
bool testBrakeState = false;

float currentVoltageReading = 0.0f;
int currentRawThrottle = 0;

bool rawBrakePinState = false;
bool debouncedBrakeState = false;
bool lastDebouncedBrakeState = false;
bool lastSentBrakeState = false;
unsigned long lastBrakeSampleTime = 0;
int brakeFilterCount = 0;
uint8_t brakeReleaseFrames = 0;

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

  buffer_append_float32_auto(payload, 1.0f, &ind); // l_current_min_scale
  buffer_append_float32_auto(payload, currentScale,
                             &ind);                      // l_current_max_scale
  buffer_append_float32_auto(payload, -maxErpm, &ind);   // l_min_erpm
  buffer_append_float32_auto(payload, maxErpm, &ind);    // l_max_erpm
  buffer_append_float32_auto(payload, 0.005f, &ind);     // l_min_duty
  buffer_append_float32_auto(payload, 0.95f, &ind);      // l_max_duty
  buffer_append_float32_auto(payload, -150000.0f, &ind); // l_watt_min
  buffer_append_float32_auto(payload, 150000.0f, &ind);  // l_watt_max

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
  if (slaveCanId == 0)
    return;
  uint8_t payload[5];
  payload[0] = 34; // COMM_FORWARD_CAN
  payload[1] = slaveCanId;
  payload[2] = 36;   // COMM_CUSTOM_APP_DATA
  payload[3] = 0x42; // tag: brake state
  payload[4] = isBraking ? 1 : 0;
  uint16_t crc = crc16_vesc(payload, 5);
  uint8_t frame[10] = {0x02,
                       5,
                       payload[0],
                       payload[1],
                       payload[2],
                       payload[3],
                       payload[4],
                       (uint8_t)(crc >> 8),
                       (uint8_t)(crc & 0xFF),
                       0x03};
  VescSerial.write(frame, sizeof(frame));
}

// Fast non-blocking Current command sender
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
  uint8_t mFrame[10] = {0x02,
                        5,
                        mPayload[0],
                        mPayload[1],
                        mPayload[2],
                        mPayload[3],
                        mPayload[4],
                        (uint8_t)(mCrc >> 8),
                        (uint8_t)(mCrc & 0xFF),
                        0x03};
  VescSerial.write(mFrame, 10);

  // 2. Forward to Slave VESC over CAN (7 bytes payload)
  if (slaveCanId > 0) {
    int32_t slaveMilliAmps = (int32_t)(slaveAmps * 1000.0f);
    uint8_t sPayload[7];
    sPayload[0] = 34; // COMM_FORWARD_CAN
    sPayload[1] = slaveCanId;
    sPayload[2] = 6; // COMM_SET_CURRENT
    sPayload[3] = (uint8_t)((slaveMilliAmps >> 24) & 0xFF);
    sPayload[4] = (uint8_t)((slaveMilliAmps >> 16) & 0xFF);
    sPayload[5] = (uint8_t)((slaveMilliAmps >> 8) & 0xFF);
    sPayload[6] = (uint8_t)(slaveMilliAmps & 0xFF);
    uint16_t sCrc = crc16_vesc(sPayload, 7);
    uint8_t sFrame[12] = {0x02,
                          7,
                          sPayload[0],
                          sPayload[1],
                          sPayload[2],
                          sPayload[3],
                          sPayload[4],
                          sPayload[5],
                          sPayload[6],
                          (uint8_t)(sCrc >> 8),
                          (uint8_t)(sCrc & 0xFF),
                          0x03};
    VescSerial.write(sFrame, 12);
  }
}

// Fast non-blocking Brake command sender
void sendDualBrakeCurrent(float masterBrakeAmps, float slaveBrakeAmps) {
  int32_t masterMilliAmps = (int32_t)(masterBrakeAmps * 1000.0f);
  uint8_t mPayload[5];
  mPayload[0] = 7; // COMM_SET_CURRENT_BRAKE
  mPayload[1] = (uint8_t)((masterMilliAmps >> 24) & 0xFF);
  mPayload[2] = (uint8_t)((masterMilliAmps >> 16) & 0xFF);
  mPayload[3] = (uint8_t)((masterMilliAmps >> 8) & 0xFF);
  mPayload[4] = (uint8_t)(masterMilliAmps & 0xFF);
  uint16_t mCrc = crc16_vesc(mPayload, 5);
  uint8_t mFrame[10] = {0x02,
                        5,
                        mPayload[0],
                        mPayload[1],
                        mPayload[2],
                        mPayload[3],
                        mPayload[4],
                        (uint8_t)(mCrc >> 8),
                        (uint8_t)(mCrc & 0xFF),
                        0x03};
  VescSerial.write(mFrame, 10);

  if (slaveCanId > 0) {
    int32_t slaveMilliAmps = (int32_t)(slaveBrakeAmps * 1000.0f);
    uint8_t sPayload[7];
    sPayload[0] = 34; // COMM_FORWARD_CAN
    sPayload[1] = slaveCanId;
    sPayload[2] = 7; // COMM_SET_CURRENT_BRAKE
    sPayload[3] = (uint8_t)((slaveMilliAmps >> 24) & 0xFF);
    sPayload[4] = (uint8_t)((slaveMilliAmps >> 16) & 0xFF);
    sPayload[5] = (uint8_t)((slaveMilliAmps >> 8) & 0xFF);
    sPayload[6] = (uint8_t)(slaveMilliAmps & 0xFF);
    uint16_t sCrc = crc16_vesc(sPayload, 7);
    uint8_t sFrame[12] = {0x02,
                          7,
                          sPayload[0],
                          sPayload[1],
                          sPayload[2],
                          sPayload[3],
                          sPayload[4],
                          sPayload[5],
                          sPayload[6],
                          (uint8_t)(sCrc >> 8),
                          (uint8_t)(sCrc & 0xFF),
                          0x03};
    VescSerial.write(sFrame, 12);
  }
}

// Fast non-blocking Handbrake command sender (COMM_SET_HANDBRAKE = 10)
// Injects open-loop holding vector in FOC mode to clamp rotor at standstill
void sendDualHandbrakeCurrent(float masterAmps, float slaveAmps) {
  int32_t masterMilliAmps = (int32_t)(masterAmps * 1000.0f);
  uint8_t mPayload[5];
  mPayload[0] = 10; // COMM_SET_HANDBRAKE
  mPayload[1] = (uint8_t)((masterMilliAmps >> 24) & 0xFF);
  mPayload[2] = (uint8_t)((masterMilliAmps >> 16) & 0xFF);
  mPayload[3] = (uint8_t)((masterMilliAmps >> 8) & 0xFF);
  mPayload[4] = (uint8_t)(masterMilliAmps & 0xFF);
  uint16_t mCrc = crc16_vesc(mPayload, 5);
  uint8_t mFrame[10] = {0x02,
                        5,
                        mPayload[0],
                        mPayload[1],
                        mPayload[2],
                        mPayload[3],
                        mPayload[4],
                        (uint8_t)(mCrc >> 8),
                        (uint8_t)(mCrc & 0xFF),
                        0x03};
  VescSerial.write(mFrame, 10);

  if (slaveCanId > 0 && dualMotorEnabled) {
    int32_t slaveMilliAmps = (int32_t)(slaveAmps * 1000.0f);
    uint8_t sPayload[7];
    sPayload[0] = 34; // COMM_FORWARD_CAN
    sPayload[1] = slaveCanId;
    sPayload[2] = 10; // COMM_SET_HANDBRAKE
    sPayload[3] = (uint8_t)((slaveMilliAmps >> 24) & 0xFF);
    sPayload[4] = (uint8_t)((slaveMilliAmps >> 16) & 0xFF);
    sPayload[5] = (uint8_t)((slaveMilliAmps >> 8) & 0xFF);
    sPayload[6] = (uint8_t)(slaveMilliAmps & 0xFF);
    uint16_t sCrc = crc16_vesc(sPayload, 7);
    uint8_t sFrame[12] = {0x02,
                          7,
                          sPayload[0],
                          sPayload[1],
                          sPayload[2],
                          sPayload[3],
                          sPayload[4],
                          sPayload[5],
                          sPayload[6],
                          (uint8_t)(sCrc >> 8),
                          (uint8_t)(sCrc & 0xFF),
                          0x03};
    VescSerial.write(sFrame, 12);
  }
}

// Non-blocking telemetry request (fires in < 20 microseconds)
void requestVescTelemetryAsync() {
  uint8_t payload = 4; // COMM_GET_VALUES
  uint16_t crc = crc16_vesc(&payload, 1);
  uint8_t frame[6] = {0x02, 1, 4, (uint8_t)(crc >> 8), (uint8_t)(crc & 0xFF),
                      0x03};
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
      if (b == 0x02)
        vescRxBuf[vescRxIdx++] = b;
    } else if (vescRxIdx == 1) {
      vescRxBuf[vescRxIdx++] = b; // Payload length
    } else {
      vescRxBuf[vescRxIdx++] = b;
      int payloadLen = vescRxBuf[1];
      int totalFrameLen =
          2 + payloadLen + 3; // header(2) + payload + crc(2) + end(1)

      if (vescRxIdx >= totalFrameLen && totalFrameLen <= 256) {
        if (vescRxBuf[totalFrameLen - 1] == 0x03) {
          uint16_t expectedCrc = crc16_vesc(&vescRxBuf[2], payloadLen);
          uint16_t receivedCrc = ((uint16_t)vescRxBuf[2 + payloadLen] << 8) |
                                 vescRxBuf[2 + payloadLen + 1];

          if (expectedCrc == receivedCrc && vescRxBuf[2] == 4 &&
              payloadLen >= 27) {
            // Unpack ERPM (bytes 23-26 in COMM_GET_VALUES payload)
            // Payload starts at vescRxBuf[2], so ERPM is at index 2 + 23 = 25
            int32_t erpm = ((int32_t)vescRxBuf[25] << 24) |
                           ((int32_t)vescRxBuf[26] << 16) |
                           ((int32_t)vescRxBuf[27] << 8) |
                           ((int32_t)vescRxBuf[28]);
            vescRpm57 = (float)erpm;
            vehicleSpeedMps = fabs(vescRpm57) * ERPM_TO_MPS;
            vehicleSpeedKmH = fabs(vescRpm57) * ERPM_TO_KMH;
            kickBlocked =
                (KICK_RPM_ERPM > 0.0f) && (fabs(vescRpm57) < KICK_RPM_ERPM);

            if (payloadLen >= 49) {
              // Unpack Tachometer (bytes 45-48 in COMM_GET_VALUES payload, at 2 + 45 = 47)
              int32_t tach = ((int32_t)vescRxBuf[47] << 24) |
                             ((int32_t)vescRxBuf[48] << 16) |
                             ((int32_t)vescRxBuf[49] << 8) |
                             ((int32_t)vescRxBuf[50]);
              vescTachometer = tach;
            }
          }
        }
        vescRxIdx = 0;
      }
    }
  }
}

void updateKickStartForGear() {
  bool isZeroStart = (unlockEnabled && bleClientConnected);
  if (isZeroStart) {
    KICK_RPM_ERPM = 0.0f; // Unlock mode: Kick-to-start disabled (Zero start)
  } else {
    KICK_RPM_ERPM = (kickErpmThreshold > 0.0f)
                        ? kickErpmThreshold
                        : DEFAULT_KICK_ERPM; // Locked mode (Gears 1..3): Kick start
  }
  kickBlocked = (KICK_RPM_ERPM > 0.0f) && (fabs(vescRpm57) < KICK_RPM_ERPM);
}

void updateActiveProfile() {
  if (currentGear <= 0) {
    currentGear = 0;
    // Park gear (0) on display; VESC park implementation to be added later
    activeProfile = PROFILE_1_LOCKED;
    profileSSwitch = false;
  } else if (currentGear == 1) {
    if (unlockEnabled) {
      unlockEnabled = false;
      gearShiftEnabled = false;
      secretComboUnlocked = false;
      prefs.putBool("unlock_en", false);
      prefs.putBool("gear_shift", false);
    }
    activeProfile = PROFILE_1_LOCKED;
    profileSSwitch = false;
  } else if (currentGear == 2) {
    activeProfile = (unlockEnabled && bleClientConnected)
                        ? PROFILE_2_UNLOCKED
                        : PROFILE_2_LOCKED;
    profileSSwitch = false;
  } else if (currentGear >= 3) {
    currentGear = 3;
    activeProfile = (unlockEnabled && bleClientConnected)
                        ? PROFILE_3_UNLOCKED
                        : PROFILE_3_LOCKED;
    profileSSwitch = (unlockEnabled && bleClientConnected);
  }
  updateKickStartForGear();
  // Apply native VESC speed limit profile (COMM_SET_MCCONF_TEMP = 48) to both
  // VESCs
  sendVescTempProfile(activeProfile.maxErpm, 1.0f);
}

void setGear(int newGear, bool syncToDisplay = true) {
  currentGear = constrain(newGear, 0, 3);
  if (currentGear >= 1 && currentGear <= 3) {
    lastNonParkGear = currentGear;
  }
  if (currentGear == 0) {
    parkMotionDetected = false;
  }

  if (syncToDisplay) {
    displayTargetGear = (uint8_t)currentGear;
    displayGearSyncRemaining = 8;
    lastRawGear = currentGear * 5;
  }

  // Shift gear history for gears 1..3
  if (currentGear >= 1) {
    for (int i = 0; i < 6; i++) {
      gearHistory[i] = gearHistory[i + 1];
    }
    gearHistory[6] = (uint8_t)currentGear;
  }

  // Safety relock: switching to Gear 1 immediately locks scooter to 5, 15, 20 km/h
  if (currentGear == 1 && unlockEnabled) {
    unlockEnabled = false;
    gearShiftEnabled = false;
    secretComboUnlocked = false;
    prefs.putBool("unlock_en", false);
    prefs.putBool("gear_shift", false);
    blePushLine("UNLOCK: RELOCKED (Gear 1 Safety) UL=0 G=1");
  }

  // Cruise control suspended in Gear 3 Unlocked (Sport) or Park (0)
  if (currentGear == 3 && unlockEnabled && bleClientConnected) {
    profileSSwitch = true;
    if (cruiseControlActive) {
      cruiseControlActive = false;
      cruiseTopSpeedStartTime = 0;
      blePushLine("CRUISE: SUSPENDED (Sport)");
    }
  } else {
    profileSSwitch = false;
    if (currentGear == 0 && cruiseControlActive) {
      cruiseControlActive = false;
      cruiseTopSpeedStartTime = 0;
    }
  }

  updateActiveProfile();

  char gbuf[170];
  snprintf(gbuf, sizeof(gbuf),
           "GEAR: %d (%s, Limit: %.0f km/h, %.0f A, %s) G=%d PARK=%d UL=%d",
           currentGear, (currentGear == 0) ? "Park" : activeProfile.name,
           activeProfile.speedLimitKmH, activeProfile.maxCurrentAmps,
           (KICK_RPM_ERPM > 0.0f) ? "Kick-start" : "Zero-start",
           currentGear, (currentGear == 0) ? 1 : 0,
           (unlockEnabled && bleClientConnected) ? 1 : 0);
  blePushLine(String(gbuf));
}

int getDisplayGear(int raw) {
  if (raw == 0)
    return 0;
  if (raw == 5 || raw == 1)
    return 1;
  if (raw == 10 || raw == 2)
    return 2;
  if (raw == 15 || raw == 3)
    return 3;
  return constrain(raw, 0, 3);
}

int calculateMappedGear(int raw) {
  return getDisplayGear(raw);
}

void applyUnlockState() {
  setGear(currentGear, false);
}

void applyGearShiftState() {
  applyUnlockState();
}

void handleDisplayRxPacket(const uint8_t *packet) {
  displayPacketsCount++;
  int rawGear = packet[4];
  bool light = (packet[9] & 0x08) != 0;

  // Handle Gear change
  if (displayGearSyncRemaining > 0) {
    if (rawGear == displayTargetGear * 5 || rawGear == displayTargetGear) {
      displayGearSyncRemaining = 0;
      lastRawGear = rawGear;
    }
  } else if (rawGear != lastRawGear) {
    int mappedGear = calculateMappedGear(rawGear);
    setGear(mappedGear, false);
    lastRawGear = rawGear;
  }

  // Handle Light button change
  if (light != lastLightState) {
    displayLightState = light;
    lights.setFrontLight(light);

    // Secret combo unlock check: [1, 2, 3, 2, 3, 2, 3] + Light ON
    if (light && (memcmp(gearHistory, COMBO_KEY, 7) == 0)) {
      secretComboUnlocked = true;
      unlockEnabled = true;
      gearShiftEnabled = true;
      setGear(3, true);
      blePushLine("SECRET UNLOCK: Sport Unlimited activated! UL=1 G=3");
    }

    lastLightState = light;
  }
}

uint16_t calculateDisplaySpeed(float speedMps) {
  if (speedMps <= 0.05f)
    return 0;
  float wheelCircumferenceMeters =
      P06_WHEEL_DIAMETER_INCH * 3.14159265f * 0.0254f;
  float rotationsPerSec = speedMps / wheelCircumferenceMeters;
  float displaySpeed = P07_MAGNET_POLES * rotationsPerSec * SPEED_CALC_FACTOR;
  if (displaySpeed < 0)
    displaySpeed = 0;
  if (displaySpeed > 65535.0f)
    displaySpeed = 65535.0f;
  return (uint16_t)displaySpeed;
}

void sendDisplayTxPacket(float speedMps) {
  uint8_t txBuf[15] = {0};

  // Byte 0: Header
  txBuf[0] = 0x36;

  // Byte 1: Rolling counter
  displayTxCounter++;
  txBuf[1] = displayTxCounter;

  // Byte 4:
  //   Bit 7 (0x80 = 128): ESP32 BLE app connected (Bluetooth icon on display)
  //   Bit 5 (0x20 = 32):  S-Mode flag (unlocked Sport mode)
  //   Bit 2 (0x04 = 4):   Gear override command valid flag
  //   Bits 0..1 (0x03):   Target gear (0 = Park, 1 = Gear 1, 2 = Gear 2, 3 = Gear 3)
  if (bleClientConnected) {
    txBuf[4] |= 0x80;
  }
  if (profileSSwitch) {
    txBuf[4] |= 32;
  }
  if (displayGearSyncRemaining > 0 && displayTargetGear <= 3) {
    txBuf[4] |= 0x04 | (displayTargetGear & 0x03);
    displayGearSyncRemaining--;
  }

  // Bytes 7 & 8: Speed in Big Endian
  uint16_t dispSpeed = calculateDisplaySpeed(speedMps);
  txBuf[7] = (dispSpeed >> 8) & 0xFF;
  txBuf[8] = dispSpeed & 0xFF;

  // Byte 13: Turn signal indicators on display LCD (bit 7 = Left, bit 6 = Right)
  if (lights.isTurnLeftActive()) {
    txBuf[13] |= 0x80;
  }
  if (lights.isTurnRightActive()) {
    txBuf[13] |= 0x40;
  }

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

    if (displayRxIndex > 0 && (now - lastDisplayRxByteTime) > 80) {
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

  // Send packet to display every 200ms (15 bytes @ 1200 baud = 125ms wire time
  // + 75ms idle gap required for display >40ms inter-frame timer)
  unsigned long now = millis();
  if (now - lastDisplayTxTime >= 200) {
    lastDisplayTxTime = now;
    sendDisplayTxPacket(speedMps);
  }
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
    char buf[360];
    const char *ccStatus =
        !cruiseControlEnabled
            ? "0"
            : ((currentGear >= 3 && unlockEnabled && bleClientConnected) ? "G4"
                                : (cruiseControlActive ? "ACTIVE" : "1"));
    snprintf(buf, sizeof(buf),
             "SPD=%.1f G=%d PARK=%d PL=%d S=%d V=%.2f RAW=%d BRK=%d BEN=%d AMP=%.1f PROF=%s "
             "LIM=%.0fkm/h KICK=%s(%.0f) UL=%d GS=%d CC=%s PIN19=%d BPIN=%d BPOL=%s "
             "BC=%.1fA PA=%.1fA PE=%.0f ABS=%d AF=%d ABSS=%d CAN=%d",
             vehicleSpeedKmH, currentGear, (currentGear == 0) ? 1 : 0,
             (currentGear == 0 && parkMotionDetected) ? 1 : 0,
             profileSSwitch ? 1 : 0, currentVoltageReading, currentRawThrottle,
             debouncedBrakeState ? 1 : 0, brakeEnabled ? 1 : 0, targetAmps,
             (currentGear == 0) ? "Park" : activeProfile.name,
             activeProfile.speedLimitKmH,
             (KICK_RPM_ERPM > 0.0f) ? "ON" : "ZERO", KICK_RPM_ERPM,
             (unlockEnabled && bleClientConnected) ? 1 : 0,
             (unlockEnabled && bleClientConnected) ? 1 : 0, ccStatus,
             digitalRead(19), brakePin, brakeActiveLow ? "LOW" : "HIGH",
             userBrakeAmps, parkBrakeAmps, parkErpmThreshold, absEnabled ? 1 : 0, absFrequencyHz,
             absStrobeEnabled ? 1 : 0, slaveCanId);
    blePushLine(String(buf));
  } else if (cmd == "UL" || cmd == "UNLOCK" || cmd == "GS" || cmd == "GSHIFT") {
    blePushLine("UNLOCK is " +
                String((unlockEnabled && bleClientConnected)
                           ? "ON (G2: 25km/h, G3: Unlimited)"
                           : "OFF (G1: 5km/h, G2: 15km/h, G3: 20km/h)"));
  } else if (cmd.startsWith("UNLOCK ") || cmd.startsWith("UL ") ||
             cmd.startsWith("GSHIFT ") || cmd.startsWith("GS ")) {
    int val = 0;
    if (cmd.startsWith("UNLOCK "))
      val = cmd.substring(7).toInt();
    else if (cmd.startsWith("UL "))
      val = cmd.substring(3).toInt();
    else if (cmd.startsWith("GSHIFT "))
      val = cmd.substring(7).toInt();
    else
      val = cmd.substring(3).toInt();

    if (val != 0) {
      if (currentGear <= 1) {
        blePushLine("ERR cannot unlock in Park/Gear 1 (shift to 2 or 3 first)");
      } else {
        unlockEnabled = true;
        gearShiftEnabled = true;
        prefs.putBool("unlock_en", true);
        prefs.putBool("gear_shift", true);
        updateActiveProfile();
        blePushLine("UNLOCK set to ON (Gears 2: 25km/h, 3: Unlim) UL=1 G=" + String(currentGear));
      }
    } else {
      unlockEnabled = false;
      gearShiftEnabled = false;
      secretComboUnlocked = false;
      prefs.putBool("unlock_en", false);
      prefs.putBool("gear_shift", false);
      updateActiveProfile();
      blePushLine("UNLOCK set to OFF (Gears 1: 5km/h, 2: 15km/h, 3: 20km/h) UL=0 G=" + String(currentGear));
    }
  } else if (cmd == "CC" || cmd == "CRUISE") {
    const char *stateStr =
        !cruiseControlEnabled
            ? "DISABLED"
            : ((currentGear >= 3 && unlockEnabled && bleClientConnected) ? "SUSPENDED (G4)"
                                : (cruiseControlActive ? "ENGAGED" : "ARMED"));
    blePushLine("CRUISE is " + String(stateStr));
  } else if (cmd.startsWith("CC ") || cmd.startsWith("CRUISE ")) {
    int val = 0;
    if (cmd.startsWith("CC "))
      val = cmd.substring(3).toInt();
    else
      val = cmd.substring(7).toInt();
    cruiseControlEnabled = (val != 0);
    prefs.putBool("cruise_en", cruiseControlEnabled);
    if (!cruiseControlEnabled) {
      cruiseControlActive = false;
      cruiseTopSpeedStartTime = 0;
    }
    const char *stateStr =
        !cruiseControlEnabled
            ? "DISABLED"
            : ((currentGear >= 3 && unlockEnabled && bleClientConnected) ? "ARMED (Suspended in G4)" : "ARMED");
    blePushLine("CRUISE set to " + String(stateStr));
  } else if (cmd.startsWith("BEN ")) {
    int en = cmd.substring(4).toInt();
    brakeEnabled = (en != 0);
    prefs.putBool("brake_en", brakeEnabled);
    if (!brakeEnabled) {
      debouncedBrakeState = false;
      rawBrakePinState = false;
      brakeFilterCount = 0;
      sendBrakeFlagToSlave(false);
      lastSentBrakeState = false;
      sendDualCurrent(0.0f, 0.0f);
    }
    blePushLine("BRAKE SENSOR " +
                String(brakeEnabled ? "ENABLED" : "DISABLED"));
  } else if (cmd == "PARK") {
    int target = (currentGear == 0) ? (lastNonParkGear >= 1 ? lastNonParkGear : 1) : 0;
    setGear(target);
  } else if (cmd.startsWith("PARK ")) {
    String arg = cmd.substring(5);
    arg.trim();
    bool en = (arg == "1" || arg.equalsIgnoreCase("ON"));
    if (en) {
      setGear(0);
    } else {
      setGear(lastNonParkGear >= 1 ? lastNonParkGear : 1);
    }
  } else if (cmd == "PA") {
    blePushLine("PARK BRAKE AMPS: " + String(parkBrakeAmps, 1) + " A");
  } else if (cmd.startsWith("PA ")) {
    float a = cmd.substring(3).toFloat();
    if (a >= 5.0f && a <= 120.0f) {
      parkBrakeAmps = a;
      prefs.putFloat("park_amps", parkBrakeAmps);
      blePushLine("PARK BRAKE AMPS set to " + String(parkBrakeAmps, 1) + " A");
    } else {
      blePushLine("ERR park amps 5..120 A");
    }
  } else if (cmd == "PE" || cmd == "PERPM") {
    blePushLine("PARK ERPM: " + String(parkErpmThreshold, 0) + " (approx " + String(parkErpmThreshold * ERPM_TO_KMH, 2) + " km/h)");
  } else if (cmd.startsWith("PE ") || cmd.startsWith("PERPM ")) {
    int spaceIdx = cmd.indexOf(' ');
    float e = cmd.substring(spaceIdx + 1).toFloat();
    if (e >= 20.0f && e <= 1000.0f) {
      parkErpmThreshold = e;
      prefs.putFloat("park_erpm", parkErpmThreshold);
      blePushLine("PARK ERPM set to " + String(parkErpmThreshold, 0) + " (approx " + String(parkErpmThreshold * ERPM_TO_KMH, 2) + " km/h)");
    } else {
      blePushLine("ERR park ERPM range 20..1000");
    }
  } else if (cmd.startsWith("G ") || cmd.startsWith("P ")) {
    int g = cmd.substring(2).toInt();
    if (g >= 0 && g <= 3) {
      setGear(g);
      char pbuf[150];
      snprintf(pbuf, sizeof(pbuf),
               "PROFILE %d: %s (Limit: %.0f km/h, %.0f ERPM, %.0f A, %s) G=%d PARK=%d UL=%d", g,
               (currentGear == 0) ? "Park" : activeProfile.name,
               activeProfile.speedLimitKmH,
               activeProfile.maxErpm, activeProfile.maxCurrentAmps,
               (KICK_RPM_ERPM > 0.0f) ? "Kick-start" : "Zero-start",
               currentGear, (currentGear == 0) ? 1 : 0,
               (unlockEnabled && bleClientConnected) ? 1 : 0);
      blePushLine(String(pbuf));
    } else {
      blePushLine("ERR profile 0..3 (0=Park, 1=5km/h, 2=15/25km/h, 3=20/Unlim km/h)");
    }
  } else if (cmd.startsWith("BP ")) {
    int p = cmd.substring(3).toInt();
    if (p == 19) {
      brakePin = 19;
      prefs.putInt("brake_pin", 19);
      pinMode(brakePin, brakeActiveLow ? INPUT_PULLUP : INPUT_PULLDOWN);
      blePushLine("BRAKE PIN set to GPIO 19 (Soldered)");
    } else {
      blePushLine("BRAKE PIN is fixed to GPIO 19 (Soldered)");
    }
  } else if (cmd.startsWith("BPOL ")) {
    int pol = cmd.substring(5).toInt();
    brakeActiveLow = (pol != 0);
    prefs.putBool("brake_low", brakeActiveLow);
    pinMode(brakePin, brakeActiveLow ? INPUT_PULLUP : INPUT_PULLDOWN);
    blePushLine("BRAKE POLARITY set to " + String(brakeActiveLow
                                                      ? "Active LOW (GND)"
                                                      : "Active HIGH (3.3V)"));
  } else if (cmd == "L" || cmd == "LIGHT") {
    lights.toggleFrontLight();
    blePushLine("LIGHT: " + String(lights.isFrontLightOn() ? "ON" : "OFF"));
  } else if (cmd.startsWith("L ") || cmd.startsWith("LIGHT ")) {
    int val = cmd.substring(cmd.indexOf(' ') + 1).toInt();
    lights.setFrontLight(val != 0);
    blePushLine("LIGHT: " + String(lights.isFrontLightOn() ? "ON" : "OFF"));
  } else if (cmd == "TL" || cmd == "TURNL") {
    lights.toggleTurnLeft();
    blePushLine("TURN LEFT: " + String(lights.isTurnLeftActive() ? "ON" : "OFF"));
  } else if (cmd == "TR" || cmd == "TURNR") {
    lights.toggleTurnRight();
    blePushLine("TURN RIGHT: " + String(lights.isTurnRightActive() ? "ON" : "OFF"));
  } else if (cmd == "HAZ" || cmd == "HAZARD") {
    lights.toggleHazard();
    blePushLine("HAZARD: " + String(lights.isHazardActive() ? "ON" : "OFF"));
  } else if (cmd == "DDM" || cmd == "DUAL") {
    dualMotorEnabled = !dualMotorEnabled;
    prefs.putBool("dual_mode", dualMotorEnabled);
    blePushLine("DUAL MOTOR: " + String(dualMotorEnabled ? "ENABLED (2WD)" : "DISABLED (1WD)"));
  } else if (cmd == "DUAL 1" || cmd == "DUAL ON" || cmd == "DDM 1") {
    dualMotorEnabled = true;
    prefs.putBool("dual_mode", dualMotorEnabled);
    blePushLine("DUAL MOTOR: ENABLED (2WD)");
  } else if (cmd == "DUAL 0" || cmd == "DUAL OFF" || cmd == "DDM 0") {
    dualMotorEnabled = false;
    prefs.putBool("dual_mode", dualMotorEnabled);
    blePushLine("DUAL MOTOR: DISABLED (1WD)");
  } else if (cmd.startsWith("BC ")) {
    float bc = cmd.substring(3).toFloat();
    if (bc >= 0.0f && bc <= 60.0f) {
      userBrakeAmps = bc;
      prefs.putFloat("brake_amps", userBrakeAmps);
      blePushLine("BRAKE CURRENT set to " + String(userBrakeAmps, 1) + " A");
    } else {
      blePushLine("ERR brake amps range 0..60");
    }
  } else if (cmd == "ABS") {
    blePushLine("e-ABS is " + String(absEnabled ? "ON" : "OFF") +
                " (" + String(absFrequencyHz) + " Hz, Strobe=" +
                String(absStrobeEnabled ? "ON" : "OFF") + ", Current=" +
                String(userBrakeAmps, 1) + " A)");
  } else if (cmd == "ABS 1" || cmd == "ABS ON") {
    absEnabled = true;
    prefs.putBool("abs_en", absEnabled);
    blePushLine("e-ABS ENABLED (" + String(absFrequencyHz) + " Hz Dualtron pulsation)");
  } else if (cmd == "ABS 0" || cmd == "ABS OFF") {
    absEnabled = false;
    prefs.putBool("abs_en", absEnabled);
    blePushLine("e-ABS DISABLED (Solid braking)");
  } else if (cmd.startsWith("AF ") || cmd.startsWith("ABSFREQ ")) {
    int spIdx = cmd.indexOf(' ');
    int freq = cmd.substring(spIdx + 1).toInt();
    if (freq >= 2 && freq <= 20) {
      absFrequencyHz = freq;
      prefs.putInt("abs_freq", absFrequencyHz);
      blePushLine("ABS FREQUENCY set to " + String(absFrequencyHz) + " Hz");
    } else {
      blePushLine("ERR ABS frequency range 2..20 Hz");
    }
  } else if (cmd == "ABSS") {
    absStrobeEnabled = !absStrobeEnabled;
    prefs.putBool("abs_strobe", absStrobeEnabled);
    blePushLine("ABS STROBE: " + String(absStrobeEnabled ? "ENABLED" : "DISABLED"));
  } else if (cmd == "ABSS 1" || cmd == "ABSS ON") {
    absStrobeEnabled = true;
    prefs.putBool("abs_strobe", absStrobeEnabled);
    blePushLine("ABS STROBE: ENABLED");
  } else if (cmd == "ABSS 0" || cmd == "ABSS OFF") {
    absStrobeEnabled = false;
    prefs.putBool("abs_strobe", absStrobeEnabled);
    blePushLine("ABS STROBE: DISABLED");
  } else if (cmd == "CAN") {
    blePushLine("SLAVE CAN ID: " + String(slaveCanId));
  } else if (cmd.startsWith("CAN ")) {
    int cid = cmd.substring(4).toInt();
    if (cid >= 0 && cid <= 255) {
      slaveCanId = (uint8_t)cid;
      prefs.putUChar("can_slave", slaveCanId);
      blePushLine("SLAVE CAN ID set to " + String(slaveCanId));
    } else {
      blePushLine("ERR CAN ID range 0..255 (0=disabled)");
    }
  } else if (cmd == "T") {
    testModeActive = false;
    testErpm = 0.0f;
    blePushLine("TEST off");
  } else if (cmd.startsWith("T ")) {
    float v = 1.0;
    int b = 0;
    float erpm = 0.0f;
    int matched = sscanf(cmd.c_str() + 2, "%f %d %f", &v, &b, &erpm);
    testModeActive = true;
    testVoltage = constrain(v, 0.5, 3.3);
    testBrakeState = (b != 0);
    if (matched >= 3) {
      testErpm = erpm;
    } else {
      testErpm = 0.0f;
    }
    blePushLine("TEST on V=" + String(testVoltage, 2) +
                " B=" + String(testBrakeState ? 1 : 0) +
                " ERPM=" + String(testErpm, 0));
  } else if (cmd.startsWith("TE ")) {
    testModeActive = true;
    testErpm = cmd.substring(3).toFloat();
    blePushLine("TEST ERPM set to " + String(testErpm, 0));
  } else if (cmd.startsWith("K ")) {
    float k = cmd.substring(2).toFloat();
    if (k >= 0 && k < 5000) {
      kickErpmThreshold = k;
      prefs.putFloat("kick_th", kickErpmThreshold);
      updateKickStartForGear();
      blePushLine("KICK threshold set to " + String(kickErpmThreshold, 0) +
                  " (Active: " + String(KICK_RPM_ERPM, 0) + ")");
    } else {
      blePushLine("ERR kick range 0..5000");
    }
  } else if (cmd == "K") {
    blePushLine("KICK Active: " + String(KICK_RPM_ERPM, 0) + " ERPM (" +
                ((KICK_RPM_ERPM > 0.0f) ? "Kick-start" : "Zero-start") +
                ", threshold=" + String(kickErpmThreshold, 0) + ")");
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
    blePushLine(
        "S status | P [0-3] prof | G [0-3] gear | PARK [0/1] park | PA [amps] park-amps | "
        "GS [0/1] shift | CC [0/1] cruise | BEN [0/1] brake-en | BC [amps] brake | "
        "ABS [0/1] e-abs | AF [2-20] abs-freq | ABSS [0/1] abs-strobe | L [0/1] light | "
        "TL turnL | TR turnR | HAZ haz | DUAL [0/1] dual | CAN [id] | T [v b e] test | "
        "TE [erpm] | K kick | R reboot");
  } else {
    blePushLine("ERR unknown, send ?");
  }
}

class ConsoleCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *c) {
    String v = String((const char *)c->getData(), c->getLength());
    v.trim();
    if (v.length() == 0)
      return;
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
    if (!bleOtaActive)
      return;
    size_t n = c->getLength();
    if (n == 0)
      return;
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
    lastBleNotify = millis() + 800; // 800ms quiet window so mobile app completes GATT discovery & CCCD subscribe cleanly
  }
  void onDisconnect(BLEServer *) {
    bleClientConnected = false;
    bleOtaActive = false;
    unlockEnabled = false;
    gearShiftEnabled = false;
    secretComboUnlocked = false;
    if (cruiseControlActive) {
      cruiseControlActive = false;
      cruiseTopSpeedStartTime = 0;
    }
    applyUnlockState();
    bleServer->getAdvertising()->start();
  }
};

void bleInit() {
  BLEDevice::init(BLE_DEVICE_NAME);
  BLEDevice::setMTU(517);
  bleServer = BLEDevice::createServer();
  bleServer->setCallbacks(new ServerCallbacks());
  BLEService *svc = bleServer->createService(BLE_SVC_UUID);
  bleConsole = svc->createCharacteristic(BLE_CONSOLE_UUID,
                                         BLECharacteristic::PROPERTY_NOTIFY |
                                             BLECharacteristic::PROPERTY_WRITE);
  bleConsole->addDescriptor(new BLE2902());
  bleConsole->setCallbacks(new ConsoleCallbacks());
  bleOta = svc->createCharacteristic(BLE_OTA_UUID,
                                     BLECharacteristic::PROPERTY_WRITE);
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
  kickErpmThreshold = prefs.getFloat("kick_th", DEFAULT_KICK_ERPM);
  if (kickErpmThreshold < 0.0f) {
    kickErpmThreshold = DEFAULT_KICK_ERPM;
  }
  unlockEnabled = prefs.getBool("unlock_en", false);
  gearShiftEnabled = unlockEnabled;
  cruiseControlEnabled = prefs.getBool("cruise_en", false);
  brakePin = 19;                                     // Default 19 (Soldered brake pin)
  prefs.putInt("brake_pin", 19);
  brakeActiveLow = prefs.getBool("brake_low", true); // Default Active LOW
  brakeEnabled = prefs.getBool("brake_en", true);    // Default Enabled
  userBrakeAmps =
      prefs.getFloat("brake_amps", 25.0f);      // Default 25A strong e-brake
  parkBrakeAmps =
      prefs.getFloat("park_amps", 35.0f);       // Default 35A park lock
  if (parkBrakeAmps < 5.0f || parkBrakeAmps > 120.0f) {
    parkBrakeAmps = 35.0f;
  }
  parkErpmThreshold =
      prefs.getFloat("park_erpm", 100.0f);     // Default 100 ERPM threshold (approx 0.3 km/h)
  if (parkErpmThreshold < 20.0f || parkErpmThreshold > 1000.0f) {
    parkErpmThreshold = 100.0f;
  }
  absEnabled = prefs.getBool("abs_en", false);  // Default e-ABS disabled
  absStrobeEnabled = prefs.getBool("abs_strobe", true); // Default strobe rear light
  absFrequencyHz = prefs.getInt("abs_freq", 10);// Default 10 Hz
  if (absFrequencyHz < 2 || absFrequencyHz > 20) {
    absFrequencyHz = 10;
  }
  slaveCanId = prefs.getUChar("can_slave", 37); // Default CAN ID 37 (Second Motor)
  if (slaveCanId == 61) {
    // Automatically migrate legacy default (61) to the new secondary motor ID (37)
    slaveCanId = 37;
    prefs.putUChar("can_slave", 37);
  }

  // Set internal pullup/pulldown on soldered brake pin (GPIO 19)
  pinMode(brakePin, brakeActiveLow ? INPUT_PULLUP : INPUT_PULLDOWN);

  // Initialize Lights Controller (Physical buttons & MOSFET/relay outputs)
  lights.begin();

  dualMotorEnabled = prefs.getBool("dual_mode", true); // Default Dual Motor (2WD)
  lastDdmRaw = digitalRead(PIN_IN_DDM);

  bleInit();

  // UART2 connected to VESC Master at 115200 Baud (RX=16, TX=17)
  VescSerial.begin(115200, SERIAL_8N1, 16, 17);

  updateActiveProfile();
}

void loop() {
  unsigned long now = millis();

  // 1. Process Incoming VESC Telemetry Bytes (Non-blocking, < 20 microseconds)
  processVescIncoming();

  // 2. Poll VESC Telemetry asynchronously (30ms in Park for instant motion sensing, 50ms otherwise)
  unsigned long vescPollInterval = (currentGear == 0) ? 30 : 50;
  if (now - lastVescPoll >= vescPollInterval) {
    lastVescPoll = now;
    requestVescTelemetryAsync();
  }

  // 3. Fast Brake Sensor Reading & EMI Integrator Filter
  if (testModeActive) {
    debouncedBrakeState = testBrakeState && brakeEnabled;
    currentRawThrottle = (int)((testVoltage / 3.3f) * 4095.0f);
    if (testErpm != 0.0f) {
      vescRpm57 = testErpm;
      vehicleSpeedMps = fabs(vescRpm57) * ERPM_TO_MPS;
      vehicleSpeedKmH = fabs(vescRpm57) * ERPM_TO_KMH;
    }
  } else {
    if (!brakeEnabled) {
      debouncedBrakeState = false;
      rawBrakePinState = false;
      brakeFilterCount = 0;
    } else {
      if (now - lastBrakeSampleTime >= BRAKE_SAMPLE_INTERVAL_MS) {
        lastBrakeSampleTime = now;
        bool rawReading = (digitalRead(brakePin) == (brakeActiveLow ? LOW : HIGH));
        rawBrakePinState = rawReading;

        if (rawReading) {
          if (brakeFilterCount < BRAKE_FILTER_SAMPLES) {
            brakeFilterCount++;
          }
        } else {
          if (brakeFilterCount > 0) {
            brakeFilterCount--;
          }
        }

        // Active after sustained continuous signal (BRAKE_FILTER_SAMPLES * 4ms
        // = 20ms)
        if (brakeFilterCount >= BRAKE_FILTER_SAMPLES) {
          debouncedBrakeState = true;
        } else if (brakeFilterCount == 0) {
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

  currentVoltageReading = (currentRawThrottle / 4095.0f) * 3.3f;

  // Monitor physical DDM switch toggle (GPIO 4)
  int ddmReading = digitalRead(PIN_IN_DDM);
  if (ddmReading != lastDdmRaw && (now - lastDdmDebounceTime > 50)) {
    lastDdmDebounceTime = now;
    lastDdmRaw = ddmReading;
    bool newDual = (ddmReading == LOW);
    if (newDual != dualMotorEnabled) {
      dualMotorEnabled = newDual;
      prefs.putBool("dual_mode", dualMotorEnabled);
      blePushLine("DUAL MOTOR: " + String(dualMotorEnabled ? "ENABLED (2WD via Switch)" : "DISABLED (1WD via Switch)"));
    }
  }

  // 4. Push brake flag to Slave VESC immediately on change
  if (debouncedBrakeState != lastSentBrakeState) {
    sendBrakeFlagToSlave(debouncedBrakeState);
    lastSentBrakeState = debouncedBrakeState;
  }

  // 5. Update Display UART (Non-blocking)
  processDisplayUart(vehicleSpeedMps);

  // Track brake pull transition for zero-latency ABS cycle bite
  static bool lastRawBrakeSeen = false;
  if (debouncedBrakeState && !lastRawBrakeSeen) {
    absCycleStartTime = now;
  }
  lastRawBrakeSeen = debouncedBrakeState;

  // Evaluate e-ABS pulsation state
  bool inAbsPulsation = false;
  bool absBrakePulseActive = true;
  if (debouncedBrakeState && absEnabled && (vehicleSpeedKmH >= ABS_MIN_SPEED_KMH) && (userBrakeAmps > 0.0f)) {
    inAbsPulsation = true;
    int freq = constrain(absFrequencyHz, 2, 20);
    unsigned long periodMs = 1000 / freq;
    unsigned long onTimeMs = (periodMs * 60) / 100; // 60% braking duty cycle
    unsigned long elapsed = now - absCycleStartTime;
    unsigned long cyclePos = elapsed % periodMs;
    absBrakePulseActive = (cyclePos < onTimeMs);
  }

  // 5b. Update Lights Controller (Inputs, Debouncing, Blinkers & Brake Light / Strobe)
  bool parkAlarmActive = (currentGear == 0 && parkMotionDetected);
  bool strobeActive = (debouncedBrakeState && inAbsPulsation && absStrobeEnabled) || parkAlarmActive;
  lights.update(debouncedBrakeState || parkAlarmActive, strobeActive, absBrakePulseActive || parkAlarmActive);
  if (lights.isFrontLightOn() != displayLightState) {
    displayLightState = lights.isFrontLightOn();
  }

  // 6. INSTANT ZERO-LATENCY Throttle Calculation
  float rawRatio = 0.0f;
  if (currentGear == 0) {
    // In Park mode (Gear 0), throttle is completely locked out
    rawRatio = 0.0f;
  } else if (currentRawThrottle > THROTTLE_MIN_RAW) {
    rawRatio = (currentRawThrottle - THROTTLE_MIN_RAW) /
               (float)(THROTTLE_MAX_RAW - THROTTLE_MIN_RAW);
    rawRatio = constrain(rawRatio, 0.0f, 1.0f);
  } else {
    rawRatio = 0.0f; // Instant cutoff when below deadband!
  }

  // 6b. Top-Speed Cruise Control Detection
  // Activates only in Gears 1-3 when cruise is armed, brake is released, and
  // kick is passed. Requires holding speed within +/- 2.0 km/h of profile top
  // speed continuously for 5.0 seconds.
  if (cruiseControlEnabled && currentGear < 4 && !debouncedBrakeState &&
      !kickBlocked && !testModeActive) {
    float minCruiseSpeed =
        activeProfile.speedLimitKmH - CRUISE_SPEED_TOLERANCE_KMH;
    float maxCruiseSpeed =
        activeProfile.speedLimitKmH + CRUISE_SPEED_TOLERANCE_KMH;

    if (vehicleSpeedKmH >= minCruiseSpeed &&
        vehicleSpeedKmH <= maxCruiseSpeed) {
      if (cruiseTopSpeedStartTime == 0) {
        cruiseTopSpeedStartTime = now;
      } else if (!cruiseControlActive &&
                 (now - cruiseTopSpeedStartTime >= CRUISE_HOLD_DURATION_MS)) {
        cruiseControlActive = true;
        blePushLine("CRUISE: ENGAGED at " + String(vehicleSpeedKmH, 1) +
                    " km/h");
      }
    } else {
      if (!cruiseControlActive) {
        cruiseTopSpeedStartTime = 0;
      }
    }
  } else {
    if (!cruiseControlActive) {
      cruiseTopSpeedStartTime = 0;
    }
  }

  // 7. Dispatch Motor Current at 50 Hz (every 20ms) with zero lag & full
  // authority braking
  if (now - lastMotorCmdTime >= 20) {
    lastMotorCmdTime = now;

    // Detect brake release transition
    bool brakeJustReleased = (lastDebouncedBrakeState && !debouncedBrakeState);
    lastDebouncedBrakeState = debouncedBrakeState;

    if (brakeJustReleased) {
      brakeReleaseFrames = 2; // Cleanly clear brake mode on master and slave
    }

    if (debouncedBrakeState) {
      // Full brake priority: Throttle is completely deactivated and cruise
      // control cancels!
      if (cruiseControlActive) {
        cruiseControlActive = false;
        cruiseTopSpeedStartTime = 0;
        blePushLine("CRUISE: DISENGAGED (Brake)");
      }
      targetAmps = 0.0f;
      if (userBrakeAmps > 0.0f) {
        if (absBrakePulseActive) {
          targetBrakeAmps = userBrakeAmps;
          sendDualBrakeCurrent(targetBrakeAmps, targetBrakeAmps);
        } else {
          targetBrakeAmps = 0.0f;
          sendDualCurrent(0.0f, 0.0f); // 0A freewheel release pulse for e-ABS
        }
      } else {
        targetBrakeAmps = 0.0f;
        sendDualCurrent(0.0f, 0.0f);
      }
    } else if (currentGear == 0) {
      // =====================================================================
      // 🅿️ ACTIVE PARK MODE & MOTOR ANTI-THEFT LOCK
      // =====================================================================
      if (cruiseControlActive) {
        cruiseControlActive = false;
        cruiseTopSpeedStartTime = 0;
      }
      targetAmps = 0.0f;

      // Only engage electronic brake when actual measured ERPM reaches/exceeds slider threshold
      // Below threshold and at standstill, keep motors completely free (0A) to prevent ANY shuddering!
      float currentErpm = fabs(vescRpm57);
      if (currentErpm >= parkErpmThreshold) {
        if (!parkMotionDetected) {
          parkMotionDetected = true;
          blePushLine("PARK: MOTION DETECTED (ERPM=" + String(vescRpm57, 0) + ", " + String(vehicleSpeedKmH, 1) + " km/h) -> BRAKING MOTORS");
        }
        targetBrakeAmps = parkBrakeAmps;
        float slaveLockAmps = dualMotorEnabled ? parkBrakeAmps : 0.0f;
        // Closed-loop VESC electronic brake applies smooth opposing torque in the needed direction
        sendDualBrakeCurrent(parkBrakeAmps, slaveLockAmps);
      } else {
        if (parkMotionDetected) {
          parkMotionDetected = false;
          blePushLine("PARK: MOTION STOPPED -> MOTORS SECURED (Standby 0A)");
        }
        targetBrakeAmps = 0.0f;
        // Zero current standby - completely smooth, silent, zero shuddering at standstill
        sendDualCurrent(0.0f, 0.0f);
      }
    } else if (kickBlocked && !debouncedBrakeState && !testModeActive) {
      if (cruiseControlActive) {
        cruiseControlActive = false;
        cruiseTopSpeedStartTime = 0;
      }
      targetAmps = 0.0f;
      targetBrakeAmps = 0.0f;
      sendDualCurrent(0.0f, 0.0f);
    } else {
      targetBrakeAmps = 0.0f;

      if (brakeReleaseFrames > 0) {
        brakeReleaseFrames--;
        targetAmps = 0.0f;
        // Clean 0A current cancels VESC brake mode and enters freewheel/coast.
        // Never send sendDualBrakeCurrent(0, 0) on release as that locks
        // low-side FETs!
        sendDualCurrent(0.0f, 0.0f);
      } else if (cruiseControlActive && currentGear < 4) {
        // Cruise Control Active: Physical throttle is ignored, send maximum
        // current for current gear! VESC native speed limiter profile limits
        // motor RPM cleanly at the gear's top speed.
        targetAmps = activeProfile.maxCurrentAmps;
        float slaveAmps = dualMotorEnabled ? targetAmps : 0.0f;
        sendDualCurrent(targetAmps, slaveAmps);
      } else if (rawRatio > 0.01f) {
        targetAmps = rawRatio * activeProfile.maxCurrentAmps;
        float slaveAmps = dualMotorEnabled ? targetAmps : 0.0f;
        sendDualCurrent(targetAmps, slaveAmps);
      } else {
        targetAmps = 0.0f;
        sendDualCurrent(0.0f, 0.0f); // Freewheel / coasting on release
      }
    }
  }

  // 8. BLE notify live line at 5 Hz

  if (bleClientConnected && now - lastBleNotify > 200) {
    lastBleNotify = now;
    char buf[300];
    const char *ccStatus =
        !cruiseControlEnabled
            ? "0"
            : ((currentGear >= 3 && unlockEnabled && bleClientConnected) ? "G4"
                                : (cruiseControlActive ? "ACTIVE" : "1"));
    snprintf(
        buf, sizeof(buf),
        "SPD=%.1f G=%d PARK=%d PL=%d PE=%.0f PA=%.0f S=%d V=%.2f RAW=%d BRK=%d BEN=%d AMP=%.1f KICK=%s CC=%s L=%d TL=%d TR=%d DDM=%d UL=%d GS=%d ABS=%d AF=%d",
        vehicleSpeedKmH, currentGear, (currentGear == 0) ? 1 : 0,
        (currentGear == 0 && parkMotionDetected) ? 1 : 0,
        parkErpmThreshold, parkBrakeAmps,
        profileSSwitch ? 1 : 0, currentVoltageReading, currentRawThrottle,
        debouncedBrakeState ? 1 : 0, brakeEnabled ? 1 : 0, targetAmps,
        kickBlocked ? "HELD" : "ROLL", ccStatus,
        lights.isFrontLightOn() ? 1 : 0,
        lights.isTurnLeftActive() ? 1 : 0,
        lights.isTurnRightActive() ? 1 : 0,
        dualMotorEnabled ? 1 : 0,
        (unlockEnabled && bleClientConnected) ? 1 : 0,
        (unlockEnabled && bleClientConnected) ? 1 : 0,
        absEnabled ? 1 : 0, absFrequencyHz);
    blePushLine(String(buf));
  }

  // Yield to FreeRTOS scheduler (no delay)
  yield();
}
