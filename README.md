# Non-Steam Uploader

Drag-and-drop desktop app that:

- accepts `.exe` files
- adds Steam shortcuts automatically
- downloads artwork from official Steam assets first
- falls back to SteamGridDB when official assets are missing
- shows a managed game grid with remove actions

## Requirements

- Windows with Steam installed
- Node.js 20+
- Steam must be closed while writing `shortcuts.vdf` (recommended)

## Setup

```powershell
npm install
npm start
```

If Steam is installed in a custom location, set:

```powershell
$env:STEAM_PATH="D:\Apps\Steam"
```

## Usage

- Drag one or more `.exe` files into the app window.
- Or use `Pick EXE`.
- Right-click a game card to remove it.
- Use `Remove All` to delete all Steam Drop shortcuts + artwork.

The app updates the latest Steam user profile under:

- `Steam\userdata\<userId>\config\shortcuts.vdf`
- `Steam\userdata\<userId>\config\grid\`

## Notes

Artwork naming follows Steam grid conventions:

- `<shortcutId>.jpg` (landscape)
- `<shortcutId>p.jpg` (portrait)
- `<shortcutId>_hero.jpg`
- `<shortcutId>_logo.png`

SteamGridDB fallback needs a valid API key from https://www.steamgriddb.com/profile/preferences/api


## Build For Windows

Build installer:

```powershell
npm run build:win
```

Build portable app:

```powershell
npm run build:win-portable
```

Build output goes to `dist\`.

