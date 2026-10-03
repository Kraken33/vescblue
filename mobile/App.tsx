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
  SafeAreaView,
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

// BleManager instance singleton
let bleManager: BleManager | null = null;
const getBleManager = () => {
  if (!bleManager) {
    bleManager = new BleManager();
  }
  return bleManager;
};

export default function App() {
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;

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
  const [activeGear, setActiveGear] = useState(1);
  const [brakeAmps, setBrakeAmps] = useState(25);
  const [isZeroStart, setIsZeroStart] = useState(true);

  // Console State
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [consoleLines, setConsoleLines] = useState<string[]>(['Scooter Native BLE Ready']);
  const [customCmd, setCustomCmd] = useState('');

  // Refs for subscriptions and active characteristic
  const charRef = useRef<Characteristic | null>(null);
  const notifSubRef = useRef<Subscription | null>(null);
  const isWritingRef = useRef(false);

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

  useEffect(() => {
    requestAndroidPermissions();
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

  // Connect BLE
  const connectBle = async () => {
    const manager = getBleManager();
    try {
      setIsScanning(true);
      setStatusText('Scanning for Scooter-ESP32...');
      addConsole('[BLE] Scanning...');

      manager.startDeviceScan([BLE_SVC_UUID], null, async (error, scannedDevice) => {
        if (error) {
          console.warn('Scan error:', error);
          setStatusText('Scan error: ' + error.message);
          setIsScanning(false);
          return;
        }

        if (scannedDevice && (scannedDevice.name === 'Scooter-ESP32' || scannedDevice.localName === 'Scooter-ESP32')) {
          manager.stopDeviceScan();
          setIsScanning(false);
          setStatusText('Connecting...');
          addConsole(`[BLE] Found ${scannedDevice.name}. Connecting...`);

          try {
            const connectedDevice = await scannedDevice.connect();
            setDevice(connectedDevice);
            setIsConnected(true);
            setStatusText('Connected to Scooter-ESP32');
            addConsole('[BLE] Connected!');
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

            // Initial query
            setTimeout(() => sendCmd('S'), 300);
          } catch (e: any) {
            console.warn('Connection failed:', e);
            setStatusText('Connect failed: ' + e.message);
            setIsConnected(false);
          }
        }
      });

      // Timeout scan after 12s if not found
      setTimeout(() => {
        if (!charRef.current) {
          manager.stopDeviceScan();
          setIsScanning(false);
          if (!isConnected) {
            setStatusText('Scooter not found. Tap to retry.');
          }
        }
      }, 12000);
    } catch (e: any) {
      console.warn('Scan exception:', e);
      setStatusText('Scan error: ' + e.message);
      setIsScanning(false);
    }
  };

  const disconnect = async () => {
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
    const ampMatch = str.match(/AMP=([\d.]+)/);
    const bcMatch = str.match(/BC=([\d.]+)A/);
    const kickMatch = str.match(/KICK=(\w+)/);

    if (spdMatch) setSpeed(parseFloat(spdMatch[1]));
    if (vMatch) setVoltage(parseFloat(vMatch[1]).toFixed(1));
    if (ampMatch) setTargetAmps(parseFloat(ampMatch[1]).toFixed(1));
    if (rawMatch) setThrottleRaw(rawMatch[1]);
    if (brkMatch) setIsBraking(brkMatch[1] === '1');
    if (bcMatch) setBrakeAmps(parseFloat(bcMatch[1]));

    if (gearMatch) {
      let g = parseInt(gearMatch[1], 10);
      let s = sMatch ? parseInt(sMatch[1], 10) : 0;
      if (g === 3 && s === 1) g = 4;
      setActiveGear(g);
    }

    if (kickMatch) {
      setIsZeroStart(kickMatch[1] !== 'HELD');
    }
  };

  // Outgoing BLE commands
  const sendCmd = async (cmdStr: string) => {
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

  const selectProfile = (gear: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setActiveGear(gear);
    sendCmd(`P ${gear}`);
  };

  const toggleKick = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (isZeroStart) {
      sendCmd('K 400');
    } else {
      sendCmd('K 0');
    }
  };

  // Arc math: 180° semi-circle from (10, 50) to (90, 50), r=40
  // Arc length = π * 40 ≈ 125.66
  const arcLength = 125.66;
  const maxSpeed = 45.0;
  const ratio = Math.min(Math.max(speed / maxSpeed, 0), 1);
  const strokeOffset = arcLength - ratio * arcLength;

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />

      {/* Top Header */}
      <View style={[styles.header, isLandscape && styles.headerLandscape]}>
        <View style={styles.brandRow}>
          <View style={styles.brandDot} />
          <View>
            <Text style={styles.brandTitle}>SCOOTER BLE</Text>
            <Text style={styles.subStatus}>{statusText}</Text>
          </View>
        </View>

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

      {/* Main Content Area: Responsive Grid */}
      <ScrollView
        contentContainerStyle={[styles.scrollContent, isLandscape && styles.scrollLandscape]}
        showsVerticalScrollIndicator={false}
      >
        {/* Left Column in Landscape / Top Section in Portrait */}
        <View style={[styles.col, isLandscape && styles.colLeft]}>
          {/* Speedometer Hero */}
          <View style={styles.speedoHero}>
            <View style={styles.gaugeBox}>
              <Svg width={180} height={105} viewBox="0 0 100 60">
                <Defs>
                  <LinearGradient id="cyanGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                    <Stop offset="0%" stopColor="#00f2fe" />
                    <Stop offset="50%" stopColor="#3b82f6" />
                    <Stop offset="100%" stopColor="#9d4edd" />
                  </LinearGradient>
                </Defs>
                {/* Background track */}
                <Path
                  d="M 10 55 A 40 40 0 0 1 90 55"
                  fill="none"
                  stroke="rgba(255, 255, 255, 0.08)"
                  strokeWidth="8"
                  strokeLinecap="round"
                />
                {/* Active speed progress fill */}
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
                <Text style={styles.speedNum}>{speed.toFixed(1)}</Text>
                <Text style={styles.speedUnit}>KM / H</Text>
              </View>
            </View>

            {/* Badges */}
            <View style={styles.badgeRow}>
              <View style={[styles.badge, isBraking && styles.badgeBraking]}>
                <Text style={[styles.badgeText, isBraking && styles.badgeTextBraking]}>
                  {isBraking ? '🛑 BRAKING' : 'BRAKE OFF'}
                </Text>
              </View>
              <View style={[styles.badge, isZeroStart && styles.badgeKick]}>
                <Text style={[styles.badgeText, isZeroStart && styles.badgeTextKick]}>
                  {isZeroStart ? '⚡ ZERO START' : 'PUSH TO START'}
                </Text>
              </View>
            </View>
          </View>

          {/* Telemetry Strip */}
          <View style={styles.telemGrid}>
            <View style={styles.telemBox}>
              <Text style={styles.telemLabel}>BATTERY</Text>
              <Text style={styles.telemVal}>{voltage}</Text>
              <Text style={styles.telemUnit}>Volts</Text>
            </View>
            <View style={styles.telemBox}>
              <Text style={styles.telemLabel}>TARGET</Text>
              <Text style={styles.telemVal}>{targetAmps}</Text>
              <Text style={styles.telemUnit}>Amps</Text>
            </View>
            <View style={styles.telemBox}>
              <Text style={styles.telemLabel}>THROTTLE</Text>
              <Text style={styles.telemVal}>{throttleRaw}</Text>
              <Text style={styles.telemUnit}>ADC Raw</Text>
            </View>
          </View>
        </View>

        {/* Right Column in Landscape / Bottom Section in Portrait */}
        <View style={[styles.col, isLandscape && styles.colRight]}>
          {/* Profile Selector */}
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>SPEED PROFILES</Text>
            <Text style={styles.activeProfileLabel}>Gear {activeGear}</Text>
          </View>

          <View style={styles.profileGrid}>
            {[
              { gear: 1, name: 'Eco Mode', limit: '10 km/h', amps: '25A Max', color: '#10b981' },
              { gear: 2, name: 'City Cruising', limit: '15 km/h', amps: '40A Max', color: '#00f2fe' },
              { gear: 3, name: 'Drive Legal', limit: '25 km/h', amps: '65A Max', color: '#f59e0b' },
              { gear: 4, name: 'Sport Unlock', limit: '40+ km/h', amps: '120A Max', color: '#f43f5e' },
            ].map((p) => {
              const active = activeGear === p.gear;
              return (
                <TouchableOpacity
                  key={p.gear}
                  style={[
                    styles.profileCard,
                    active && { borderColor: p.color, backgroundColor: 'rgba(255, 255, 255, 0.08)' },
                  ]}
                  onPress={() => selectProfile(p.gear)}
                  activeOpacity={0.7}
                >
                  <View style={styles.pHeader}>
                    <Text style={[styles.pGear, active && { color: p.color }]}>G{p.gear}</Text>
                    <Text style={styles.pLimit}>{p.limit}</Text>
                  </View>
                  <Text style={styles.pName}>{p.name}</Text>
                  <Text style={styles.pAmps}>{p.amps}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Tuning Card */}
          <View style={styles.controlsCard}>
            <View style={styles.sliderHeader}>
              <Text style={styles.controlLabel}>E-Brake Strength</Text>
              <Text style={styles.sliderVal}>{brakeAmps.toFixed(1)} A</Text>
            </View>

            <Slider
              style={styles.slider}
              minimumValue={10}
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
              <TouchableOpacity style={styles.btnAction} onPress={toggleKick} activeOpacity={0.7}>
                <Text style={styles.btnActionText}>
                  {isZeroStart ? '🔄 Zero Start: ON' : '🔄 Push-to-Start: ON'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.btnAction} onPress={() => sendCmd('S')} activeOpacity={0.7}>
                <Text style={styles.btnActionText}>📡 Refresh (S)</Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Collapsible Console Drawer */}
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
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
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
    paddingHorizontal: 20,
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
  badgeKick: {
    backgroundColor: 'rgba(16, 185, 129, 0.16)',
    borderColor: 'rgba(16, 185, 129, 0.45)',
  },
  badgeText: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '700',
  },
  badgeTextBraking: {
    color: '#f43f5e',
  },
  badgeTextKick: {
    color: '#10b981',
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
  controlsCard: {
    backgroundColor: '#101626',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 18,
    padding: 12,
    gap: 8,
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
});
