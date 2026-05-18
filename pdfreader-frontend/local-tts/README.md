Place local Piper assets in this folder for Electron builds:

- `piper.exe`
- `en_US-ryan-high.onnx`
- `en_US-ryan-high.onnx.json` (optional, but recommended if your voice requires it)

When packaged, these files are copied into the app's resources and used by desktop TTS.

You can override paths at runtime with environment variables:

- `PIPER_BINARY_PATH`
- `PIPER_MODEL_PATH`
