#!/usr/bin/env python3
"""Scooter Display Speed Emulator for FMD FT32F030 / IO-Hawk / VSETT Displays.

Emulates the scooter motor controller sending live speed packets to the display
over UART (1200 Baud, 8N1) based on the exact protocol and constants in vescblue.ino.

Usage:
  python3 emulate_display_speed.py --mock                    # Simulation / dry-run (no hardware required)
  python3 emulate_display_speed.py --port /dev/cu.usbserial  # Real serial connection
  python3 emulate_display_speed.py --mode ramp               # Smooth 0 -> 80 -> 0 km/h cycle (default)
  python3 emulate_display_speed.py --mode steps              # Step through test speeds (10, 20, 25, 45, etc.)
  python3 emulate_display_speed.py --mode interactive        # Live keyboard control (+, -, space, set speed)
  python3 emulate_display_speed.py --speed 50                # Fixed 50 km/h stream
"""

import argparse
import glob
import math
import os
import select
import sys
import threading
import time

# =========================================================================
# Protocol Constants (from vescblue.ino)
# =========================================================================
DEFAULT_WHEEL_INCH = 10.0      # P06_WHEEL_DIAMETER_INCH
DEFAULT_MAGNET_POLES = 30.0    # P07_MAGNET_POLES (15 pole pairs)
DEFAULT_SPEED_FACTOR = 1.52069 # SPEED_CALC_FACTOR
DEFAULT_BAUD = 1200            # DISPLAY_BAUD (1200 baud, 8N1)
DEFAULT_INTERVAL_SEC = 0.200   # 200ms packet interval (125ms wire + 75ms idle gap)

ENCODING_KEY_ARRAY = [
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
    0x76, 0x7b, 0x74, 0x79, 0x22, 0x27, 0x20, 0x25
]

ENCODED_BYTES = [3, 4, 5, 7, 8, 9, 10, 11, 12, 13]


def xor_crc(data: bytes, length: int) -> int:
    crc = 0
    for i in range(length):
        crc ^= data[i]
    return crc


def calculate_display_speed(speed_kmh: float, wheel_inch: float = DEFAULT_WHEEL_INCH,
                            poles: float = DEFAULT_MAGNET_POLES,
                            factor: float = DEFAULT_SPEED_FACTOR) -> int:
    """Calculate the 16-bit raw speed integer expected by the display firmware."""
    speed_mps = speed_kmh / 3.6
    if speed_mps <= 0.05:
        return 0
    wheel_circ_meters = wheel_inch * math.pi * 0.0254
    rotations_per_sec = speed_mps / wheel_circ_meters
    disp_speed = poles * rotations_per_sec * factor
    return max(0, min(65535, int(round(disp_speed))))


def build_tx_packet(counter: int, disp_speed: int, sport_mode: bool = True,
                    target_gear: int = 0, turn_left: bool = False,
                    turn_right: bool = False, ble_connected: bool = False) -> bytes:
    """Construct and encrypt a 15-byte display packet (vescblue.ino sendDisplayTxPacket)."""
    buf = bytearray(15)

    # Byte 0: Header
    buf[0] = 0x36

    # Byte 1: Rolling counter
    buf[1] = counter & 0xFF

    # Byte 4: BLE connected (0x80) + S-Mode flag (0x20) + gear override (0x03)
    if ble_connected:
        buf[4] |= 0x80
    if sport_mode:
        buf[4] |= 32
    if 1 <= target_gear <= 3:
        buf[4] |= (target_gear & 0x03)

    # Bytes 7 & 8: Speed in Big Endian
    buf[7] = (disp_speed >> 8) & 0xFF
    buf[8] = disp_speed & 0xFF

    # Byte 13: Turn signal indicators on display LCD (bit 7 = Left, bit 6 = Right)
    if turn_left:
        buf[13] |= 0x80
    if turn_right:
        buf[13] |= 0x40

    # Encryption: add rolling key from table to selected bytes
    enc_key = ENCODING_KEY_ARRAY[counter % 128]
    for idx in ENCODED_BYTES:
        buf[idx] = (buf[idx] + enc_key) % 256

    # Byte 14: XOR Checksum over first 14 bytes
    buf[14] = xor_crc(buf, 14)

    return bytes(buf)


# =========================================================================
# Serial Port Abstraction (works with pyserial OR native termios)
# =========================================================================
class SerialChannel:
    def __init__(self, port_name: str, baud: int = DEFAULT_BAUD):
        self.port_name = port_name
        self.baud = baud
        self.fd = None
        self.py_serial = None

        if port_name.lower() in ("mock", "sim", "none"):
            self.mock = True
            return

        self.mock = False
        try:
            import serial
            self.py_serial = serial.Serial(port_name, baud, timeout=0.05)
        except ImportError:
            # Fallback to native termios (macOS & Linux standard library)
            import termios, tty
            self.fd = os.open(port_name, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
            tty.setraw(self.fd)
            attrs = termios.tcgetattr(self.fd)
            # Set 1200 baud
            baud_const = getattr(termios, f"B{baud}", termios.B1200)
            attrs[4] = baud_const  # ispeed
            attrs[5] = baud_const  # ospeed
            attrs[2] &= ~termios.PARENB  # No parity
            attrs[2] &= ~termios.CSTOPB  # 1 stop bit
            attrs[2] &= ~termios.CSIZE
            attrs[2] |= termios.CS8       # 8 data bits
            attrs[2] |= termios.CREAD | termios.CLOCAL
            attrs[0] = 0
            attrs[1] = 0
            attrs[3] = 0
            termios.tcsetattr(self.fd, termios.TCSANOW, attrs)

    def write(self, data: bytes):
        if self.mock:
            return
        if self.py_serial:
            self.py_serial.write(data)
        elif self.fd is not None:
            os.write(self.fd, data)

    def read(self, max_bytes: int = 64) -> bytes:
        if self.mock:
            return b""
        if self.py_serial:
            return self.py_serial.read(max_bytes)
        elif self.fd is not None:
            r, _, _ = select.select([self.fd], [], [], 0.01)
            if r:
                try:
                    return os.read(self.fd, max_bytes)
                except BlockingIOError:
                    return b""
        return b""

    def close(self):
        if self.py_serial:
            self.py_serial.close()
        elif self.fd is not None:
            os.close(self.fd)


def find_serial_ports():
    ports = glob.glob("/dev/cu.usbserial*") + glob.glob("/dev/cu.usbmodem*") + \
            glob.glob("/dev/ttyUSB*") + glob.glob("/dev/ttyACM*")
    return sorted(ports)


# =========================================================================
# Terminal Dashboard & Live Controller
# =========================================================================
class DisplayEmulator:
    def __init__(self, channel: SerialChannel, wheel_inch: float = DEFAULT_WHEEL_INCH,
                 poles: float = DEFAULT_MAGNET_POLES, factor: float = DEFAULT_SPEED_FACTOR,
                 interval: float = DEFAULT_INTERVAL_SEC):
        self.channel = channel
        self.wheel_inch = wheel_inch
        self.poles = poles
        self.factor = factor
        self.interval = interval

        self.current_speed_kmh = 0.0
        self.target_speed_kmh = 0.0
        self.sport_mode = True
        self.counter = 0
        self.running = True

        # RX parser state
        self.rx_buffer = bytearray()
        self.last_gear = 1
        self.last_light = False
        self.rx_packet_count = 0

    def parse_rx(self, chunk: bytes):
        """Parse incoming packets from the display (Header: 0x01 0x03)."""
        for b in chunk:
            if len(self.rx_buffer) == 0:
                if b == 0x01:
                    self.rx_buffer.append(b)
            elif len(self.rx_buffer) == 1:
                if b == 0x03:
                    self.rx_buffer.append(b)
                elif b == 0x01:
                    self.rx_buffer = bytearray([0x01])
                else:
                    self.rx_buffer.clear()
            else:
                self.rx_buffer.append(b)
                if len(self.rx_buffer) >= 15:
                    if self.rx_buffer[14] == xor_crc(self.rx_buffer, 14):
                        self.rx_packet_count += 1
                        raw_gear = self.rx_buffer[4]
                        self.last_gear = 3 if raw_gear in (3, 15) else max(1, min(3, raw_gear))
                        self.last_light = bool(self.rx_buffer[9] & 0x08)
                    self.rx_buffer.clear()

    def send_tick(self):
        """Build and send a single 15-byte packet to the display."""
        self.counter = (self.counter + 1) & 0xFF
        disp_speed = calculate_display_speed(self.current_speed_kmh, self.wheel_inch, self.poles, self.factor)
        pkt = build_tx_packet(self.counter, disp_speed, self.sport_mode)
        self.channel.write(pkt)

        # Read any incoming telemetry from the display
        rx = self.channel.read(64)
        if rx:
            self.parse_rx(rx)

        return pkt, disp_speed

    def draw_dashboard(self, pkt: bytes, disp_speed: int):
        """Render clean live terminal dashboard."""
        bar_len = 30
        max_bar_speed = 100.0
        filled = int((self.current_speed_kmh / max_bar_speed) * bar_len)
        filled = max(0, min(bar_len, filled))
        bar = "█" * filled + "░" * (bar_len - filled)

        unlocked_flag = "✓ UNLOCKED (S-Mode: 32)" if self.sport_mode else "✗ LOCKED (S-Mode: 0)"
        light_flag = "ON 💡" if self.last_light else "OFF"

        hex_pkt = " ".join(f"{b:02X}" for b in pkt)

        sys.stdout.write(
            f"\r\033[K"
            f"Speed: \033[1;32m{self.current_speed_kmh:5.1f} km/h\033[0m "
            f"[{bar}]  "
            f"Raw: {disp_speed:4d} | "
            f"Pkt #{self.counter:03d} | "
            f"{unlocked_flag} | "
            f"Disp: G{self.last_gear} Light={light_flag} | "
            f"TX: {hex_pkt}"
        )
        sys.stdout.flush()


# =========================================================================
# Test Modes
# =========================================================================
def run_ramp_mode(emu: DisplayEmulator, max_speed: float, step: float):
    """Accelerate smoothly to max_speed, hold, decelerate to 0, and repeat."""
    print(f"\n[Ramp Mode] Cycling 0.0 -> {max_speed:.1f} km/h (Smooth sweep). Press Ctrl+C to stop.\n")
    speed = 0.0
    direction = 1.0

    while emu.running:
        if direction > 0:
            speed += step
            if speed >= max_speed:
                speed = max_speed
                # Hold top speed for 2.5 seconds
                for _ in range(int(2.5 / emu.interval)):
                    emu.current_speed_kmh = speed
                    pkt, raw = emu.send_tick()
                    emu.draw_dashboard(pkt, raw)
                    time.sleep(emu.interval)
                direction = -1.0
        else:
            speed -= step
            if speed <= 0.0:
                speed = 0.0
                # Hold zero for 1.5 seconds
                for _ in range(int(1.5 / emu.interval)):
                    emu.current_speed_kmh = speed
                    pkt, raw = emu.send_tick()
                    emu.draw_dashboard(pkt, raw)
                    time.sleep(emu.interval)
                direction = 1.0

        emu.current_speed_kmh = speed
        pkt, raw = emu.send_tick()
        emu.draw_dashboard(pkt, raw)
        time.sleep(emu.interval)


def run_steps_mode(emu: DisplayEmulator, hold_sec: float = 3.0):
    """Step through standard test speeds to verify speedometer linearity."""
    speeds = [0.0, 10.0, 15.0, 20.0, 22.0, 25.0, 30.0, 45.0, 60.0, 80.0, 99.0]
    print(f"\n[Steps Mode] Testing speeds: {speeds} (Holding each for {hold_sec}s). Press Ctrl+C to stop.\n")

    while emu.running:
        for s in speeds:
            emu.current_speed_kmh = s
            ticks = int(hold_sec / emu.interval)
            for _ in range(ticks):
                if not emu.running:
                    return
                pkt, raw = emu.send_tick()
                emu.draw_dashboard(pkt, raw)
                time.sleep(emu.interval)


def run_interactive_mode(emu: DisplayEmulator):
    """Interactive real-time speed adjustment via keyboard input."""
    print("\n[Interactive Mode] Controls:")
    print("  Type any number (e.g. '45' <Enter>) to set exact speed")
    print("  '+' / '-' to adjust speed by 2 km/h")
    print("  's' / 'space' for emergency stop (0 km/h)")
    print("  'u' to toggle Sport/Unlocked mode")
    print("  'q' to exit\n")

    def input_thread():
        while emu.running:
            try:
                line = sys.stdin.readline().strip().lower()
                if line in ("q", "quit", "exit"):
                    emu.running = False
                    break
                elif line in ("+", "w"):
                    emu.current_speed_kmh = min(199.0, emu.current_speed_kmh + 2.0)
                elif line in ("-", "x"):
                    emu.current_speed_kmh = max(0.0, emu.current_speed_kmh - 2.0)
                elif line in ("s", "0", ""):
                    emu.current_speed_kmh = 0.0
                elif line == "u":
                    emu.sport_mode = not emu.sport_mode
                else:
                    try:
                        val = float(line)
                        emu.current_speed_kmh = max(0.0, min(199.0, val))
                    except ValueError:
                        pass
            except Exception:
                break

    t = threading.Thread(target=input_thread, daemon=True)
    t.start()

    while emu.running:
        pkt, raw = emu.send_tick()
        emu.draw_dashboard(pkt, raw)
        time.sleep(emu.interval)


def run_fixed_mode(emu: DisplayEmulator, speed: float):
    """Transmit a constant speed."""
    print(f"\n[Fixed Mode] Streaming constant {speed:.1f} km/h. Press Ctrl+C to stop.\n")
    emu.current_speed_kmh = speed
    while emu.running:
        pkt, raw = emu.send_tick()
        emu.draw_dashboard(pkt, raw)
        time.sleep(emu.interval)


# =========================================================================
# Main Entry Point
# =========================================================================
def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("-p", "--port", default=None,
                        help="Serial port (e.g. /dev/cu.usbserial-xxx). Defaults to auto-detect or mock.")
    parser.add_argument("-m", "--mode", choices=["ramp", "steps", "interactive", "fixed"],
                        default="ramp", help="Test mode (default: ramp)")
    parser.add_argument("-s", "--speed", type=float, default=None,
                        help="Constant speed in km/h (forces --mode fixed)")
    parser.add_argument("--max-speed", type=float, default=80.0,
                        help="Maximum sweep speed for ramp mode in km/h (default: 80)")
    parser.add_argument("--ramp-step", type=float, default=1.0,
                        help="Speed change per 150ms packet in ramp mode (default: 1.0 km/h)")
    parser.add_argument("--mock", action="store_true",
                        help="Dry-run / simulation mode without physical serial hardware")
    parser.add_argument("--wheel", type=float, default=DEFAULT_WHEEL_INCH,
                        help="Wheel diameter in inches (default: 10.0)")
    parser.add_argument("--poles", type=float, default=DEFAULT_MAGNET_POLES,
                        help="Motor magnet poles (default: 30)")
    parser.add_argument("--factor", type=float, default=DEFAULT_SPEED_FACTOR,
                        help="Speed calc factor (default: 1.52069)")
    args = parser.parse_args()

    port = args.port
    if args.mock:
        port = "mock"
    elif port is None:
        detected = find_serial_ports()
        if detected:
            port = detected[0]
            print(f"[Auto-detect] Found serial port: {port}")
        else:
            print("[Note] No physical USB-Serial adapter detected. Defaulting to --mock simulation.")
            print("       Connect a USB-UART adapter (TX to Display RX, GND to GND) or pass --port <device>.")
            port = "mock"

    channel = SerialChannel(port, DEFAULT_BAUD)
    emu = DisplayEmulator(channel, wheel_inch=args.wheel, poles=args.poles, factor=args.factor)

    print("==================================================================")
    print("   Scooter Display Speed Emulator (vescblue.ino Protocol)         ")
    print("==================================================================")
    print(f" Port       : {port} (1200 Baud, 8N1)")
    print(f" Wheel / Pol: {args.wheel}\" / {args.poles} poles (Factor: {args.factor})")
    print(f" Interval   : {DEFAULT_INTERVAL_SEC * 1000:.0f} ms")
    print(f" Mode       : {'fixed (' + str(args.speed) + ' km/h)' if args.speed is not None else args.mode}")
    print("==================================================================")

    try:
        if args.speed is not None:
            run_fixed_mode(emu, args.speed)
        elif args.mode == "ramp":
            run_ramp_mode(emu, max_speed=args.max_speed, step=args.ramp_step)
        elif args.mode == "steps":
            run_steps_mode(emu)
        elif args.mode == "interactive":
            run_interactive_mode(emu)
    except KeyboardInterrupt:
        print("\n\n[Stopped by user]")
    finally:
        emu.running = False
        channel.close()
        print("Serial channel closed. Done.\n")


if __name__ == "__main__":
    main()
