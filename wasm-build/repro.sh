#!/bin/bash
# Drive a fresh game: new game -> hire MD -> shutdown -> compress time -> sector
# load, all via the headed CDP harness. Prints title after key steps.
cd "$(dirname "$0")/.."
H="node wasm-build/harness.mjs"
c(){ $H click "$1" "$2" >/dev/null 2>&1; sleep "${3:-1.5}"; }
t(){ $H title 2>/dev/null || echo DEAD; }

echo "start: $(t)"
c 640 500 2; c 478 700 2; c 587 519 4     # new game -> laptop
echo "laptop: $(t)"
c 944 250 1                                 # close help
c 300 265 1.5                               # Web (mail pops)
c 643 432 1.5                               # dismiss mail
c 300 265 1.5                               # Web dropdown
c 422 266 4                                 # A.I.M. (load)
c 583 480 2                                 # Members
c 545 435 2                                 # mug index
c 897 628 2                                 # MD
echo "bio: $(t)"
c 700 661 2                                 # Contact
c 608 373 2                                 # HIRE
c 608 373 2                                 # HIRE (first-contact -> contract, if needed)
c 608 440 2                                 # TRANSFER FUNDS
c 662 429 1.5                               # OK (EFT successful)
c 852 284 1                                 # close video conf X
echo "after hire: $(t)"
c 300 638 2                                 # Shut Down (-> arrival msg)
c 692 458 1.5                               # OK arrival
c 300 638 3                                 # Shut Down (-> map)
echo "map: $(t)"
c 920 733 1.5                               # compress toggle
$H click 920 733 >/dev/null 2>&1            # compress start
echo "compressing... waiting for sector load"
sleep 8
echo "FINAL: $(t)"
