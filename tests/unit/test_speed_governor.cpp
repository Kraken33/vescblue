#include <iostream>
#include <cmath>
#include <algorithm>

class SpeedGovernor {
public:
    SpeedGovernor() : integral(0.0f), lastTime(0) {}

    float update(float requestedCurrent, float currentSpeedKmH, float maxSpeedKmH, float dt) {
        if (requestedCurrent <= 0.05f) {
            integral = 0.0f;
            return 0.0f;
        }

        // Speed error
        float error = maxSpeedKmH - currentSpeedKmH;

        // If well below the speed limit (> 2.5 km/h below), allow full requested current and reset integral
        if (error > 2.5f) {
            integral = requestedCurrent;
            return requestedCurrent;
        }

        // PI Speed Limiter gains
        float Kp = 4.0f;   // Amps per km/h error
        float Ki = 2.0f;   // Integral gain

        integral += error * Ki * dt;
        // Anti-windup
        integral = std::max(0.0f, std::min(integral, requestedCurrent));

        float piCurrent = (Kp * error) + integral;
        piCurrent = std::max(0.0f, std::min(piCurrent, requestedCurrent));

        return piCurrent;
    }

    void reset() {
        integral = 0.0f;
    }

private:
    float integral;
    uint32_t lastTime;
};

int main() {
    SpeedGovernor gov;
    float maxSpeed = 10.0f;
    float requestedCurrent = 20.0f; // User pulling full throttle in Gear 1

    // Simulation: Unloaded bench motor (very low inertia J=0.01, friction B=0.02)
    float speed = 0.0f;
    float dt = 0.02f; // 50 Hz loop (20ms)

    std::cout << "--- Simulating Unloaded Motor Acceleration in Gear 1 (Max 10 km/h) ---" << std::endl;
    for (int step = 0; step <= 150; step++) {
        float current = gov.update(requestedCurrent, speed, maxSpeed, dt);

        // Simple motor model: a = (Current * Kt - Friction) / Mass
        // Kt = 15.0 km/h/s per Amp, Friction = speed * 0.1
        float accel = (current * 15.0f) - (speed * 0.2f);
        speed += accel * dt;
        if (speed < 0.0f) speed = 0.0f;

        if (step % 10 == 0) {
            std::cout << "Time " << (step * dt) << "s | Speed: " << speed << " km/h | Motor Current: " << current << " A" << std::endl;
        }
    }

    std::cout << "\nFinal steady-state speed: " << speed << " km/h (Target: " << maxSpeed << " km/h)" << std::endl;
    return 0;
}
