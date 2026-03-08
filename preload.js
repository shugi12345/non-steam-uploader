const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("steamDrop", {
  process: (payload) => ipcRenderer.invoke("app:process", payload),
  listGames: () => ipcRenderer.invoke("app:listGames"),
  removeGame: (shortcutId) => ipcRenderer.invoke("app:removeGame", shortcutId),
  renameGame: (shortcutId, appName) => ipcRenderer.invoke("app:renameGame", { shortcutId, appName }),
  setGameVr: (shortcutId, isVr) => ipcRenderer.invoke("app:setGameVr", { shortcutId, isVr }),
  getApiSettings: () => ipcRenderer.invoke("app:getApiSettings"),
  saveApiKey: (apiKey) => ipcRenderer.invoke("app:saveApiKey", { apiKey }),
  dismissApiKeyPrompt: () => ipcRenderer.invoke("app:dismissApiKeyPrompt"),
  removeAll: () => ipcRenderer.invoke("app:removeAll"),
  pickExes: () => ipcRenderer.invoke("app:pickExes"),
  restartSteam: () => ipcRenderer.invoke("app:restartSteam"),
  getPathForFile: (file) => webUtils.getPathForFile(file)
});
