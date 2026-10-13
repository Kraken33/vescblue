import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Platform,
  PermissionsAndroid,
  useWindowDimensions,
  NativeModules,
  Switch,
  AppState,
  AppStateStatus,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import Slider from '@react-native-community/slider';
import Svg, { Path, Defs, LinearGradient, Stop } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { BleManager, Device, Characteristic, Subscription } from 'react-native-ble-plx';
import { Buffer } from 'buffer';

// BLE UUIDs for ESP32 VESC Controller
const BLE_SVC_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const BLE_CONSOLE_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

// BLE UUIDs for ESP32 Antispark Keyless Controller
const BLE_ANTISPARK_SVC_UUID = '6e400010-b5a3-f393-e0a9-e50e24dcca9e';
const BLE_ANTISPARK_CTRL_UUID = '6e400011-b5a3-f393-e0a9-e50e24dcca9e';

// BleManager instance singleton (safe for iOS Simulator where Bluetooth is unavailable)
let bleManager: BleManager | null = null;

const getBleManager = (): BleManager | null => {
  if (!NativeModules.BlePlx) return null;
  if (!bleManager) {
    try {
      bleManager = new BleManager();
    } catch (err) {
      console.warn('BleManager initialization skipped or failed:', err);
      return null;
    }
  }
  return bleManager;
};

export default function App() {
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  const isIOS = Platform.OS === 'ios';

  // Dynamic Island, Notch, & Home Bar Insets (Pure JS - zero native library dependencies)
  // On iPhone 14 Pro, 15, 16 series, Dynamic Island in landscape sits on the left or right edge (~56-59px).
  // In portrait, it sits at the top (~54px).
  const islandInsetLeft = isLandscape ? (isIOS ? 56 : 24) : 16;
  const islandInsetRight = isLandscape ? (isIOS ? 56 : 24) : 16;
  const safeTop = isLandscape ? (isIOS ? 10 : 8) : (isIOS ? 54 : 24);
  const safeBottom = isLandscape ? (isIOS ? 12 : 8) : (isIOS ? 24 : 16);

  // Available landscape content width strictly inside safe margins
  const landscapePageWidth = Math.max(width - islandInsetLeft - islandInsetRight, 280);

  // Connection State
  const [device, setDevice] = useState<Device | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [statusText, setStatusText] = useState('Ready to Connect');
  const [isScanning, setIsScanning] = useState(false);

  // Telemetry State
  const [speed, setSpeed] = useState(0.0);
  const [voltage, setVoltage] = useState('--');
  const [targetAmps, setTargetAmps] = useState('0.0');
  const [throttleRaw, setThrottleRaw] = useState('--');
  const [isBraking, setIsBraking] = useState(false);
  const [brakeEnabled, setBrakeEnabled] = useState(true);
  const [activeGear, setActiveGear] = useState(1);
  const [brakeAmps, setBrakeAmps] = useState(25);
  const [gearShiftEnabled, setGearShiftEnabled] = useState(true);
  const [cruiseEnabled, setCruiseEnabled] = useState(false);
  const [cruiseActive, setCruiseActive] = useState(false);
  const [cruiseStatus, setCruiseStatus] = useState<'OFF' | 'ARMED' | 'ACTIVE' | 'G4'>('OFF');
  const [landscapeTab, setLandscapeTab] = useState<'drive' | 'settings'>('drive');
  const pagerRef = useRef<ScrollView | null>(null);

  const switchLandscapePage = (page: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setLandscapeTab(page === 0 ? 'drive' : 'settings');
    pagerRef.current?.scrollTo({ x: page * landscapePageWidth, animated: true });
  };

  // Console State
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [consoleLines, setConsoleLines] = useState<string[]>(['Scooter Native BLE Ready']);
  const [customCmd, setCustomCmd] = useState('');

  const [isDemoMode, setIsDemoMode] = useState(false);
  const demoIntervalRef = useRef<any>(null);

  // Refs for subscriptions and active characteristic
  const charRef = useRef<Characteristic | null>(null);
  const notifSubRef = useRef<Subscription | null>(null);
  const isWritingRef = useRef(false);

  // Antispark Smart Key State
  const [antisparkDevice, setAntisparkDevice] = useState<Device | null>(null);
  const [isAntisparkConnected, setIsAntisparkConnected] = useState(false);
  const [antisparkStatusText, setAntisparkStatusText] = useState('Disconnected');
  const [isAntisparkConnecting, setIsAntisparkConnecting] = useState(false);
  const [antisparkState, setAntisparkState] = useState(false); // true = ON (GPIO 10 HIGH), false = OFF (GPIO 10 LOW)
  const [autoKeyEnabled, setAutoKeyEnabled] = useState(true);
  const [antisparkRssi, setAntisparkRssi] = useState<number | null>(null);
  const [filteredRssi, setFilteredRssi] = useState<number | null>(null);
  const [proximityZone, setProximityZone] = useState<'immediate' | 'in_zone' | 'edge' | 'out_of_zone' | 'disconnected'>('disconnected');
  const [exitCountdown, setExitCountdown] = useState<number | null>(null);
  const [motionLockActive, setMotionLockActive] = useState(false);
  const [smartKeySettingsOpen, setSmartKeySettingsOpen] = useState(false);

  // Proximity Thresholds
  const [enterThreshold, setEnterThreshold] = useState(-70); // dBm
  const [exitThreshold, setExitThreshold] = useState(-85); // dBm
  const [exitDelaySec, setExitDelaySec] = useState(8); // seconds

  // Antispark Refs (synchronized for interval and BLE callbacks)
  const antisparkCharRef = useRef<Characteristic | null>(null);
  const antisparkNotifSubRef = useRef<Subscription | null>(null);
  const isAntisparkWritingRef = useRef(false);
  const rssiPollIntervalRef = useRef<any>(null);
  const exitCountdownTimerRef = useRef<any>(null);
  const exitCountdownValRef = useRef<number | null>(null);
  const filteredRssiRef = useRef<number | null>(null);
  const speedRef = useRef<number>(0.0);
  const antisparkStateRef = useRef<boolean>(false);
  const autoKeyEnabledRef = useRef<boolean>(true);
  const enterThresholdRef = useRef<number>(-70);
  const exitThresholdRef = useRef<number>(-85);
  const exitDelaySecRef = useRef<number>(8);
  const manualDisconnectRef = useRef<boolean>(false);
  const autoReconnectTimerRef = useRef<any>(null);
  const savedAntisparkIdRef = useRef<string | null>(null);
  const isAntisparkConnectingRef = useRef<boolean>(false);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const antisparkDeviceRef = useRef<Device | null>(null);

  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);
  useEffect(() => {
    autoKeyEnabledRef.current = autoKeyEnabled;
  }, [autoKeyEnabled]);
  useEffect(() => {
    enterThresholdRef.current = enterThreshold;
  }, [enterThreshold]);
  useEffect(() => {
    exitThresholdRef.current = exitThreshold;
  }, [exitThreshold]);
  useEffect(() => {
    exitDelaySecRef.current = exitDelaySec;
  }, [exitDelaySec]);

  // Request Android Bluetooth Permissions
  const requestAndroidPermissions = async () => {
    if (Platform.OS === 'android') {
      try {
        await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        ]);
      } catch (err) {
        console.warn('Android permissions error:', err);
      }
    }
  };

  // Helper to ensure Bluetooth hardware is in 'PoweredOn' state before scanning
  const waitForBluetoothPoweredOn = (mgr: BleManager): Promise<{ ok: boolean; reason?: string }> => {
    return new Promise(async (resolve) => {
      try {
        const state = await mgr.state();
        if (state === 'PoweredOn') {
          return resolve({ ok: true });
        }
        if (state === 'Unauthorized') {
          return resolve({ ok: false, reason: 'Bluetooth permission denied in iOS Settings' });
        }
        if (state === 'PoweredOff') {
          return resolve({ ok: false, reason: 'Bluetooth is turned OFF. Please enable it in Settings/Control Center' });
        }
      } catch (_) {}

      // Wait up to 5 seconds for state to change to PoweredOn
      let timeoutId: any;
      const sub = mgr.onStateChange((state) => {
        if (state === 'PoweredOn') {
          clearTimeout(timeoutId);
          sub.remove();
          resolve({ ok: true });
        } else if (state === 'Unauthorized') {
          clearTimeout(timeoutId);
          sub.remove();
          resolve({ ok: false, reason: 'Bluetooth permission denied' });
        } else if (state === 'PoweredOff') {
          clearTimeout(timeoutId);
          sub.remove();
          resolve({ ok: false, reason: 'Bluetooth is turned OFF' });
        }
      }, true);

      timeoutId = setTimeout(() => {
        sub.remove();
        resolve({ ok: false, reason: 'Bluetooth initialization timed out' });
      }, 5000);
    });
  };

  useEffect(() => {
    requestAndroidPermissions();
    // Warm up BLE manager on app startup so it is PoweredOn when user taps Connect
    getBleManager();
    return () => {
      disconnect();
      if (bleManager) {
        bleManager.destroy();
        bleManager = null;
      }
    };
  }, []);

  const addConsole = (msg: string) => {
    setConsoleLines((prev) => {
      const next = [...prev, msg];
      return next.length > 50 ? next.slice(-40) : next;
    });
  };

  // =========================================================================
  // Antispark Smart Key BLE & Proximity Engine (Instant Low-Latency Mode)
  // =========================================================================
  const updateProximityEvaluation = (currentRssi: number) => {
    const prev = filteredRssiRef.current;
    // Fast-attack on approach (85% weight) for zero-latency turn-on; smooth decay on exit
    const alpha = (prev === null || currentRssi > prev) ? 0.85 : 0.25;
    const filtered = prev === null ? currentRssi : alpha * currentRssi + (1 - alpha) * prev;
    filteredRssiRef.current = filtered;
    setFilteredRssi(Math.round(filtered));
    setAntisparkRssi(currentRssi);

    let zone: 'immediate' | 'in_zone' | 'edge' | 'out_of_zone' = 'edge';
    if (filtered >= -60) {
      zone = 'immediate';
    } else if (filtered >= enterThresholdRef.current) {
      zone = 'in_zone';
    } else if (filtered <= exitThresholdRef.current) {
      zone = 'out_of_zone';
    } else {
      zone = 'edge';
    }
    setProximityZone(zone);

    // Auto Proximity Key Engine
    if (autoKeyEnabledRef.current) {
      // Instant Trigger: If either raw RSSI or filtered RSSI crosses threshold
      if (currentRssi >= enterThresholdRef.current || filtered >= enterThresholdRef.current) {
        // In zone! Cancel any pending exit countdown
        if (exitCountdownTimerRef.current) {
          clearInterval(exitCountdownTimerRef.current);
          exitCountdownTimerRef.current = null;
        }
        exitCountdownValRef.current = null;
        setExitCountdown(null);
        setMotionLockActive(false);

        // Turn Antispark ON instantly if currently OFF
        if (!antisparkStateRef.current) {
          addConsole(`[ANTISPARK] Proximity detected (${currentRssi} dBm). Instant Auto-Power ON!`);
          sendAntisparkCmd('PWR 1');
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
      } else if (filtered <= exitThresholdRef.current) {
        // Out of zone!
        if (antisparkStateRef.current) {
          // If countdown is not ticking, start it
          if (!exitCountdownTimerRef.current) {
            let remaining = exitDelaySecRef.current;
            exitCountdownValRef.current = remaining;
            setExitCountdown(remaining);
            addConsole(`[ANTISPARK] Out of zone (${filtered.toFixed(0)} dBm). Starting ${remaining}s auto-off countdown...`);

            exitCountdownTimerRef.current = setInterval(() => {
              if (exitCountdownValRef.current !== null && exitCountdownValRef.current > 1) {
                exitCountdownValRef.current -= 1;
                setExitCountdown(exitCountdownValRef.current);
              } else {
                // Countdown reached 0
                clearInterval(exitCountdownTimerRef.current);
                exitCountdownTimerRef.current = null;
                exitCountdownValRef.current = null;
                setExitCountdown(null);

                // Check Motion Interlock before powering off
                if (speedRef.current > 0.5) {
                  setMotionLockActive(true);
                  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
                  addConsole(`[ANTISPARK] ⚠️ MOTION INTERLOCK! Speed is ${speedRef.current.toFixed(1)} km/h. Power-off BLOCKED!`);
                } else {
                  setMotionLockActive(false);
                  addConsole('[ANTISPARK] Proximity exit confirmed. Auto-Power OFF triggered.');
                  sendAntisparkCmd('PWR 0');
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                }
              }
            }, 1000);
          }
        }
      }
    }
  };

  const startRssiPolling = (dev: Device, intervalMs?: number) => {
    if (rssiPollIntervalRef.current) clearInterval(rssiPollIntervalRef.current);
    const ms = intervalMs ?? (appStateRef.current === 'active' ? 250 : 2000);
    rssiPollIntervalRef.current = setInterval(async () => {
      try {
        const updatedDev = await dev.readRSSI();
        if (updatedDev && typeof updatedDev.rssi === 'number') {
          updateProximityEvaluation(updatedDev.rssi);
        }
      } catch (_) {}
    }, ms);
  };

  // Adaptive background/foreground handling when screen is locked vs active
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      const prev = appStateRef.current;
      appStateRef.current = nextAppState;
      addConsole(`[APP] State: ${prev} -> ${nextAppState}`);

      if (nextAppState === 'active') {
        // Returned to foreground: switch to high-speed 250ms polling
        if (antisparkDeviceRef.current) {
          startRssiPolling(antisparkDeviceRef.current, 250);
        }
      } else {
        // Screen locked or backgrounded: throttle polling to 2000ms to save battery
        if (antisparkDeviceRef.current) {
          startRssiPolling(antisparkDeviceRef.current, 2000);
        }
      }
    });
    return () => subscription.remove();
  }, []);

  const sendAntisparkCmd = async (cmdStr: string) => {
    if (isDemoMode) {
      addConsole(`[SIM-ANTISPARK-TX] ${cmdStr}`);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      if (cmdStr === 'PWR 1' || cmdStr === 'ON') {
        antisparkStateRef.current = true;
        setAntisparkState(true);
      } else if (cmdStr === 'PWR 0' || cmdStr === 'OFF') {
        antisparkStateRef.current = false;
        setAntisparkState(false);
      }
      return;
    }

    if (cmdStr === 'PWR 0' || cmdStr === 'OFF') {
      if (speedRef.current > 0.5) {
        setMotionLockActive(true);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        addConsole(`[ANTISPARK] ⚠️ MOTION INTERLOCK! Speed is ${speedRef.current.toFixed(1)} km/h. Cannot turn off while moving!`);
        return;
      }
    }

    // Optimistic Zero-Latency UI feedback
    if (cmdStr === 'PWR 1' || cmdStr === 'ON') {
      antisparkStateRef.current = true;
      setAntisparkState(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } else if (cmdStr === 'PWR 0' || cmdStr === 'OFF') {
      antisparkStateRef.current = false;
      setAntisparkState(false);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }

    if (!antisparkCharRef.current) {
      addConsole(`[ANTISPARK] Cannot send '${cmdStr}' - Antispark not connected`);
      return;
    }

    try {
      const base64Data = Buffer.from(cmdStr, 'utf-8').toString('base64');
      // Use writeWithoutResponse for immediate radio transmission (no GATT round-trip latency)
      try {
        await antisparkCharRef.current.writeWithoutResponse(base64Data);
      } catch (_) {
        await antisparkCharRef.current.writeWithResponse(base64Data);
      }
      addConsole(`[ANTISPARK-TX] ${cmdStr}`);
    } catch (e: any) {
      console.warn('Antispark write error:', e);
      addConsole(`[ANTISPARK-ERR] ${e.message}`);
    }
  };

  const parseAntisparkTelemetry = (str: string) => {
    addConsole(`[ANTISPARK-RX] ${str}`);
    const pwrMatch = str.match(/PWR=(\d+)/);
    const autoMatch = str.match(/AUTO=(\d+)/);
    const toMatch = str.match(/TO=(\d+)/);

    if (pwrMatch) {
      const isPwrOn = pwrMatch[1] === '1';
      antisparkStateRef.current = isPwrOn;
      setAntisparkState(isPwrOn);
    }
    if (autoMatch) {
      const isAuto = autoMatch[1] === '1';
      autoKeyEnabledRef.current = isAuto;
      setAutoKeyEnabled(isAuto);
    }
    if (toMatch) {
      const toVal = parseInt(toMatch[1], 10);
      exitDelaySecRef.current = toVal;
      setExitDelaySec(toVal);
    }
  };

  // Background auto-reconnect is disabled: Connection is initiated manually via the dedicated app button
  const startAutoReconnect = () => {
    return;
  };

  const connectAntisparkDevice = async (scannedDev: Device) => {
    manualDisconnectRef.current = false;
    isAntisparkConnectingRef.current = true;
    setIsAntisparkConnecting(true);
    savedAntisparkIdRef.current = scannedDev.id;

    if (autoReconnectTimerRef.current) {
      clearTimeout(autoReconnectTimerRef.current);
      autoReconnectTimerRef.current = null;
    }
    // Cancel any pending countdown
    if (exitCountdownTimerRef.current) {
      clearInterval(exitCountdownTimerRef.current);
      exitCountdownTimerRef.current = null;
    }
    exitCountdownValRef.current = null;
    setExitCountdown(null);

    try {
      setAntisparkStatusText('Connecting to Antispark...');
      addConsole(`[ANTISPARK] Connecting to ${scannedDev.name || scannedDev.id}...`);
      const connected = await scannedDev.connect();
      setAntisparkDevice(connected);
      antisparkDeviceRef.current = connected;
      setIsAntisparkConnected(true);
      setAntisparkState(true);
      antisparkStateRef.current = true;
      setAntisparkStatusText('Connected • Power ON');
      addConsole('[ANTISPARK] Connected! Scooter power engaged.');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      connected.onDisconnected(() => {
        handleAntisparkDisconnected();
      });

      await connected.discoverAllServicesAndCharacteristics();
      const services = await connected.services();
      const antisparkSvc = services.find(
        (s) => s.uuid.toLowerCase() === BLE_ANTISPARK_SVC_UUID.toLowerCase()
      );
      if (!antisparkSvc) throw new Error('Antispark Service not found');

      const chars = await antisparkSvc.characteristics();
      const ctrlChar = chars.find(
        (c) => c.uuid.toLowerCase() === BLE_ANTISPARK_CTRL_UUID.toLowerCase()
      );
      if (!ctrlChar) throw new Error('Antispark Control Characteristic not found');

      antisparkCharRef.current = ctrlChar;

      // Subscribe to notifications
      antisparkNotifSubRef.current = ctrlChar.monitor((err, notifiedChar) => {
        if (err) return;
        if (notifiedChar && notifiedChar.value) {
          const text = Buffer.from(notifiedChar.value, 'base64').toString('ascii');
          parseAntisparkTelemetry(text);
        }
      });

      // Assert power ON command to ESP32
      setTimeout(() => {
        sendAntisparkCmd('PWR 1');
      }, 300);

      // Start RSSI polling for radar/signal bars (500ms)
      startRssiPolling(connected, 500);
    } catch (e: any) {
      console.warn('Antispark connect failed:', e);
      setAntisparkStatusText('Failed: ' + e.message);
      setIsAntisparkConnected(false);
      setIsAntisparkConnecting(false);
      isAntisparkConnectingRef.current = false;
      addConsole(`[ANTISPARK-ERR] ${e.message}`);
    } finally {
      isAntisparkConnectingRef.current = false;
      setIsAntisparkConnecting(false);
    }
  };

  const scanAndConnectAntispark = async () => {
    manualDisconnectRef.current = false;
    if (isAntisparkConnectingRef.current || isAntisparkConnected) return;

    isAntisparkConnectingRef.current = true;
    setIsAntisparkConnecting(true);

    if (autoReconnectTimerRef.current) {
      clearTimeout(autoReconnectTimerRef.current);
      autoReconnectTimerRef.current = null;
    }

    const manager = getBleManager();
    if (!manager) {
      setIsAntisparkConnected(true);
      setAntisparkState(true);
      antisparkStateRef.current = true;
      setAntisparkStatusText('Connected (Simulated)');
      setProximityZone('in_zone');
      setFilteredRssi(-65);
      filteredRssiRef.current = -65;
      setAntisparkRssi(-65);
      setIsAntisparkConnecting(false);
      isAntisparkConnectingRef.current = false;
      addConsole('[SIMULATOR] Antispark connected and powered ON.');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      return;
    }

    try {
      setAntisparkStatusText('Scanning for Antispark...');
      addConsole('[ANTISPARK] Scanning for Scooter-Antispark...');
      try { manager.stopDeviceScan(); } catch (_) {}

      // 8-second search timeout
      const scanTimeout = setTimeout(() => {
        try { manager.stopDeviceScan(); } catch (_) {}
        if (!antisparkCharRef.current && !isAntisparkConnected) {
          isAntisparkConnectingRef.current = false;
          setIsAntisparkConnecting(false);
          setAntisparkStatusText('Not found. Tap to retry.');
          addConsole('[ANTISPARK] Scooter-Antispark not detected nearby.');
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        }
      }, 8000);

      manager.startDeviceScan([BLE_ANTISPARK_SVC_UUID], { allowDuplicates: true }, async (error, scannedDevice) => {
        if (error) {
          clearTimeout(scanTimeout);
          setAntisparkStatusText('Scan error: ' + error.message);
          addConsole(`[ANTISPARK] Scan error: ${error.message}`);
          isAntisparkConnectingRef.current = false;
          setIsAntisparkConnecting(false);
          return;
        }
        if (!scannedDevice || !isAntisparkConnectingRef.current || isAntisparkConnected) return;

        const matchesName =
          scannedDevice.name === 'Scooter-Antispark' ||
          scannedDevice.localName === 'Scooter-Antispark';
        const matchesSvc =
          scannedDevice.serviceUUIDs &&
          scannedDevice.serviceUUIDs.some(
            (u) => u.toLowerCase() === BLE_ANTISPARK_SVC_UUID.toLowerCase()
          );
        const matchesId =
          savedAntisparkIdRef.current !== null &&
          scannedDevice.id === savedAntisparkIdRef.current;

        if (matchesName || matchesSvc || matchesId) {
          clearTimeout(scanTimeout);
          try { manager.stopDeviceScan(); } catch (_) {}
          connectAntisparkDevice(scannedDevice);
        }
      });
    } catch (e: any) {
      setAntisparkStatusText('Scan failed: ' + e.message);
      isAntisparkConnectingRef.current = false;
      setIsAntisparkConnecting(false);
    }
  };

  const disconnectAntispark = async () => {
    manualDisconnectRef.current = true;
    if (autoReconnectTimerRef.current) {
      clearTimeout(autoReconnectTimerRef.current);
      autoReconnectTimerRef.current = null;
    }
    const manager = getBleManager();
    if (manager) {
      try { manager.stopDeviceScan(); } catch (_) {}
    }

    if (rssiPollIntervalRef.current) {
      clearInterval(rssiPollIntervalRef.current);
      rssiPollIntervalRef.current = null;
    }
    if (exitCountdownTimerRef.current) {
      clearInterval(exitCountdownTimerRef.current);
      exitCountdownTimerRef.current = null;
    }
    exitCountdownValRef.current = null;
    setExitCountdown(null);

    if (antisparkNotifSubRef.current) {
      antisparkNotifSubRef.current.remove();
      antisparkNotifSubRef.current = null;
    }
    if (antisparkDevice) {
      try {
        await antisparkDevice.cancelConnection();
      } catch (e) {}
    }
    handleAntisparkDisconnected();
  };

  const handleAntisparkDisconnected = () => {
    setIsAntisparkConnected(false);
    setAntisparkDevice(null);
    antisparkDeviceRef.current = null;
    antisparkCharRef.current = null;
    setProximityZone('disconnected');
    setAntisparkRssi(null);
    setFilteredRssi(null);
    filteredRssiRef.current = null;

    if (exitCountdownTimerRef.current) {
      clearInterval(exitCountdownTimerRef.current);
      exitCountdownTimerRef.current = null;
    }
    exitCountdownValRef.current = null;
    setExitCountdown(null);

    if (autoReconnectTimerRef.current) {
      clearTimeout(autoReconnectTimerRef.current);
      autoReconnectTimerRef.current = null;
    }

    // Signal lost: immediately set power to OFF
    antisparkStateRef.current = false;
    setAntisparkState(false);
    setAntisparkStatusText('Disconnected (Power OFF)');
    addConsole('[ANTISPARK] Signal lost. Antispark turned OFF automatically.');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    const manager = getBleManager();
    if (manager) {
      try { manager.stopDeviceScan(); } catch (_) {}
    }
  };

  // Connect BLE (Multi-device: Scooter-ESP32 & Scooter-Antispark)
  const connectBle = async () => {
    const manager = getBleManager();
    if (!manager) {
      // In iOS Simulator, Bluetooth hardware does not exist
      setIsDemoMode(true);
      setIsConnected(true);
      setIsAntisparkConnected(true);
      setAntisparkState(true);
      antisparkStateRef.current = true;
      setAntisparkStatusText('Connected (Simulated)');
      setProximityZone('in_zone');
      setFilteredRssi(-65);
      filteredRssiRef.current = -65;
      setAntisparkRssi(-65);

      setStatusText('Simulator Demo (Active)');
      addConsole('[SIMULATOR] CoreBluetooth is unavailable on iOS Simulator.');
      addConsole('[SIMULATOR] Starting live cockpit & Antispark demonstration...');
      activateKeepAwakeAsync();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      let step = 0;
      if (demoIntervalRef.current) clearInterval(demoIntervalRef.current);
      demoIntervalRef.current = setInterval(() => {
        step++;
        const simSpeed = Math.min(25, Math.abs(Math.sin(step * 0.1) * 28));
        const simAmps = simSpeed > 2 ? Math.min(35, simSpeed * 1.2 + Math.random() * 2) : 0;
        const simVolt = 41.6 - simSpeed * 0.04;
        setSpeed(simSpeed);
        setVoltage(simVolt.toFixed(1));
        setTargetAmps(simAmps.toFixed(1));
        setThrottleRaw(simSpeed > 0 ? String(Math.floor(simSpeed * 110 + 850)) : '850');
      }, 200);
      return;
    }
    try {
      setIsScanning(true);
      setStatusText('Checking Bluetooth state...');
      addConsole('[BLE] Checking Bluetooth state...');

      const btStatus = await waitForBluetoothPoweredOn(manager);
      if (!btStatus.ok) {
        setStatusText(btStatus.reason || 'Bluetooth not ready');
        addConsole(`[BLE] Error: ${btStatus.reason}`);
        setIsScanning(false);
        return;
      }

      setStatusText('Scanning for Scooter & Antispark...');
      addConsole('[BLE] Scanning for Scooter-ESP32 and Scooter-Antispark...');

      manager.startDeviceScan(null, null, async (error, scannedDevice) => {
        if (error) {
          console.warn('Scan error:', error);
          setStatusText('Scan error: ' + error.message);
          setIsScanning(false);
          return;
        }

        // 1. Check for Scooter-ESP32 (Main controller)
        if (
          scannedDevice &&
          (scannedDevice.name === 'Scooter-ESP32' || scannedDevice.localName === 'Scooter-ESP32') &&
          !charRef.current
        ) {
          addConsole(`[BLE] Found ${scannedDevice.name}. Connecting...`);
          try {
            const connectedDevice = await scannedDevice.connect();
            setDevice(connectedDevice);
            setIsConnected(true);
            setStatusText('Connected to Scooter-ESP32');
            addConsole('[BLE] Main Scooter Connected!');
            activateKeepAwakeAsync();
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

            // Setup disconnect listener
            connectedDevice.onDisconnected(() => {
              handleDisconnected();
            });

            // Discover services and characteristics
            await connectedDevice.discoverAllServicesAndCharacteristics();
            const services = await connectedDevice.services();
            const service = services.find((s) => s.uuid.toLowerCase() === BLE_SVC_UUID.toLowerCase());
            if (!service) throw new Error('Scooter Service not found');

            const characteristics = await service.characteristics();
            const char = characteristics.find((c) => c.uuid.toLowerCase() === BLE_CONSOLE_UUID.toLowerCase());
            if (!char) throw new Error('Console Characteristic not found');

            charRef.current = char;

            // Subscribe to notifications
            notifSubRef.current = char.monitor((err, notifiedChar) => {
              if (err) {
                console.warn('Notification error:', err);
                return;
              }
              if (notifiedChar && notifiedChar.value) {
                const text = Buffer.from(notifiedChar.value, 'base64').toString('ascii');
                parseTelemetry(text);
              }
            });

            // Sync gear shift mode and query initial telemetry
            setTimeout(() => {
              sendCmd(gearShiftEnabled ? 'GS 1' : 'GS 0');
              setTimeout(() => sendCmd('S'), 200);
            }, 300);
          } catch (e: any) {
            console.warn('Main scooter connection failed:', e);
            setStatusText('Connect failed: ' + e.message);
            setIsConnected(false);
          }
        }

        // 2. Check for Scooter-Antispark (Secondary keyless controller)
        if (
          scannedDevice &&
          (scannedDevice.name === 'Scooter-Antispark' ||
            scannedDevice.localName === 'Scooter-Antispark' ||
            (savedAntisparkIdRef.current !== null && scannedDevice.id === savedAntisparkIdRef.current) ||
            (scannedDevice.serviceUUIDs && scannedDevice.serviceUUIDs.some((u) => u.toLowerCase() === BLE_ANTISPARK_SVC_UUID.toLowerCase()))) &&
          !antisparkCharRef.current &&
          !isAntisparkConnectingRef.current
        ) {
          connectAntisparkDevice(scannedDevice);
        }
      });

      // Stop scan after 12s if completed or timeout
      setTimeout(() => {
        manager.stopDeviceScan();
        setIsScanning(false);
        if (!charRef.current && !isConnected) {
          setStatusText('Scooter not found. Tap to retry.');
        }
      }, 12000);
    } catch (e: any) {
      console.warn('Scan exception:', e);
      setStatusText('Scan error: ' + e.message);
      setIsScanning(false);
    }
  };

  const disconnect = async () => {
    if (demoIntervalRef.current) {
      clearInterval(demoIntervalRef.current);
      demoIntervalRef.current = null;
    }
    setIsDemoMode(false);
    if (notifSubRef.current) {
      notifSubRef.current.remove();
      notifSubRef.current = null;
    }
    if (device) {
      try {
        await device.cancelConnection();
      } catch (e) {}
    }
    handleDisconnected();
    await disconnectAntispark();
  };

  const handleDisconnected = () => {
    setIsConnected(false);
    setDevice(null);
    charRef.current = null;
    setStatusText('Disconnected');
    addConsole('[BLE] Disconnected');
    deactivateKeepAwake();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  };

  // Parse Telemetry packet
  const parseTelemetry = (str: string) => {
    // Format: SPD=%.1f G=%d S=%d V=%.2f RAW=%d BRK=%d AMP=%.1f KICK=%s
    addConsole(str);

    const spdMatch = str.match(/SPD=([\d.]+)/);
    const gearMatch = str.match(/G=(\d+)/);
    const sMatch = str.match(/S=(\d+)/);
    const vMatch = str.match(/V=([\d.]+)/);
    const rawMatch = str.match(/RAW=(\d+)/);
    const brkMatch = str.match(/BRK=(\d+)/);
    const benMatch = str.match(/BEN=(\d+)/);
    const ampMatch = str.match(/AMP=([\d.]+)/);
    const bcMatch = str.match(/BC=([\d.]+)A/);
    const gsMatch = str.match(/GS=(\d+)/);
    const ccMatch = str.match(/CC=([A-Za-z0-9_]+)/);

    if (spdMatch) setSpeed(parseFloat(spdMatch[1]));
    if (vMatch) setVoltage(parseFloat(vMatch[1]).toFixed(1));
    if (ampMatch) setTargetAmps(parseFloat(ampMatch[1]).toFixed(1));
    if (rawMatch) setThrottleRaw(rawMatch[1]);
    if (brkMatch) setIsBraking(brkMatch[1] === '1');
    if (benMatch) setBrakeEnabled(benMatch[1] === '1');
    if (bcMatch) setBrakeAmps(parseFloat(bcMatch[1]));
    if (gsMatch) setGearShiftEnabled(gsMatch[1] === '1');

    if (ccMatch) {
      const ccVal = ccMatch[1];
      if (ccVal === '1') {
        setCruiseEnabled(true);
        setCruiseActive(false);
        setCruiseStatus('ARMED');
      } else if (ccVal === 'ACTIVE') {
        setCruiseEnabled(true);
        setCruiseActive(true);
        setCruiseStatus('ACTIVE');
      } else if (ccVal === 'G4') {
        setCruiseEnabled(true);
        setCruiseActive(false);
        setCruiseStatus('G4');
      } else {
        setCruiseEnabled(false);
        setCruiseActive(false);
        setCruiseStatus('OFF');
      }
    }

    if (str.includes('CRUISE: ENGAGED')) {
      setCruiseEnabled(true);
      setCruiseActive(true);
      setCruiseStatus('ACTIVE');
    } else if (str.includes('CRUISE: DISENGAGED')) {
      setCruiseActive(false);
      setCruiseStatus(activeGear >= 4 ? 'G4' : 'ARMED');
    } else if (str.includes('CRUISE: SUSPENDED')) {
      setCruiseActive(false);
      setCruiseStatus('G4');
    }

    if (gearMatch) {
      let g = parseInt(gearMatch[1], 10);
      let s = sMatch ? parseInt(sMatch[1], 10) : 0;
      if (g === 3 && s === 1) g = 4;
      setActiveGear(g);
    }
  };

  // Outgoing BLE commands
  const sendCmd = async (cmdStr: string) => {
    if (isDemoMode) {
      addConsole(`[SIM-TX] ${cmdStr}`);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      if (cmdStr.startsWith('P ')) {
        const g = parseInt(cmdStr.split(' ')[1], 10);
        if (g >= 1 && g <= 4) setActiveGear(g);
      } else if (cmdStr.startsWith('GS ')) {
        const en = cmdStr.split(' ')[1] === '1';
        setGearShiftEnabled(en);
        if (en && activeGear === 1) setActiveGear(2);
      } else if (cmdStr.startsWith('BEN ')) {
        const en = cmdStr.split(' ')[1] === '1';
        setBrakeEnabled(en);
      } else if (cmdStr.startsWith('CC ')) {
        const en = cmdStr.split(' ')[1] === '1';
        setCruiseEnabled(en);
        if (!en) {
          setCruiseActive(false);
          setCruiseStatus('OFF');
        } else {
          setCruiseStatus(activeGear >= 4 ? 'G4' : 'ARMED');
        }
      }
      return;
    }
    if (!charRef.current) return;
    if (isWritingRef.current) return;
    isWritingRef.current = true;

    try {
      const base64Data = Buffer.from(cmdStr, 'utf-8').toString('base64');
      await charRef.current.writeWithResponse(base64Data);
      addConsole(`[TX] ${cmdStr}`);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch (e: any) {
      console.warn('Write error:', e);
      addConsole(`[ERR] ${e.message}`);
    } finally {
      isWritingRef.current = false;
    }
  };

  const toggleGearShift = (val: boolean) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setGearShiftEnabled(val);
    sendCmd(`GS ${val ? 1 : 0}`);
    if (val && activeGear === 1) {
      setActiveGear(2);
    }
  };

  const toggleBrakeSensor = (val: boolean) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setBrakeEnabled(val);
    sendCmd(`BEN ${val ? 1 : 0}`);
  };

  const toggleCruiseControl = (val: boolean) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setCruiseEnabled(val);
    if (!val) {
      setCruiseActive(false);
      setCruiseStatus('OFF');
    } else {
      setCruiseStatus(activeGear >= 4 ? 'G4' : 'ARMED');
    }
    sendCmd(`CC ${val ? 1 : 0}`);
  };

  const selectProfile = (gear: number) => {
    if (gearShiftEnabled && gear === 1) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      addConsole('[INFO] 1st Gear bypassed in Gear Shift mode (Gears 2–4 active)');
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setActiveGear(gear);
    sendCmd(`P ${gear}`);
  };

  // Arc math: 180° semi-circle from (10, 50) to (90, 50), r=40
  // Arc length = π * 40 ≈ 125.66
  const arcLength = 125.66;
  const maxSpeed = 45.0;
  const ratio = Math.min(Math.max(speed / maxSpeed, 0), 1);
  const strokeOffset = arcLength - ratio * arcLength;

  // Render Components for Modular Screen Layouts
  const renderSpeedometer = () => (
    <View style={[styles.speedoHero, isLandscape && styles.speedoHeroLandscape]}>
      <View style={styles.gaugeBox}>
        <Svg width={isLandscape ? 170 : 180} height={isLandscape ? 95 : 105} viewBox="0 0 100 60">
          <Defs>
            <LinearGradient id="cyanGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <Stop offset="0%" stopColor="#00f2fe" />
              <Stop offset="50%" stopColor="#3b82f6" />
              <Stop offset="100%" stopColor="#9d4edd" />
            </LinearGradient>
          </Defs>
          <Path
            d="M 10 55 A 40 40 0 0 1 90 55"
            fill="none"
            stroke="rgba(255, 255, 255, 0.08)"
            strokeWidth="8"
            strokeLinecap="round"
          />
          <Path
            d="M 10 55 A 40 40 0 0 1 90 55"
            fill="none"
            stroke="url(#cyanGrad)"
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={`${arcLength}`}
            strokeDashoffset={strokeOffset}
          />
        </Svg>

        <View style={styles.speedTextWrap}>
          <Text style={[styles.speedNum, isLandscape && styles.speedNumLandscape]}>{speed.toFixed(1)}</Text>
          <Text style={styles.speedUnit}>KM / H</Text>
        </View>
      </View>

      {/* Badges */}
      <View style={styles.badgeRow}>
        <View style={[styles.badge, isBraking ? styles.badgeBraking : (!brakeEnabled ? styles.badgeDisabled : null)]}>
          <Text style={[styles.badgeText, isBraking && styles.badgeTextBraking]}>
            {!brakeEnabled ? '⚪ BRAKE OFF' : isBraking ? '🛑 BRAKING' : 'BRAKE OK'}
          </Text>
        </View>
        {cruiseEnabled && (
          <View style={[
            styles.badge,
            cruiseStatus === 'ACTIVE'
              ? styles.badgeCruiseActive
              : cruiseStatus === 'G4'
              ? styles.badgeCruiseG4
              : styles.badgeCruiseArmed
          ]}>
            <Text style={[
              styles.badgeText,
              cruiseStatus === 'ACTIVE'
                ? styles.badgeTextCruiseActive
                : cruiseStatus === 'G4'
                ? styles.badgeTextCruiseG4
                : styles.badgeTextCruiseArmed
            ]}>
              {cruiseStatus === 'ACTIVE' ? '🚀 CRUISING' : cruiseStatus === 'G4' ? '⏸️ CC PAUSED' : '🎯 CC ARMED'}
            </Text>
          </View>
        )}
      </View>
    </View>
  );

  const renderTelemetry = (inLandscapeMode = false) => (
    <View style={[styles.telemGrid, inLandscapeMode && styles.telemGridLandscape]}>
      <View style={[styles.telemBox, inLandscapeMode && styles.telemBoxLandscape]}>
        <Text style={styles.telemLabel}>BATTERY</Text>
        <Text style={styles.telemVal}>{voltage}</Text>
        <Text style={styles.telemUnit}>Volts</Text>
      </View>
      <View style={[styles.telemBox, inLandscapeMode && styles.telemBoxLandscape]}>
        <Text style={styles.telemLabel}>TARGET</Text>
        <Text style={styles.telemVal}>{targetAmps}</Text>
        <Text style={styles.telemUnit}>Amps</Text>
      </View>
      <View style={[styles.telemBox, inLandscapeMode && styles.telemBoxLandscape]}>
        <Text style={styles.telemLabel}>THROTTLE</Text>
        <Text style={styles.telemVal}>{throttleRaw}</Text>
        <Text style={styles.telemUnit}>ADC Raw</Text>
      </View>
    </View>
  );

  const renderProfiles = (inLandscapeMode = false) => (
    <View style={inLandscapeMode ? styles.profilesSectionLandscape : styles.profilesSection}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>SPEED PROFILES</Text>
        <Text style={styles.activeProfileLabel}>
          Gear {activeGear} {gearShiftEnabled ? '(Shifted 2–4)' : '(Standard 1–3)'}
        </Text>
      </View>

      <View style={[styles.profileGrid, inLandscapeMode && styles.profileGridLandscape]}>
        {[
          {
            gear: 1,
            name: 'Eco Mode',
            limit: '10 km/h',
            amps: '25A Max',
            color: '#10b981',
            handlebar: gearShiftEnabled ? 'Bypassed' : 'Disp 1',
          },
          {
            gear: 2,
            name: 'City Cruising',
            limit: '15 km/h',
            amps: '40A Max',
            color: '#00f2fe',
            handlebar: gearShiftEnabled ? 'Disp 1' : 'Disp 2',
          },
          {
            gear: 3,
            name: 'Drive Legal',
            limit: gearShiftEnabled ? '25 km/h' : '22 km/h',
            amps: '65A Max',
            color: '#f59e0b',
            handlebar: gearShiftEnabled ? 'Disp 2' : 'Disp 3',
          },
          {
            gear: 4,
            name: 'Sport Unlock',
            limit: '40+ km/h',
            amps: '120A Max',
            color: '#f43f5e',
            handlebar: gearShiftEnabled ? 'Disp 3 (Unlocked)' : 'Secret Locked',
          },
        ].map((p) => {
          const active = activeGear === p.gear;
          const isBypassed = gearShiftEnabled && p.gear === 1;
          return (
            <TouchableOpacity
              key={p.gear}
              style={[
                styles.profileCard,
                inLandscapeMode && styles.profileCardLandscape,
                active && { borderColor: p.color, backgroundColor: 'rgba(255, 255, 255, 0.08)' },
                isBypassed && styles.profileCardBypassed,
              ]}
              onPress={() => selectProfile(p.gear)}
              activeOpacity={isBypassed ? 1 : 0.7}
            >
              <View style={styles.pHeader}>
                <Text style={[styles.pGear, inLandscapeMode && styles.pGearLandscape, active && { color: p.color }]}>G{p.gear}</Text>
                <Text style={[styles.pLimit, inLandscapeMode && styles.pLimitLandscape]}>{p.limit}</Text>
              </View>
              <Text style={[styles.pName, inLandscapeMode && styles.pNameLandscape]} numberOfLines={1}>{p.name}</Text>
              <View style={styles.pFooterRow}>
                <Text style={[styles.pAmps, inLandscapeMode && styles.pAmpsLandscape]}>{p.amps}</Text>
                <View style={[styles.handlebarBadge, isBypassed && styles.handlebarBadgeBypassed, active && { borderColor: p.color }]}>
                  <Text style={[styles.handlebarBadgeText, active && { color: p.color }]}>{p.handlebar}</Text>
                </View>
              </View>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );

  const renderAntisparkCard = () => {
    // 5 visual bars calculation
    const currentRssi = filteredRssi ?? -100;
    const barLevels = [
      currentRssi >= -95,
      currentRssi >= -85,
      currentRssi >= -75,
      currentRssi >= -65,
      currentRssi >= -55,
    ];

    return (
      <View style={styles.antisparkCard}>
        {/* Header Row */}
        <View style={styles.antisparkHeaderRow}>
          <View style={styles.antisparkHeaderLeft}>
            <Text style={styles.antisparkTitle}>⚡ ANTISPARK POWER SWITCH</Text>
            <Text style={styles.antisparkSubStatus}>
              {isAntisparkConnected
                ? '⚡ Connected • Power Active'
                : isAntisparkConnecting
                ? '⏳ Scanning & Connecting...'
                : '⚪ Disconnected (Power OFF)'}
            </Text>
          </View>
        </View>

        {/* Dedicated Main Power Action Button */}
        <View style={styles.dedicatedPowerButtonWrap}>
          {isAntisparkConnected ? (
            <View style={styles.powerConnectedBox}>
              <View style={styles.powerConnectedTopRow}>
                <View style={styles.powerConnectedStatusDot} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.powerConnectedTitle}>⚡ SCOOTER POWERED ON</Text>
                  <Text style={styles.powerConnectedSub}>
                    GPIO 10 HIGH (3.3V) • Onboard LED ON • Auto-off when signal lost
                  </Text>
                </View>
              </View>
              <TouchableOpacity
                style={styles.btnDedicatedPowerDisconnect}
                onPress={disconnectAntispark}
                activeOpacity={0.8}
              >
                <Text style={styles.btnDedicatedPowerDisconnectText}>⚪ Turn OFF & Disconnect</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity
              style={[
                styles.btnDedicatedPowerConnect,
                isAntisparkConnecting && styles.btnDedicatedPowerConnectLoading,
              ]}
              onPress={isAntisparkConnecting ? undefined : scanAndConnectAntispark}
              activeOpacity={0.8}
              disabled={isAntisparkConnecting}
            >
              <Text style={styles.btnDedicatedPowerConnectIcon}>
                {isAntisparkConnecting ? '⏳' : '⚡'}
              </Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.btnDedicatedPowerConnectText}>
                  {isAntisparkConnecting ? 'CONNECTING TO ANTISPARK...' : 'CONNECT & POWER ON'}
                </Text>
                <Text style={styles.btnDedicatedPowerConnectSub}>
                  {isAntisparkConnecting
                    ? 'Scanning for Scooter-Antispark nearby...'
                    : 'Tap to connect to Scooter-Antispark and engage power'}
                </Text>
              </View>
            </TouchableOpacity>
          )}
        </View>

        {/* Automatic Cutoff Notice */}
        <View style={styles.autoCutoffNoticeBox}>
          <Text style={styles.autoCutoffNoticeText}>
            🛡️ <Text style={{ fontWeight: '700', color: '#38bdf8' }}>Automatic Power Cutoff:</Text> When you walk away or Bluetooth signal is lost, the Antispark turns OFF automatically. To reconnect and turn on, open the app and tap 'CONNECT & POWER ON'.
          </Text>
        </View>

        {/* Hero State Banner */}
        <View style={[styles.antisparkHero, antisparkState ? styles.antisparkHeroActive : styles.antisparkHeroInactive]}>
          <View style={styles.antisparkHeroContent}>
            <View style={styles.antisparkHeroTitleRow}>
              <Text style={[styles.antisparkHeroTitle, antisparkState && styles.antisparkHeroTitleActive]}>
                {antisparkState ? '⚡ ANTISPARK: ACTIVE' : '⚪ ANTISPARK: OFF'}
              </Text>
              <View style={[styles.antisparkStateTag, antisparkState ? styles.antisparkStateTagActive : styles.antisparkStateTagInactive]}>
                <Text style={[styles.antisparkStateTagText, antisparkState && styles.antisparkStateTagTextActive]}>
                  {antisparkState ? 'GPIO 10 HIGH' : 'GPIO 10 LOW'}
                </Text>
              </View>
            </View>
            <Text style={styles.antisparkHeroSub}>
              {antisparkState
                ? '⚡ System Power Engaged • Onboard LED (GPIO 8) ON'
                : '⚪ Standby • Onboard LED (GPIO 8) OFF • Scooter Depowered'}
            </Text>
          </View>
        </View>

        {/* Proximity Radar & Signal Bars */}
        <View style={styles.radarCard}>
          <View style={styles.radarRow}>
            <View style={[
              styles.radarPill,
              proximityZone === 'immediate'
                ? styles.radarPillImmediate
                : proximityZone === 'in_zone'
                ? styles.radarPillInZone
                : proximityZone === 'edge'
                ? styles.radarPillEdge
                : proximityZone === 'out_of_zone'
                ? styles.radarPillOut
                : styles.radarPillDisc
            ]}>
              <Text style={[
                styles.radarPillText,
                (proximityZone === 'immediate' || proximityZone === 'in_zone') && styles.radarPillTextGreen,
                proximityZone === 'edge' && styles.radarPillTextYellow,
                proximityZone === 'out_of_zone' && styles.radarPillTextRed,
              ]}>
                {proximityZone === 'immediate'
                  ? '🟢 IMMEDIATE (< 1m)'
                  : proximityZone === 'in_zone'
                  ? '🟢 IN REGISTERED ZONE (< 2m)'
                  : proximityZone === 'edge'
                  ? '🟡 ZONE BOUNDARY (~ 3-5m)'
                  : proximityZone === 'out_of_zone'
                  ? '🔴 OUT OF ZONE (> 5m)'
                  : '⚪ SEARCHING / DISCONNECTED'}
              </Text>
            </View>

            {/* RSSI Signal Meter */}
            <View style={styles.signalMeterWrap}>
              <Text style={styles.rssiValueText}>
                {filteredRssi !== null ? `${filteredRssi} dBm` : '-- dBm'}
              </Text>
              <View style={styles.signalBarsRow}>
                {barLevels.map((lvl, idx) => (
                  <View
                    key={idx}
                    style={[
                      styles.signalBar,
                      lvl && (proximityZone === 'out_of_zone' ? styles.signalBarRed : styles.signalBarActive),
                      { height: 6 + idx * 3 }
                    ]}
                  />
                ))}
              </View>
            </View>
          </View>
        </View>

        {/* Live Exit Countdown Alert */}
        {exitCountdown !== null && (
          <View style={styles.countdownAlertBox}>
            <Text style={styles.countdownAlertText}>
              ⏳ Auto Power-Off in {exitCountdown}s (Leaving proximity zone)
            </Text>
          </View>
        )}

        {/* Motion Safety Interlock Alert */}
        {(motionLockActive || (speed > 0.5 && proximityZone === 'out_of_zone')) && (
          <View style={styles.motionLockAlertBox}>
            <Text style={styles.motionLockAlertText}>
              🛡️ SAFETY INTERLOCK ACTIVE: Antispark shutoff blocked while scooter is moving ({speed.toFixed(1)} km/h)
            </Text>
          </View>
        )}

        {/* Auto Proximity Key Switch */}
        <View style={styles.autoKeySwitchRow}>
          <View style={styles.autoKeyTextCol}>
            <Text style={styles.controlLabel}>Auto Proximity Key</Text>
            <Text style={styles.gearShiftDesc}>
              {autoKeyEnabled
                ? 'Turns antispark ON when entering zone; turns OFF when walking away.'
                : 'Proximity automation paused. Use manual buttons below.'}
            </Text>
          </View>
          <Switch
            value={autoKeyEnabled}
            onValueChange={(val) => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              setAutoKeyEnabled(val);
              autoKeyEnabledRef.current = val;
              sendAntisparkCmd(`AUTO ${val ? 1 : 0}`);
            }}
            trackColor={{ false: '#1e293b', true: '#10b981' }}
            thumbColor={autoKeyEnabled ? '#ffffff' : '#64748b'}
            ios_backgroundColor="#1e293b"
          />
        </View>

        {/* Bench-Test Manual Controls */}
        <View style={styles.testSection}>
          <Text style={styles.testSectionTitle}>BENCH TEST CONTROLS (WITHOUT ANTISPARK WIRED)</Text>
          <View style={styles.testBtnRow}>
            <TouchableOpacity
              style={[styles.btnTestPower, styles.btnTestPowerOn, antisparkState && styles.btnTestPowerOnActive]}
              onPress={() => sendAntisparkCmd('PWR 1')}
              activeOpacity={0.7}
            >
              <Text style={styles.btnTestPowerOnText}>⚡ Force Test ON</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.btnTestPower, styles.btnTestPowerOff, !antisparkState && styles.btnTestPowerOffActive]}
              onPress={() => sendAntisparkCmd('PWR 0')}
              activeOpacity={0.7}
            >
              <Text style={styles.btnTestPowerOffText}>⚪ Force Test OFF</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Simulator Demo Proximity Triggers (when in Demo Mode) */}
        {isDemoMode && (
          <View style={styles.simDemoBox}>
            <Text style={styles.simDemoTitle}>SIMULATOR PROXIMITY TEST</Text>
            <View style={styles.testBtnRow}>
              <TouchableOpacity
                style={styles.btnSimApproach}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  updateProximityEvaluation(-63);
                }}
                activeOpacity={0.7}
              >
                <Text style={styles.btnSimApproachText}>🏃 Approach (-63 dBm)</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.btnSimWalkAway}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  updateProximityEvaluation(-89);
                }}
                activeOpacity={0.7}
              >
                <Text style={styles.btnSimWalkAwayText}>🚶 Walk Away (-89 dBm)</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Collapsible Zone Calibration & Sliders */}
        <TouchableOpacity
          style={styles.calibToggleHeader}
          onPress={() => setSmartKeySettingsOpen(!smartKeySettingsOpen)}
          activeOpacity={0.7}
        >
          <Text style={styles.calibToggleText}>⚙️ Zone Calibration & Watchdog Timers</Text>
          <Text style={styles.calibToggleIcon}>{smartKeySettingsOpen ? '▲' : '▼'}</Text>
        </TouchableOpacity>

        {smartKeySettingsOpen && (
          <View style={styles.calibBody}>
            {/* Entry Threshold Slider */}
            <View style={styles.sliderHeader}>
              <Text style={styles.controlLabel}>Entry Proximity (Turn ON)</Text>
              <Text style={styles.calibValGreen}>{enterThreshold} dBm (~2m)</Text>
            </View>
            <Slider
              style={styles.slider}
              minimumValue={-85}
              maximumValue={-55}
              step={1}
              value={enterThreshold}
              onValueChange={(val) => {
                setEnterThreshold(val);
                enterThresholdRef.current = val;
              }}
              minimumTrackTintColor="#10b981"
              maximumTrackTintColor="rgba(255, 255, 255, 0.15)"
              thumbTintColor="#10b981"
            />

            {/* Exit Threshold Slider */}
            <View style={styles.sliderHeader}>
              <Text style={styles.controlLabel}>Exit Proximity (Turn OFF)</Text>
              <Text style={styles.calibValRed}>{exitThreshold} dBm (~6-10m)</Text>
            </View>
            <Slider
              style={styles.slider}
              minimumValue={-95}
              maximumValue={-70}
              step={1}
              value={exitThreshold}
              onValueChange={(val) => {
                setExitThreshold(val);
                exitThresholdRef.current = val;
              }}
              minimumTrackTintColor="#f43f5e"
              maximumTrackTintColor="rgba(255, 255, 255, 0.15)"
              thumbTintColor="#f43f5e"
            />

            {/* Exit Delay Slider */}
            <View style={styles.sliderHeader}>
              <Text style={styles.controlLabel}>Exit Debounce Grace Delay</Text>
              <Text style={styles.calibValAmber}>{exitDelaySec} Seconds</Text>
            </View>
            <Slider
              style={styles.slider}
              minimumValue={3}
              maximumValue={30}
              step={1}
              value={exitDelaySec}
              onValueChange={(val) => {
                setExitDelaySec(val);
                exitDelaySecRef.current = val;
              }}
              onSlidingComplete={(val) => {
                sendAntisparkCmd(`TIMEOUT ${val}`);
              }}
              minimumTrackTintColor="#f59e0b"
              maximumTrackTintColor="rgba(255, 255, 255, 0.15)"
              thumbTintColor="#f59e0b"
            />
          </View>
        )}
      </View>
    );
  };

  const renderGearShiftCard = () => (
    <View style={styles.gearShiftCard}>
      <View style={styles.gearShiftRow}>
        <View style={styles.gearShiftTextCol}>
          <View style={styles.gearShiftTitleRow}>
            <Text style={styles.gearShiftTitle}>⚡ GEAR SHIFT MODE</Text>
            <View style={[styles.gearShiftBadge, gearShiftEnabled ? styles.gearShiftBadgeOn : styles.gearShiftBadgeOff]}>
              <Text style={[styles.gearShiftBadgeText, gearShiftEnabled ? styles.gearShiftBadgeTextOn : styles.gearShiftBadgeTextOff]}>
                {gearShiftEnabled ? 'GEARS 2–4 ACTIVE' : 'STANDARD 1–3'}
              </Text>
            </View>
          </View>
          <Text style={styles.gearShiftDesc}>
            {gearShiftEnabled
              ? 'Handlebar: 1→15 km/h, 2→25 km/h, 3→40+ km/h (G4 Unlocked). 1st gear omitted. Auto-locks on disconnect.'
              : 'Handlebar: 1→10 km/h, 2→15 km/h, 3→22 km/h. 4th gear secret locked.'}
          </Text>
        </View>
        <Switch
          value={gearShiftEnabled}
          onValueChange={toggleGearShift}
          trackColor={{ false: '#1e293b', true: '#00f2fe' }}
          thumbColor={gearShiftEnabled ? '#ffffff' : '#64748b'}
          ios_backgroundColor="#1e293b"
        />
      </View>
    </View>
  );

  const renderCruiseCard = () => (
    <View style={[styles.gearShiftCard, cruiseActive && styles.cruiseCardActive]}>
      <View style={styles.gearShiftRow}>
        <View style={styles.gearShiftTextCol}>
          <View style={styles.gearShiftTitleRow}>
            <Text style={styles.gearShiftTitle}>🎯 CRUISE CONTROL</Text>
            <View style={[
              styles.gearShiftBadge,
              cruiseStatus === 'ACTIVE'
                ? styles.cruiseBadgeActive
                : cruiseStatus === 'G4'
                ? styles.cruiseBadgeG4
                : cruiseStatus === 'ARMED'
                ? styles.cruiseBadgeArmed
                : styles.gearShiftBadgeOff
            ]}>
              <Text style={[
                styles.gearShiftBadgeText,
                cruiseStatus === 'ACTIVE'
                  ? styles.cruiseBadgeTextActive
                  : cruiseStatus === 'G4'
                  ? styles.cruiseBadgeTextG4
                  : cruiseStatus === 'ARMED'
                  ? styles.cruiseBadgeTextArmed
                  : styles.gearShiftBadgeTextOff
              ]}>
                {cruiseStatus === 'ACTIVE'
                  ? 'CRUISING ACTIVE'
                  : cruiseStatus === 'G4'
                  ? 'SUSPENDED (G4)'
                  : cruiseStatus === 'ARMED'
                  ? 'ARMED (TOP SPD 5s)'
                  : 'DISABLED'}
              </Text>
            </View>
          </View>
          <Text style={styles.gearShiftDesc}>
            {cruiseStatus === 'ACTIVE'
              ? 'Holding top speed! Throttle inactive. Pull brake to cancel.'
              : cruiseStatus === 'G4'
              ? 'Cruise disabled in 4th gear (Sport). Auto-restores in Gears 1–3.'
              : cruiseStatus === 'ARMED'
              ? `Hold top speed (${activeGear === 1 ? '10' : activeGear === 2 ? '15' : gearShiftEnabled ? '25' : '22'} km/h ±2) for 5s to engage.`
              : 'Locks maximum speed for current gear after 5 seconds at top speed. Stops on brake.'}
          </Text>
        </View>
        <Switch
          value={cruiseEnabled}
          onValueChange={toggleCruiseControl}
          trackColor={{ false: '#1e293b', true: cruiseActive ? '#10b981' : '#00f2fe' }}
          thumbColor={cruiseEnabled ? '#ffffff' : '#64748b'}
          ios_backgroundColor="#1e293b"
        />
      </View>
    </View>
  );

  const renderBrakeCard = () => (
    <View style={styles.controlsCard}>
      <View style={styles.brakeSwitchRow}>
        <View style={styles.brakeSwitchTextCol}>
          <View style={styles.brakeSwitchTitleRow}>
            <Text style={styles.controlLabel}>E-Brake Sensor</Text>
            <View style={[styles.brakeBadge, brakeEnabled ? styles.brakeBadgeOn : styles.brakeBadgeOff]}>
              <Text style={[styles.brakeBadgeText, brakeEnabled ? styles.brakeBadgeTextOn : styles.brakeBadgeTextOff]}>
                {brakeEnabled ? 'ACTIVE (GPIO 19)' : 'DISABLED'}
              </Text>
            </View>
          </View>
          <Text style={styles.gearShiftDesc}>
            {brakeEnabled
              ? 'Physical brake lever active with 20ms glitch filter'
              : 'Brake sensor disabled in firmware (software bypass)'}
          </Text>
        </View>
        <Switch
          value={brakeEnabled}
          onValueChange={toggleBrakeSensor}
          trackColor={{ false: '#1e293b', true: '#f43f5e' }}
          thumbColor={brakeEnabled ? '#ffffff' : '#64748b'}
          ios_backgroundColor="#1e293b"
        />
      </View>

      <View style={styles.sliderHeader}>
        <Text style={styles.controlLabel}>E-Brake Strength</Text>
        <Text style={styles.sliderVal}>{brakeAmps.toFixed(1)} A</Text>
      </View>

      <Slider
        style={styles.slider}
        minimumValue={0}
        maximumValue={50}
        step={1}
        value={brakeAmps}
        onValueChange={(val) => setBrakeAmps(val)}
        onSlidingComplete={(val) => sendCmd(`BC ${val}`)}
        minimumTrackTintColor="#f43f5e"
        maximumTrackTintColor="rgba(255, 255, 255, 0.15)"
        thumbTintColor="#f43f5e"
      />

      <View style={styles.btnRow}>
        <TouchableOpacity style={styles.btnAction} onPress={() => sendCmd('S')} activeOpacity={0.7}>
          <Text style={styles.btnActionText}>📡 Refresh Telemetry (S)</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderConsoleCard = () => (
    <View style={styles.consoleCard}>
      <TouchableOpacity
        style={styles.consoleHeader}
        onPress={() => setConsoleOpen(!consoleOpen)}
        activeOpacity={0.8}
      >
        <Text style={styles.consoleHeaderText}>Live Console</Text>
        <Text style={styles.consoleToggleIcon}>{consoleOpen ? '▲' : '▼'}</Text>
      </TouchableOpacity>

      {consoleOpen && (
        <View style={styles.consoleBody}>
          <ScrollView style={styles.consoleLogBox} nestedScrollEnabled>
            {consoleLines.map((line, idx) => (
              <Text key={idx} style={styles.consoleLine}>
                {line}
              </Text>
            ))}
          </ScrollView>

          <View style={styles.consoleInputRow}>
            <TextInput
              style={styles.consoleInput}
              placeholder="Command (e.g. S, BC 30, R)"
              placeholderTextColor="#64748b"
              value={customCmd}
              onChangeText={setCustomCmd}
              onSubmitEditing={() => {
                if (customCmd.trim()) {
                  sendCmd(customCmd.trim());
                  setCustomCmd('');
                }
              }}
            />
            <TouchableOpacity
              style={styles.btnSend}
              onPress={() => {
                if (customCmd.trim()) {
                  sendCmd(customCmd.trim());
                  setCustomCmd('');
                }
              }}
            >
              <Text style={styles.btnSendText}>Send</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );

  return (
    <View style={[styles.safeArea, { paddingTop: safeTop, paddingBottom: safeBottom }]}>
      <StatusBar style="light" />

      {/* Top Header with Island Padding */}
      <View style={[
        styles.header,
        isLandscape && styles.headerLandscape,
        { paddingLeft: islandInsetLeft, paddingRight: islandInsetRight }
      ]}>
        <View style={styles.brandRow}>
          <View style={styles.brandDot} />
          <View>
            <Text style={styles.brandTitle}>SCOOTER BLE</Text>
            <Text style={styles.subStatus}>{statusText}</Text>
          </View>
        </View>

        {/* Landscape Screen Mode Switcher Tabs */}
        {isLandscape && (
          <View style={styles.headerTabs}>
            <TouchableOpacity
              style={[styles.headerTabBtn, landscapeTab === 'drive' && styles.headerTabBtnActive]}
              onPress={() => switchLandscapePage(0)}
              activeOpacity={0.7}
            >
              <Text style={[styles.headerTabText, landscapeTab === 'drive' && styles.headerTabTextActive]}>
                ⚡ Speed & Gears
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.headerTabBtn, landscapeTab === 'settings' && styles.headerTabBtnActive]}
              onPress={() => switchLandscapePage(1)}
              activeOpacity={0.7}
            >
              <Text style={[styles.headerTabText, landscapeTab === 'settings' && styles.headerTabTextActive]}>
                ⚙️ All Settings
              </Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={styles.headerRightGroup}>
          {/* Dedicated Antispark Power Button */}
          <TouchableOpacity
            style={[
              styles.btnHeaderPower,
              isAntisparkConnected && styles.btnHeaderPowerActive,
              isAntisparkConnecting && styles.btnHeaderPowerConnecting,
            ]}
            onPress={isAntisparkConnected ? disconnectAntispark : scanAndConnectAntispark}
            activeOpacity={0.8}
          >
            <View
              style={[
                styles.statusDot,
                isAntisparkConnected
                  ? styles.statusDotActive
                  : isAntisparkConnecting
                  ? styles.statusDotYellow
                  : styles.statusDotInactive,
              ]}
            />
            <Text
              style={[
                styles.btnHeaderPowerText,
                isAntisparkConnected && styles.btnHeaderPowerTextActive,
              ]}
            >
              {isAntisparkConnected ? '⚡ Power ON' : isAntisparkConnecting ? 'Connecting...' : '⚡ Power'}
            </Text>
          </TouchableOpacity>

          {/* VESC Telemetry Connect Button */}
          <TouchableOpacity
            style={[styles.btnConnect, isConnected && styles.btnConnected]}
            onPress={isConnected ? disconnect : connectBle}
            activeOpacity={0.8}
          >
            <View style={[styles.statusDot, isConnected && styles.statusDotActive]} />
            <Text style={[styles.btnConnectText, isConnected && styles.btnConnectedText]}>
              {isConnected ? 'Connected' : isScanning ? 'Scanning...' : 'Connect'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Main Content Area */}
      {isLandscape ? (
        <View style={[styles.landscapeWrapper, { paddingLeft: islandInsetLeft, paddingRight: islandInsetRight }]}>
          <ScrollView
            ref={pagerRef}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            style={[styles.landscapePager, { width: landscapePageWidth }]}
            onMomentumScrollEnd={(e) => {
              const pageIdx = Math.round(e.nativeEvent.contentOffset.x / landscapePageWidth);
              setLandscapeTab(pageIdx === 0 ? 'drive' : 'settings');
            }}
          >
            {/* SCREEN 1: Speed + Telemetry + Gears */}
            <View style={[styles.landscapePage, { width: landscapePageWidth }]}>
              <View style={styles.screen1Layout}>
                <View style={styles.screen1LeftCol}>
                  {renderSpeedometer()}
                </View>
                <View style={styles.screen1RightCol}>
                  {renderTelemetry(true)}
                  {renderProfiles(true)}
                </View>
              </View>
            </View>

            {/* SCREEN 2: All Settings */}
            <View style={[styles.landscapePage, { width: landscapePageWidth }]}>
              <ScrollView
                style={styles.settingsScrollView}
                contentContainerStyle={styles.settingsScrollContent}
                showsVerticalScrollIndicator={true}
              >
                <View style={styles.settingsHeader}>
                  <Text style={styles.sectionTitle}>SCOOTER SETTINGS</Text>
                  <Text style={styles.activeProfileLabel}>Configuration & Tuning</Text>
                </View>
                {renderAntisparkCard()}
                {renderGearShiftCard()}
                {renderCruiseCard()}
                {renderBrakeCard()}
                {renderConsoleCard()}
              </ScrollView>
            </View>
          </ScrollView>

          {/* Bottom Navigation Pills */}
          <View style={[styles.landscapeFooter, { paddingLeft: islandInsetLeft, paddingRight: islandInsetRight }]}>
            <TouchableOpacity
              style={[styles.footerPill, landscapeTab === 'drive' && styles.footerPillActive]}
              onPress={() => switchLandscapePage(0)}
              activeOpacity={0.7}
            >
              <View style={[styles.footerDot, landscapeTab === 'drive' && styles.footerDotActive]} />
              <Text style={[styles.footerPillText, landscapeTab === 'drive' && styles.footerPillTextActive]}>
                Screen 1: Speed & Gears
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.footerPill, landscapeTab === 'settings' && styles.footerPillActive]}
              onPress={() => switchLandscapePage(1)}
              activeOpacity={0.7}
            >
              <View style={[styles.footerDot, landscapeTab === 'settings' && styles.footerDotActive]} />
              <Text style={[styles.footerPillText, landscapeTab === 'settings' && styles.footerPillTextActive]}>
                Screen 2: All Settings
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        /* Portrait continuous vertical scroll */
        <ScrollView
          contentContainerStyle={[styles.scrollContent, { paddingHorizontal: islandInsetLeft }]}
          showsVerticalScrollIndicator={false}
        >
          {renderSpeedometer()}
          {renderTelemetry(false)}
          {renderAntisparkCard()}
          {renderGearShiftCard()}
          {renderCruiseCard()}
          {renderProfiles(false)}
          {renderBrakeCard()}
          {renderConsoleCard()}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#070a12',
  },
  safeAreaLandscape: {
    backgroundColor: '#070a12',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#101626',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.08)',
  },
  headerLandscape: {
    paddingVertical: 6,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  brandDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#00f2fe',
  },
  brandTitle: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  subStatus: {
    color: '#94a3b8',
    fontSize: 11,
  },
  btnConnect: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(0, 242, 254, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(0, 242, 254, 0.35)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 12,
  },
  btnConnected: {
    backgroundColor: 'rgba(16, 185, 129, 0.16)',
    borderColor: 'rgba(16, 185, 129, 0.45)',
  },
  btnConnectText: {
    color: '#00f2fe',
    fontSize: 12,
    fontWeight: '700',
  },
  btnConnectedText: {
    color: '#10b981',
  },
  headerRightGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  btnHeaderPower: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.15)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
  },
  btnHeaderPowerActive: {
    backgroundColor: 'rgba(16, 185, 129, 0.18)',
    borderColor: 'rgba(16, 185, 129, 0.55)',
  },
  btnHeaderPowerConnecting: {
    backgroundColor: 'rgba(245, 158, 11, 0.18)',
    borderColor: 'rgba(245, 158, 11, 0.55)',
  },
  btnHeaderPowerText: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '700',
  },
  btnHeaderPowerTextActive: {
    color: '#10b981',
  },
  statusDotYellow: {
    backgroundColor: '#f59e0b',
  },
  statusDotInactive: {
    backgroundColor: '#64748b',
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: '#64748b',
  },
  statusDotActive: {
    backgroundColor: '#10b981',
  },
  scrollContent: {
    padding: 14,
    gap: 12,
  },
  scrollLandscape: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  col: {
    gap: 12,
  },
  colLeft: {
    flex: 1,
    paddingRight: 8,
  },
  colRight: {
    flex: 1.1,
    paddingLeft: 8,
  },

  // Header Tabs for Landscape
  headerTabs: {
    flexDirection: 'row',
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderRadius: 12,
    padding: 3,
    gap: 4,
  },
  headerTabBtn: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 9,
  },
  headerTabBtnActive: {
    backgroundColor: '#00f2fe',
  },
  headerTabText: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '700',
  },
  headerTabTextActive: {
    color: '#070a12',
  },

  // Landscape View Wrapper & Pager
  landscapeWrapper: {
    flex: 1,
  },
  landscapePager: {
    flex: 1,
  },
  landscapePage: {
    flex: 1,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },

  // Screen 1: Speed + Telemetry + Gears
  screen1Layout: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    paddingVertical: 6,
  },
  screen1LeftCol: {
    flex: 0.9,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  screen1RightCol: {
    flex: 1.15,
    gap: 8,
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  speedoHeroLandscape: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 20,
    width: '100%',
  },
  speedNumLandscape: {
    fontSize: 40,
    lineHeight: 40,
  },
  telemGridLandscape: {
    flexDirection: 'row',
    gap: 8,
    marginVertical: 0,
  },
  telemBoxLandscape: {
    flex: 1,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 12,
  },
  profilesSection: {
    gap: 8,
  },
  profilesSectionLandscape: {
    gap: 6,
  },
  profileGridLandscape: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
    gap: 6,
  },
  profileCardLandscape: {
    flex: 1,
    padding: 8,
    borderRadius: 12,
  },
  pGearLandscape: {
    fontSize: 12,
  },
  pLimitLandscape: {
    fontSize: 11,
  },
  pNameLandscape: {
    fontSize: 11,
    marginBottom: 4,
  },
  pAmpsLandscape: {
    fontSize: 10,
  },

  // Screen 2: Settings
  settingsScrollView: {
    flex: 1,
  },
  settingsScrollContent: {
    paddingVertical: 12,
    paddingHorizontal: 10,
    gap: 12,
  },
  settingsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },

  // Landscape Footer Bar
  landscapeFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    gap: 12,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.06)',
    backgroundColor: '#070a12',
  },
  footerPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 5,
    borderRadius: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  footerPillActive: {
    backgroundColor: 'rgba(0, 242, 254, 0.15)',
    borderColor: 'rgba(0, 242, 254, 0.4)',
  },
  footerDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#64748b',
  },
  footerDotActive: {
    backgroundColor: '#00f2fe',
  },
  footerPillText: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '700',
  },
  footerPillTextActive: {
    color: '#00f2fe',
  },
  speedoHero: {
    backgroundColor: '#101626',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 22,
    paddingVertical: 16,
    alignItems: 'center',
  },
  gaugeBox: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
    height: 105,
  },
  speedTextWrap: {
    position: 'absolute',
    bottom: 2,
    alignItems: 'center',
  },
  speedNum: {
    color: '#ffffff',
    fontSize: 48,
    fontWeight: '900',
    lineHeight: 48,
    letterSpacing: -1,
  },
  speedUnit: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 2,
  },
  badgeRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
  },
  badge: {
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  badgeBraking: {
    backgroundColor: 'rgba(244, 63, 94, 0.2)',
    borderColor: 'rgba(244, 63, 94, 0.6)',
  },
  badgeText: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '700',
  },
  badgeTextBraking: {
    color: '#f43f5e',
  },
  telemGrid: {
    flexDirection: 'row',
    gap: 8,
  },
  telemBox: {
    flex: 1,
    backgroundColor: '#101626',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 14,
    paddingVertical: 10,
    alignItems: 'center',
    gap: 2,
  },
  telemLabel: {
    color: '#64748b',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1,
  },
  telemVal: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '800',
  },
  telemUnit: {
    color: '#94a3b8',
    fontSize: 10,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  sectionTitle: {
    color: '#64748b',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.5,
  },
  activeProfileLabel: {
    color: '#00f2fe',
    fontSize: 12,
    fontWeight: '700',
  },
  profileGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  profileCard: {
    width: '48.5%',
    backgroundColor: '#101626',
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 16,
    padding: 10,
    gap: 2,
  },
  pHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  pGear: {
    color: '#64748b',
    fontSize: 11,
    fontWeight: '800',
  },
  pLimit: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '800',
  },
  pName: {
    color: '#f8fafc',
    fontSize: 13,
    fontWeight: '700',
  },
  pAmps: {
    color: '#94a3b8',
    fontSize: 10,
  },
  pFooterRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 4,
  },
  profileCardBypassed: {
    opacity: 0.45,
    borderStyle: 'dashed',
  },
  handlebarBadge: {
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 5,
  },
  handlebarBadgeBypassed: {
    backgroundColor: 'rgba(244, 63, 94, 0.15)',
  },
  handlebarBadgeText: {
    color: '#94a3b8',
    fontSize: 9,
    fontWeight: '700',
  },
  gearShiftCard: {
    backgroundColor: '#101626',
    borderWidth: 1,
    borderColor: 'rgba(0, 242, 254, 0.25)',
    borderRadius: 18,
    padding: 12,
  },
  gearShiftRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  gearShiftTextCol: {
    flex: 1,
    gap: 4,
  },
  gearShiftTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  gearShiftTitle: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  gearShiftBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  gearShiftBadgeOn: {
    backgroundColor: 'rgba(0, 242, 254, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(0, 242, 254, 0.4)',
  },
  gearShiftBadgeOff: {
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  gearShiftBadgeText: {
    fontSize: 10,
    fontWeight: '800',
  },
  gearShiftBadgeTextOn: {
    color: '#00f2fe',
  },
  gearShiftBadgeTextOff: {
    color: '#94a3b8',
  },
  gearShiftDesc: {
    color: '#94a3b8',
    fontSize: 11,
    lineHeight: 15,
  },
  cruiseCardActive: {
    borderColor: 'rgba(16, 185, 129, 0.6)',
    backgroundColor: '#0c1a24',
  },
  cruiseBadgeActive: {
    backgroundColor: 'rgba(16, 185, 129, 0.2)',
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.6)',
  },
  cruiseBadgeTextActive: {
    color: '#10b981',
  },
  cruiseBadgeG4: {
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.4)',
  },
  cruiseBadgeTextG4: {
    color: '#f59e0b',
  },
  cruiseBadgeArmed: {
    backgroundColor: 'rgba(0, 242, 254, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(0, 242, 254, 0.4)',
  },
  cruiseBadgeTextArmed: {
    color: '#00f2fe',
  },
  badgeCruiseActive: {
    backgroundColor: 'rgba(16, 185, 129, 0.2)',
    borderColor: 'rgba(16, 185, 129, 0.6)',
  },
  badgeTextCruiseActive: {
    color: '#10b981',
    fontWeight: '800',
  },
  badgeCruiseG4: {
    backgroundColor: 'rgba(245, 158, 11, 0.2)',
    borderColor: 'rgba(245, 158, 11, 0.6)',
  },
  badgeTextCruiseG4: {
    color: '#f59e0b',
    fontWeight: '800',
  },
  badgeCruiseArmed: {
    backgroundColor: 'rgba(0, 242, 254, 0.2)',
    borderColor: 'rgba(0, 242, 254, 0.6)',
  },
  badgeTextCruiseArmed: {
    color: '#00f2fe',
    fontWeight: '800',
  },
  controlsCard: {
    backgroundColor: '#101626',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 18,
    padding: 12,
    gap: 12,
  },
  brakeSwitchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.06)',
  },
  brakeSwitchTextCol: {
    flex: 1,
    gap: 4,
  },
  brakeSwitchTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  brakeBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  brakeBadgeOn: {
    backgroundColor: 'rgba(244, 63, 94, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(244, 63, 94, 0.4)',
  },
  brakeBadgeOff: {
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  brakeBadgeText: {
    fontSize: 10,
    fontWeight: '800',
  },
  brakeBadgeTextOn: {
    color: '#f43f5e',
  },
  brakeBadgeTextOff: {
    color: '#94a3b8',
  },
  badgeDisabled: {
    backgroundColor: 'rgba(100, 116, 139, 0.2)',
    borderColor: 'rgba(100, 116, 139, 0.4)',
  },
  sliderHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  controlLabel: {
    color: '#f8fafc',
    fontSize: 12,
    fontWeight: '600',
  },
  sliderVal: {
    color: '#f43f5e',
    fontSize: 13,
    fontWeight: '700',
  },
  slider: {
    width: '100%',
    height: 30,
  },
  btnRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  btnAction: {
    flex: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 10,
    paddingVertical: 8,
    alignItems: 'center',
  },
  btnActionText: {
    color: '#f8fafc',
    fontSize: 11,
    fontWeight: '700',
  },
  consoleCard: {
    backgroundColor: '#101626',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 16,
    overflow: 'hidden',
  },
  consoleHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  consoleHeaderText: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '700',
  },
  consoleToggleIcon: {
    color: '#64748b',
    fontSize: 10,
  },
  consoleBody: {
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.06)',
    padding: 10,
    gap: 8,
  },
  consoleLogBox: {
    height: 70,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    borderRadius: 8,
    padding: 6,
  },
  consoleLine: {
    color: '#34d399',
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  consoleInputRow: {
    flexDirection: 'row',
    gap: 8,
  },
  consoleInput: {
    flex: 1,
    height: 34,
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 8,
    paddingHorizontal: 10,
    color: '#ffffff',
    fontSize: 11,
  },
  btnSend: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 8,
    paddingHorizontal: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  btnSendText: {
    color: '#00f2fe',
    fontSize: 11,
    fontWeight: '700',
  },

  // =========================================================================
  // Antispark Smart Key Styles
  // =========================================================================
  antisparkCard: {
    backgroundColor: '#101626',
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.3)',
    borderRadius: 18,
    padding: 12,
    gap: 10,
  },
  antisparkHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  antisparkHeaderLeft: {
    flex: 1,
    gap: 2,
  },
  antisparkTitle: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  antisparkSubStatus: {
    color: '#94a3b8',
    fontSize: 11,
  },
  btnAntisparkPair: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(16, 185, 129, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.35)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 10,
  },
  btnAntisparkPairConnected: {
    backgroundColor: 'rgba(16, 185, 129, 0.22)',
    borderColor: 'rgba(16, 185, 129, 0.6)',
  },
  btnAntisparkPairText: {
    color: '#10b981',
    fontSize: 11,
    fontWeight: '700',
  },
  btnAntisparkPairTextConnected: {
    color: '#34d399',
  },

  // Dedicated Power Action Button & Status Box
  dedicatedPowerButtonWrap: {
    marginVertical: 4,
  },
  btnDedicatedPowerConnect: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    borderWidth: 1.5,
    borderColor: '#10b981',
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  btnDedicatedPowerConnectLoading: {
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
    borderColor: '#f59e0b',
  },
  btnDedicatedPowerConnectIcon: {
    fontSize: 24,
  },
  btnDedicatedPowerConnectText: {
    color: '#10b981',
    fontSize: 15,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  btnDedicatedPowerConnectSub: {
    color: '#94a3b8',
    fontSize: 11,
    marginTop: 2,
  },
  powerConnectedBox: {
    backgroundColor: 'rgba(16, 185, 129, 0.12)',
    borderWidth: 1.5,
    borderColor: '#10b981',
    borderRadius: 14,
    padding: 14,
    gap: 12,
  },
  powerConnectedTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  powerConnectedStatusDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#10b981',
  },
  powerConnectedTitle: {
    color: '#10b981',
    fontSize: 15,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  powerConnectedSub: {
    color: '#cbd5e1',
    fontSize: 11,
    marginTop: 2,
  },
  btnDedicatedPowerDisconnect: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.15)',
    borderRadius: 10,
    paddingVertical: 9,
    alignItems: 'center',
  },
  btnDedicatedPowerDisconnectText: {
    color: '#f43f5e',
    fontSize: 13,
    fontWeight: '700',
  },
  autoCutoffNoticeBox: {
    backgroundColor: 'rgba(56, 189, 248, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.25)',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  autoCutoffNoticeText: {
    color: '#94a3b8',
    fontSize: 11,
    lineHeight: 16,
  },

  // Hero Banner for Bench Testing
  antisparkHero: {
    borderRadius: 14,
    padding: 12,
    borderWidth: 1.5,
  },
  antisparkHeroActive: {
    backgroundColor: 'rgba(16, 185, 129, 0.12)',
    borderColor: '#10b981',
  },
  antisparkHeroInactive: {
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  antisparkHeroContent: {
    gap: 4,
  },
  antisparkHeroTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  antisparkHeroTitle: {
    color: '#94a3b8',
    fontSize: 15,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  antisparkHeroTitleActive: {
    color: '#10b981',
  },
  antisparkStateTag: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  antisparkStateTagActive: {
    backgroundColor: 'rgba(16, 185, 129, 0.25)',
  },
  antisparkStateTagInactive: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  antisparkStateTagText: {
    color: '#94a3b8',
    fontSize: 10,
    fontWeight: '800',
  },
  antisparkStateTagTextActive: {
    color: '#34d399',
  },
  antisparkHeroSub: {
    color: '#cbd5e1',
    fontSize: 11,
    lineHeight: 15,
  },

  // Radar & RSSI
  radarCard: {
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    borderRadius: 12,
    padding: 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
  },
  radarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  radarPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
  },
  radarPillImmediate: {
    backgroundColor: 'rgba(16, 185, 129, 0.25)',
    borderColor: 'rgba(16, 185, 129, 0.6)',
  },
  radarPillInZone: {
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    borderColor: 'rgba(16, 185, 129, 0.4)',
  },
  radarPillEdge: {
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
    borderColor: 'rgba(245, 158, 11, 0.4)',
  },
  radarPillOut: {
    backgroundColor: 'rgba(244, 63, 94, 0.15)',
    borderColor: 'rgba(244, 63, 94, 0.4)',
  },
  radarPillDisc: {
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  radarPillText: {
    color: '#94a3b8',
    fontSize: 10,
    fontWeight: '800',
  },
  radarPillTextGreen: {
    color: '#10b981',
  },
  radarPillTextYellow: {
    color: '#f59e0b',
  },
  radarPillTextRed: {
    color: '#f43f5e',
  },
  signalMeterWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  rssiValueText: {
    color: '#cbd5e1',
    fontSize: 11,
    fontWeight: '700',
  },
  signalBarsRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 2,
    height: 18,
  },
  signalBar: {
    width: 3.5,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    borderRadius: 1.5,
  },
  signalBarActive: {
    backgroundColor: '#10b981',
  },
  signalBarRed: {
    backgroundColor: '#f43f5e',
  },

  // Alert Bars
  countdownAlertBox: {
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
    borderColor: 'rgba(245, 158, 11, 0.45)',
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  countdownAlertText: {
    color: '#f59e0b',
    fontSize: 11,
    fontWeight: '800',
    textAlign: 'center',
  },
  motionLockAlertBox: {
    backgroundColor: 'rgba(244, 63, 94, 0.18)',
    borderColor: 'rgba(244, 63, 94, 0.6)',
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  motionLockAlertText: {
    color: '#f43f5e',
    fontSize: 11,
    fontWeight: '800',
    textAlign: 'center',
  },

  // Auto Key Switch
  autoKeySwitchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingVertical: 4,
  },
  autoKeyTextCol: {
    flex: 1,
    gap: 2,
  },

  // Test Section
  testSection: {
    backgroundColor: 'rgba(0, 0, 0, 0.25)',
    borderRadius: 12,
    padding: 8,
    gap: 6,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
  },
  testSectionTitle: {
    color: '#64748b',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  testBtnRow: {
    flexDirection: 'row',
    gap: 8,
  },
  btnTestPower: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 10,
    alignItems: 'center',
    borderWidth: 1,
  },
  btnTestPowerOn: {
    backgroundColor: 'rgba(16, 185, 129, 0.12)',
    borderColor: 'rgba(16, 185, 129, 0.35)',
  },
  btnTestPowerOnActive: {
    backgroundColor: 'rgba(16, 185, 129, 0.28)',
    borderColor: '#10b981',
  },
  btnTestPowerOnText: {
    color: '#10b981',
    fontSize: 11,
    fontWeight: '800',
  },
  btnTestPowerOff: {
    backgroundColor: 'rgba(244, 63, 94, 0.1)',
    borderColor: 'rgba(244, 63, 94, 0.3)',
  },
  btnTestPowerOffActive: {
    backgroundColor: 'rgba(244, 63, 94, 0.22)',
    borderColor: '#f43f5e',
  },
  btnTestPowerOffText: {
    color: '#f43f5e',
    fontSize: 11,
    fontWeight: '800',
  },

  // Sim Demo Box
  simDemoBox: {
    backgroundColor: 'rgba(0, 242, 254, 0.05)',
    borderRadius: 12,
    padding: 8,
    gap: 6,
    borderWidth: 1,
    borderColor: 'rgba(0, 242, 254, 0.2)',
  },
  simDemoTitle: {
    color: '#00f2fe',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  btnSimApproach: {
    flex: 1,
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    borderColor: 'rgba(16, 185, 129, 0.4)',
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 6,
    alignItems: 'center',
  },
  btnSimApproachText: {
    color: '#34d399',
    fontSize: 10,
    fontWeight: '700',
  },
  btnSimWalkAway: {
    flex: 1,
    backgroundColor: 'rgba(244, 63, 94, 0.15)',
    borderColor: 'rgba(244, 63, 94, 0.4)',
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 6,
    alignItems: 'center',
  },
  btnSimWalkAwayText: {
    color: '#fb7185',
    fontSize: 10,
    fontWeight: '700',
  },

  // Calibration Collapsible
  calibToggleHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.06)',
    marginTop: 2,
  },
  calibToggleText: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '700',
  },
  calibToggleIcon: {
    color: '#64748b',
    fontSize: 10,
  },
  calibBody: {
    gap: 8,
    paddingTop: 4,
  },
  calibValGreen: {
    color: '#10b981',
    fontSize: 12,
    fontWeight: '700',
  },
  calibValRed: {
    color: '#f43f5e',
    fontSize: 12,
    fontWeight: '700',
  },
  calibValAmber: {
    color: '#f59e0b',
    fontSize: 12,
    fontWeight: '700',
  },
});
