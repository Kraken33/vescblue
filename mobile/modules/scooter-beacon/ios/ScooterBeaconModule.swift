import ExpoModulesCore
import CoreLocation

internal class BeaconDelegate: NSObject, CLLocationManagerDelegate {
  weak var module: ScooterBeaconModule?

  init(module: ScooterBeaconModule) {
    self.module = module
    super.init()
  }

  func locationManager(_ manager: CLLocationManager, didEnterRegion region: CLRegion) {
    if UserDefaults.standard.bool(forKey: "scooter_manual_override_off") {
      NSLog("[ScooterBeacon] didEnterRegion suppressed: Manual Turn OFF active")
      return
    }
    NSLog("[ScooterBeacon] didEnterRegion: %@", region.identifier)
    var bgTaskId: UIBackgroundTaskIdentifier = .invalid
    bgTaskId = UIApplication.shared.beginBackgroundTask(withName: "ScooterBeaconEnter") {
      if bgTaskId != .invalid {
        UIApplication.shared.endBackgroundTask(bgTaskId)
        bgTaskId = .invalid
      }
    }
    
    if #available(iOS 13.0, *), let constraint = module?.beaconConstraint {
      manager.startRangingBeacons(satisfying: constraint)
    } else if let beaconRegion = region as? CLBeaconRegion {
      manager.startRangingBeacons(in: beaconRegion)
    }
    
    module?.sendEvent("onBeaconEnter", ["region": region.identifier])
    
    DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
      if bgTaskId != .invalid {
        UIApplication.shared.endBackgroundTask(bgTaskId)
        bgTaskId = .invalid
      }
    }
  }

  func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) {
    NSLog("[ScooterBeacon] didExitRegion: %@", region.identifier)
    module?.sendEvent("onBeaconExit", ["region": region.identifier])
  }

  func locationManager(_ manager: CLLocationManager, didDetermineState state: CLRegionState, for region: CLRegion) {
    if UserDefaults.standard.bool(forKey: "scooter_manual_override_off") {
      NSLog("[ScooterBeacon] didDetermineState suppressed: Manual Turn OFF active")
      return
    }
    let stateStr: String
    switch state {
    case .inside: stateStr = "inside"
    case .outside: stateStr = "outside"
    case .unknown: stateStr = "unknown"
    }
    NSLog("[ScooterBeacon] didDetermineState: %@ for region: %@", stateStr, region.identifier)
    if state == .inside {
      var bgTaskId: UIBackgroundTaskIdentifier = .invalid
      bgTaskId = UIApplication.shared.beginBackgroundTask(withName: "ScooterBeaconStateInside") {
        if bgTaskId != .invalid {
          UIApplication.shared.endBackgroundTask(bgTaskId)
          bgTaskId = .invalid
        }
      }
      
      if #available(iOS 13.0, *), let constraint = module?.beaconConstraint {
        manager.startRangingBeacons(satisfying: constraint)
      } else if let beaconRegion = region as? CLBeaconRegion {
        manager.startRangingBeacons(in: beaconRegion)
      }
      
      module?.sendEvent("onBeaconEnter", ["region": region.identifier, "state": stateStr])
      
      DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
        if bgTaskId != .invalid {
          UIApplication.shared.endBackgroundTask(bgTaskId)
          bgTaskId = .invalid
        }
      }
    } else if state == .outside {
      module?.sendEvent("onBeaconExit", ["region": region.identifier, "state": stateStr])
    }
  }

  // iOS 13+ constraint ranging
  func locationManager(_ manager: CLLocationManager, didRange beacons: [CLBeacon], satisfying beaconConstraint: CLBeaconIdentityConstraint) {
    handleRangedBeacons(beacons)
  }

  // Pre-iOS 13 region ranging fallback
  func locationManager(_ manager: CLLocationManager, didRangeBeacons beacons: [CLBeacon], in region: CLBeaconRegion) {
    handleRangedBeacons(beacons)
  }

  private func handleRangedBeacons(_ beacons: [CLBeacon]) {
    if UserDefaults.standard.bool(forKey: "scooter_manual_override_off") {
      return
    }
    guard let nearest = beacons.first else { return }
    NSLog("[ScooterBeacon] didRange nearest: rssi=%ld, prox=%ld, acc=%.2f", nearest.rssi, nearest.proximity.rawValue, nearest.accuracy)
    module?.sendEvent("onBeaconRange", [
      "rssi": nearest.rssi,
      "proximity": nearest.proximity.rawValue, // 0=unknown, 1=immediate (<0.5m), 2=near (<2m), 3=far (>2m)
      "accuracy": nearest.accuracy
    ])
  }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    // Keep-alive heartbeat for background execution while locked
  }

  func locationManager(_ manager: CLLocationManager, monitoringDidFailFor region: CLRegion?, withError error: Error) {
    NSLog("[ScooterBeacon] monitoringDidFailFor: %@", error.localizedDescription)
    module?.sendEvent("onBeaconError", ["error": error.localizedDescription, "phase": "monitoring"])
  }

  func locationManager(_ manager: CLLocationManager, rangingBeaconsDidFailFor region: CLBeaconRegion, withError error: Error) {
    NSLog("[ScooterBeacon] rangingBeaconsDidFailFor: %@", error.localizedDescription)
    module?.sendEvent("onBeaconError", ["error": error.localizedDescription, "phase": "ranging"])
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    NSLog("[ScooterBeacon] didFailWithError: %@", error.localizedDescription)
    module?.sendEvent("onBeaconError", ["error": error.localizedDescription, "phase": "general"])
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    let statusStr = ScooterBeaconModule.authStatusString(manager)
    NSLog("[ScooterBeacon] locationManagerDidChangeAuthorization: %@", statusStr)
    module?.sendEvent("onAuthorizationChange", ["status": statusStr])
  }
}

public class ScooterBeaconModule: Module {
  private var locationManager: CLLocationManager?
  private var beaconDelegate: BeaconDelegate?
  internal var monitoredRegion: CLBeaconRegion?
  internal var beaconConstraint: CLBeaconIdentityConstraint?

  internal static func authStatusString(_ manager: CLLocationManager? = nil) -> String {
    let status: CLAuthorizationStatus
    if #available(iOS 14.0, *) {
      status = manager?.authorizationStatus ?? CLLocationManager().authorizationStatus
    } else {
      status = CLLocationManager.authorizationStatus()
    }
    switch status {
    case .authorizedAlways: return "authorizedAlways"
    case .authorizedWhenInUse: return "authorizedWhenInUse"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown"
    }
  }

  public func definition() -> ModuleDefinition {
    Name("ScooterBeacon")

    Events("onBeaconEnter", "onBeaconExit", "onBeaconRange", "onAuthorizationChange", "onBeaconError")

    Function("requestLocationPermission") {
      DispatchQueue.main.async {
        self.ensureManagerInitialized()
        let status: CLAuthorizationStatus
        if #available(iOS 14.0, *) {
          status = self.locationManager?.authorizationStatus ?? .notDetermined
        } else {
          status = CLLocationManager.authorizationStatus()
        }
        NSLog("[ScooterBeacon] requestLocationPermission called, current status: %d", status.rawValue)
        if status == .notDetermined {
          self.locationManager?.requestWhenInUseAuthorization()
        } else if status == .authorizedWhenInUse {
          self.locationManager?.requestAlwaysAuthorization()
        }
      }
    }

    Function("requestWhenInUseAuthorization") {
      DispatchQueue.main.async {
        self.ensureManagerInitialized()
        NSLog("[ScooterBeacon] requestWhenInUseAuthorization called")
        self.locationManager?.requestWhenInUseAuthorization()
      }
    }

    Function("requestAlwaysAuthorization") {
      DispatchQueue.main.async {
        self.ensureManagerInitialized()
        let status: CLAuthorizationStatus
        if #available(iOS 14.0, *) {
          status = self.locationManager?.authorizationStatus ?? .notDetermined
        } else {
          status = CLLocationManager.authorizationStatus()
        }
        NSLog("[ScooterBeacon] requestAlwaysAuthorization called, current status: %d", status.rawValue)
        if status == .notDetermined {
          self.locationManager?.requestWhenInUseAuthorization()
        } else {
          self.locationManager?.requestAlwaysAuthorization()
        }
      }
    }

    Function("getAuthorizationStatus") { () -> String in
      self.ensureManagerInitialized()
      return ScooterBeaconModule.authStatusString(self.locationManager)
    }

    Function("setManualOverrideOff") { (enabled: Bool) in
      DispatchQueue.main.async {
        UserDefaults.standard.set(enabled, forKey: "scooter_manual_override_off")
        NSLog("[ScooterBeacon] setManualOverrideOff: %d", enabled)
        if enabled {
          self.stopAllMonitoringAndRanging()
        }
      }
    }

    Function("isManualOverrideOff") { () -> Bool in
      return UserDefaults.standard.bool(forKey: "scooter_manual_override_off")
    }

    Function("isAutoTest5xRequested") { () -> Bool in
      return CommandLine.arguments.contains("--autotest5x") ||
             ProcessInfo.processInfo.environment["SCOOTER_AUTOTEST_5X"] == "1"
    }

    Function("nativeLog") { (msg: String) in
      NSLog("[ScooterApp] %@", msg)
    }

    Function("startMonitoring") { (uuidStr: String, major: Int, minor: Int) in
      DispatchQueue.main.async {
        if UserDefaults.standard.bool(forKey: "scooter_manual_override_off") {
          NSLog("[ScooterBeacon] startMonitoring suppressed: Manual Turn OFF has highest priority")
          return
        }
        self.ensureManagerInitialized()
        let authStatus = ScooterBeaconModule.authStatusString(self.locationManager)
        let isMonitoringAvail = CLLocationManager.isMonitoringAvailable(for: CLBeaconRegion.self)
        let isRangingAvail = CLLocationManager.isRangingAvailable()
        NSLog("[ScooterBeacon] startMonitoring called (auth: %@, canMonitor: %d, canRange: %d)", authStatus, isMonitoringAvail, isRangingAvail)

        if authStatus == "notDetermined" {
          self.locationManager?.requestWhenInUseAuthorization()
        }

        guard let uuid = UUID(uuidString: uuidStr) else {
          NSLog("[ScooterBeacon] Invalid UUID string: %@", uuidStr)
          self.sendEvent("onBeaconError", ["error": "Invalid UUID string", "phase": "validation"])
          return
        }

        // Standard Universal CLBeaconRegion constructor
        let region = CLBeaconRegion(
          uuid: uuid,
          major: CLBeaconMajorValue(major),
          minor: CLBeaconMinorValue(minor),
          identifier: "ScooterAntisparkBeacon"
        )
        region.notifyOnEntry = true
        region.notifyOnExit = true
        region.notifyEntryStateOnDisplay = false

        let constraint = CLBeaconIdentityConstraint(
          uuid: uuid,
          major: CLBeaconMajorValue(major),
          minor: CLBeaconMinorValue(minor)
        )

        self.beaconConstraint = constraint
        self.monitoredRegion = region

        NSLog("[ScooterBeacon] Starting beacon monitoring & ranging for UUID: %@ Major: %d Minor: %d", uuidStr, major, minor)

        self.locationManager?.startMonitoring(for: region)
        self.locationManager?.startRangingBeacons(satisfying: constraint)
        self.locationManager?.requestState(for: region)
        
        // Start low-power location updates to keep active ranging alive while screen is locked
        self.locationManager?.desiredAccuracy = kCLLocationAccuracyThreeKilometers
        self.locationManager?.distanceFilter = 99999
        self.locationManager?.startUpdatingLocation()
        NSLog("[ScooterBeacon] Started background location updates for locked-screen beacon ranging")
      }
    }

    Function("stopMonitoring") {
      DispatchQueue.main.async {
        self.stopAllMonitoringAndRanging()
      }
    }
  }

  internal func stopAllMonitoringAndRanging() {
    self.ensureManagerInitialized()
    if let mgr = self.locationManager {
      for r in mgr.monitoredRegions {
        mgr.stopMonitoring(for: r)
        NSLog("[ScooterBeacon] Stopped monitoring for region: %@", r.identifier)
      }
      if #available(iOS 13.0, *) {
        for c in mgr.rangedBeaconConstraints {
          mgr.stopRangingBeacons(satisfying: c)
          NSLog("[ScooterBeacon] Stopped ranging for constraint: %@", c.uuid.uuidString)
        }
      } else if let r = self.monitoredRegion {
        mgr.stopRangingBeacons(in: r)
      }
      mgr.stopUpdatingLocation()
    }
    self.monitoredRegion = nil
    self.beaconConstraint = nil
    NSLog("[ScooterBeacon] Stopped all beacon monitoring & ranging")
  }

  private func ensureManagerInitialized() {
    if locationManager == nil {
      let mgr = CLLocationManager()
      let del = BeaconDelegate(module: self)
      mgr.delegate = del
      mgr.pausesLocationUpdatesAutomatically = false
      if #available(iOS 9.0, *) {
        mgr.allowsBackgroundLocationUpdates = true
        mgr.showsBackgroundLocationIndicator = false
      }
      self.locationManager = mgr
      self.beaconDelegate = del
      NSLog("[ScooterBeacon] CLLocationManager initialized with background location updates")
    }
  }
}
