#!/data/data/com.termux/files/usr/bin/sh
# Copy this file to ~/.termux/boot/start-site.sh (needs the Termux:Boot app, opened once).
# It starts the site automatically after the phone reboots.
termux-wake-lock
sleep 20   # let mobile data / Wi-Fi come up first
cd "$HOME/sfhub" && ./scripts/hub start
