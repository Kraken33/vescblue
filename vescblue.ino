#include <Arduino.h>
#include <VescUart.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <Update.h>
#include <Preferences.h>

// =========================================================================
// Hardware & CAN Pin Configuration
// =========================================================================
#define THROTTLE_PIN 34

// Default Brake Pin & Dual-pin support (GPIO 19 and GPIO 21)
int brakePin = 0; // 0 = Dual pin (both 19 and 21), or specify 19 or 21
bool brakeActiveLow = true; // true = Active LOW (pulls to GND when brake engaged)

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
bool secretComboUnlocked = false;
bool gearShiftEnabled = false;
uint8_t gearHistory[7] = { 1, 1, 1, 1, 1, 1, 1 };

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
unsigned long lastBrakeStateChange = 0;

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
          }
        }
        vescRxIdx = 0;
      }
    }
  }
}

void updateKickStartForGear() {
  bool isZeroStart = (currentGear >= 4);
  if (isZeroStart) {
    KICK_RPM_ERPM = 0.0f; // 4th gear (Sport): Zero start
  } else {
    KICK_RPM_ERPM = (kickErpmThreshold > 0.0f) ? kickErpmThreshold : DEFAULT_KICK_ERPM; // 1st, 2nd, 3rd gears: Kick start
  }
  kickBlocked = (KICK_RPM_ERPM > 0.0f) && (fabs(vescRpm57) < KICK_RPM_ERPM);
}

void updateActiveProfile() {
  if (currentGear == 1) {
    activeProfile = PROFILE_1;
  } else if (currentGear == 2) {
    activeProfile = PROFILE_2;
  } else if (currentGear == 3) {
    activeProfile = PROFILE_3;
  } else if (currentGear >= 4) {
    activeProfile = PROFILE_S3;
  }
  updateKickStartForGear();
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

  if (currentGear < 4) {
    // Leaving 4th gear (or operating in gears 1..3) immediately locks 4th gear / S-mode
    secretComboUnlocked = false;
    profileSSwitch = false;
  } else {
    profileSSwitch = true;
  }

  updateActiveProfile();

  char gbuf[140];
  snprintf(gbuf, sizeof(gbuf), "GEAR shifted -> Gear %d: %s (Limit: %.0f km/h, %.0f A, %s)",
           currentGear, activeProfile.name, activeProfile.speedLimitKmH, activeProfile.maxCurrentAmps,
           (KICK_RPM_ERPM > 0.0f) ? "Kick-start" : "Zero-start");
  blePushLine(String(gbuf));
}

int getDisplayGear(int raw) {
  if (raw == 5 || raw == 1) return 1;
  if (raw == 10 || raw == 2) return 2;
  if (raw == 15 || raw == 3) return 3;
  if (raw == 20 || raw == 4) return 4;
  return constrain(raw, 1, 3);
}

int calculateMappedGear(int raw) {
  int dispGear = getDisplayGear(raw);
  if (bleClientConnected && gearShiftEnabled) {
    // Gear shift mode: Display 1 -> Gear 2, Display 2 -> Gear 3, Display 3 -> Gear 4 (Sport, unlocked by default)
    int shifted = dispGear + 1;
    return constrain(shifted, 2, 4);
  } else {
    // Normal mode: Display 1 -> Gear 1, Display 2 -> Gear 2, Display 3 -> Gear 3
    // Gear 4 locked unless secret combo unlocked
    int g = constrain(dispGear, 1, 4);
    if (!secretComboUnlocked && g > 3) {
      g = 3;
    }
    return g;
  }
}

void applyGearShiftState() {
  int raw = (lastRawGear > 0) ? lastRawGear : 1;
  int newGear = calculateMappedGear(raw);
  setGear(newGear);
}

void handleDisplayRxPacket(const uint8_t *packet) {
  displayPacketsCount++;
  int rawGear = packet[4];
  bool light = (packet[9] & 0x08) != 0;

  // Handle Gear change
  if (rawGear != lastRawGear) {
    int mappedGear = calculateMappedGear(rawGear);
    setGear(mappedGear);
    lastRawGear = rawGear;
  }

  // Handle Light button change
  if (light != lastLightState) {
    displayLightState = light;

    // Secret combo unlock check: [1, 2, 3, 2, 3, 2, 3] + Light ON
    if (light && (memcmp(gearHistory, COMBO_KEY, 7) == 0)) {
      secretComboUnlocked = true;
      setGear(4);
      blePushLine("SECRET UNLOCK: S-Mode (Sport 40+ km/h) activated!");
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

  // Send packet to display every 150ms
  unsigned long now = millis();
  if (now - lastDisplayTxTime >= 150) {
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
    char buf[250];
    snprintf(buf, sizeof(buf), "SPD=%.1f G=%d S=%d V=%.2f RAW=%d BRK=%d AMP=%.1f PROF=%s LIM=%.0fkm/h KICK=%s(%.0f) GS=%d PINS[19=%d 21=%d] BPIN=%d BPOL=%s BC=%.1fA CAN=%d",
             vehicleSpeedKmH, currentGear, profileSSwitch ? 1 : 0,
             currentVoltageReading, currentRawThrottle, debouncedBrakeState ? 1 : 0,
             targetAmps, activeProfile.name, activeProfile.speedLimitKmH,
             (KICK_RPM_ERPM > 0.0f) ? "ON" : "ZERO", KICK_RPM_ERPM,
             (gearShiftEnabled && bleClientConnected) ? 1 : 0,
             digitalRead(19), digitalRead(21), brakePin, brakeActiveLow ? "LOW" : "HIGH", userBrakeAmps, slaveCanId);
    blePushLine(String(buf));
  } else if (cmd == "GS" || cmd == "GSHIFT") {
    blePushLine("GSHIFT is " + String((gearShiftEnabled && bleClientConnected) ? "ON (Display: 1->G2, 2->G3, 3->G4)" : "OFF (Display: 1->G1, 2->G2, 3->G3)"));
  } else if (cmd.startsWith("GSHIFT ") || cmd.startsWith("GS ")) {
    int val = 0;
    if (cmd.startsWith("GSHIFT ")) val = cmd.substring(7).toInt();
    else val = cmd.substring(3).toInt();
    gearShiftEnabled = (val != 0);
    if (!gearShiftEnabled) {
      secretComboUnlocked = false;
    }
    applyGearShiftState();
    blePushLine("GSHIFT set to " + String((gearShiftEnabled && bleClientConnected) ? "ON (Gears 2-4, G4 unlocked)" : "OFF (Gears 1-3, G4 locked)"));
  } else if (cmd.startsWith("G ") || cmd.startsWith("P ")) {
    int g = cmd.substring(2).toInt();
    if (g >= 1 && g <= 4) {
      if (gearShiftEnabled && bleClientConnected && g == 1) {
        g = 2; // In Gear Shift mode, there is no 1st gear
      }
      setGear(g);
      char pbuf[140];
      snprintf(pbuf, sizeof(pbuf), "PROFILE %d: %s (Limit: %.0f km/h, %.0f ERPM, %.0f A, %s)",
               g, activeProfile.name, activeProfile.speedLimitKmH, activeProfile.maxErpm, activeProfile.maxCurrentAmps,
               (KICK_RPM_ERPM > 0.0f) ? "Kick-start" : "Zero-start");
      blePushLine(String(pbuf));
    } else {
      blePushLine("ERR profile 1..4 (1=10km/h, 2=15km/h, 3=25km/h, 4=40km/h)");
    }
  } else if (cmd.startsWith("BP ")) {
    int p = cmd.substring(3).toInt();
    if (p == 0 || p == 19 || p == 21 || p == 18 || p == 5 || p == 4) {
      brakePin = p;
      prefs.putInt("brake_pin", brakePin);
      if (brakePin > 0) {
        pinMode(brakePin, brakeActiveLow ? INPUT_PULLUP : INPUT_PULLDOWN);
        blePushLine("BRAKE PIN set to GPIO " + String(brakePin));
      } else {
        blePushLine("BRAKE PIN set to DUAL (both GPIO 19 and 21)");
      }
    } else {
      blePushLine("ERR valid pins: 0 (dual), 19, 21, 18, 5, 4");
    }
  } else if (cmd.startsWith("BPOL ")) {
    int pol = cmd.substring(5).toInt();
    brakeActiveLow = (pol != 0);
    prefs.putBool("brake_low", brakeActiveLow);
    pinMode(19, brakeActiveLow ? INPUT_PULLUP : INPUT_PULLDOWN);
    pinMode(21, brakeActiveLow ? INPUT_PULLUP : INPUT_PULLDOWN);
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
      kickErpmThreshold = k;
      prefs.putFloat("kick_th", kickErpmThreshold);
      updateKickStartForGear();
      blePushLine("KICK threshold set to " + String(kickErpmThreshold, 0) + " (Active: " + String(KICK_RPM_ERPM, 0) + ")");
    } else {
      blePushLine("ERR kick range 0..5000");
    }
  } else if (cmd == "K") {
    blePushLine("KICK Active: " + String(KICK_RPM_ERPM, 0) + " ERPM (" + ((KICK_RPM_ERPM > 0.0f) ? "Kick-start" : "Zero-start") + ", threshold=" + String(kickErpmThreshold, 0) + ")");
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
    blePushLine("S status | P [1-4] prof | G [1-4] gear | GS [0/1] shift | BP [0/19/21] pin | BPOL [0/1] pol | BC [amps] brake | CAN [id] | T [v b] test | K kick | R reboot");
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
  void onConnect(BLEServer *) { bleClientConnected = true; }
  void onDisconnect(BLEServer *) {
    bleClientConnected = false;
    bleOtaActive = false;
    gearShiftEnabled = false;
    secretComboUnlocked = false;
    applyGearShiftState();
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
  kickErpmThreshold = prefs.getFloat("kick_th", DEFAULT_KICK_ERPM);
  if (kickErpmThreshold < 0.0f) {
    kickErpmThreshold = DEFAULT_KICK_ERPM;
  }
  brakePin = prefs.getInt("brake_pin", 0);           // Default 0 = Dual pin (both 19 and 21)
  brakeActiveLow = prefs.getBool("brake_low", true); // Default Active LOW
  userBrakeAmps = prefs.getFloat("brake_amps", 25.0f);// Default 25A strong e-brake
  slaveCanId = prefs.getUChar("can_slave", 61);      // Default CAN ID 61

  // Set internal pullup/pulldown on both candidate brake pins (19 and 21)
  pinMode(19, brakeActiveLow ? INPUT_PULLUP : INPUT_PULLDOWN);
  pinMode(21, brakeActiveLow ? INPUT_PULLUP : INPUT_PULLDOWN);

  bleInit();

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

  // 3. Fast Brake Sensor Reading (Supports dual pin 19 & 21 or single pin)
  if (testModeActive) {
    debouncedBrakeState = testBrakeState;
    currentRawThrottle = (int)((testVoltage / 3.3f) * 4095.0f);
  } else {
    bool rawReading = false;
    if (brakePin == 0) {
      // Dual-pin mode: Trigger if EITHER Pin 19 or Pin 21 is active
      bool p19 = (digitalRead(19) == (brakeActiveLow ? LOW : HIGH));
      bool p21 = (digitalRead(21) == (brakeActiveLow ? LOW : HIGH));
      rawReading = p19 || p21;
    } else {
      rawReading = (digitalRead(brakePin) == (brakeActiveLow ? LOW : HIGH));
    }

    if (rawReading != rawBrakePinState) {
      lastBrakeStateChange = now;
      rawBrakePinState = rawReading;
    }
    if ((now - lastBrakeStateChange) > BRAKE_DEBOUNCE_MS) {
      debouncedBrakeState = rawBrakePinState;
    }

    // Fast 4-sample ADC read (takes ~80 microseconds total)
    int rawSum = 0;
    for (int i = 0; i < 4; i++) {
      rawSum += analogRead(THROTTLE_PIN);
    }
    currentRawThrottle = rawSum >> 2;
  }

  currentVoltageReading = (currentRawThrottle / 4095.0f) * 3.3f;

  // 4. Push brake flag to Slave VESC immediately on change
  if (debouncedBrakeState != lastSentBrakeState) {
    sendBrakeFlagToSlave(debouncedBrakeState);
    lastSentBrakeState = debouncedBrakeState;
  }

  // 5. Update Display UART (Non-blocking)
  processDisplayUart(vehicleSpeedMps);

  // 6. INSTANT ZERO-LATENCY Throttle Calculation
  float rawRatio = 0.0f;
  if (currentRawThrottle > THROTTLE_MIN_RAW) {
    rawRatio = (currentRawThrottle - THROTTLE_MIN_RAW) /
               (float)(THROTTLE_MAX_RAW - THROTTLE_MIN_RAW);
    rawRatio = constrain(rawRatio, 0.0f, 1.0f);
  } else {
    rawRatio = 0.0f; // Instant cutoff when below deadband!
  }

  // 7. Dispatch Motor Current at 50 Hz (every 20ms) with zero lag & full authority braking
  if (now - lastMotorCmdTime >= 20) {
    lastMotorCmdTime = now;

    // Detect brake release transition
    bool brakeJustReleased = (lastDebouncedBrakeState && !debouncedBrakeState);
    lastDebouncedBrakeState = debouncedBrakeState;

    if (kickBlocked && !debouncedBrakeState && !testModeActive) {
      targetAmps = 0.0f;
      targetBrakeAmps = 0.0f;
      sendDualCurrent(0.0f, 0.0f);
    } else if (debouncedBrakeState) {
      targetAmps = 0.0f;

      if (rawRatio <= 0.0f) {
        targetBrakeAmps = userBrakeAmps;
      } else {
        // Variable braking modulated by throttle (10A to 35A)
        targetBrakeAmps = MIN_VARIABLE_BRAKE +
                          (rawRatio * (MAX_VARIABLE_BRAKE - MIN_VARIABLE_BRAKE));
      }
      sendDualBrakeCurrent(targetBrakeAmps, targetBrakeAmps);
    } else {
      targetBrakeAmps = 0.0f;

      if (brakeJustReleased) {
        // Clear brake mode on VESC immediately upon release
        sendDualBrakeCurrent(0.0f, 0.0f);
        sendDualCurrent(0.0f, 0.0f);
      } else if (rawRatio > 0.01f) {
        targetAmps = rawRatio * activeProfile.maxCurrentAmps;
        sendDualCurrent(targetAmps, targetAmps);
      } else {
        targetAmps = 0.0f;
        sendDualCurrent(0.0f, 0.0f); // Freewheel / coasting on release
      }
    }
  }

  // 8. BLE notify live line at 5 Hz
  if (bleClientConnected && now - lastBleNotify > 200) {
    lastBleNotify = now;
    char buf[160];
    snprintf(buf, sizeof(buf), "SPD=%.1f G=%d S=%d V=%.2f RAW=%d BRK=%d AMP=%.1f KICK=%s",
             vehicleSpeedKmH, currentGear, profileSSwitch ? 1 : 0,
             currentVoltageReading, currentRawThrottle, debouncedBrakeState ? 1 : 0,
             targetAmps, kickBlocked ? "HELD" : "ROLL");
    blePushLine(String(buf));
  }

  // Yield to FreeRTOS scheduler (no delay)
  yield();
}
