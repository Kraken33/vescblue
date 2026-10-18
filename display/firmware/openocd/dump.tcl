# Chunked dump of the display flash with periodic IWDG watchdog reloading.
# Caller sets OUT (path prefix) and halts the target first.
#   -> ${OUT}_<offset>.part  (32 chunks of 2 KiB = 64 KiB)
#   -> ${OUT}.optbytes.bin   (16 B option bytes)

if { ![info exists OUT] } { set OUT "display" }

set BASE 0x08000000
set BLOCK 0x800
set TOTAL 0x10000

for { set off 0 } { $off < $TOTAL } { incr off $BLOCK } {
	# Reload IWDG before every 2 KiB chunk
	catch { write_memory 0x40003000 32 0xAAAA }
	set addr [expr {$BASE + $off}]
	set fn [format "%s_%05X.part" $OUT $off]
	if { [catch { dump_image $fn $addr $BLOCK } err] } {
		echo [format "DUMP FAILED at 0x%08X: %s" $addr $err]
		shutdown error
	}
}

catch { write_memory 0x40003000 32 0xAAAA }
if { [catch { dump_image ${OUT}.optbytes.bin 0x1FFFF800 16 } err] } {
	echo "option byte read failed (not fatal): $err"
}
echo "DUMP CHUNKS OK"
