#pragma once
#include <Arduino.h>

// ============================================================================
//                               PIN DEFINITIONS
// ============================================================================

// --- Display UART (UART0) ---
// Connected to Display at 1200 Baud (8N1)
#define PIN_DISPLAY_TX 1   // TX0
#define PIN_DISPLAY_RX 3   // RX0
#define DISPLAY_BAUD   1200

// --- VESC UART (UART2) ---
// Connected to VESC Master at 115200 Baud (8N1)
#define PIN_VESC_TX    17  // TX2 (GPIO 17)
#define PIN_VESC_RX    16  // RX2 (GPIO 16)
#define VESC_BAUD      115200

// --- Throttle Analog Input (ADC1) ---
#define PIN_THROTTLE   34  // GPIO 34 (ADC1_CH6) - 0 to 3.3V Analog Signal
#define THROTTLE_ADC_MIN  950   // Throttle min idle ADC count (adjust if needed)
#define THROTTLE_ADC_MAX  3600  // Throttle max full ADC count
#define THROTTLE_DEADBAND 50    // ADC counts deadband near min
#define THROTTLE_FAULT_LOW 400  // Wire disconnect fault below this
#define THROTTLE_FAULT_HIGH 4050// Short circuit fault above this

// --- Physical Inputs (Active LOW with internal pull-ups) ---
#define PIN_IN_BRAKE   21  // Brake sensor (pulls to GND when brake engaged)
#define PIN_IN_TURN_L  18  // Left turn switch (pulls to GND)
#define PIN_IN_TURN_R  19  // Right turn switch (pulls to GND)
#define PIN_IN_LIGHT   5   // Physical light switch (optional)

// --- Outputs to ABE Box / Relays / Transistors ---
#define PIN_OUT_BRAKE  2   // Brake light output (High = ON)
#define PIN_OUT_LIGHT  25  // Front light output (High = ON)
#define PIN_OUT_TURN_L 26  // Left turn signal output
#define PIN_OUT_TURN_R 4   // Right turn signal output

// ============================================================================
//                             VESC & MOTOR SETTINGS
// ============================================================================
#define CAN_SLAVE_ID       61      // CAN ID of the secondary/slave VESC
#define DUAL_MOTOR_ENABLED true    // True if driving dual VESCs via CAN

// Wheel & Motor specifications (from display.lisp)
#define WHEEL_DIAMETER_INCH 10.0f  // p06 in display.lisp
#define MOTOR_POLES         30     // p07 in display.lisp (magnets count = 15 pole pairs)
#define MOTOR_POLE_PAIRS    (MOTOR_POLES / 2)

// Speed calculation multiplier from display.lisp:
// display_speed = p07 * (v_m_s / (p06 * PI * 0.0254)) * 1.52069
#define SPEED_CALC_FACTOR   1.52069f

// ============================================================================
//                             DRIVE PROFILES
// ============================================================================
struct DriveProfile {
    float maxSpeedKmH;      // Max speed in km/h
    float maxCurrentAmps;   // Max motor current per VESC in Amperes
    bool isUnlocked;        // S-Mode flag
};

// Standard and Unlocked Profiles (matching display.lisp)
const DriveProfile PROFILE_1  = { 10.0f, 20.0f, false }; // Gear 1: 10 km/h, 20A
const DriveProfile PROFILE_2  = { 15.0f, 30.0f, false }; // Gear 2: 15 km/h, 30A
const DriveProfile PROFILE_3  = { 22.0f, 40.0f, false }; // Gear 3: 22 km/h, 40A
const DriveProfile PROFILE_S2 = { 100.0f, 30.0f, true }; // S-Mode Gear 2: 100 km/h, 30A
const DriveProfile PROFILE_S3 = { 100.0f, 90.0f, true }; // S-Mode Gear 3: 100 km/h, 90A

// Regen braking current when brake is pulled (0A for coasting/cutoff only, or >0 for active regen)
#define REGEN_BRAKE_CURRENT_AMPS 15.0f

// ============================================================================
//                             WIFI & WEB SETTINGS
// ============================================================================
#define WIFI_AP_SSID     "BikeLights"
#define WIFI_AP_PASSWORD "12345678"
#define BLINK_INTERVAL_MS 400
#define AUTO_OFF_TIME_MS  20000
#define DEBOUNCE_DELAY_MS 50
