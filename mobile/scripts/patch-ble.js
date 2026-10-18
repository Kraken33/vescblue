#!/usr/bin/env node
/**
 * Automatically applies BLE reconnect & dual-device stability fixes to:
 *   1. node_modules/react-native-ble-plx/src/BleManager.js
 *   2. ios/Pods/MultiplatformBleAdapter (when ios/Pods is present)
 *
 * Triggered automatically by:
 *   - `npm install` (via package.json "postinstall")
 *   - `pod install` / `npx expo prebuild` / `npx expo run:ios` (via plugins/withBleFixes.js Podfile post_install hook)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');

function patchFile(relPath, replacer) {
  const fullPath = path.join(rootDir, relPath);
  if (!fs.existsSync(fullPath)) {
    return false;
  }
  try {
    fs.chmodSync(fullPath, 0o644);
  } catch (_) {}
  const original = fs.readFileSync(fullPath, 'utf8');
  const updated = replacer(original);
  if (updated !== original) {
    fs.writeFileSync(fullPath, updated, 'utf8');
    console.log(`[patch-ble] Patched ${relPath}`);
  } else {
    console.log(`[patch-ble] Already up to date: ${relPath}`);
  }
  return true;
}

// 1. Patch node_modules/react-native-ble-plx/src/BleManager.js
patchFile('node_modules/react-native-ble-plx/src/BleManager.js', (src) => {
  if (src.includes('if (this._scanEventSubscription != null) {\n      this._scanEventSubscription.remove()\n      this._scanEventSubscription = null\n    }\n    // $FlowFixMe: Flow cannot deduce EmitterSubscription type.')) {
    return src;
  }
  return src.replace(
    '    // $FlowFixMe: Flow cannot deduce EmitterSubscription type.\n    this._scanEventSubscription = this._eventEmitter.addListener(BleModule.ScanEvent, scanListener)',
    '    if (this._scanEventSubscription != null) {\n      this._scanEventSubscription.remove()\n      this._scanEventSubscription = null\n    }\n    // $FlowFixMe: Flow cannot deduce EmitterSubscription type.\n    this._scanEventSubscription = this._eventEmitter.addListener(BleModule.ScanEvent, scanListener)'
  );
});

// 2. Patch ios/Pods/MultiplatformBleAdapter if Pods are installed
const podRoot = path.join(rootDir, 'ios/Pods/MultiplatformBleAdapter');
if (fs.existsSync(podRoot)) {
  try {
    execSync(`chmod -R u+w "${podRoot}"`);
  } catch (_) {}

  // 2a. BleModule.swift
  patchFile('ios/Pods/MultiplatformBleAdapter/iOS/Classes/BleModule.swift', (src) => {
    let out = src;

    // Make descriptor discovery fault-tolerant
    out = out.replace(
      '            .flatMap { $0.discoverDescriptors() }',
      '            .flatMap { $0.discoverDescriptors().catchError { _ in .empty() } }'
    );

    // Always create fresh characteristic monitor observable and do not send setNotifyValue(false) on dispose
    const oldMonitorBlock = `        let observable: Observable<Characteristic> = characteristicObservable
            .flatMap { [weak self] (characteristic: Characteristic) -> Observable<Characteristic> in
                let characteristicIdentifier = characteristic.jsIdentifier
                if let monitoredObservable = self?.monitoredCharacteristics[characteristicIdentifier] {
                    return monitoredObservable
                }
                let newObservable: Observable<Characteristic> = characteristic
                    .setNotificationAndMonitorUpdates()
                    .do(onNext: nil, onError: nil, onCompleted: nil, onSubscribe: nil, onDispose: { [weak self] in
                        if characteristic.service.peripheral.isConnected {
                            _ = characteristic.setNotifyValue(false).subscribe()
                        }
                        self?.monitoredCharacteristics[characteristicIdentifier] = nil
                    })
                    .share()
                self?.monitoredCharacteristics[characteristicIdentifier] = newObservable
                return newObservable
            }`;

    const newMonitorBlock = `        let observable: Observable<Characteristic> = characteristicObservable
            .flatMap { [weak self] (characteristic: Characteristic) -> Observable<Characteristic> in
                let characteristicIdentifier = characteristic.jsIdentifier
                let newObservable: Observable<Characteristic> = characteristic
                    .setNotificationAndMonitorUpdates()
                    .do(onNext: nil, onError: { [weak self] _ in
                        self?.monitoredCharacteristics[characteristicIdentifier] = nil
                    }, onCompleted: nil, onSubscribe: nil, onDispose: { [weak self] in
                        self?.monitoredCharacteristics[characteristicIdentifier] = nil
                    })
                    .share()
                self?.monitoredCharacteristics[characteristicIdentifier] = newObservable
                return newObservable
            }`;

    if (out.includes(oldMonitorBlock)) {
      out = out.replace(oldMonitorBlock, newMonitorBlock);
    }

    // Also handle intermediate version if setNotifyValue(false) is still present
    out = out.replace(
      `                    }, onCompleted: nil, onSubscribe: nil, onDispose: { [weak self] in
                        if characteristic.service.peripheral.isConnected {
                            _ = characteristic.setNotifyValue(false).subscribe()
                        }
                        self?.monitoredCharacteristics[characteristicIdentifier] = nil
                    })`,
      `                    }, onCompleted: nil, onSubscribe: nil, onDispose: { [weak self] in
                        self?.monitoredCharacteristics[characteristicIdentifier] = nil
                    })`
    );

    // Clear monitoredCharacteristics in clearCacheForPeripheral
    const oldClearCache = `        for (key, value) in discoveredCharacteristics {
            if value.service.peripheral == peripheral {
                discoveredCharacteristics[key] = nil
            }
        }
        for (key, value) in discoveredServices {
            if value.peripheral == peripheral {
                discoveredServices[key] = nil
            }
        }
    }`;

    const newClearCache = `        for (key, value) in discoveredCharacteristics {
            if value.service.peripheral == peripheral {
                discoveredCharacteristics[key] = nil
                monitoredCharacteristics[key] = nil
            }
        }
        for (key, value) in discoveredServices {
            if value.peripheral == peripheral {
                discoveredServices[key] = nil
            }
        }
        if let services = peripheral.services {
            for service in services {
                if let chars = service.characteristics {
                    for char in chars {
                        monitoredCharacteristics[char.jsIdentifier] = nil
                    }
                }
            }
        }
    }`;

    if (out.includes(oldClearCache)) {
      out = out.replace(oldClearCache, newClearCache);
    }

    return out;
  });

  // 2b. Peripheral.swift
  patchFile('ios/Pods/MultiplatformBleAdapter/iOS/RxBluetoothKit/Peripheral.swift', (src) => {
    let out = src;

    const oldWriteValue = `    public func writeValue(_ data: Data,
                           for characteristic: Characteristic,
                           type: CBCharacteristicWriteType) -> Observable<Characteristic> {
        let observable: Observable<Characteristic>
        switch type {
        case .withoutResponse:
            observable = self.peripheral
                .rx_isReadyToSendWriteWithoutResponse
                .startWith(peripheral.canSendWriteWithoutResponse)
                .filter { $0 }
                .take(1)
                .map { [weak self] _ in
                    self?.peripheral.writeValue(data, for: characteristic.characteristic, type: type)
                    return characteristic
                }
            
        case .withResponse:
            let action = Observable<Characteristic>.deferred { [weak self] in
                    self?.peripheral.writeValue(data, for: characteristic.characteristic, type: type)
                    return .empty()
                }

            let monitor = peripheral
                .rx_didWriteValueForCharacteristic
                .filter { return $0.0 == characteristic.characteristic }
                .take(1)
                .map { (_, error) -> Characteristic in
                    if let error = error {
                        throw BluetoothError.characteristicWriteFailed(characteristic, error)
                    }
                    return characteristic
                }

            observable = Observable.merge([monitor, action])
        }
        return ensureValidPeripheralState(for: observable)
    }`;

    const newWriteValue = `    public func writeValue(_ data: Data,
                           for characteristic: Characteristic,
                           type: CBCharacteristicWriteType) -> Observable<Characteristic> {
        switch type {
        case .withoutResponse:
            let observable = Observable<Characteristic>.deferred { [weak self] in
                guard let strongSelf = self else { throw BluetoothError.destroyed }
                strongSelf.peripheral.writeValue(data, for: characteristic.characteristic, type: type)
                return .just(characteristic)
            }
            return ensureValidPeripheralState(for: observable)

        case .withResponse:
            let monitor = peripheral
                .rx_didWriteValueForCharacteristic
                .filter { return $0.0 == characteristic.characteristic }
                .take(1)
                .map { (_, error) -> Characteristic in
                    if let error = error {
                        throw BluetoothError.characteristicWriteFailed(characteristic, error)
                    }
                    return characteristic
                }
            return ensureValidPeripheralStateAndCallIfSucceeded(
                for: monitor,
                postSubscriptionCall: { [weak self] in
                    self?.peripheral.writeValue(data, for: characteristic.characteristic, type: type)
                }
            )
        }
    }`;

    if (out.includes(oldWriteValue)) {
      out = out.replace(oldWriteValue, newWriteValue);
    }

    const oldMonitorValue = `    public func monitorValueUpdate(for characteristic: Characteristic) -> Observable<Characteristic> {
        let observable = peripheral
            .rx_didUpdateValueForCharacteristic
            .filter { $0.0 == characteristic.characteristic }
            .map { (_, error) -> Characteristic in
                if let error = error {
                    throw BluetoothError.characteristicReadFailed(characteristic, error)
                }
                return characteristic
            }
        return ensureValidPeripheralState(for: observable)
    }`;

    const newMonitorValue = `    public func monitorValueUpdate(for characteristic: Characteristic) -> Observable<Characteristic> {
        let observable = peripheral
            .rx_didUpdateValueForCharacteristic
            .filter { $0.0 == characteristic.characteristic }
            .map { (rxCharacteristic, error) -> Characteristic in
                if let error = error {
                    throw BluetoothError.characteristicReadFailed(characteristic, error)
                }
                return Characteristic(characteristic: rxCharacteristic, service: characteristic.service)
            }
        return ensureValidPeripheralState(for: observable)
    }`;

    if (out.includes(oldMonitorValue)) {
      out = out.replace(oldMonitorValue, newMonitorValue);
    }

    out = out.replace(
      `                monitorValueUpdate(for: characteristic),
                setNotifyValue(true, for: characteristic)
                    .ignoreElements()`,
      `                monitorValueUpdate(for: characteristic),
                setNotifyValue(true, for: characteristic)
                    .catchError { _ in .empty() }
                    .ignoreElements()`
    );

    return out;
  });

  // 2c. RxCBCharacteristic.swift
  patchFile('ios/Pods/MultiplatformBleAdapter/iOS/RxBluetoothKit/RxCBCharacteristic.swift', (src) => {
    return src.replace(
      `    func isEqualTo(characteristic: RxCharacteristicType) -> Bool {
        guard let rhs = characteristic as? RxCBCharacteristic else { return false }
        return self.characteristic === rhs.characteristic
    }`,
      `    func isEqualTo(characteristic: RxCharacteristicType) -> Bool {
        guard let rhs = characteristic as? RxCBCharacteristic else { return false }
        if self.characteristic === rhs.characteristic { return true }
        return self.characteristic.uuid == rhs.characteristic.uuid &&
               self.characteristic.service?.peripheral?.identifier == rhs.characteristic.service?.peripheral?.identifier
    }`
    );
  });

  // 2d. RxCBService.swift
  patchFile('ios/Pods/MultiplatformBleAdapter/iOS/RxBluetoothKit/RxCBService.swift', (src) => {
    return src.replace(
      `    func isEqualTo(service: RxServiceType) -> Bool {
        guard let rhs = service as? RxCBService else { return false }
        return self.service === rhs.service
    }`,
      `    func isEqualTo(service: RxServiceType) -> Bool {
        guard let rhs = service as? RxCBService else { return false }
        if self.service === rhs.service { return true }
        return self.service.uuid == rhs.service.uuid &&
               self.service.peripheral?.identifier == rhs.service.peripheral?.identifier
    }`
    );
  });

  // 2e. RxCBPeripheral.swift
  patchFile('ios/Pods/MultiplatformBleAdapter/iOS/RxBluetoothKit/RxCBPeripheral.swift', (src) => {
    return src.replace(
      `        if let wrapper = internalPeripheralDelegateWrappers[cbPeripheral] {
            wrapper.refCount += 1
            return wrapper.delegate`,
      `        if let wrapper = internalPeripheralDelegateWrappers[cbPeripheral] {
            wrapper.refCount += 1
            cbPeripheral.delegate = wrapper.delegate
            return wrapper.delegate`
    );
  });

  // 2f. ShareReplayScope.swift
  patchFile('ios/Pods/MultiplatformBleAdapter/iOS/RxSwift/Observables/ShareReplayScope.swift', (src) => {
    return src.replace(
      `    final func on(_ event: Event<Element>) {
        let observers = self.lock.performLocked { self.synchronized_on(event) }
        dispatch(observers, event)
    }

    final private func synchronized_on(_ event: Event<Element>) -> Observers {
        if self.disposed {
            return Observers()
        }

        switch event {
        case .next:
            return self.observers`,
      `    final func on(_ event: Event<Element>) {
        let observers = self.lock.performLocked { self.synchronized_on(event) }
        dispatch(observers, event)
        switch event {
        case .error, .completed:
            self.subscription.dispose()
        case .next:
            break
        }
    }

    final private func synchronized_on(_ event: Event<Element>) -> Observers {
        if self.disposed {
            return Observers()
        }

        switch event {
        case .next:
            return self.observers`
    );
  });
}
