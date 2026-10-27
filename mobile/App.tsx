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
  Linking,
  Alert,
  Animated,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import Slider from '@react-native-community/slider';
import Svg, { Path, Defs, LinearGradient, Stop } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { BleManager, Device, Characteristic, Subscription } from 'react-native-ble-plx';
import { Buffer } from 'buffer';
import { ScooterBeacon, BeaconRangeEvent, BeaconRegionEvent } from 'scooter-beacon';
import { useAudioPlayer, setAudioModeAsync } from 'expo-audio';

// BLE UUIDs for ESP32 VESC Controller
const BLE_SVC_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const BLE_CONSOLE_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

// BLE UUIDs for ESP32 Antispark Keyless Controller
const BLE_ANTISPARK_SVC_UUID = '6e400010-b5a3-f393-e0a9-e50e24dcca9e';
const BLE_ANTISPARK_CTRL_UUID = '6e400011-b5a3-f393-e0a9-e50e24dcca9e';

// Apple iBeacon Constants for Scooter-Antispark Proximity Wake-Up
const IBEACON_PROXIMITY_UUID = 'FDA50693-A4E2-4FB1-AFCF-C6EB07647825';
const IBEACON_MAJOR = 1;
const IBEACON_MINOR = 1;

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
  const [isMainConnecting, setIsMainConnecting] = useState(false);

  // Telemetry State
  const [speed, setSpeed] = useState(0.0);
  const [voltage, setVoltage] = useState('--');
  const [targetAmps, setTargetAmps] = useState('0.0');
  const [throttleRaw, setThrottleRaw] = useState('--');
  const [isBraking, setIsBraking] = useState(false);
  const [brakeEnabled, setBrakeEnabled] = useState(true);
  const [activeGear, setActiveGear] = useState(1);
  const [parkEnabled, setParkEnabled] = useState(false);
  const [parkLockActive, setParkLockActive] = useState(false);
  const [parkSecurityLocked, setParkSecurityLocked] = useState(false);
  const [parkErpm, setParkErpm] = useState(100);
  const [parkBrakeAmps, setParkBrakeAmps] = useState(35);
  const lastNonParkGearRef = useRef<number>(1);
  const [brakeAmps, setBrakeAmps] = useState(25);
  const [absEnabled, setAbsEnabled] = useState(false);
  const [absFreq, setAbsFreq] = useState(10);
  const [absStrobe, setAbsStrobe] = useState(true);
  const [unlockEnabled, setUnlockEnabled] = useState(false);
  const gearShiftEnabled = unlockEnabled;
  const setGearShiftEnabled = setUnlockEnabled;
  const [cruiseEnabled, setCruiseEnabled] = useState(false);
  const [cruiseActive, setCruiseActive] = useState(false);
  const [cruiseStatus, setCruiseStatus] = useState<'OFF' | 'ARMED' | 'ACTIVE' | 'G4'>('OFF');
  const [landscapeTab, setLandscapeTab] = useState<'drive' | 'settings'>('drive');
  const pagerRef = useRef<ScrollView | null>(null);

  // Lights & Indicators State
  const [frontLightOn, setFrontLightOn] = useState(false);
  const [turnLeftOn, setTurnLeftOn] = useState(false);
  const [turnRightOn, setTurnRightOn] = useState(false);
  const [ddmActive, setDdmActive] = useState(false);
  const blinkAnim = useRef(new Animated.Value(1)).current;

  // Sound effects for turn signal blinker via expo-audio
  const tickPlayer = useAudioPlayer(require('./assets/turn_tick.wav'));
  const tockPlayer = useAudioPlayer(require('./assets/turn_tock.wav'));
  const soundStepRef = useRef<'tick' | 'tock'>('tick');

  useEffect(() => {
    try {
      setAudioModeAsync({
        playsInSilentMode: true,
        interruptionMode: 'mixWithOthers',
      }).catch(() => {});
    } catch {
      // Safe ignore
    }
  }, []);

  const playBlinkerClick = useCallback((step?: 'tick' | 'tock') => {
    try {
      const targetStep = step || soundStepRef.current;
      soundStepRef.current = targetStep === 'tick' ? 'tock' : 'tick';
      const player = targetStep === 'tick' ? tickPlayer : tockPlayer;
      if (player) {
        player.seekTo(0);
        player.play();
      }
    } catch {
      // Safe ignore playback errors
    }
  }, [tickPlayer, tockPlayer]);

  useEffect(() => {
    if (turnLeftOn || turnRightOn) {
      // Play crisp tick immediately on activation
      playBlinkerClick('tick');

      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(blinkAnim, {
            toValue: 0.2,
            duration: 380,
            useNativeDriver: true,
          }),
          Animated.timing(blinkAnim, {
            toValue: 1,
            duration: 380,
            useNativeDriver: true,
          }),
        ])
      );
      loop.start();

      // Alternating tick-tock flasher sound (~380ms)
      const timer = setInterval(() => {
        playBlinkerClick();
      }, 380);

      return () => {
        clearInterval(timer);
        loop.stop();
        blinkAnim.setValue(1);
        soundStepRef.current = 'tick';
      };
    } else {
      blinkAnim.setValue(1);
      soundStepRef.current = 'tick';
    }
  }, [turnLeftOn, turnRightOn, playBlinkerClick]);

  const switchLandscapePage = (page: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setLandscapeTab(page === 0 ? 'drive' : 'settings');
    pagerRef.current?.scrollTo({ x: page * landscapePageWidth, animated: true });
  };

  // Collapsible Settings Sections (all collapsed by default)
  const [openSections, setOpenSections] = useState<{ [key: string]: boolean }>({
    lights: false,
    antispark: false,
    park: false,
    unlock: false,
    cruise: false,
    brake: false,
  });

  const toggleSection = (section: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setOpenSections((prev) => ({
      ...prev,
      [section]: !prev[section],
    }));
  };

  const toggleAllSections = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const nextState = !Object.values(openSections).every(Boolean);
    setOpenSections({
      lights: nextState,
      antispark: nextState,
      park: nextState,
      unlock: nextState,
      cruise: nextState,
      brake: nextState,
    });
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
  const disconnectSubRef = useRef<Subscription | null>(null);
  const handshakeTimerRef = useRef<any>(null);
  const espGearRef = useRef<number>(0);
  const isWritingRef = useRef(false);
  const isMainConnectingRef = useRef<boolean>(false);
  const deviceRef = useRef<Device | null>(null);
  const savedMainDeviceIdRef = useRef<string | null>(null);
  const lastTelemetryTimeRef = useRef<number>(0);
  // Command queue: prevents silent drops when a write is already in progress
  const cmdQueueRef = useRef<string[]>([]);
  // Stable ref to parseTelemetry so monitor callback always calls the latest version (avoids stale closure)
  const parseTelemetryRef = useRef<((str: string) => void) | null>(null);

  // Antispark Smart Key State
  const [antisparkDevice, setAntisparkDevice] = useState<Device | null>(null);
  const [isAntisparkConnected, setIsAntisparkConnected] = useState(false);
  const [antisparkStatusText, setAntisparkStatusText] = useState('Disconnected');
  const [isAntisparkConnecting, setIsAntisparkConnecting] = useState(false);
  const [antisparkState, setAntisparkState] = useState(false); // true = ON (GPIO 10 HIGH), false = OFF (GPIO 10 LOW)
  const [antisparkAutoCutoff, setAntisparkAutoCutoff] = useState<boolean>(false); // false = power kept ON for Park Mode, true = auto power cut
  // Apple iBeacon Hands-Free Auto Key State
  const [iBeaconAutoKey, setIBeaconAutoKey] = useState<boolean>(true);
  const [iBeaconStatus, setIBeaconStatus] = useState<string>('Standby');
  const [iBeaconAuthStatus, setIBeaconAuthStatus] = useState<string>('unknown');
  const [iBeaconProximity, setIBeaconProximity] = useState<'immediate' | 'near' | 'far' | 'unknown'>('unknown');
  const [iBeaconRssi, setIBeaconRssi] = useState<number | null>(null);
  const [iBeaconAccuracy, setIBeaconAccuracy] = useState<number | null>(null);
  const [iBeaconSensitivity, setIBeaconSensitivity] = useState<'immediate' | 'near' | 'far'>('near');
  const [manualOverrideOff, setManualOverrideOff] = useState<boolean>(() => {
    return ScooterBeacon.isManualOverrideOff();
  });

  const manualOverrideOffRef = useRef<boolean>(ScooterBeacon.isManualOverrideOff());

  // Antispark Refs (synchronized for interval and BLE callbacks)
  const antisparkCharRef = useRef<Characteristic | null>(null);
  const antisparkNotifSubRef = useRef<Subscription | null>(null);
  const antisparkDisconnectSubRef = useRef<Subscription | null>(null);
  const antisparkScanTimerRef = useRef<any>(null);
  const mainScanTimerRef = useRef<any>(null);
  const parseAntisparkTelemetryRef = useRef<((str: string) => void) | null>(null);
  const speedRef = useRef<number>(0.0);
  const antisparkStateRef = useRef<boolean>(false);
  const antisparkAutoCutoffRef = useRef<boolean>(false);
  const iBeaconAutoKeyRef = useRef<boolean>(true);
  const iBeaconSensitivityRef = useRef<'immediate' | 'near' | 'far'>('near');
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
    iBeaconAutoKeyRef.current = iBeaconAutoKey;
  }, [iBeaconAutoKey]);
  useEffect(() => {
    iBeaconSensitivityRef.current = iBeaconSensitivity;
  }, [iBeaconSensitivity]);
  useEffect(() => {
    manualOverrideOffRef.current = manualOverrideOff;
    ScooterBeacon.setManualOverrideOff(manualOverrideOff);
  }, [manualOverrideOff]);

  // Telemetry watchdog: if connected and no notifications received for 1.8s, poll with 'S'
  useEffect(() => {
    if (!isConnected || isDemoMode) return;
    const interval = setInterval(() => {
      // Use deviceRef (not charRef) since writes now go via manager-level UUID API
      if (
        deviceRef.current &&
        Date.now() - lastTelemetryTimeRef.current > 1800
      ) {
        sendCmd('S');
      }
    }, 1500);
    return () => clearInterval(interval);
  }, [isConnected, isDemoMode]);

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
    console.log('[ScooterBLE]', msg);
    ScooterBeacon.nativeLog(msg);
    setConsoleLines((prev) => {
      const next = [...prev, msg];
      return next.length > 50 ? next.slice(-40) : next;
    });
  };



  // Adaptive background/foreground handling when screen is locked vs active
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      const prev = appStateRef.current;
      appStateRef.current = nextAppState;
      addConsole(`[APP] State: ${prev} -> ${nextAppState}`);
    });
    return () => subscription.remove();
  }, []);

  // -------------------------------------------------------------------------
  // Apple iBeacon Proximity Engine (iOS Silicon-Level Background Wake-Up)
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!ScooterBeacon.isAvailable()) {
      addConsole('[iBEACON] ⚠️ Native module not active in this app binary.');
      setIBeaconAuthStatus('unavailable');
      return;
    }

    const checkAuthAndInit = () => {
      const status = ScooterBeacon.getAuthorizationStatus();
      setIBeaconAuthStatus(status);
      addConsole(`[iBEACON] CoreLocation Auth: ${status}`);

      if (status === 'authorizedAlways' || status === 'authorizedWhenInUse') {
        if (iBeaconAutoKeyRef.current && !manualOverrideOffRef.current && !ScooterBeacon.isManualOverrideOff()) {
          ScooterBeacon.startMonitoring(IBEACON_PROXIMITY_UUID, IBEACON_MAJOR, IBEACON_MINOR);
          setIBeaconStatus('Armed • Listening');
          addConsole('[iBEACON] 🛡️ Monitoring Scooter Beacon for keyless auto-unlock');
        } else if (manualOverrideOffRef.current || ScooterBeacon.isManualOverrideOff()) {
          setIBeaconStatus('Disabled • Manual Turn OFF Active');
          addConsole('[iBEACON] 🛑 Manual Turn OFF active from previous session. Auto-ignition held OFF.');
        }
      } else if (status === 'notDetermined') {
        ScooterBeacon.requestLocationPermission();
      }
    };

    checkAuthAndInit();

    // Event 1: Hardware-Level Region Enter (wakes app even when locked in pocket)
    const enterSub = ScooterBeacon.addEnterListener((event) => {
      addConsole(`[iBEACON] 📍 ENTERED Scooter Beacon Region! State: ${event.state ?? 'inside'}`);
      setIBeaconStatus('In Proximity • Auto-Connecting');
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      if (manualOverrideOffRef.current) {
        addConsole('[iBEACON] 🛑 Region entered, but Manual Turn OFF has highest priority. Auto-connect suppressed.');
        return;
      }

      if (
        iBeaconAutoKeyRef.current &&
        !antisparkDeviceRef.current &&
        !antisparkCharRef.current &&
        !isAntisparkConnectingRef.current &&
        !isMainConnectingRef.current
      ) {
        addConsole('[iBEACON] Auto Key: Waking from pocket, auto-connecting to Antispark...');
        scanAndConnectAntispark();
      }
    });

    // Event 2: Region Exit
    const exitSub = ScooterBeacon.addExitListener((event) => {
      addConsole(`[iBEACON] 🚶 EXITED Scooter Beacon Region (${event.region})`);
      setIBeaconStatus('Out of Range');
      setIBeaconProximity('far');
      if (manualOverrideOffRef.current) {
        manualOverrideOffRef.current = false;
        setManualOverrideOff(false);
        ScooterBeacon.setManualOverrideOff(false);
        addConsole('[iBEACON] 🔄 Walked away: Manual power-off lock cleared. Proximity re-armed for next approach.');
      }
    });

    // Event 3: Calibrated Ranging (sub-meter accuracy)
    const rangeSub = ScooterBeacon.addRangeListener((event) => {
      if (typeof event.rssi === 'number' && event.rssi !== 0) {
        setIBeaconRssi(event.rssi);
      }
      if (event.accuracy && event.accuracy > 0) {
        setIBeaconAccuracy(parseFloat(event.accuracy.toFixed(1)));
      }

      let proxStr: 'immediate' | 'near' | 'far' | 'unknown' = 'unknown';
      if (event.proximity === 1) {
        proxStr = 'immediate';
      } else if (event.proximity === 2) {
        proxStr = 'near';
      } else if (event.proximity === 3) {
        proxStr = 'far';
      } else if (event.accuracy && event.accuracy > 0) {
        // Distance-based fallback when CLProximity is 0 (CLProximityUnknown)
        proxStr = event.accuracy <= 1.2 ? 'immediate' : event.accuracy <= 2.5 ? 'near' : 'far';
      } else if (typeof event.rssi === 'number' && event.rssi !== 0) {
        // RF fallback
        proxStr = event.rssi >= -65 ? 'immediate' : event.rssi >= -80 ? 'near' : 'far';
      }

      if (proxStr !== 'unknown') {
        setIBeaconProximity(proxStr);
      }

      // Manual turn-off has HIGHEST priority!
      if (manualOverrideOffRef.current || ScooterBeacon.isManualOverrideOff()) {
        return;
      }

      // Check user sensitivity threshold
      const sens = iBeaconSensitivityRef.current;
      const shouldTrigger =
        sens === 'far' ? (proxStr === 'immediate' || proxStr === 'near' || proxStr === 'far') :
        sens === 'near' ? (proxStr === 'immediate' || proxStr === 'near') :
        proxStr === 'immediate';

      if (
        shouldTrigger &&
        iBeaconAutoKeyRef.current &&
        !antisparkDeviceRef.current &&
        !antisparkCharRef.current &&
        !isAntisparkConnectingRef.current &&
        !isMainConnectingRef.current &&
        !antisparkStateRef.current
      ) {
        addConsole(`[iBEACON] 🎯 Target Proximity reached (${proxStr}, ${event.accuracy > 0 ? event.accuracy.toFixed(1) + 'm' : event.rssi + 'dBm'}). Auto-Power ON!`);
        scanAndConnectAntispark();
      } else if (
        shouldTrigger &&
        iBeaconAutoKeyRef.current &&
        antisparkStateRef.current &&
        !deviceRef.current &&
        !isMainConnectingRef.current
      ) {
        addConsole(`[iBEACON] 🎯 Proximity reached while powered. Auto-connecting to Scooter-ESP32 to unlock Park Mode...`);
        connectBle();
      }
    });

    // Event 4: Authorization status change
    const authSub = ScooterBeacon.addAuthListener((event) => {
      addConsole(`[iBEACON] Location Auth changed: ${event.status}`);
      setIBeaconAuthStatus(event.status);
      if (
        (event.status === 'authorizedAlways' || event.status === 'authorizedWhenInUse') &&
        iBeaconAutoKeyRef.current
      ) {
        ScooterBeacon.startMonitoring(IBEACON_PROXIMITY_UUID, IBEACON_MAJOR, IBEACON_MINOR);
        setIBeaconStatus('Armed • Listening');
      }
    });

    // Event 5: CoreLocation error callback
    const errorSub = ScooterBeacon.addErrorListener((event) => {
      addConsole(`[iBEACON] ⚠️ Error (${event.phase || 'general'}): ${event.error}`);
    });

    return () => {
      enterSub?.remove();
      exitSub?.remove();
      rangeSub?.remove();
      authSub?.remove();
      errorSub?.remove();
    };
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
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        addConsole(`[ANTISPARK] ⚠️ MOTION INTERLOCK! Speed is ${speedRef.current.toFixed(1)} km/h. Cannot turn off while moving!`);
        return;
      }
    }

    // Optimistic Zero-Latency UI feedback
    if (cmdStr === 'PWR 1' || cmdStr === 'ON') {
      const wasManualOff = manualOverrideOffRef.current || ScooterBeacon.isManualOverrideOff();
      manualOverrideOffRef.current = false;
      setManualOverrideOff(false);
      if (wasManualOff) {
        ScooterBeacon.setManualOverrideOff(false);
        if (iBeaconAutoKeyRef.current) {
          ScooterBeacon.startMonitoring(IBEACON_PROXIMITY_UUID, IBEACON_MAJOR, IBEACON_MINOR);
          setIBeaconStatus('Armed • Listening');
        }
      }
      antisparkStateRef.current = true;
      setAntisparkState(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } else if (cmdStr === 'PWR 0' || cmdStr === 'OFF') {
      manualOverrideOffRef.current = true;
      setManualOverrideOff(true);
      ScooterBeacon.setManualOverrideOff(true);
      ScooterBeacon.stopMonitoring();
      setIBeaconStatus('Disabled • Manual Turn OFF Active');
      addConsole('[ANTISPARK] 🛑 Manual Turn OFF: Proximity auto-ignition held OFF.');
      antisparkStateRef.current = false;
      setAntisparkState(false);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }

    const antisparkDevId = antisparkDeviceRef.current?.id ?? savedAntisparkIdRef.current;
    const mgr = getBleManager();
    if (!mgr || !antisparkDevId || !antisparkDeviceRef.current) {
      addConsole(`[ANTISPARK] Cannot send '${cmdStr}' - Antispark not connected`);
      return;
    }

    try {
      const base64Data = Buffer.from(cmdStr, 'utf-8').toString('base64');
      try {
        await mgr.writeCharacteristicWithResponseForDevice(
          antisparkDevId,
          BLE_ANTISPARK_SVC_UUID,
          BLE_ANTISPARK_CTRL_UUID,
          base64Data
        );
      } catch (_) {
        await mgr.writeCharacteristicWithoutResponseForDevice(
          antisparkDevId,
          BLE_ANTISPARK_SVC_UUID,
          BLE_ANTISPARK_CTRL_UUID,
          base64Data
        );
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

    if (pwrMatch) {
      const isPwrOn = pwrMatch[1] === '1';
      antisparkStateRef.current = isPwrOn;
      setAntisparkState(isPwrOn);
    }
    if (autoMatch) {
      const isAutoOn = autoMatch[1] === '1';
      antisparkAutoCutoffRef.current = isAutoOn;
      setAntisparkAutoCutoff(isAutoOn);
    }
  };
  parseAntisparkTelemetryRef.current = parseAntisparkTelemetry;

  const toggleAntisparkAutoCutoff = async (enabled: boolean) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setAntisparkAutoCutoff(enabled);
    antisparkAutoCutoffRef.current = enabled;
    addConsole(`[ANTISPARK] Auto-cutoff on disconnect set to: ${enabled ? 'ENABLED' : 'DISABLED'}`);
    if (antisparkDeviceRef.current) {
      await sendAntisparkCmd(enabled ? 'AUTO 1' : 'AUTO 0');
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

    try {
      setAntisparkStatusText('Connecting to Antispark...');
      addConsole(`[ANTISPARK] Connecting to ${scannedDev.name || scannedDev.id}...`);
      const connected = await scannedDev.connect({ timeout: 6000 });
      setAntisparkDevice(connected);
      antisparkDeviceRef.current = connected;
      setIsAntisparkConnected(true);
      setAntisparkState(true);
      antisparkStateRef.current = true;
      setAntisparkStatusText('Connected • Power ON');
      addConsole('[ANTISPARK] Connected! Scooter power engaged.');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      if (antisparkDisconnectSubRef.current) {
        try { antisparkDisconnectSubRef.current.remove(); } catch (_) {}
        antisparkDisconnectSubRef.current = null;
      }
      antisparkDisconnectSubRef.current = connected.onDisconnected(() => {
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

      if (antisparkNotifSubRef.current) {
        try { antisparkNotifSubRef.current.remove(); } catch (_) {}
        antisparkNotifSubRef.current = null;
      }

      // Subscribe to notifications via manager-level API
      const manager = getBleManager()!;
      antisparkNotifSubRef.current = manager.monitorCharacteristicForDevice(
        connected.id,
        BLE_ANTISPARK_SVC_UUID,
        BLE_ANTISPARK_CTRL_UUID,
        (err, notifiedChar) => {
          if (err) return;
          if (notifiedChar && notifiedChar.value) {
            const text = Buffer.from(notifiedChar.value, 'base64').toString('ascii');
            parseAntisparkTelemetryRef.current?.(text);
          }
        }
      );

      // Assert power ON command to ESP32 and query latest configuration
      setTimeout(async () => {
        await sendAntisparkCmd('STATUS');
        await sendAntisparkCmd('PWR 1');
        // Auto-connect to main Scooter-ESP32 to release Park Mode interlock
        if (!deviceRef.current && !isMainConnectingRef.current) {
          connectBle();
        }
      }, 350);
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

  const scanAndConnectAntispark = async (isManual: boolean = false) => {
    manualDisconnectRef.current = false;
    if (isManual) {
      manualOverrideOffRef.current = false;
      setManualOverrideOff(false);
      ScooterBeacon.setManualOverrideOff(false);
      if (iBeaconAutoKeyRef.current) {
        ScooterBeacon.startMonitoring(IBEACON_PROXIMITY_UUID, IBEACON_MAJOR, IBEACON_MINOR);
        setIBeaconStatus('Armed • Listening');
      }
    } else if (manualOverrideOffRef.current || ScooterBeacon.isManualOverrideOff()) {
      addConsole('[iBEACON] 🛑 Auto-ignition suppressed: Manual Turn OFF has priority.');
      return;
    }
    if (isAntisparkConnectingRef.current || isAntisparkConnected || antisparkDeviceRef.current) return;
    // Do not interrupt an active Main Scooter connection/scan with automatic Antispark scan
    if (!isManual && isMainConnectingRef.current) return;

    isAntisparkConnectingRef.current = true;
    setIsAntisparkConnecting(true);

    if (autoReconnectTimerRef.current) {
      clearTimeout(autoReconnectTimerRef.current);
      autoReconnectTimerRef.current = null;
    }
    if (antisparkScanTimerRef.current) {
      clearTimeout(antisparkScanTimerRef.current);
      antisparkScanTimerRef.current = null;
    }

    const manager = getBleManager();
    if (!manager) {
      setIsAntisparkConnected(true);
      setAntisparkState(true);
      antisparkStateRef.current = true;
      setAntisparkStatusText('Connected (Simulated)');
      setIsAntisparkConnecting(false);
      isAntisparkConnectingRef.current = false;
      addConsole('[SIMULATOR] Antispark connected and powered ON.');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      return;
    }

    try {
      // Attempt direct reconnection if device ID is already known BEFORE starting any scan
      if (savedAntisparkIdRef.current) {
        try {
          const knownDevs = await manager.devices([savedAntisparkIdRef.current]);
          if (knownDevs && knownDevs.length > 0) {
            await connectAntisparkDevice(knownDevs[0]);
            if (antisparkDeviceRef.current) return;
          }
        } catch (_) {}
      }

      setAntisparkStatusText('Scanning for Antispark...');
      addConsole('[ANTISPARK] Scanning for Scooter-Antispark...');
      if (!isMainConnectingRef.current) {
        try { manager.stopDeviceScan(); } catch (_) {}
      }

      let foundAntispark = false;

      // 8-second search timeout
      antisparkScanTimerRef.current = setTimeout(() => {
        antisparkScanTimerRef.current = null;
        if (!isMainConnectingRef.current) {
          try { manager.stopDeviceScan(); } catch (_) {}
        }
        if (!antisparkDeviceRef.current && !antisparkCharRef.current) {
          isAntisparkConnectingRef.current = false;
          setIsAntisparkConnecting(false);
          setAntisparkStatusText('Not found. Tap to retry.');
          addConsole('[ANTISPARK] Scooter-Antispark not detected nearby.');
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        }
      }, 8000);

      const scanServices = appStateRef.current === 'active' ? null : [BLE_ANTISPARK_SVC_UUID];
      manager.startDeviceScan(scanServices, { allowDuplicates: false }, async (error, scannedDevice) => {
        if (error) {
          if (antisparkScanTimerRef.current) {
            clearTimeout(antisparkScanTimerRef.current);
            antisparkScanTimerRef.current = null;
          }
          setAntisparkStatusText('Scan error: ' + error.message);
          addConsole(`[ANTISPARK] Scan error: ${error.message}`);
          isAntisparkConnectingRef.current = false;
          setIsAntisparkConnecting(false);
          return;
        }
        if (!scannedDevice || foundAntispark || !isAntisparkConnectingRef.current || antisparkDeviceRef.current) return;

        const matchesName =
          scannedDevice.name === 'Scooter-Antispark' ||
          scannedDevice.localName === 'Scooter-Antispark' ||
          scannedDevice.name === 'Antispark' ||
          scannedDevice.localName === 'Antispark';
        const matchesSvc =
          scannedDevice.serviceUUIDs &&
          scannedDevice.serviceUUIDs.some(
            (u) => u.toLowerCase() === BLE_ANTISPARK_SVC_UUID.toLowerCase()
          );
        const matchesId =
          savedAntisparkIdRef.current !== null &&
          scannedDevice.id === savedAntisparkIdRef.current;

        if (matchesName || matchesSvc || matchesId) {
          foundAntispark = true;
          if (antisparkScanTimerRef.current) {
            clearTimeout(antisparkScanTimerRef.current);
            antisparkScanTimerRef.current = null;
          }
          try { manager.stopDeviceScan(); } catch (_) {}
          await connectAntisparkDevice(scannedDevice);
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
    manualOverrideOffRef.current = true;
    setManualOverrideOff(true);
    ScooterBeacon.setManualOverrideOff(true);
    ScooterBeacon.stopMonitoring();
    setIBeaconStatus('Disabled • Manual Turn OFF Active');
    addConsole('[ANTISPARK] 🛑 Manual Turn OFF requested. Disabling iBeacon on ESP32 & iOS...');

    // Explicitly send PWR 0 to ESP32 to deactivate iBeacon advertising
    try {
      await sendAntisparkCmd('PWR 0');
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));

    if (autoReconnectTimerRef.current) {
      clearTimeout(autoReconnectTimerRef.current);
      autoReconnectTimerRef.current = null;
    }
    if (antisparkScanTimerRef.current) {
      clearTimeout(antisparkScanTimerRef.current);
      antisparkScanTimerRef.current = null;
    }
    const manager = getBleManager();
    if (manager && !isMainConnectingRef.current) {
      try { manager.stopDeviceScan(); } catch (_) {}
    }

    if (antisparkDisconnectSubRef.current) {
      try { antisparkDisconnectSubRef.current.remove(); } catch (_) {}
      antisparkDisconnectSubRef.current = null;
    }
    if (antisparkNotifSubRef.current) {
      try { antisparkNotifSubRef.current.remove(); } catch (_) {}
      antisparkNotifSubRef.current = null;
    }
    const devToCancel = antisparkDeviceRef.current || antisparkDevice;
    if (devToCancel) {
      try {
        await devToCancel.cancelConnection();
      } catch (e) {}
    }
    handleAntisparkDisconnected();
  };

  const handleAntisparkDisconnected = () => {
    if (antisparkScanTimerRef.current) {
      clearTimeout(antisparkScanTimerRef.current);
      antisparkScanTimerRef.current = null;
    }
    if (antisparkDisconnectSubRef.current) {
      try { antisparkDisconnectSubRef.current.remove(); } catch (_) {}
      antisparkDisconnectSubRef.current = null;
    }
    if (antisparkNotifSubRef.current) {
      try { antisparkNotifSubRef.current.remove(); } catch (_) {}
      antisparkNotifSubRef.current = null;
    }
    setIsAntisparkConnected(false);
    setAntisparkDevice(null);
    antisparkDeviceRef.current = null;
    antisparkCharRef.current = null;

    if (autoReconnectTimerRef.current) {
      clearTimeout(autoReconnectTimerRef.current);
      autoReconnectTimerRef.current = null;
    }

    if (manualDisconnectRef.current || antisparkAutoCutoffRef.current) {
      // Signal lost with auto-cutoff active OR manual disconnect: power turned OFF
      antisparkStateRef.current = false;
      setAntisparkState(false);
      setAntisparkStatusText('Disconnected (Power OFF)');
      addConsole('[ANTISPARK] Signal lost. Antispark turned OFF automatically.');
    } else {
      // Auto-cutoff disabled: Scooter power remains ON across disconnects
      if (antisparkStateRef.current) {
        setAntisparkStatusText('Disconnected • Power Kept ON');
        addConsole('[ANTISPARK] Disconnected. Scooter power kept ON (Auto-off disabled).');
      } else {
        setAntisparkStatusText('Disconnected (Power OFF)');
      }
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    const manager = getBleManager();
    if (manager && !isMainConnectingRef.current) {
      try { manager.stopDeviceScan(); } catch (_) {}
    }
  };

  // Setup connected main scooter controller (services, characteristics, notifications)
  const setupConnectedMainScooter = async (targetDevice: Device): Promise<boolean> => {
    espGearRef.current = 0;
    cmdQueueRef.current = [];
    isWritingRef.current = false;
    addConsole(`[BLE] Connecting to ${targetDevice.name || targetDevice.localName || targetDevice.id}...`);
    setStatusText('Connecting to Scooter-ESP32...');
    try {
      // Always invoke targetDevice.connect() so native BleModule registers connectedPeripherals[deviceId]
      // and clears any stale peripheral cache before service/characteristic discovery.
      const connectedDevice = await targetDevice.connect({ timeout: 6000 });

      // Verify this is not VESC's built-in BLE UART module which shares the Nordic UART Service UUID
      const devName = `${connectedDevice.name || ''} ${connectedDevice.localName || ''}`;
      if (/vesc|antispark/i.test(devName)) {
        addConsole(`[BLE] Rejecting non-main BLE device (${devName.trim()}), continuing search for Scooter-ESP32...`);
        try { await connectedDevice.cancelConnection(); } catch (_) {}
        return false;
      }

      // Discover services and characteristics before marking connected
      setStatusText('Discovering services...');
      await connectedDevice.discoverAllServicesAndCharacteristics();
      const services = await connectedDevice.services();
      const service = services.find((s) => s.uuid.toLowerCase() === BLE_SVC_UUID.toLowerCase());
      if (!service) throw new Error('Scooter Service not found');

      const characteristics = await service.characteristics();
      const char = characteristics.find((c) => c.uuid.toLowerCase() === BLE_CONSOLE_UUID.toLowerCase());
      if (!char) throw new Error('Console Characteristic not found');

      // On Scooter-ESP32, 6e400002 is both NOTIFY and WRITE. On VESC BLE UART (standard NUS), 6e400002 is write-only (not notifiable).
      if (!char.isNotifiable) {
        addConsole(`[BLE] Rejecting device ${connectedDevice.id} (6e400002 is not notifiable - VESC BLE UART), continuing search...`);
        try { await connectedDevice.cancelConnection(); } catch (_) {}
        return false;
      }

      // Confirmed genuine Scooter-ESP32! Save its UUID for fast direct reconnects.
      savedMainDeviceIdRef.current = connectedDevice.id;
      setDevice(connectedDevice);
      deviceRef.current = connectedDevice;

      // Negotiate higher MTU so ~90-byte telemetry packet is not truncated (especially on Android)
      try {
        await connectedDevice.requestMTU(512);
      } catch (_) {}

      // Keep charRef for backwards-compat, while writes/monitors use manager-level UUID API
      charRef.current = char;

      // Clean up any lingering notification subscription before starting a new one
      if (notifSubRef.current) {
        try { notifSubRef.current.remove(); } catch (_) {}
        notifSubRef.current = null;
      }

      // Subscribe via manager-level API so we never hold a stale characteristic object.
      // Route through parseTelemetryRef so the callback always calls the latest closure.
      const manager = getBleManager()!;
      notifSubRef.current = manager.monitorCharacteristicForDevice(
        connectedDevice.id,
        BLE_SVC_UUID,
        BLE_CONSOLE_UUID,
        (err, notifiedChar) => {
          if (err) {
            // Code 205 = BLE operation cancelled (normal on disconnect) – suppress noise
            if ((err as any).errorCode !== 205) {
              console.warn('Notification error:', err);
              addConsole(`[NOTIF-ERR] ${err.message}`);
            }
            return;
          }
          if (notifiedChar && notifiedChar.value) {
            const text = Buffer.from(notifiedChar.value, 'base64').toString('ascii');
            // Always use the latest parseTelemetry (via ref) to avoid stale closure
            parseTelemetryRef.current?.(text);
          }
        }
      );

      // Clean up any old disconnect listener before registering a new one
      if (disconnectSubRef.current) {
        try { disconnectSubRef.current.remove(); } catch (_) {}
        disconnectSubRef.current = null;
      }
      disconnectSubRef.current = connectedDevice.onDisconnected(() => {
        handleDisconnected();
      });

      // Mark connected only once characteristic is confirmed and monitored
      setIsConnected(true);
      setIsMainConnecting(false);
      isMainConnectingRef.current = false;
      setIsScanning(false);
      setStatusText('Connected to Scooter-ESP32');
      addConsole('[BLE] Main Scooter Connected & Telemetry Active!');
      activateKeepAwakeAsync();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      // Request initial status ('S') once CCCD subscription settles
      if (handshakeTimerRef.current) {
        clearTimeout(handshakeTimerRef.current);
        handshakeTimerRef.current = null;
      }
      handshakeTimerRef.current = setTimeout(async () => {
        handshakeTimerRef.current = null;
        if (!deviceRef.current) return;
        try {
          await sendCmd('S');
        } catch (e) {
          console.warn('Initial telemetry sync failed:', e);
        }
        setTimeout(() => {
          if (deviceRef.current && espGearRef.current === 0) {
            sendCmd('S');
          }
        }, 650);
      }, 250);
      return true;
    } catch (e: any) {
      console.warn('Main scooter connection failed:', e);
      addConsole(`[BLE-ERR] Connect failed: ${e.message}`);
      setStatusText('Connect failed: ' + e.message);
      setIsConnected(false);
      setDevice(null);
      deviceRef.current = null;
      charRef.current = null;
      if (disconnectSubRef.current) {
        try { disconnectSubRef.current.remove(); } catch (_) {}
        disconnectSubRef.current = null;
      }
      if (notifSubRef.current) {
        try { notifSubRef.current.remove(); } catch (_) {}
        notifSubRef.current = null;
      }
      return false;
    } finally {
      setIsMainConnecting(false);
      isMainConnectingRef.current = false;
    }
  };

  // Connect BLE (Main Scooter Controller: Scooter-ESP32)
  const connectBle = async () => {
    if (isMainConnectingRef.current || isConnected || deviceRef.current) return;

    const manager = getBleManager();
    if (!manager) {
      // In iOS Simulator, Bluetooth hardware does not exist
      setIsDemoMode(true);
      setIsConnected(true);
      setIsAntisparkConnected(true);
      setAntisparkState(true);
      antisparkStateRef.current = true;
      setAntisparkStatusText('Connected (Simulated)');

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
      isMainConnectingRef.current = true;
      setIsMainConnecting(true);
      setIsScanning(true);
      setStatusText('Checking Bluetooth state...');
      addConsole('[BLE] Checking Bluetooth state...');

      const btStatus = await waitForBluetoothPoweredOn(manager);
      if (!btStatus.ok) {
        setStatusText(btStatus.reason || 'Bluetooth not ready');
        addConsole(`[BLE] Error: ${btStatus.reason}`);
        setIsScanning(false);
        setIsMainConnecting(false);
        isMainConnectingRef.current = false;
        return;
      }

      // Stop any existing scans and cancel pending scan timers to avoid collision
      if (antisparkScanTimerRef.current) {
        clearTimeout(antisparkScanTimerRef.current);
        antisparkScanTimerRef.current = null;
      }
      if (mainScanTimerRef.current) {
        clearTimeout(mainScanTimerRef.current);
        mainScanTimerRef.current = null;
      }
      try { manager.stopDeviceScan(); } catch (_) {}

      // Fast direct reconnect if verified Scooter-ESP32 peripheral UUID is already known in this session
      if (savedMainDeviceIdRef.current) {
        try {
          addConsole(`[BLE] Fast-reconnecting to verified Scooter-ESP32 (${savedMainDeviceIdRef.current})...`);
          setStatusText('Reconnecting to Scooter-ESP32...');
          const knownDevs = await manager.devices([savedMainDeviceIdRef.current]);
          if (knownDevs && knownDevs.length > 0) {
            setIsScanning(false);
            const ok = await setupConnectedMainScooter(knownDevs[0]);
            if (ok && deviceRef.current) return;
          }
        } catch (e: any) {
          addConsole(`[BLE] Fast-reconnect fallback to scan: ${e?.message || e}`);
        }
        // Re-assert connecting state if fast reconnect fell back to scan
        isMainConnectingRef.current = true;
        setIsMainConnecting(true);
        setIsScanning(true);
      }

      setStatusText('Scanning for Scooter-ESP32...');
      addConsole('[BLE] Scanning for Scooter-ESP32...');

      let foundMainInScan = false;
      const seenScanIds = new Set<string>();

      // Stop scan after 10s if completed or timeout
      mainScanTimerRef.current = setTimeout(() => {
        mainScanTimerRef.current = null;
        try { manager.stopDeviceScan(); } catch (_) {}
        setIsScanning(false);
        if (!foundMainInScan && !charRef.current && !deviceRef.current) {
          setIsMainConnecting(false);
          isMainConnectingRef.current = false;
          setStatusText('Scooter not found. Tap to retry.');
          addConsole('[BLE] Scan timed out: Scooter-ESP32 not found');
        }
      }, 10000);

      manager.startDeviceScan(null, { allowDuplicates: true }, async (error, scannedDevice) => {
        if (error) {
          if (mainScanTimerRef.current) {
            clearTimeout(mainScanTimerRef.current);
            mainScanTimerRef.current = null;
          }
          console.warn('Scan error:', error);
          setStatusText('Scan error: ' + error.message);
          setIsScanning(false);
          setIsMainConnecting(false);
          isMainConnectingRef.current = false;
          return;
        }

        if (!scannedDevice) return;
        const dName = scannedDevice.name || '';
        const lName = scannedDevice.localName || '';
        const combinedName = `${dName} ${lName}`.trim();

        // Log each newly discovered named/service BLE device once per scan for diagnostics
        if (combinedName && !seenScanIds.has(`${scannedDevice.id}:${combinedName}`)) {
          seenScanIds.add(`${scannedDevice.id}:${combinedName}`);
          addConsole(`[SCAN] Saw ${combinedName} (${scannedDevice.id})`);
        }

        // Explicitly ignore VESC BLE UART and Scooter-Antispark (VESC BLE UART shares Nordic UART Service UUID!)
        if (/vesc|antispark/i.test(combinedName)) {
          return;
        }
        if (savedAntisparkIdRef.current && scannedDevice.id === savedAntisparkIdRef.current) {
          return;
        }

        // Match ONLY Scooter-ESP32 by exact name or previously verified Scooter-ESP32 UUID
        const isScooterEsp32 =
          dName === 'Scooter-ESP32' ||
          lName === 'Scooter-ESP32' ||
          (savedMainDeviceIdRef.current !== null && scannedDevice.id === savedMainDeviceIdRef.current);

        if (isScooterEsp32) {
          if (foundMainInScan || charRef.current || deviceRef.current || isConnected) return;
          foundMainInScan = true;

          // CRITICAL: Stop scan immediately before initiating connection.
          if (mainScanTimerRef.current) {
            clearTimeout(mainScanTimerRef.current);
            mainScanTimerRef.current = null;
          }
          try { manager.stopDeviceScan(); } catch (_) {}
          setIsScanning(false);

          await setupConnectedMainScooter(scannedDevice);
          return;
        }
      });
    } catch (e: any) {
      console.warn('Scan exception:', e);
      setStatusText('Scan error: ' + e.message);
      setIsScanning(false);
      setIsMainConnecting(false);
      isMainConnectingRef.current = false;
    }
  };

  const disconnect = async () => {
    if (demoIntervalRef.current) {
      clearInterval(demoIntervalRef.current);
      demoIntervalRef.current = null;
    }
    if (handshakeTimerRef.current) {
      clearTimeout(handshakeTimerRef.current);
      handshakeTimerRef.current = null;
    }
    setIsDemoMode(false);
    if (disconnectSubRef.current) {
      try { disconnectSubRef.current.remove(); } catch (_) {}
      disconnectSubRef.current = null;
    }
    if (notifSubRef.current) {
      try { notifSubRef.current.remove(); } catch (_) {}
      notifSubRef.current = null;
    }
    const devToCancel = deviceRef.current || device;
    if (devToCancel) {
      try {
        await devToCancel.cancelConnection();
      } catch (e) {}
      await new Promise((r) => setTimeout(r, 150));
    }
    handleDisconnected();
  };

  const handleDisconnected = () => {
    if (handshakeTimerRef.current) {
      clearTimeout(handshakeTimerRef.current);
      handshakeTimerRef.current = null;
    }
    if (disconnectSubRef.current) {
      try { disconnectSubRef.current.remove(); } catch (_) {}
      disconnectSubRef.current = null;
    }
    if (notifSubRef.current) {
      try { notifSubRef.current.remove(); } catch (_) {}
      notifSubRef.current = null;
    }
    // Clear write queue and lock so stale state doesn't block re-connect
    cmdQueueRef.current = [];
    isWritingRef.current = false;
    espGearRef.current = 0;
    setUnlockEnabled(false);
    setParkEnabled(true);
    setParkSecurityLocked(true);
    setIsConnected(false);
    setDevice(null);
    deviceRef.current = null;
    charRef.current = null;
    isMainConnectingRef.current = false;
    setIsMainConnecting(false);
    setIsScanning(false);
    setStatusText('Disconnected');
    addConsole('[BLE] Disconnected');
    deactivateKeepAwake();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  };

  // Parse Telemetry packet
  const parseTelemetry = (str: string) => {
    lastTelemetryTimeRef.current = Date.now();
    if (!isConnected && (charRef.current || deviceRef.current)) {
      setIsConnected(true);
      setIsMainConnecting(false);
      isMainConnectingRef.current = false;
      setIsScanning(false);
      setStatusText('Connected to Scooter-ESP32');
    }
    // Format: SPD=%.1f G=%d S=%d V=%.2f RAW=%d BRK=%d AMP=%.1f KICK=%s
    addConsole(str);

    const spdMatch = str.match(/SPD=([\d.]+)/);
    const gearMatch = str.match(/(?:G=|GEAR:\s*|GEAR shifted -> Gear\s*)(\d+)/);
    const parkMatch = str.match(/\bPARK=(\d+)/);
    const plMatch = str.match(/\bPL=(\d+)/);
    const peMatch = str.match(/\bPE=([\d.]+)/);
    const paMatch = str.match(/\bPA=([\d.]+)A?/);
    const sMatch = str.match(/S=(\d+)/);
    const vMatch = str.match(/V=([\d.]+)/);
    const rawMatch = str.match(/RAW=(\d+)/);
    const brkMatch = str.match(/BRK=(\d+)/);
    const benMatch = str.match(/BEN=(\d+)/);
    const ampMatch = str.match(/AMP=([\d.]+)/);
    const bcMatch = str.match(/BC=([\d.]+)A/);
    const ulMatch = str.match(/UL=(\d+)/);
    const gsMatch = str.match(/GS=(\d+)/);
    const ccMatch = str.match(/CC=([A-Za-z0-9_]+)/);
    const lMatch = str.match(/\bL=(\d+)/);
    const tlMatch = str.match(/\bTL=(\d+)/);
    const trMatch = str.match(/\bTR=(\d+)/);
    const ddmMatch = str.match(/\bDDM=(\d+)/);
    const absMatch = str.match(/\bABS=(\d+)/);
    const afMatch = str.match(/\bAF=(\d+)/);
    const abssMatch = str.match(/\bABSS=(\d+)/);
    const plockMatch = str.match(/\bPLOCK=(\d+)/);

    if (spdMatch) setSpeed(parseFloat(spdMatch[1]));
    if (vMatch) setVoltage(parseFloat(vMatch[1]).toFixed(1));
    if (ampMatch) setTargetAmps(parseFloat(ampMatch[1]).toFixed(1));
    if (rawMatch) setThrottleRaw(rawMatch[1]);
    if (brkMatch) setIsBraking(brkMatch[1] === '1');
    if (benMatch) setBrakeEnabled(benMatch[1] === '1');
    if (bcMatch) setBrakeAmps(parseFloat(bcMatch[1]));
    if (absMatch) setAbsEnabled(absMatch[1] === '1');
    if (afMatch) setAbsFreq(parseInt(afMatch[1], 10));
    if (abssMatch) setAbsStrobe(abssMatch[1] === '1');
    if (ulMatch) setUnlockEnabled(ulMatch[1] === '1');
    else if (gsMatch) setUnlockEnabled(gsMatch[1] === '1');
    if (lMatch) setFrontLightOn(lMatch[1] === '1');
    if (tlMatch) setTurnLeftOn(tlMatch[1] === '1');
    if (trMatch) setTurnRightOn(trMatch[1] === '1');
    if (ddmMatch) setDdmActive(ddmMatch[1] === '1');
    if (parkMatch) {
      const en = parkMatch[1] === '1';
      setParkEnabled(en);
      if (!en) setParkLockActive(false);
    }
    if (plMatch) setParkLockActive(plMatch[1] === '1');
    if (plockMatch) setParkSecurityLocked(plockMatch[1] === '1');
    if (peMatch) setParkErpm(Math.round(parseFloat(peMatch[1])));
    const peLog = str.match(/PARK ERPM (?:set to |:\s*)(\d+)/);
    if (peLog) setParkErpm(parseInt(peLog[1], 10));
    if (paMatch) setParkBrakeAmps(Math.round(parseFloat(paMatch[1])));
    const paLog = str.match(/PARK BRAKE AMPS (?:set to |:\s*)(\d+(?:\.\d+)?)/);
    if (paLog) setParkBrakeAmps(Math.round(parseFloat(paLog[1])));
    if (str.includes('PARK: MOTION DETECTED')) setParkLockActive(true);
    if (str.includes('PARK: MOTION STOPPED')) setParkLockActive(false);

    if (str.includes('e-ABS ENABLED')) setAbsEnabled(true);
    else if (str.includes('e-ABS DISABLED')) setAbsEnabled(false);
    if (str.includes('ABS STROBE: ENABLED')) setAbsStrobe(true);
    else if (str.includes('ABS STROBE: DISABLED')) setAbsStrobe(false);

    if (str.includes('UNLOCK: RELOCKED')) {
      setUnlockEnabled(false);
      setActiveGear(1);
    }

    if (str.includes('LIGHT: ON')) setFrontLightOn(true);
    else if (str.includes('LIGHT: OFF')) setFrontLightOn(false);

    if (str.includes('TURN LEFT: ON')) setTurnLeftOn(true);
    else if (str.includes('TURN LEFT: OFF')) setTurnLeftOn(false);

    if (str.includes('TURN RIGHT: ON')) setTurnRightOn(true);
    else if (str.includes('TURN RIGHT: OFF')) setTurnRightOn(false);

    if (str.includes('HAZARD: ON')) {
      setTurnLeftOn(true);
      setTurnRightOn(true);
    } else if (str.includes('HAZARD: OFF')) {
      setTurnLeftOn(false);
      setTurnRightOn(false);
    }

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
      setCruiseStatus((activeGear >= 3 && unlockEnabled) ? 'G4' : 'ARMED');
    } else if (str.includes('CRUISE: SUSPENDED')) {
      setCruiseActive(false);
      setCruiseStatus('G4');
    }

    if (gearMatch) {
      let g = parseInt(gearMatch[1], 10);
      if (g === 0) {
        espGearRef.current = 0;
        setActiveGear(0);
        setParkEnabled(true);
      } else if (g >= 1 && g <= 3) {
        espGearRef.current = g;
        lastNonParkGearRef.current = g;
        setActiveGear(g);
        setParkEnabled(false);
      }
    }
  };

  // Always keep parseTelemetryRef pointing to the freshest version of parseTelemetry so the
  // BLE monitor callback (which is set up once on connect) never uses a stale closure.
  parseTelemetryRef.current = parseTelemetry;

  // Internal: drain the command queue one-at-a-time using the manager-level UUID API
  // (avoids stale Characteristic object references that cause silent failures on iOS)
  const drainCmdQueue = async () => {
    if (isWritingRef.current) return; // already running a drain loop
    isWritingRef.current = true;
    try {
      while (cmdQueueRef.current.length > 0) {
        const cmd = cmdQueueRef.current.shift()!;
        const mgr = getBleManager();
        const devId = deviceRef.current?.id ?? savedMainDeviceIdRef.current;
        if (!mgr || !devId || !deviceRef.current) break; // no connection, stop draining
        const base64Data = Buffer.from(cmd, 'utf-8').toString('base64');
        const txId = `tx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        try {
          await Promise.race([
            mgr.writeCharacteristicWithResponseForDevice(
              devId,
              BLE_SVC_UUID,
              BLE_CONSOLE_UUID,
              base64Data,
              txId
            ),
            new Promise((_, reject) =>
              setTimeout(() => {
                try { mgr.cancelTransaction(txId); } catch (_) {}
                reject(new Error('WriteWithResponse timeout'));
              }, 1200)
            ),
          ]);
          addConsole(`[TX] ${cmd}`);
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        } catch (e: any) {
          // Fallback to writeWithoutResponse if ATT Write Request timed out or collided
          try {
            await mgr.writeCharacteristicWithoutResponseForDevice(
              devId,
              BLE_SVC_UUID,
              BLE_CONSOLE_UUID,
              base64Data
            );
            addConsole(`[TX-NR] ${cmd}`);
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          } catch (e2: any) {
            console.warn('Write error:', e2);
            addConsole(`[ERR] ${e2.message || e.message}`);
            break;
          }
        }
      }
    } finally {
      isWritingRef.current = false;
    }
  };

  // Outgoing BLE commands – queues instead of dropping when a write is in flight
  const sendCmd = async (cmdStr: string) => {
    if (isDemoMode) {
      addConsole(`[SIM-TX] ${cmdStr}`);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      if (cmdStr.startsWith('P ') || cmdStr.startsWith('G ')) {
        const g = parseInt(cmdStr.split(' ')[1], 10);
        if (g === 0) {
          setParkEnabled(true);
          setActiveGear(0);
        } else if (g >= 1 && g <= 3) {
          setParkEnabled(false);
          lastNonParkGearRef.current = g;
          setActiveGear(g);
        }
      } else if (cmdStr.startsWith('PARK ')) {
        const en = cmdStr.split(' ')[1] === '1';
        setParkEnabled(en);
        setActiveGear(en ? 0 : lastNonParkGearRef.current);
      } else if (cmdStr === 'PARK') {
        setParkEnabled((prev) => {
          const next = !prev;
          setActiveGear(next ? 0 : lastNonParkGearRef.current);
          return next;
        });
      } else if (cmdStr.startsWith('PE ')) {
        const e = parseInt(cmdStr.split(' ')[1], 10);
        if (!isNaN(e)) setParkErpm(e);
      } else if (cmdStr.startsWith('PA ')) {
        const a = parseFloat(cmdStr.split(' ')[1]);
        if (!isNaN(a)) setParkBrakeAmps(Math.round(a));
      } else if (cmdStr.startsWith('UL ') || cmdStr.startsWith('GS ')) {
        const en = cmdStr.split(' ')[1] === '1';
        setUnlockEnabled(en);
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
          setCruiseStatus((activeGear >= 3 && unlockEnabled) ? 'G4' : 'ARMED');
        }
      } else if (cmdStr === 'L' || cmdStr === 'LIGHT') {
        setFrontLightOn((prev) => !prev);
      } else if (cmdStr.startsWith('L ') || cmdStr.startsWith('LIGHT ')) {
        const val = cmdStr.split(' ')[1] === '1';
        setFrontLightOn(val);
      } else if (cmdStr === 'TL' || cmdStr === 'TURNL') {
        setTurnLeftOn((prev) => !prev);
        setTurnRightOn(false);
      } else if (cmdStr === 'TR' || cmdStr === 'TURNR') {
        setTurnRightOn((prev) => !prev);
        setTurnLeftOn(false);
      } else if (cmdStr === 'HAZ' || cmdStr === 'HAZARD') {
        setTurnLeftOn((prev) => !prev);
        setTurnRightOn((prev) => !prev);
      } else if (cmdStr === 'DUAL' || cmdStr === 'DDM') {
        setDdmActive((prev) => !prev);
      } else if (cmdStr === 'DUAL 1' || cmdStr === 'DDM 1') {
        setDdmActive(true);
      } else if (cmdStr === 'DUAL 0' || cmdStr === 'DDM 0') {
        setDdmActive(false);
      }
      return;
    }
    // Real BLE: push to queue, then drain (no-op if already draining)
    const devId = deviceRef.current?.id ?? savedMainDeviceIdRef.current;
    if (!devId) return;
    cmdQueueRef.current.push(cmdStr);
    drainCmdQueue();
  };


  const toggleDualMode = (desiredState?: boolean) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const nextState = desiredState !== undefined ? desiredState : !ddmActive;
    setDdmActive(nextState);
    sendCmd(nextState ? 'DUAL 1' : 'DUAL 0');
  };

  const togglePark = (val: boolean) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setParkEnabled(val);
    if (val) {
      if (activeGear >= 1 && activeGear <= 3) {
        lastNonParkGearRef.current = activeGear;
      }
      setActiveGear(0);
      sendCmd('PARK 1');
    } else {
      const restoreGear = lastNonParkGearRef.current >= 1 ? lastNonParkGearRef.current : 1;
      setActiveGear(restoreGear);
      sendCmd('PARK 0');
    }
  };

  const toggleUnlock = (val: boolean) => {
    if (val && activeGear <= 1) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      Alert.alert(
        'Cannot Unlock in Park / 1st Gear',
        'Please shift to Gear 2 or Gear 3 on the handlebar display or app before activating Unlock.',
        [{ text: 'OK' }]
      );
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setUnlockEnabled(val);
    sendCmd(`UL ${val ? 1 : 0}`);
  };
  const toggleGearShift = toggleUnlock;

  const toggleBrakeSensor = (val: boolean) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setBrakeEnabled(val);
    sendCmd(`BEN ${val ? 1 : 0}`);
  };

  const toggleAbs = (val: boolean) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setAbsEnabled(val);
    sendCmd(val ? 'ABS 1' : 'ABS 0');
  };

  const toggleAbsStrobe = (val: boolean) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setAbsStrobe(val);
    sendCmd(val ? 'ABSS 1' : 'ABSS 0');
  };

  const handleAbsFreqChange = (val: number) => {
    setAbsFreq(Math.round(val));
  };

  const handleAbsFreqComplete = (val: number) => {
    sendCmd(`AF ${Math.round(val)}`);
  };

  const toggleCruiseControl = (val: boolean) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setCruiseEnabled(val);
    if (!val) {
      setCruiseActive(false);
      setCruiseStatus('OFF');
    } else {
      setCruiseStatus((activeGear >= 3 && unlockEnabled) ? 'G4' : 'ARMED');
    }
    sendCmd(`CC ${val ? 1 : 0}`);
  };

  const selectProfile = (gear: number) => {
    setParkEnabled(gear === 0);
    if (gear >= 1 && gear <= 3) {
      lastNonParkGearRef.current = gear;
    }
    if (gear === 1 && unlockEnabled) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      setUnlockEnabled(false);
      setActiveGear(1);
      sendCmd('P 1');
      addConsole('[SAFETY] Gear 1 selected: Scooter Locked (5 km/h limit)');
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setActiveGear(gear);
    sendCmd(`P ${gear}`);
  };

  // Automated 5x hardware verification loop when launched with --autotest5x
  useEffect(() => {
    if (!ScooterBeacon.isAutoTest5xRequested()) return;
    let cancelled = false;
    const waitCond = async (pred: () => boolean, timeoutMs: number): Promise<boolean> => {
      const start = Date.now();
      while (!cancelled && Date.now() - start < timeoutMs) {
        if (pred()) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return pred();
    };

    const run5xTest = async () => {
      await new Promise((r) => setTimeout(r, 1000));
      addConsole('[AUTOTEST-5X] 🚀 Starting 5-in-a-row Connect -> Change Gear -> Disconnect test on iPhone...');
      if (!antisparkDeviceRef.current && !isAntisparkConnectingRef.current) {
        scanAndConnectAntispark(true);
      }
      await waitCond(() => antisparkDeviceRef.current !== null && !isAntisparkConnectingRef.current, 4500);
      await new Promise((r) => setTimeout(r, 2000));
      addConsole(`[AUTOTEST-5X] Dual-BLE status: Antispark connected=${antisparkDeviceRef.current !== null}`);

      for (let cycle = 1; cycle <= 5; cycle++) {
        if (cancelled) return;
        addConsole(`[AUTOTEST-5X] === CYCLE ${cycle}/5: Connecting to Scooter-ESP32 (Antispark=${antisparkDeviceRef.current !== null}) ===`);
        await connectBle();

        const connectedAndTelemetry = await waitCond(
          () => deviceRef.current !== null && espGearRef.current >= 1,
          12000
        );
        if (!connectedAndTelemetry) {
          addConsole(`[AUTOTEST-5X] ❌ CYCLE ${cycle}/5 FAILED: Did not receive initial telemetry after connect`);
          return;
        }

        const startGear = espGearRef.current;
        const targetGear = startGear === 1 ? 2 : startGear === 2 ? 3 : 1;
        addConsole(
          `[AUTOTEST-5X] Cycle ${cycle}/5: Connected (ESP32 G=${startGear}). Changing gear in app -> G=${targetGear}...`
        );

        selectProfile(targetGear);

        const gearChanged = await waitCond(() => espGearRef.current === targetGear, 5000);
        if (!gearChanged) {
          addConsole(
            `[AUTOTEST-5X] ❌ CYCLE ${cycle}/5 FAILED: ESP32 gear stayed G=${espGearRef.current}, expected G=${targetGear}`
          );
          return;
        }

        addConsole(
          `[AUTOTEST-5X] Cycle ${cycle}/5: Verified ESP32 gear changed ${startGear} -> ${espGearRef.current}! Disconnecting...`
        );
        await disconnect();

        const disconnectedOk = await waitCond(() => deviceRef.current === null, 5000);
        if (!disconnectedOk) {
          addConsole(`[AUTOTEST-5X] ❌ CYCLE ${cycle}/5 FAILED: Device did not disconnect cleanly`);
          return;
        }

        addConsole(`[AUTOTEST-5X] ✅ CYCLE ${cycle}/5 PASSED!`);
        await new Promise((r) => setTimeout(r, 1000));
      }
      addConsole('[AUTOTEST-5X] 🎉 ALL 5/5 CYCLES PASSED IN A ROW!');
    };

    run5xTest();
    return () => {
      cancelled = true;
    };
  }, []);

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
        {parkEnabled && (
          <View style={[styles.badge, (parkLockActive || parkSecurityLocked) ? styles.badgeBraking : styles.badgeCruiseG4]}>
            <Text style={[styles.badgeText, (parkLockActive || parkSecurityLocked) ? styles.badgeTextBraking : styles.badgeTextCruiseG4]}>
              {parkSecurityLocked ? '🔒 PARK LOCKED (AWAY)' : (parkLockActive ? '🚨 PARK BRAKING' : '🅿️ PARK')}
            </Text>
          </View>
        )}
        <View style={[styles.badge, isBraking ? styles.badgeBraking : (!brakeEnabled ? styles.badgeDisabled : null)]}>
          <Text style={[styles.badgeText, isBraking && styles.badgeTextBraking]}>
            {!brakeEnabled
              ? '⚪ BRAKE OFF'
              : isBraking
              ? (absEnabled ? '⚡ e-ABS' : '🛑 BRAKING')
              : (absEnabled ? 'ABS READY' : 'BRAKE OK')}
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
          {parkEnabled || activeGear === 0
            ? '🅿️ Park (Gear 0)'
            : `Gear ${activeGear} ${unlockEnabled ? '(Unlocked 25 / Unlim)' : '(Locked 5 / 15 / 20)'}`}
        </Text>
      </View>

      <View style={[styles.profileGrid, inLandscapeMode && styles.profileGridLandscape]}>
        {[
          {
            gear: 1,
            name: unlockEnabled ? 'Lock Safety Trigger' : 'Eco Safe',
            limit: '5 km/h',
            amps: '25A Max',
            color: '#10b981',
            handlebar: 'Disp 1',
          },
          {
            gear: 2,
            name: unlockEnabled ? 'Drive Unlocked' : 'City Cruising',
            limit: unlockEnabled ? '25 km/h' : '15 km/h',
            amps: unlockEnabled ? '65A Max' : '40A Max',
            color: '#00f2fe',
            handlebar: 'Disp 2',
          },
          {
            gear: 3,
            name: unlockEnabled ? 'Sport Unlimited' : 'Drive Legal',
            limit: unlockEnabled ? 'Unlimited' : '20 km/h',
            amps: unlockEnabled ? '120A Max' : '65A Max',
            color: unlockEnabled ? '#f43f5e' : '#f59e0b',
            handlebar: 'Disp 3',
          },
        ].map((p) => {
          const active = activeGear === p.gear;
          return (
            <TouchableOpacity
              key={p.gear}
              style={[
                styles.profileCard,
                inLandscapeMode && styles.profileCardLandscape,
                active && { borderColor: p.color, backgroundColor: 'rgba(255, 255, 255, 0.08)' },
              ]}
              onPress={() => selectProfile(p.gear)}
              activeOpacity={0.7}
            >
              <View style={styles.pHeader}>
                <Text style={[styles.pGear, inLandscapeMode && styles.pGearLandscape, active && { color: p.color }]}>G{p.gear}</Text>
                <Text style={[styles.pLimit, inLandscapeMode && styles.pLimitLandscape]}>{p.limit}</Text>
              </View>
              <Text style={[styles.pName, inLandscapeMode && styles.pNameLandscape]} numberOfLines={1}>{p.name}</Text>
              <View style={styles.pFooterRow}>
                <Text style={[styles.pAmps, inLandscapeMode && styles.pAmpsLandscape]}>{p.amps}</Text>
                <View style={[styles.handlebarBadge, active && { borderColor: p.color }]}>
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
    return (
      <View style={styles.antisparkCard}>
        {/* Header Row */}
        <TouchableOpacity
          style={styles.antisparkHeaderRow}
          onPress={() => toggleSection('antispark')}
          activeOpacity={0.7}
        >
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
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <View
              style={[
                styles.antisparkStateTag,
                antisparkState ? styles.antisparkStateTagActive : styles.antisparkStateTagInactive,
              ]}
            >
              <Text
                style={[
                  styles.antisparkStateTagText,
                  antisparkState && styles.antisparkStateTagTextActive,
                ]}
              >
                {antisparkState ? 'POWER ON' : 'POWER OFF'}
              </Text>
            </View>
            <Text style={styles.sectionToggleIcon}>{openSections.antispark ? '▲' : '▼'}</Text>
          </View>
        </TouchableOpacity>

        {openSections.antispark && (
          <View style={{ gap: 10, marginTop: 4 }}>
            {/* Dedicated Main Power Action Button */}
            <View style={styles.dedicatedPowerButtonWrap}>
          {isAntisparkConnected ? (
            <View style={styles.powerConnectedBox}>
              <View style={styles.powerConnectedTopRow}>
                <View style={styles.powerConnectedStatusDot} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.powerConnectedTitle}>⚡ SCOOTER POWERED ON</Text>
                  <Text style={styles.powerConnectedSub}>
                    GPIO 10 HIGH (+) • GPIO 20 LOW (-) • Optocoupler Active
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
              onPress={isAntisparkConnecting ? undefined : () => scanAndConnectAntispark(true)}
              activeOpacity={0.8}
              disabled={isAntisparkConnecting}
            >
              <Text style={styles.btnDedicatedPowerConnectIcon}>
                {isAntisparkConnecting ? '⏳' : '⚡'}
              </Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.btnDedicatedPowerConnectText}>
                  {isAntisparkConnecting
                    ? 'CONNECTING TO ANTISPARK...'
                    : antisparkState
                    ? 'RECONNECT TO ANTISPARK (POWER ON)'
                    : 'CONNECT & POWER ON'}
                </Text>
                <Text style={styles.btnDedicatedPowerConnectSub}>
                  {isAntisparkConnecting
                    ? 'Scanning for Scooter-Antispark nearby...'
                    : antisparkState
                    ? 'Scooter is currently running. Tap to reconnect app control.'
                    : 'Tap to connect to Scooter-Antispark and engage power'}
                </Text>
              </View>
            </TouchableOpacity>
          )}
        </View>

        {/* Automatic Cutoff Toggle Card */}
        <View style={styles.autoCutoffCard}>
          <View style={styles.autoCutoffHeaderRow}>
            <View style={{ flex: 1, minWidth: 0, gap: 3, marginRight: 10 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <Text style={styles.autoCutoffTitle}>🛡️ AUTO TURN OFF ON DISCONNECT</Text>
                <View
                  style={[
                    styles.autoCutoffBadge,
                    antisparkAutoCutoff ? styles.autoCutoffBadgeActive : styles.autoCutoffBadgeDisabled,
                  ]}
                >
                  <Text
                    style={[
                      styles.autoCutoffBadgeText,
                      antisparkAutoCutoff ? styles.autoCutoffBadgeTextActive : styles.autoCutoffBadgeTextDisabled,
                    ]}
                  >
                    {antisparkAutoCutoff ? 'AUTO-OFF' : 'OFF'}
                  </Text>
                </View>
              </View>
              <Text style={styles.autoCutoffDesc}>
                {antisparkAutoCutoff
                  ? 'Power turns OFF automatically when Bluetooth signal is lost, app is closed, or phone walks away.'
                  : '🛡️ Active Park Mode enabled: Scooter stays powered ON in Park Mode when phone disconnects, actively blocking wheel motion.'}
              </Text>
            </View>
            <View style={{ flexShrink: 0 }}>
              <Switch
                value={antisparkAutoCutoff}
                onValueChange={toggleAntisparkAutoCutoff}
                trackColor={{ false: '#334155', true: '#38bdf8' }}
                thumbColor={antisparkAutoCutoff ? '#ffffff' : '#94a3b8'}
                ios_backgroundColor="#334155"
              />
            </View>
          </View>
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
                  {antisparkState ? 'PIN 10 HIGH • PIN 20 LOW' : 'PIN 10 LOW • PIN 20 LOW'}
                </Text>
              </View>
            </View>
            <Text style={styles.antisparkHeroSub}>
              {antisparkState
                ? '⚡ Optocoupler Active: GPIO 10 (+) -> GPIO 20 (-)'
                : '⚪ Standby: Optocoupler Depowered (0V differential)'}
            </Text>
          </View>
        </View>



        {/* Apple iBeacon Hands-Free Auto Key Card */}
        <View style={styles.ibeaconCard}>
          <View style={styles.ibeaconHeaderRow}>
            <View style={{ flex: 1, minWidth: 0, gap: 3, marginRight: 10 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <Text style={styles.ibeaconTitle}>🍎 APPLE iBEACON AUTO-IGNITION</Text>
                <View style={[styles.beaconBadge, iBeaconAutoKey ? styles.beaconBadgeActive : styles.beaconBadgeInactive]}>
                  <Text style={styles.beaconBadgeText}>
                    {iBeaconAutoKey ? 'ARMED' : 'OFF'}
                  </Text>
                </View>
              </View>
              <Text style={styles.ibeaconDesc}>
                {iBeaconAutoKey
                  ? 'Hardware-level iOS detection. Wakes your phone when locked in pocket & auto-engages power.'
                  : 'Hands-free beacon wake-up disabled. Manual button control only.'}
              </Text>
            </View>
            <View style={{ flexShrink: 0 }}>
              <Switch
                value={iBeaconAutoKey}
                onValueChange={(val) => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                  setIBeaconAutoKey(val);
                  iBeaconAutoKeyRef.current = val;
                  if (val) {
                    ScooterBeacon.startMonitoring(IBEACON_PROXIMITY_UUID, IBEACON_MAJOR, IBEACON_MINOR);
                    setIBeaconStatus('Armed • Listening');
                  } else {
                    ScooterBeacon.stopMonitoring();
                    setIBeaconStatus('Disabled');
                    setIBeaconProximity('unknown');
                  }
                }}
                trackColor={{ false: '#1e293b', true: '#00f2fe' }}
                thumbColor={iBeaconAutoKey ? '#ffffff' : '#64748b'}
                ios_backgroundColor="#1e293b"
              />
            </View>
          </View>

          {/* iBeacon Real-Time Proximity Radar Pill */}
          {iBeaconAutoKey && (
            <View style={styles.ibeaconDetailsBox}>
              <View style={styles.ibeaconDetailsRow}>
                <View style={styles.ibeaconDetailPill}>
                  <Text style={styles.ibeaconDetailPillLabel}>PROXIMITY</Text>
                  <Text style={[
                    styles.ibeaconDetailPillVal,
                    (iBeaconProximity === 'immediate' || iBeaconProximity === 'near') && { color: '#00f2fe' }
                  ]}>
                    {iBeaconProximity === 'immediate'
                      ? '🎯 IMMEDIATE (< 1m)'
                      : iBeaconProximity === 'near'
                      ? '🟢 NEAR (< 2m)'
                      : iBeaconProximity === 'far'
                      ? '🟡 FAR (> 2m)'
                      : '⚪ SEARCHING'}
                  </Text>
                </View>

                <View style={styles.ibeaconDetailPill}>
                  <Text style={styles.ibeaconDetailPillLabel}>ACCURACY</Text>
                  <Text style={styles.ibeaconDetailPillVal}>
                    {iBeaconAccuracy !== null ? `±${iBeaconAccuracy}m` : '--'}
                  </Text>
                </View>

                <View style={styles.ibeaconDetailPill}>
                  <Text style={styles.ibeaconDetailPillLabel}>BEACON RSSI</Text>
                  <Text style={styles.ibeaconDetailPillVal}>
                    {iBeaconRssi !== null ? `${iBeaconRssi} dBm` : '-- dBm'}
                  </Text>
                </View>
              </View>

              {/* Sensitivity Selector */}
              <View style={styles.sensitivityRow}>
                <Text style={styles.sensitivityLabel}>Wake Sensitivity:</Text>
                <View style={styles.sensitivityBtnGroup}>
                  {(['immediate', 'near', 'far'] as const).map((s) => (
                    <TouchableOpacity
                      key={s}
                      style={[
                        styles.btnSensitivity,
                        iBeaconSensitivity === s && styles.btnSensitivityActive
                      ]}
                      onPress={() => {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        setIBeaconSensitivity(s);
                        iBeaconSensitivityRef.current = s;
                      }}
                      activeOpacity={0.7}
                    >
                      <Text style={[
                        styles.btnSensitivityText,
                        iBeaconSensitivity === s && styles.btnSensitivityTextActive
                      ]}>
                        {s === 'immediate' ? '< 1m' : s === 'near' ? '< 2m (Def)' : '< 4m'}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              {/* Action & Status Row */}
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, gap: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
                  <Text style={{ color: '#94a3b8', fontSize: 11, fontWeight: '600' }}>iOS Auth:</Text>
                  <View style={{
                    backgroundColor: iBeaconAuthStatus === 'authorizedAlways' ? '#10b98120' : iBeaconAuthStatus === 'authorizedWhenInUse' ? '#f59e0b20' : '#ef444420',
                    paddingHorizontal: 6,
                    paddingVertical: 2,
                    borderRadius: 4
                  }}>
                    <Text style={{
                      color: iBeaconAuthStatus === 'authorizedAlways' ? '#10b981' : iBeaconAuthStatus === 'authorizedWhenInUse' ? '#f59e0b' : '#ef4444',
                      fontSize: 10,
                      fontWeight: '700'
                    }}>
                      {iBeaconAuthStatus === 'authorizedAlways' ? 'ALWAYS (Pocket OK)' : iBeaconAuthStatus === 'authorizedWhenInUse' ? 'WHILE USING' : iBeaconAuthStatus}
                    </Text>
                  </View>
                </View>

                <TouchableOpacity
                  style={{
                    backgroundColor: '#00f2fe20',
                    borderColor: '#00f2fe60',
                    borderWidth: 1,
                    borderRadius: 6,
                    paddingVertical: 4,
                    paddingHorizontal: 10,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 4
                  }}
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    addConsole('[iBEACON] 🔄 Manual Re-Arm & Scan triggered');
                    ScooterBeacon.startMonitoring(IBEACON_PROXIMITY_UUID, IBEACON_MAJOR, IBEACON_MINOR);
                    setIBeaconStatus('Armed • Listening');
                    scanAndConnectAntispark(true);
                  }}
                  activeOpacity={0.7}
                >
                  <Text style={{ color: '#00f2fe', fontSize: 11, fontWeight: '700' }}>🔄 Re-Arm & Scan</Text>
                </TouchableOpacity>
              </View>

              {/* Manual Turn-Off Priority Banner */}
              {manualOverrideOff && (
                <View style={styles.manualOverrideBanner}>
                  <Text style={styles.manualOverrideBannerText}>
                    🛑 <Text style={{ fontWeight: '700' }}>Manual Turn OFF Active:</Text> Auto-ignition is paused because you manually turned off the scooter. Step away to re-arm automatically, or tap below to reconnect.
                  </Text>
                  <TouchableOpacity
                    style={styles.manualOverrideResumeBtn}
                    onPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      manualOverrideOffRef.current = false;
                      setManualOverrideOff(false);
                      ScooterBeacon.setManualOverrideOff(false);
                      scanAndConnectAntispark(true);
                    }}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.manualOverrideResumeBtnText}>⚡ Re-Arm & Turn ON</Text>
                  </TouchableOpacity>
                </View>
              )}

              {/* Permission Helper Banner if not Always Allowed */}
              {iBeaconAuthStatus !== 'authorizedAlways' && (
                <TouchableOpacity
                  style={styles.permissionAlertBox}
                  onPress={async () => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    if (iBeaconAuthStatus === 'unavailable') {
                      addConsole('[iBEACON] Native module unavailable. The app binary on device must be rebuilt.');
                      Alert.alert(
                        'Rebuild Required',
                        'The iBeacon proximity engine requires compiling the native module. Please run:\nnpx expo run:ios\nto install the updated app binary on your iPhone.'
                      );
                    } else if (iBeaconAuthStatus === 'notDetermined' || iBeaconAuthStatus === 'unknown') {
                      addConsole('[iBEACON] Requesting in-app Location permission...');
                      ScooterBeacon.requestLocationPermission();
                    } else if (iBeaconAuthStatus === 'authorizedWhenInUse') {
                      addConsole('[iBEACON] Requesting Always authorization upgrade...');
                      ScooterBeacon.requestAlwaysAuthorization();
                    } else if (iBeaconAuthStatus === 'denied' || iBeaconAuthStatus === 'restricted') {
                      try {
                        await Linking.openSettings();
                      } catch (_) {
                        ScooterBeacon.requestLocationPermission();
                      }
                    } else {
                      ScooterBeacon.requestLocationPermission();
                    }
                  }}
                  activeOpacity={0.8}
                >
                  <Text style={styles.permissionAlertText}>
                    {iBeaconAuthStatus === 'unavailable' ? (
                      <>⚠️ <Text style={{ fontWeight: '700' }}>Native Module Not Compiled:</Text> App binary needs rebuilding with <Text style={{ fontWeight: '700' }}>npx expo run:ios</Text> to enable iBeacon proximity.</>
                    ) : iBeaconAuthStatus === 'authorizedWhenInUse' ? (
                      <>⚠️ <Text style={{ fontWeight: '700' }}>"Always Allow" Recommended:</Text> Currently "While Using". Tap here to upgrade to <Text style={{ fontWeight: '700' }}>"Always"</Text> for hands-free unlock while iPhone is locked in your pocket.</>
                    ) : (
                      <>⚠️ <Text style={{ fontWeight: '700' }}>Location Permission Required:</Text> Tap here to allow Location access for iBeacon auto-ignition.</>
                    )}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          )}
        </View>
        </View>
        )}

      </View>
    );
  };

  const renderParkCard = () => (
    <View
      style={[
        styles.gearShiftCard,
        parkEnabled && {
          borderColor: parkLockActive ? 'rgba(239, 68, 68, 0.7)' : 'rgba(245, 158, 11, 0.45)',
          backgroundColor: parkLockActive ? 'rgba(239, 68, 68, 0.12)' : 'rgba(245, 158, 11, 0.08)',
        },
      ]}
    >
      <TouchableOpacity
        style={styles.cardHeaderCollapseRow}
        onPress={() => toggleSection('park')}
        activeOpacity={0.7}
      >
        <View style={styles.gearShiftTextCol}>
          <View style={styles.gearShiftTitleRow}>
            <Text style={styles.gearShiftTitle}>🅿️ PARK & MOTOR LOCK (0)</Text>
            <View
              style={[
                styles.gearShiftBadge,
                parkEnabled
                  ? (parkLockActive ? styles.badgeBraking : styles.cruiseBadgeG4)
                  : styles.gearShiftBadgeOff,
              ]}
            >
              <Text
                style={[
                  styles.gearShiftBadgeText,
                  parkEnabled
                    ? ((parkLockActive || parkSecurityLocked) ? styles.badgeTextBraking : styles.cruiseBadgeTextG4)
                    : styles.gearShiftBadgeTextOff,
                ]}
              >
                {parkEnabled
                  ? (parkSecurityLocked
                      ? '🔒 PHONE AWAY (LOCKED)'
                      : (parkLockActive ? '🚨 MOTION BLOCKED' : 'PARK ON (DISP 0)'))
                  : 'DRIVING (GEAR 1–3)'}
              </Text>
            </View>
          </View>
          <Text style={styles.gearShiftDesc} numberOfLines={openSections.park ? undefined : 1}>
            {parkEnabled
              ? parkSecurityLocked
                ? 'Security lock active: phone is away. Handlebar display buttons cannot exit Park Mode until you return.'
                : parkLockActive
                ? 'Motion detected! Applying active directional counter-torque and electromagnetic brake to lock motors.'
                : `Park active (Gear 0). Motors in 0A silent standby; automatically blocks movement if pushed.`
              : 'Locks scooter motors when parked. Detects any movement and immediately blocks it via directional brakes.'}
          </Text>
        </View>
        <Text style={styles.sectionToggleIcon}>{openSections.park ? '▲' : '▼'}</Text>
      </TouchableOpacity>

      {openSections.park && (
        <View style={{ marginTop: 10, borderTopWidth: 1, borderTopColor: 'rgba(255, 255, 255, 0.08)', paddingTop: 10 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <Text style={[styles.controlLabel, { fontSize: 13 }]}>Engage Park & Motor Lock</Text>
            <Switch
              value={parkEnabled}
              onValueChange={togglePark}
              trackColor={{ false: '#1e293b', true: parkLockActive ? '#ef4444' : '#f59e0b' }}
              thumbColor={parkEnabled ? '#ffffff' : '#64748b'}
              ios_backgroundColor="#1e293b"
            />
          </View>
          <View style={{ marginTop: 6, borderTopWidth: 1, borderTopColor: 'rgba(255, 255, 255, 0.08)', paddingTop: 8 }}>
            <View style={styles.sliderHeader}>
              <Text style={styles.controlLabel}>Motion Sensitivity</Text>
              <Text style={styles.sliderVal}>{parkErpm} ERPM (≈ {(parkErpm * 0.00319).toFixed(2)} km/h)</Text>
            </View>
            <Slider
              style={styles.slider}
              minimumValue={20}
              maximumValue={400}
              step={10}
              value={parkErpm}
              onValueChange={(val) => setParkErpm(val)}
              onSlidingComplete={(val) => sendCmd(`PE ${val}`)}
              minimumTrackTintColor={parkEnabled ? '#f59e0b' : '#38bdf8'}
              maximumTrackTintColor="rgba(255, 255, 255, 0.15)"
              thumbTintColor={parkEnabled ? '#f59e0b' : '#38bdf8'}
            />
            <Text style={[styles.gearShiftDesc, { marginTop: 2, fontSize: 11 }]}>
              Lower ERPM = higher sensitivity (locks on slight roll). Increase if motor sensor noise triggers false braking.
            </Text>
          </View>
          <View style={{ marginTop: 10, borderTopWidth: 1, borderTopColor: 'rgba(255, 255, 255, 0.08)', paddingTop: 8 }}>
            <View style={styles.sliderHeader}>
              <Text style={styles.controlLabel}>Park Brake Current</Text>
              <Text style={styles.sliderVal}>{parkBrakeAmps} A</Text>
            </View>
            <Slider
              style={styles.slider}
              minimumValue={5}
              maximumValue={120}
              step={5}
              value={parkBrakeAmps}
              onValueChange={(val) => setParkBrakeAmps(val)}
              onSlidingComplete={(val) => sendCmd(`PA ${val}`)}
              minimumTrackTintColor={parkEnabled ? '#ef4444' : '#f43f5e'}
              maximumTrackTintColor="rgba(255, 255, 255, 0.15)"
              thumbTintColor={parkEnabled ? '#ef4444' : '#f43f5e'}
            />
            <Text style={[styles.gearShiftDesc, { marginTop: 2, fontSize: 11 }]}>
              Counter-torque braking strength when motion is detected (5–120A). Increase to lock wheels firmly against pushing.
            </Text>
          </View>
        </View>
      )}
    </View>
  );

  const renderUnlockCard = () => (
    <View style={styles.gearShiftCard}>
      <TouchableOpacity
        style={styles.cardHeaderCollapseRow}
        onPress={() => toggleSection('unlock')}
        activeOpacity={0.7}
      >
        <View style={styles.gearShiftTextCol}>
          <View style={styles.gearShiftTitleRow}>
            <Text style={styles.gearShiftTitle}>🔓 SCOOTER UNLOCK</Text>
            <View style={[styles.gearShiftBadge, unlockEnabled ? styles.gearShiftBadgeOn : styles.gearShiftBadgeOff]}>
              <Text style={[styles.gearShiftBadgeText, unlockEnabled ? styles.gearShiftBadgeTextOn : styles.gearShiftBadgeTextOff]}>
                {unlockEnabled ? 'UNLOCKED (25 / UNLIM)' : 'LOCKED (5 / 15 / 20)'}
              </Text>
            </View>
          </View>
          <Text style={styles.gearShiftDesc} numberOfLines={openSections.unlock ? undefined : 1}>
            {unlockEnabled
              ? 'Handlebar: 2→25 km/h, 3→Unlimited. Zero-start active (kick disabled). Gear 1 locks scooter. Auto-locks on disconnect.'
              : 'Handlebar: 1→5 km/h, 2→15 km/h, 3→20 km/h. Kick-start active. Shift to Gear 2 or 3 to unlock.'}
          </Text>
        </View>
        <Text style={styles.sectionToggleIcon}>{openSections.unlock ? '▲' : '▼'}</Text>
      </TouchableOpacity>

      {openSections.unlock && (
        <View style={{ marginTop: 10, borderTopWidth: 1, borderTopColor: 'rgba(255, 255, 255, 0.08)', paddingTop: 10 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={[styles.gearShiftDesc, { flex: 1, marginRight: 10 }]}>
              {unlockEnabled
                ? 'Handlebar: 2→25 km/h, 3→Unlimited. Zero-start active (kick disabled). Gear 1 locks scooter. Auto-locks on disconnect.'
                : 'Handlebar: 1→5 km/h, 2→15 km/h, 3→20 km/h. Kick-start active. Shift to Gear 2 or 3 to unlock.'}
            </Text>
            <Switch
              value={unlockEnabled}
              onValueChange={toggleUnlock}
              trackColor={{ false: '#1e293b', true: '#00f2fe' }}
              thumbColor={unlockEnabled ? '#ffffff' : '#64748b'}
              ios_backgroundColor="#1e293b"
            />
          </View>
        </View>
      )}
    </View>
  );

  const renderGearShiftCard = renderUnlockCard;

  const renderCruiseCard = () => (
    <View style={[styles.gearShiftCard, cruiseActive && styles.cruiseCardActive]}>
      <TouchableOpacity
        style={styles.cardHeaderCollapseRow}
        onPress={() => toggleSection('cruise')}
        activeOpacity={0.7}
      >
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
          <Text style={styles.gearShiftDesc} numberOfLines={openSections.cruise ? undefined : 1}>
            {cruiseStatus === 'ACTIVE'
              ? 'Holding top speed! Throttle inactive. Pull brake to cancel.'
              : cruiseStatus === 'G4'
              ? 'Cruise disabled in 4th gear (Sport). Auto-restores in Gears 1–3.'
              : cruiseStatus === 'ARMED'
              ? `Hold top speed (${activeGear === 1 ? '5' : activeGear === 2 ? (unlockEnabled ? '25' : '15') : (unlockEnabled ? 'Sport' : '20')} km/h ±2) for 5s to engage.`
              : 'Locks maximum speed for current gear after 5 seconds at top speed. Stops on brake.'}
          </Text>
        </View>
        <Text style={styles.sectionToggleIcon}>{openSections.cruise ? '▲' : '▼'}</Text>
      </TouchableOpacity>

      {openSections.cruise && (
        <View style={{ marginTop: 10, borderTopWidth: 1, borderTopColor: 'rgba(255, 255, 255, 0.08)', paddingTop: 10 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={[styles.gearShiftDesc, { flex: 1, marginRight: 10 }]}>
              {cruiseStatus === 'ACTIVE'
                ? 'Holding top speed! Throttle inactive. Pull brake to cancel.'
                : cruiseStatus === 'G4'
                ? 'Cruise disabled in 4th gear (Sport). Auto-restores in Gears 1–3.'
                : cruiseStatus === 'ARMED'
                ? `Hold top speed (${activeGear === 1 ? '5' : activeGear === 2 ? (unlockEnabled ? '25' : '15') : (unlockEnabled ? 'Sport' : '20')} km/h ±2) for 5s to engage.`
                : 'Locks maximum speed for current gear after 5 seconds at top speed. Stops on brake.'}
            </Text>
            <Switch
              value={cruiseEnabled}
              onValueChange={toggleCruiseControl}
              trackColor={{ false: '#1e293b', true: cruiseActive ? '#10b981' : '#00f2fe' }}
              thumbColor={cruiseEnabled ? '#ffffff' : '#64748b'}
              ios_backgroundColor="#1e293b"
            />
          </View>
        </View>
      )}
    </View>
  );

  const renderBrakeCard = () => (
    <View style={styles.controlsCard}>
      <TouchableOpacity
        style={styles.cardHeaderCollapseRow}
        onPress={() => toggleSection('brake')}
        activeOpacity={0.7}
      >
        <View style={styles.gearShiftTextCol}>
          <View style={styles.gearShiftTitleRow}>
            <Text style={styles.gearShiftTitle}>🛑 E-BRAKE & ABS CONTROL</Text>
            <View style={[styles.brakeBadge, brakeEnabled ? styles.brakeBadgeOn : styles.brakeBadgeOff]}>
              <Text style={[styles.brakeBadgeText, brakeEnabled ? styles.brakeBadgeTextOn : styles.brakeBadgeTextOff]}>
                {brakeAmps.toFixed(0)}A • {absEnabled ? `ABS (${absFreq}Hz)` : 'ABS OFF'}
              </Text>
            </View>
          </View>
          <Text style={styles.gearShiftDesc} numberOfLines={openSections.brake ? undefined : 1}>
            Physical lever sensor, Dualtron pulsation ABS & regenerative current
          </Text>
        </View>
        <Text style={styles.sectionToggleIcon}>{openSections.brake ? '▲' : '▼'}</Text>
      </TouchableOpacity>

      {openSections.brake && (
        <View style={{ gap: 10, marginTop: 4 }}>
          {/* 1. Physical E-Brake Sensor Switch */}
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

          {/* 2. Dualtron e-ABS Pulsation Switch */}
          <View style={styles.brakeSwitchRow}>
            <View style={styles.brakeSwitchTextCol}>
              <View style={styles.brakeSwitchTitleRow}>
                <Text style={styles.controlLabel}>e-ABS Pulsation</Text>
                <View style={[styles.brakeBadge, absEnabled ? styles.brakeBadgeOn : styles.brakeBadgeOff]}>
                  <Text style={[styles.brakeBadgeText, absEnabled ? styles.brakeBadgeTextOn : styles.brakeBadgeTextOff]}>
                    {absEnabled ? `DUALTRON (${absFreq} Hz)` : 'OFF (SOLID)'}
                  </Text>
                </View>
              </View>
              <Text style={styles.gearShiftDesc}>
                {absEnabled
                  ? `Anti-lock pulsation (${absFreq} Hz) active above 3 km/h to prevent wheel lockup`
                  : 'Continuous solid regenerative braking without pulsation'}
              </Text>
            </View>
            <Switch
              value={absEnabled}
              onValueChange={toggleAbs}
              trackColor={{ false: '#1e293b', true: '#f43f5e' }}
              thumbColor={absEnabled ? '#ffffff' : '#64748b'}
              ios_backgroundColor="#1e293b"
            />
          </View>

          {/* 3. e-ABS Strobe Light & Frequency Options */}
          {absEnabled && (
            <>
              <View style={styles.brakeSwitchRow}>
                <View style={styles.brakeSwitchTextCol}>
                  <View style={styles.brakeSwitchTitleRow}>
                    <Text style={styles.controlLabel}>Rear Strobe Light</Text>
                    <View style={[styles.brakeBadge, absStrobe ? styles.brakeBadgeOn : styles.brakeBadgeOff]}>
                      <Text style={[styles.brakeBadgeText, absStrobe ? styles.brakeBadgeTextOn : styles.brakeBadgeTextOff]}>
                        {absStrobe ? 'STROBE ON' : 'SOLID ON'}
                      </Text>
                    </View>
                  </View>
                  <Text style={styles.gearShiftDesc}>
                    {absStrobe
                      ? 'Flashes rear brake light in real time with ABS motor pulses'
                      : 'Keeps rear brake light solid during ABS braking'}
                  </Text>
                </View>
                <Switch
                  value={absStrobe}
                  onValueChange={toggleAbsStrobe}
                  trackColor={{ false: '#1e293b', true: '#f43f5e' }}
                  thumbColor={absStrobe ? '#ffffff' : '#64748b'}
                  ios_backgroundColor="#1e293b"
                />
              </View>

              <View style={styles.sliderHeader}>
                <Text style={styles.controlLabel}>ABS Frequency</Text>
                <Text style={styles.sliderVal}>{absFreq} Hz</Text>
              </View>
              <Slider
                style={styles.slider}
                minimumValue={2}
                maximumValue={20}
                step={1}
                value={absFreq}
                onValueChange={handleAbsFreqChange}
                onSlidingComplete={handleAbsFreqComplete}
                minimumTrackTintColor="#f43f5e"
                maximumTrackTintColor="rgba(255, 255, 255, 0.15)"
                thumbTintColor="#f43f5e"
              />
            </>
          )}

          {/* 4. E-Brake Strength Slider */}
          <View style={styles.sliderHeader}>
            <Text style={styles.controlLabel}>E-Brake Strength</Text>
            <Text style={styles.sliderVal}>{brakeAmps.toFixed(1)} A</Text>
          </View>

          <Slider
            style={styles.slider}
            minimumValue={0}
            maximumValue={60}
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
      )}
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

  const renderLightsBarLandscape = () => (
    <View style={styles.landscapeLightsBar}>
      {/* Left indicator */}
      <TouchableOpacity
        style={[styles.miniLightPill, turnLeftOn && styles.miniLightPillAmber]}
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          sendCmd('TL');
        }}
        activeOpacity={0.7}
      >
        <Animated.View style={{ opacity: turnLeftOn ? blinkAnim : 1 }}>
          <Text style={[styles.miniLightIcon, turnLeftOn && styles.miniLightIconAmber]}>⬅️</Text>
        </Animated.View>
        <Text style={[styles.miniLightText, turnLeftOn && styles.miniLightTextAmber]}>LEFT</Text>
      </TouchableOpacity>

      {/* Front Light */}
      <TouchableOpacity
        style={[styles.miniLightPill, frontLightOn && styles.miniLightPillCyan]}
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          sendCmd('L');
        }}
        activeOpacity={0.7}
      >
        <Text style={styles.miniLightIcon}>💡</Text>
        <Text style={[styles.miniLightText, frontLightOn && styles.miniLightTextCyan]}>FRONT</Text>
      </TouchableOpacity>

      {/* Rear Light */}
      <View style={[styles.miniLightPill, (frontLightOn || isBraking) && styles.miniLightPillRed]}>
        <Text style={styles.miniLightIcon}>🚨</Text>
        <Text style={[styles.miniLightText, (frontLightOn || isBraking) && styles.miniLightTextRed]}>
          {isBraking ? 'BRAKE' : frontLightOn ? 'TAIL' : 'REAR'}
        </Text>
      </View>

      {/* Right indicator */}
      <TouchableOpacity
        style={[styles.miniLightPill, turnRightOn && styles.miniLightPillAmber]}
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          sendCmd('TR');
        }}
        activeOpacity={0.7}
      >
        <Text style={[styles.miniLightText, turnRightOn && styles.miniLightTextAmber]}>RIGHT</Text>
        <Animated.View style={{ opacity: turnRightOn ? blinkAnim : 1 }}>
          <Text style={[styles.miniLightIcon, turnRightOn && styles.miniLightIconAmber]}>➡️</Text>
        </Animated.View>
      </TouchableOpacity>

      {/* Interactive Single / Dual Motor Mode Switch */}
      <TouchableOpacity
        style={[
          styles.miniLightPill,
          ddmActive ? styles.miniLightPillCyan : styles.miniLightPillDim,
        ]}
        onPress={() => toggleDualMode()}
        activeOpacity={0.7}
      >
        <Text style={styles.miniLightIcon}>{ddmActive ? '⚡' : '🛴'}</Text>
        <Text
          style={[
            styles.miniLightText,
            ddmActive ? styles.miniLightTextCyan : styles.miniLightTextDim,
          ]}
        >
          {ddmActive ? '2WD DUAL' : '1WD SINGLE'}
        </Text>
      </TouchableOpacity>
    </View>
  );

  const renderLightsCard = () => {
    const isHazard = turnLeftOn && turnRightOn;

    return (
      <View style={styles.lightsCard}>
        {/* Card Header */}
        <TouchableOpacity
          style={styles.lightsHeaderRow}
          onPress={() => toggleSection('lights')}
          activeOpacity={0.7}
        >
          <View style={styles.lightsHeaderLeft}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Text style={styles.lightsTitle}>💡 LIGHTS & INDICATORS</Text>
              <View
                style={[
                  styles.lightsStatusBadge,
                  isHazard
                    ? styles.lightsBadgeHazard
                    : (turnLeftOn || turnRightOn)
                    ? styles.lightsBadgeBlinking
                    : frontLightOn
                    ? styles.lightsBadgeOn
                    : styles.lightsBadgeOff,
                ]}
              >
                <Text
                  style={[
                    styles.lightsStatusBadgeText,
                    isHazard
                      ? styles.lightsBadgeTextHazard
                      : (turnLeftOn || turnRightOn)
                      ? styles.lightsBadgeTextBlinking
                      : frontLightOn
                      ? styles.lightsBadgeTextOn
                      : styles.lightsBadgeTextOff,
                  ]}
                >
                  {isHazard
                    ? '⚠️ HAZARD'
                    : turnLeftOn
                    ? '⬅️ BLINKING L'
                    : turnRightOn
                    ? 'BLINKING R ➡️'
                    : frontLightOn
                    ? 'LIGHTS ON'
                    : isBraking
                    ? '🛑 BRAKE'
                    : 'STANDBY'}
                </Text>
              </View>
            </View>
            <Text style={styles.lightsSubDesc}>
              Hardware MOSFET/relay outputs & dual motor switch
            </Text>
          </View>
          <Text style={styles.sectionToggleIcon}>{openSections.lights ? '▲' : '▼'}</Text>
        </TouchableOpacity>

        {openSections.lights && (
          <View style={{ gap: 10, marginTop: 4 }}>

        {/* Primary Lights 2-Column Grid */}
        <View style={styles.lightsGrid}>
          {/* Front Light Tile */}
          <TouchableOpacity
            style={[
              styles.lightTile,
              frontLightOn ? styles.lightTileFrontActive : styles.lightTileInactive,
            ]}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              sendCmd('L');
            }}
            activeOpacity={0.7}
          >
            <View style={styles.lightTileTopRow}>
              <View
                style={[
                  styles.lightTileIconWrap,
                  frontLightOn && styles.lightTileIconWrapFrontOn,
                ]}
              >
                <Text style={styles.lightTileIcon}>💡</Text>
              </View>
              <View
                style={[
                  styles.lightPill,
                  frontLightOn ? styles.lightPillFrontOn : styles.lightPillOff,
                ]}
              >
                <View
                  style={[
                    styles.lightDot,
                    frontLightOn ? styles.lightDotFrontOn : styles.lightDotOff,
                  ]}
                />
                <Text
                  style={[
                    styles.lightPillText,
                    frontLightOn ? styles.lightPillTextFrontOn : styles.lightPillTextOff,
                  ]}
                >
                  {frontLightOn ? 'ON' : 'OFF'}
                </Text>
              </View>
            </View>

            <Text style={styles.lightTileName}>Front Headlight</Text>
            <Text style={styles.lightTilePin}>GPIO 25 OUT • Switch D5</Text>
          </TouchableOpacity>

          {/* Rear / Brake Light Tile */}
          <View
            style={[
              styles.lightTile,
              isBraking
                ? styles.lightTileBrakeActive
                : frontLightOn
                ? styles.lightTileTailActive
                : styles.lightTileInactive,
            ]}
          >
            <View style={styles.lightTileTopRow}>
              <View
                style={[
                  styles.lightTileIconWrap,
                  isBraking
                    ? styles.lightTileIconWrapBrake
                    : frontLightOn
                    ? styles.lightTileIconWrapTail
                    : null,
                ]}
              >
                <Text style={styles.lightTileIcon}>🚨</Text>
              </View>
              <View
                style={[
                  styles.lightPill,
                  isBraking
                    ? styles.lightPillBrakeOn
                    : frontLightOn
                    ? styles.lightPillTailOn
                    : styles.lightPillOff,
                ]}
              >
                <View
                  style={[
                    styles.lightDot,
                    isBraking
                      ? styles.lightDotBrakeOn
                      : frontLightOn
                      ? styles.lightDotTailOn
                      : styles.lightDotOff,
                  ]}
                />
                <Text
                  style={[
                    styles.lightPillText,
                    isBraking
                      ? styles.lightPillTextBrakeOn
                      : frontLightOn
                      ? styles.lightPillTextTailOn
                      : styles.lightPillTextOff,
                  ]}
                >
                  {isBraking ? 'BRAKE' : frontLightOn ? 'TAIL' : 'OFF'}
                </Text>
              </View>
            </View>

            <Text style={styles.lightTileName}>Rear Light</Text>
            <Text style={styles.lightTilePin}>
              {isBraking
                ? 'GPIO 26 OUT • 100% Brake'
                : frontLightOn
                ? 'GPIO 26 OUT • Running Tail'
                : 'GPIO 26 OUT • Solid on Brake'}
            </Text>
          </View>
        </View>

        {/* Turn Signal Controls & Indicators */}
        <View style={styles.turnSignalsSection}>
          <Text style={styles.turnSignalsLabel}>TURN SIGNALS & HAZARDS (400ms Blinker)</Text>

          <View style={styles.turnSignalsBtnRow}>
            {/* Turn Left Button */}
            <TouchableOpacity
              style={[
                styles.btnTurnSignal,
                turnLeftOn && styles.btnTurnSignalLeftActive,
              ]}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                sendCmd('TL');
              }}
              activeOpacity={0.7}
            >
              <Animated.View style={{ opacity: turnLeftOn ? blinkAnim : 1 }}>
                <Text style={[styles.turnArrowIcon, turnLeftOn && styles.turnArrowActive]}>
                  ⬅️
                </Text>
              </Animated.View>
              <View style={styles.turnBtnTextCol}>
                <Text
                  style={[
                    styles.turnBtnTitle,
                    turnLeftOn && styles.turnBtnTitleActive,
                  ]}
                >
                  LEFT TURN
                </Text>
                <Text style={styles.turnBtnPin}>GPIO 27 OUT • D18 IN</Text>
              </View>
            </TouchableOpacity>

            {/* Hazard Button */}
            <TouchableOpacity
              style={[
                styles.btnHazard,
                isHazard && styles.btnHazardActive,
              ]}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                sendCmd('HAZ');
              }}
              activeOpacity={0.7}
            >
              <Animated.View style={{ opacity: isHazard ? blinkAnim : 1 }}>
                <Text style={styles.hazardIcon}>⚠️</Text>
              </Animated.View>
              <Text
                style={[
                  styles.btnHazardText,
                  isHazard && styles.btnHazardTextActive,
                ]}
              >
                {isHazard ? 'HAZARD ON' : 'HAZARD'}
              </Text>
            </TouchableOpacity>

            {/* Turn Right Button */}
            <TouchableOpacity
              style={[
                styles.btnTurnSignal,
                turnRightOn && styles.btnTurnSignalRightActive,
              ]}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                sendCmd('TR');
              }}
              activeOpacity={0.7}
            >
              <View style={[styles.turnBtnTextCol, { alignItems: 'flex-end' }]}>
                <Text
                  style={[
                    styles.turnBtnTitle,
                    turnRightOn && styles.turnBtnTitleActive,
                  ]}
                >
                  RIGHT TURN
                </Text>
                <Text style={styles.turnBtnPin}>GPIO 14 OUT • D21 IN</Text>
              </View>
              <Animated.View style={{ opacity: turnRightOn ? blinkAnim : 1 }}>
                <Text style={[styles.turnArrowIcon, turnRightOn && styles.turnArrowActive]}>
                  ➡️
                </Text>
              </Animated.View>
            </TouchableOpacity>
          </View>
        </View>

        {/* Drive Mode Selector: Single vs Dual Motor Switch */}
        <TouchableOpacity
          style={[
            styles.ddmFooterRow,
            ddmActive ? styles.ddmFooterRowDual : styles.ddmFooterRowSingle,
          ]}
          onPress={() => toggleDualMode()}
          activeOpacity={0.8}
        >
          <View style={styles.ddmFooterLeft}>
            <View
              style={[
                styles.ddmIconCircle,
                ddmActive ? styles.ddmIconCircleDual : styles.ddmIconCircleSingle,
              ]}
            >
              <Text style={styles.ddmIcon}>{ddmActive ? '⚡' : '🛴'}</Text>
            </View>
            <View style={{ flex: 1, minWidth: 0, justifyContent: 'center' }}>
              <Text style={styles.ddmTitle} numberOfLines={1}>
                {ddmActive ? 'DUAL MOTOR (2WD)' : 'SINGLE MOTOR (1WD)'}
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
                <Text style={styles.ddmHardwareTag}>GPIO 4</Text>
                <Text style={[styles.ddmDesc, { marginTop: 0, flex: 1 }]} numberOfLines={1}>
                  {ddmActive
                    ? 'Both motors engaged • Max torque'
                    : 'Master motor only • Range mode'}
                </Text>
              </View>
            </View>
          </View>
          <View style={styles.ddmRightGroup}>
            <View
              style={[
                styles.ddmBadge,
                ddmActive ? styles.ddmBadgeDual : styles.ddmBadgeSingle,
              ]}
            >
              <Text
                style={[
                  styles.ddmBadgeText,
                  ddmActive ? styles.ddmBadgeTextDual : styles.ddmBadgeTextSingle,
                ]}
              >
                {ddmActive ? '2WD' : '1WD'}
              </Text>
            </View>
            <Switch
              value={ddmActive}
              onValueChange={(val) => toggleDualMode(val)}
              trackColor={{ false: 'rgba(255,255,255,0.12)', true: '#00f2fe' }}
              thumbColor={ddmActive ? '#ffffff' : '#94a3b8'}
              ios_backgroundColor="rgba(255,255,255,0.12)"
            />
          </View>
        </TouchableOpacity>
        </View>
        )}
      </View>
    );
  };

  return (
    <View style={[styles.safeArea, { paddingTop: safeTop, paddingBottom: safeBottom }]}>
      <StatusBar style="light" />

      {/* Top Header with Island Padding */}
      <View style={[
        styles.header,
        isLandscape && styles.headerLandscape,
        { paddingLeft: Math.max(islandInsetLeft, 12), paddingRight: Math.max(islandInsetRight, 12) }
      ]}>
        <View style={styles.brandRow}>
          <View style={styles.brandDot} />
          <View style={styles.brandTextCol}>
            <Text style={styles.brandTitle} numberOfLines={1}>SCOOTER BLE</Text>
            <Text style={styles.subStatus} numberOfLines={1} ellipsizeMode="tail">{statusText}</Text>
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
            onPress={isAntisparkConnected ? disconnectAntispark : () => scanAndConnectAntispark(true)}
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
              numberOfLines={1}
            >
              {isAntisparkConnected ? '⚡ Power ON' : isAntisparkConnecting ? 'Power...' : '⚡ Power'}
            </Text>
          </TouchableOpacity>

          {/* VESC Telemetry Connect Button */}
          <TouchableOpacity
            style={[styles.btnConnect, isConnected && styles.btnConnected]}
            onPress={isConnected ? disconnect : connectBle}
            disabled={!isConnected && (isScanning || isMainConnecting)}
            activeOpacity={0.8}
          >
            <View
              style={[
                styles.statusDot,
                isConnected
                  ? styles.statusDotActive
                  : (isScanning || isMainConnecting)
                  ? styles.statusDotYellow
                  : styles.statusDotInactive,
              ]}
            />
            <Text style={[styles.btnConnectText, isConnected && styles.btnConnectedText]} numberOfLines={1}>
              {isConnected ? 'Connected' : (isScanning || isMainConnecting) ? 'Connecting...' : 'Connect'}
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
                  {renderLightsBarLandscape()}
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
                  <View>
                    <Text style={styles.sectionTitle}>SCOOTER SETTINGS</Text>
                    <Text style={styles.activeProfileLabel}>Tap any section to configure</Text>
                  </View>
                  <TouchableOpacity
                    style={styles.btnExpandAll}
                    onPress={toggleAllSections}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.btnExpandAllText}>
                      {Object.values(openSections).every(Boolean) ? 'Collapse All' : 'Expand All'}
                    </Text>
                  </TouchableOpacity>
                </View>
                {renderLightsCard()}
                {renderAntisparkCard()}
                {renderParkCard()}
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
          {renderProfiles(false)}
          {renderTelemetry(false)}
          <View style={styles.settingsHeaderPortrait}>
            <View>
              <Text style={styles.sectionTitle}>SCOOTER SETTINGS</Text>
              <Text style={styles.activeProfileLabel}>Tap any section to configure</Text>
            </View>
            <TouchableOpacity
              style={styles.btnExpandAll}
              onPress={toggleAllSections}
              activeOpacity={0.7}
            >
              <Text style={styles.btnExpandAllText}>
                {Object.values(openSections).every(Boolean) ? 'Collapse All' : 'Expand All'}
              </Text>
            </TouchableOpacity>
          </View>
          {renderLightsCard()}
          {renderAntisparkCard()}
          {renderParkCard()}
          {renderGearShiftCard()}
          {renderCruiseCard()}
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
    paddingHorizontal: 12,
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
    gap: 8,
    flex: 1,
    minWidth: 0,
    marginRight: 8,
  },
  brandTextCol: {
    flex: 1,
    minWidth: 0,
  },
  brandDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#00f2fe',
  },
  brandTitle: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  subStatus: {
    color: '#94a3b8',
    fontSize: 10.5,
  },
  btnConnect: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(0, 242, 254, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(0, 242, 254, 0.35)',
    paddingHorizontal: 9,
    paddingVertical: 7,
    borderRadius: 10,
  },
  btnConnected: {
    backgroundColor: 'rgba(16, 185, 129, 0.16)',
    borderColor: 'rgba(16, 185, 129, 0.45)',
  },
  btnConnectText: {
    color: '#00f2fe',
    fontSize: 11.5,
    fontWeight: '700',
  },
  btnConnectedText: {
    color: '#10b981',
  },
  headerRightGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 0,
  },
  btnHeaderPower: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.15)',
    paddingHorizontal: 9,
    paddingVertical: 7,
    borderRadius: 10,
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
    fontSize: 11.5,
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
  settingsHeaderPortrait: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 14,
    marginBottom: 4,
    paddingHorizontal: 2,
  },
  btnExpandAll: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: 'rgba(0, 242, 254, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(0, 242, 254, 0.3)',
  },
  btnExpandAllText: {
    color: '#00f2fe',
    fontSize: 11,
    fontWeight: '700',
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
  cardHeaderCollapseRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  sectionToggleIcon: {
    color: '#00f2fe',
    fontSize: 13,
    fontWeight: '700',
    paddingLeft: 6,
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
  // Auto Cutoff Toggle Card
  autoCutoffCard: {
    backgroundColor: 'rgba(56, 189, 248, 0.05)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.25)',
    borderRadius: 14,
    padding: 12,
  },
  autoCutoffHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  autoCutoffTitle: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  autoCutoffDesc: {
    color: '#94a3b8',
    fontSize: 10.5,
    lineHeight: 14,
    marginTop: 2,
  },
  autoCutoffBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
  },
  autoCutoffBadgeActive: {
    backgroundColor: 'rgba(56, 189, 248, 0.18)',
    borderColor: '#38bdf8',
  },
  autoCutoffBadgeDisabled: {
    backgroundColor: 'rgba(245, 158, 11, 0.18)',
    borderColor: '#f59e0b',
  },
  autoCutoffBadgeText: {
    fontSize: 8.5,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  autoCutoffBadgeTextActive: {
    color: '#38bdf8',
  },
  autoCutoffBadgeTextDisabled: {
    color: '#f59e0b',
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

  // Apple iBeacon Card Styles
  ibeaconCard: {
    backgroundColor: 'rgba(0, 242, 254, 0.04)',
    borderWidth: 1,
    borderColor: 'rgba(0, 242, 254, 0.25)',
    borderRadius: 14,
    padding: 12,
    gap: 10,
  },
  ibeaconHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  ibeaconTitle: {
    color: '#00f2fe',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  ibeaconDesc: {
    color: '#94a3b8',
    fontSize: 10.5,
    lineHeight: 14,
    marginTop: 2,
  },
  beaconBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  beaconBadgeActive: {
    backgroundColor: 'rgba(0, 242, 254, 0.18)',
    borderWidth: 1,
    borderColor: '#00f2fe',
  },
  beaconBadgeInactive: {
    backgroundColor: 'rgba(100, 116, 139, 0.15)',
    borderWidth: 1,
    borderColor: '#475569',
  },
  beaconBadgeText: {
    color: '#00f2fe',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  ibeaconDetailsBox: {
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: 'rgba(0, 242, 254, 0.12)',
    paddingTop: 8,
  },
  ibeaconDetailsRow: {
    flexDirection: 'row',
    gap: 6,
  },
  ibeaconDetailPill: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.25)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 8,
    paddingVertical: 5,
    paddingHorizontal: 6,
    alignItems: 'center',
  },
  ibeaconDetailPillLabel: {
    color: '#64748b',
    fontSize: 8.5,
    fontWeight: '700',
  },
  ibeaconDetailPillVal: {
    color: '#f8fafc',
    fontSize: 10.5,
    fontWeight: '800',
    marginTop: 2,
  },
  sensitivityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(0, 0, 0, 0.2)',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  sensitivityLabel: {
    color: '#94a3b8',
    fontSize: 10.5,
    fontWeight: '600',
  },
  sensitivityBtnGroup: {
    flexDirection: 'row',
    gap: 4,
  },
  btnSensitivity: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
  },
  btnSensitivityActive: {
    backgroundColor: '#00f2fe',
  },
  btnSensitivityText: {
    color: '#94a3b8',
    fontSize: 10,
    fontWeight: '700',
  },
  btnSensitivityTextActive: {
    color: '#070a12',
    fontWeight: '800',
  },
  permissionAlertBox: {
    backgroundColor: 'rgba(245, 158, 11, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.35)',
    borderRadius: 8,
    padding: 8,
  },
  permissionAlertText: {
    color: '#fbbf24',
    fontSize: 10.5,
    lineHeight: 14,
  },
  manualOverrideBanner: {
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.35)',
    borderRadius: 8,
    padding: 10,
    marginVertical: 4,
  },
  manualOverrideBannerText: {
    color: '#f87171',
    fontSize: 11,
    lineHeight: 15,
  },
  manualOverrideResumeBtn: {
    marginTop: 8,
    backgroundColor: 'rgba(239, 68, 68, 0.25)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.6)',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 6,
    alignSelf: 'flex-start',
  },
  manualOverrideResumeBtnText: {
    color: '#fca5a5',
    fontSize: 11,
    fontWeight: '700',
  },

  // Lights & Indicators Section Styles
  lightsCard: {
    backgroundColor: '#101626',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 18,
    padding: 16,
    marginVertical: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 4,
  },
  lightsHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  lightsHeaderLeft: {
    flex: 1,
    minWidth: 0,
  },
  lightsTitle: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  lightsSubDesc: {
    color: '#94a3b8',
    fontSize: 11,
    marginTop: 4,
  },
  lightsStatusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
  },
  lightsBadgeOn: {
    backgroundColor: 'rgba(0, 242, 254, 0.15)',
    borderColor: 'rgba(0, 242, 254, 0.5)',
  },
  lightsBadgeBlinking: {
    backgroundColor: 'rgba(245, 158, 11, 0.2)',
    borderColor: 'rgba(245, 158, 11, 0.6)',
  },
  lightsBadgeHazard: {
    backgroundColor: 'rgba(239, 68, 68, 0.2)',
    borderColor: 'rgba(239, 68, 68, 0.7)',
  },
  lightsBadgeOff: {
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderColor: 'rgba(255, 255, 255, 0.12)',
  },
  lightsStatusBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  lightsBadgeTextOn: {
    color: '#00f2fe',
  },
  lightsBadgeTextBlinking: {
    color: '#fbbf24',
  },
  lightsBadgeTextHazard: {
    color: '#f87171',
  },
  lightsBadgeTextOff: {
    color: '#94a3b8',
  },
  lightsGrid: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 12,
  },
  lightTile: {
    flex: 1,
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
  },
  lightTileInactive: {
    backgroundColor: '#0a0f1d',
    borderColor: 'rgba(255, 255, 255, 0.06)',
  },
  lightTileFrontActive: {
    backgroundColor: 'rgba(0, 242, 254, 0.08)',
    borderColor: '#00f2fe',
    shadowColor: '#00f2fe',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
  },
  lightTileTailActive: {
    backgroundColor: 'rgba(239, 68, 68, 0.08)',
    borderColor: '#ef4444',
  },
  lightTileBrakeActive: {
    backgroundColor: 'rgba(239, 68, 68, 0.22)',
    borderColor: '#ef4444',
    shadowColor: '#ef4444',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.5,
    shadowRadius: 10,
  },
  lightTileTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  lightTileIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  lightTileIconWrapFrontOn: {
    backgroundColor: 'rgba(0, 242, 254, 0.2)',
  },
  lightTileIconWrapTail: {
    backgroundColor: 'rgba(239, 68, 68, 0.2)',
  },
  lightTileIconWrapBrake: {
    backgroundColor: 'rgba(239, 68, 68, 0.35)',
  },
  lightTileIcon: {
    fontSize: 16,
  },
  lightPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
  },
  lightPillOff: {
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  lightPillFrontOn: {
    backgroundColor: 'rgba(0, 242, 254, 0.2)',
    borderColor: 'rgba(0, 242, 254, 0.6)',
  },
  lightPillTailOn: {
    backgroundColor: 'rgba(239, 68, 68, 0.2)',
    borderColor: 'rgba(239, 68, 68, 0.6)',
  },
  lightPillBrakeOn: {
    backgroundColor: 'rgba(239, 68, 68, 0.35)',
    borderColor: '#ef4444',
  },
  lightDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  lightDotOff: {
    backgroundColor: '#64748b',
  },
  lightDotFrontOn: {
    backgroundColor: '#00f2fe',
  },
  lightDotTailOn: {
    backgroundColor: '#ef4444',
  },
  lightDotBrakeOn: {
    backgroundColor: '#ffffff',
  },
  lightPillText: {
    fontSize: 10,
    fontWeight: '800',
  },
  lightPillTextOff: {
    color: '#64748b',
  },
  lightPillTextFrontOn: {
    color: '#00f2fe',
  },
  lightPillTextTailOn: {
    color: '#f87171',
  },
  lightPillTextBrakeOn: {
    color: '#ffffff',
  },
  lightTileName: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
  },
  lightTilePin: {
    color: '#64748b',
    fontSize: 10,
    marginTop: 3,
  },
  turnSignalsSection: {
    backgroundColor: '#0a0f1d',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
    borderRadius: 14,
    padding: 12,
    marginBottom: 12,
  },
  turnSignalsLabel: {
    color: '#94a3b8',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.6,
    marginBottom: 10,
  },
  turnSignalsBtnRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  btnTurnSignal: {
    flex: 1.2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#101626',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 10,
  },
  btnTurnSignalLeftActive: {
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
    borderColor: '#f59e0b',
    shadowColor: '#f59e0b',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 6,
  },
  btnTurnSignalRightActive: {
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
    borderColor: '#f59e0b',
    shadowColor: '#f59e0b',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 6,
  },
  turnArrowIcon: {
    fontSize: 16,
    opacity: 0.6,
  },
  turnArrowActive: {
    opacity: 1,
  },
  turnBtnTextCol: {
    flex: 1,
  },
  turnBtnTitle: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  turnBtnTitleActive: {
    color: '#fbbf24',
  },
  turnBtnPin: {
    color: '#64748b',
    fontSize: 9,
    marginTop: 2,
  },
  btnHazard: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#101626',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  btnHazardActive: {
    backgroundColor: 'rgba(239, 68, 68, 0.2)',
    borderColor: '#ef4444',
  },
  hazardIcon: {
    fontSize: 14,
    marginBottom: 2,
  },
  btnHazardText: {
    color: '#94a3b8',
    fontSize: 9.5,
    fontWeight: '800',
    letterSpacing: 0.4,
  },
  btnHazardTextActive: {
    color: '#f87171',
  },
  ddmFooterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#0a0f1d',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  ddmFooterRowDual: {
    backgroundColor: 'rgba(0, 242, 254, 0.06)',
    borderColor: 'rgba(0, 242, 254, 0.35)',
  },
  ddmFooterRowSingle: {
    backgroundColor: '#0a0f1d',
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  ddmFooterLeft: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginRight: 8,
  },
  ddmRightGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
  },
  ddmIconCircle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ddmIconCircleDual: {
    backgroundColor: 'rgba(0, 242, 254, 0.16)',
    borderWidth: 1,
    borderColor: 'rgba(0, 242, 254, 0.4)',
  },
  ddmIconCircleSingle: {
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  ddmIcon: {
    fontSize: 18,
  },
  ddmTitle: {
    color: '#ffffff',
    fontSize: 12.5,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  ddmHardwareTag: {
    color: '#64748b',
    fontSize: 9.5,
    fontWeight: '600',
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  ddmDesc: {
    color: '#94a3b8',
    fontSize: 10.5,
    marginTop: 2,
  },
  ddmBadge: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
  },
  ddmBadgeDual: {
    backgroundColor: 'rgba(0, 242, 254, 0.15)',
    borderColor: 'rgba(0, 242, 254, 0.5)',
  },
  ddmBadgeSingle: {
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderColor: 'rgba(255, 255, 255, 0.12)',
  },
  ddmBadgeText: {
    fontSize: 10.5,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  ddmBadgeTextDual: {
    color: '#00f2fe',
  },
  ddmBadgeTextSingle: {
    color: '#94a3b8',
  },

  // Landscape Mini Lights Bar (Screen 1 Dashboard)
  landscapeLightsBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  miniLightPill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    backgroundColor: '#101626',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 10,
    paddingVertical: 7,
    paddingHorizontal: 6,
  },
  miniLightPillAmber: {
    backgroundColor: 'rgba(245, 158, 11, 0.18)',
    borderColor: '#f59e0b',
  },
  miniLightPillCyan: {
    backgroundColor: 'rgba(0, 242, 254, 0.18)',
    borderColor: '#00f2fe',
  },
  miniLightPillRed: {
    backgroundColor: 'rgba(239, 68, 68, 0.22)',
    borderColor: '#ef4444',
  },
  miniLightIcon: {
    fontSize: 12,
  },
  miniLightIconAmber: {
    color: '#fbbf24',
  },
  miniLightText: {
    color: '#64748b',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  miniLightTextAmber: {
    color: '#fbbf24',
  },
  miniLightTextCyan: {
    color: '#00f2fe',
  },
  miniLightTextRed: {
    color: '#f87171',
  },
  miniLightPillDim: {
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  miniLightTextDim: {
    color: '#64748b',
  },
});

