# Openstyle SDK

Small shared helpers for [Openstyle](../../README.md), the local-first voice
dictation app. Both apps import them through the `@openstyle/sdk` alias.

The plugin system is removed. This package no longer has a plugin contract,
loader or hooks.

## Exports

| Name | Kind | Use |
| --- | --- | --- |
| `OutputMode` | const object and type | How final text is delivered: `"paste"`, `"clipboard"` or `"none"` |
| `parseAppContext` | function | Turns the raw app-context string from the client into an `AppContext` |
| `AppContext` | type | The frontmost app, window title, URL and bundle id. Every field is optional |
| `AppContextPayload` | type | The raw JSON shape the client sends before parsing |

## Output modes

| Value | Constant | Behavior |
| --- | --- | --- |
| `"paste"` | `OutputMode.Paste` | Write to the clipboard and send Cmd/Ctrl+V to the focused app |
| `"clipboard"` | `OutputMode.Clipboard` | Write to the clipboard only. The user pastes by hand |
| `"none"` | `OutputMode.None` | Suppress delivery. Nothing is pasted or copied |

## App context

`parseAppContext(raw)` accepts a JSON string or a bare application name. It
returns `undefined` for empty input. It never throws.

```ts
import { parseAppContext } from "@openstyle/sdk";

parseAppContext('{"app":"Safari","url":"https://example.com"}');
// { appName: "Safari", url: "https://example.com" }

parseAppContext("Safari");
// { appName: "Safari" }
```
