# SAFE handshake test: does the flash controller honour the unlock keys?
# Sets no erase/program bits, so flash contents cannot change.
# Keys/registers are taken from the display firmware's HAL (0x08000568).

set FLASH_KEYR 0x40022004
set FLASH_SR   0x4002200C
set FLASH_CR   0x40022010

proc rd32 {a} { return [lindex [read_memory $a 32 1] 0] }

set cr0 [rd32 $FLASH_CR]
echo [format "FLASH_CR before: 0x%08X  SR: 0x%08X" $cr0 [rd32 $FLASH_SR]]
if { ($cr0 & 0x80) == 0 } {
	echo "LOCK already clear (unexpected after reset, continuing)"
}
write_memory $FLASH_KEYR 32 0x45670123
write_memory $FLASH_KEYR 32 0xCDEF89AB
set cr1 [rd32 $FLASH_CR]
echo [format "FLASH_CR after unlock: 0x%08X" $cr1]
write_memory $FLASH_CR 32 [expr {$cr1 | 0x80}]
echo [format "FLASH_CR re-locked: 0x%08X" [rd32 $FLASH_CR]]

if { ($cr1 & 0x80) == 0 } {
	echo "UNLOCK OK"
} else {
	echo "UNLOCK FAILED (LOCK bit still set) - do NOT flash"
	shutdown error
}
