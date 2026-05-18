const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopTTS", {
  speak: async (text) => {
    const arrayBuffer = await ipcRenderer.invoke("tts:speak", text);
    return arrayBuffer;
  },
});
