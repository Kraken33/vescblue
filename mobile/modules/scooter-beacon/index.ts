import { requireNativeModule, EventEmitter, EventSubscription } from 'expo-modules-core';

export interface BeaconRangeEvent {
  rssi: number;
  proximity: number; // 0=unknown, 1=immediate (<0.5m), 2=near (<2m), 3=far (>2m)
  accuracy: number;
}

export interface BeaconRegionEvent {
  region: string;
  state?: string;
}

export interface AuthChangeEvent {
  status: 'authorizedAlways' | 'authorizedWhenInUse' | 'denied' | 'restricted' | 'notDetermined' | 'unknown';
}

export interface BeaconErrorEvent {
  error: string;
  phase?: string;
}

export type ScooterBeaconEvents = {
  onBeaconEnter: (event: BeaconRegionEvent) => void;
  onBeaconExit: (event: BeaconRegionEvent) => void;
  onBeaconRange: (event: BeaconRangeEvent) => void;
  onAuthorizationChange: (event: AuthChangeEvent) => void;
  onBeaconError: (event: BeaconErrorEvent) => void;
};

let nativeModule: any = null;
try {
  nativeModule = requireNativeModule('ScooterBeacon');
} catch (e) {
  nativeModule = null;
}

const emitter = nativeModule ? new EventEmitter<ScooterBeaconEvents>(nativeModule) : null;

export const ScooterBeacon = {
  isAvailable: (): boolean => {
    return nativeModule !== null;
  },
  requestLocationPermission: () => {
    nativeModule?.requestLocationPermission();
  },
  requestAlwaysAuthorization: () => {
    nativeModule?.requestAlwaysAuthorization();
  },
  requestWhenInUseAuthorization: () => {
    nativeModule?.requestWhenInUseAuthorization();
  },
  getAuthorizationStatus: (): string => {
    return nativeModule?.getAuthorizationStatus() ?? 'unknown';
  },
  startMonitoring: (uuid: string, major: number = 1, minor: number = 1) => {
    nativeModule?.startMonitoring(uuid, major, minor);
  },
  stopMonitoring: () => {
    nativeModule?.stopMonitoring();
  },
  setManualOverrideOff: (enabled: boolean) => {
    nativeModule?.setManualOverrideOff(enabled);
  },
  isManualOverrideOff: (): boolean => {
    return nativeModule?.isManualOverrideOff() ?? false;
  },
  isAutoTest5xRequested: (): boolean => {
    return nativeModule?.isAutoTest5xRequested?.() ?? false;
  },
  nativeLog: (msg: string) => {
    nativeModule?.nativeLog?.(msg);
  },
  addEnterListener: (listener: (event: BeaconRegionEvent) => void): EventSubscription | null => {
    return emitter?.addListener('onBeaconEnter', listener) ?? null;
  },
  addExitListener: (listener: (event: BeaconRegionEvent) => void): EventSubscription | null => {
    return emitter?.addListener('onBeaconExit', listener) ?? null;
  },
  addRangeListener: (listener: (event: BeaconRangeEvent) => void): EventSubscription | null => {
    return emitter?.addListener('onBeaconRange', listener) ?? null;
  },
  addAuthListener: (listener: (event: AuthChangeEvent) => void): EventSubscription | null => {
    return emitter?.addListener('onAuthorizationChange', listener) ?? null;
  },
  addErrorListener: (listener: (event: BeaconErrorEvent) => void): EventSubscription | null => {
    return emitter?.addListener('onBeaconError', listener) ?? null;
  }
};
