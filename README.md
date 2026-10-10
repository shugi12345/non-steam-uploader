# Non-Steam Uploader 🎮

<img src="./icon.png" alt="Non-Steam Uploader Icon" width="96" />

Add non-Steam games to your Steam library with artwork, fast management tools, and a clean desktop UI.

## Screenshot

![App Screenshot](./Screenshot.png)

## Features ✨

- Drag-and-drop support for `.exe` and `.lnk` files.
- Automatic Steam shortcut creation in the latest Steam user profile.
- Artwork: official Steam assets first, with optional SteamGridDB fallback.
- In-app SteamGridDB API key setup (with optional first-run prompt).
- Right-click actions: rename, delete, `VR Game` toggle, **Change Art** and **cloud saves** (works on several selected games at once).
- Art picker: browse every official Steam / SteamGridDB image per slot (cover, wide, hero, logo) or use your own file.
- Cross-device save sync (PC <-> Steam Deck), like Steam Cloud for non-Steam games.
- Runs on Windows and Linux / Steam Deck (AppImage, Proton set automatically).
- Multi-select: `Ctrl/Cmd+Click` and `Shift+Click` range selection.
- Sorting options (recent, oldest, A-Z, Z-A, VR first).
- Game size presets (small / medium / large).
- One-click Steam restart button.
- Single-instance app lock (second launch focuses existing window).

## Requirements 🧩

- Windows or Linux (Steam Deck) with Steam installed.
- Node.js 20+.

## Install & Run 🚀

```powershell
npm install
npm start
```

The app auto-reloads in development after file changes.

## How To Use 🕹️

1. Drag and drop one or more `.exe` / `.lnk` files into the app (or click to choose files).
2. Review games in the installed grid.
3. Right-click card(s) to rename, delete, or set VR flag.
4. Click `Restart Steam` after changes so Steam refreshes shortcuts/artwork.

## SteamGridDB API Key (Optional) 🔑

You can set or edit the key directly in the app from the `SteamGridDB API Key` button.

Get your key here:
https://www.steamgriddb.com/profile/preferences/api

## Save Sync ☁️

1. Click **Cloud Saves** and connect Google Drive / OneDrive / Dropbox. Do this on every device. Nothing needs to be installed: [rclone](https://rclone.org) ships inside the app (fetched by `npm install` / the build scripts into `vendor/`) and keeps its own config in the app data folder.
2. Add games. Once a cloud account is connected, every newly added game gets cloud saves automatically when its save location is known: either it's already in your cloud from another device, or it's in the [Ludusavi manifest](https://github.com/mtkennerly/ludusavi-manifest) (save locations for ~20k games, from PCGamingWiki, matched by name or Steam app ID). Unknown games are skipped and you're told which ones.
3. For an existing or unknown game, right-click it → **Turn on cloud saves**. With one game selected you confirm the suggested folder or pick it by hand. With several selected, they're all turned on in one go (unknown ones are skipped). If every selected game already syncs, the same item turns them all off.
4. On your other devices, add the same game **with the same name**. The save folder is picked up from the cloud automatically. Renaming a synced game keeps sync on; the cloud copy then follows the new name.
5. Restart Steam. Launching the game from Steam now downloads the newest save first and uploads yours when you quit.

**Cloud Saves** also shows the linked devices (name, OS, games, last seen), lets you rename this device or forget old ones, and lists every synced game with the devices that share it and who uploaded last.

How it works:

- The shortcut launches the game through this app (`--nsu-wrap`). On Windows, the shortcut target becomes this app. On the Deck, the launch options become `"<AppImage>" --nsu-wrap <id> -- %command%` so Proton still applies. Keep the AppImage / exe where it is after enabling sync.
- Save folders are stored as portable paths (`{AppData}/Game/Saves`), which map to the shortcut's Proton prefix on the Deck.
- If both the cloud and this device changed since the last sync, you're asked which save to continue from, like Steam Cloud. Both save times and devices are shown, and the newer one is pre-selected. Before any download overwrites local files, the local save is copied to `<app data>/save-backups/<game>/` (last 5 kept).
- Cloud layout: `<remote>non-steam-saves/<game-key>/{meta.json,files/}` plus `non-steam-saves/_devices/<device-id>.json`.

### Steam Deck Game Mode

- Sync works in Game Mode as is: it runs from each game's Steam launch options, so this app's window never has to be open.
- To open the app itself from Game Mode, use **Cloud Saves → Add This App to Steam** once (in Desktop Mode).
- Quitting from the Steam overlay: the wrapper ignores Steam's stop signal and uploads once the game exits. If Steam force-kills it first, the leftover changes upload automatically at the start of the next launch.
- No Decky Loader plugin is needed.
- Game Mode can't show the app's dialogs. A save conflict there keeps the newer save (the other one is backed up), and errors only go to `~/.config/non-steam-uploader/wrap.log`. That log is also copied to `<remote>non-steam-saves/_logs/<device-id>.log` on each launch, so it can be read from the PC.

Limits:

- On the Deck, the very first launch has no Proton prefix yet, so nothing is downloaded. When you quit, you're offered the cloud save.
- A game whose launcher exits immediately (the launcher starts the real game, then quits) gets backed up too early.
- One save folder per game. Games that keep their save as a single file in the install folder root need a manual pick.
- Turn off sync before renaming a game (the cloud save is keyed on the name).

## Data Written By The App 🗂️

- `Steam\userdata\<userId>\config\shortcuts.vdf`
- `Steam\userdata\<userId>\config\grid\`
- Linux only: Proton `CompatToolMapping` entries in `Steam/config/config.vdf` (written by **Restart Steam** while Steam is closed)

Artwork filenames follow Steam grid conventions:

- `<shortcutId>.jpg` (landscape)
- `<shortcutId>p.jpg` (portrait)
- `<shortcutId>_hero.jpg`
- `<shortcutId>_logo.png`

## Build For Windows 🏗️

Build installer:

```powershell
npm run build:win
```

Build portable app:

```powershell
npm run build:win-portable
```

Output is generated in `dist\`.

## Build For Linux / Steam Deck 🐧

```bash
npm run build:linux
```

Copy the AppImage to the Deck, `chmod +x` it, and run it in Desktop Mode.
