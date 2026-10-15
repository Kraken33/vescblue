Pod::Spec.new do |s|
  s.name           = 'ScooterBeacon'
  s.version        = '1.0.0'
  s.summary        = 'Scooter iBeacon Proximity Module'
  s.description    = 'Apple iBeacon region monitoring for Scooter BLE keyless ignition'
  s.author         = 'Kraken'
  s.homepage       = 'https://github.com/Kraken33/vescblue'
  s.platforms      = { :ios => '16.4' }
  s.source         = { :git => '' }
  s.source_files   = 'ios/**/*.{h,m,mm,swift,hpp,cpp}'
  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'CoreLocation'
end
