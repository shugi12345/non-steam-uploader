# Non-Steam Uploader 🎮

<img src="./icon.png" alt="Non-Steam Uploader Icon" width="96" />

Add non-Steam games to your Steam library with artwork, fast management tools, and a clean desktop UI.

## Features ✨

- Drag-and-drop support for `.exe` and `.lnk` files.
- Automatic Steam shortcut creation in the latest Steam user profile.
- Artwork: official Steam assets first, with optional SteamGridDB fallback.
- In-app SteamGridDB API key setup (with optional first-run prompt).
- Right-click actions: rename, delete, and `VR Game` toggle.
- Multi-select: `Ctrl/Cmd+Click` and `Shift+Click` range selection.
- Sorting options (recent, oldest, A-Z, Z-A, VR first).
- Game size presets (small / medium / large).
- One-click Steam restart button.
- Single-instance app lock (second launch focuses existing window).

## Requirements 🧩

- Windows with Steam installed.
- Node.js 20+.

If Steam is installed in a custom location, set:

```powershell
$env:STEAM_PATH="D:\Apps\Steam"
```

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

## Data Written By The App 🗂️

- `Steam\userdata\<userId>\config\shortcuts.vdf`
- `Steam\userdata\<userId>\config\grid\`

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
