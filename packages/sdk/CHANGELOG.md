# Changelog

## 1.0.0

### Breaking Changes 💥

- The plugin-bridge global injected into plugin UI pages is now `window.openstyle` (was `window.freestyle`); the SDK's exported `FreestyleBridge` type is now `OpenstyleBridge`. Every plugin's UI code must update its reference to load under this SDK version.
- The plugin manifest key in `package.json` is now `openstyle` (was `freestyle`) for `icon`, `displayName`, and `contributes`. The host reads `openstyle` first and still falls back to a legacy `freestyle` key, so already-installed plugins keep working, but new/updated plugins should declare under `openstyle`.
- `loadPlugins`'s dynamic import now only accepts local file paths and bare/scoped module specifiers. A specifier carrying an explicit URI scheme (`http:`, `https:`, `file:`, `data:`, ...) is rejected with a clear error instead of being imported.

## 0.5.0

- No documented changes.

## 0.4.0

### New Features ✨

- Plugin system improvements, storage API, and create-freestyle-plugin CLI by @MathurAditya724 in [#369](https://github.com/freestyle-voice/freestyle/pull/369)

## 0.1.0

### New Features ✨

- (plugins) Plugin UI ecosystem + audio-transcription plugin by @MathurAditya724 in [#324](https://github.com/freestyle-voice/freestyle/pull/324)
- (sdk) Plugin system by @MathurAditya724 in [#317](https://github.com/freestyle-voice/freestyle/pull/317)

