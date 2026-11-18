# Hosting the site from your Poco F5 (free tunnel)

Not yet tested on a real phone. I could only test the server and scripts on a Linux machine, so expect to troubleshoot once.

## How it works
Visitor → ngrok's public address → encrypted tunnel → your phone → `scripts/server.mjs` (listens on 127.0.0.1 only) → the built site in `dist/`.
Nothing on your phone is exposed directly. Phone off or tunnel stopped = site unreachable.

## One-time setup

### A. On your PC: build the site
```
cd sfhub
set SITE_URL=https://YOUR-NAME.ngrok-free.app      (Windows cmd)
export SITE_URL=https://YOUR-NAME.ngrok-free.app   (Mac/Linux)
npm install
npm run check     # catches mistakes before you deploy
npm run build
```
This makes the `dist/` folder. Building on the phone is slow and hot, so don't.

### B. Get a free fixed address
1. Create a free account at ngrok.com.
2. In its dashboard, claim your free static domain (looks like `something.ngrok-free.app`) and copy your authtoken.

### C. On the phone
1. Install **Termux** and **Termux:Boot** from **F-Droid** (not the Play Store).
2. In Termux:
```
pkg update && pkg upgrade
pkg install nodejs-lts curl
termux-setup-storage
```
3. Install ngrok for Android/Linux **arm64** from ngrok's download page, put the `ngrok` binary in `$PREFIX/bin`, then:
```
chmod +x $PREFIX/bin/ngrok
ngrok config add-authtoken YOUR_TOKEN
```
4. Copy the project (everything except `node_modules`, with the built `dist/` folder) to `~/sfhub` on the phone (USB, or a zip then `unzip` in Termux).
5. Create the config:
```
mkdir -p ~/.sfhub
echo "NGROK_DOMAIN=YOUR-NAME.ngrok-free.app" > ~/.sfhub/config.env
chmod +x ~/sfhub/scripts/hub
```

## Daily use (in Termux, inside ~/sfhub)
```
./scripts/hub start          # server + tunnel
./scripts/hub stop           # site goes offline
./scripts/hub status         # real health checks, local and public
./scripts/hub logs
./scripts/hub resources      # memory and disk (battery needs Termux:API)
./scripts/hub maintenance on # visitors see the offline page (503) while phone stays up
./scripts/hub maintenance off
```
If ngrok rejects `--url`, edit `scripts/hub` and change `--url=` to `--domain=` (older ngrok versions).

## Keep it alive on HyperOS / MIUI
- Settings → Apps → Manage apps → Termux → **Autostart: on**, **Battery saver: No restrictions**.
- Open the recent-apps view and **lock** Termux (pull the card down or tap the lock).
- Run `termux-wake-lock` (the `start` command does this).
- For auto-start after reboot: open Termux:Boot once, then
```
mkdir -p ~/.termux/boot
cp ~/sfhub/scripts/boot-start.sh ~/.termux/boot/start-site.sh
chmod +x ~/.termux/boot/start-site.sh
```

## Publishing a new article
1. Build on your PC (`npm run build`).
2. Copy the new `dist/` to the phone, replacing the old one.
3. No restart needed. The server reads files on every request. Pages are cached by browsers for 5 minutes and compressed copies are kept in memory, so a new build shows up within minutes (or immediately after a hard refresh).

## Known limits of the free tunnel
- When the phone is off, ngrok shows **its own** offline page. A custom "We'll be back soon" message for that case needs your own domain plus a Cloudflare Worker.
- Free plans have bandwidth and request limits, and visitors may see a warning page on first visit (check ngrok's current terms).
- Mobile data, heat and battery wear: use a charger with ventilation, and ideally a spare phone.
