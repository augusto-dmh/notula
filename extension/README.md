# Notula browser extension

The optional MV3 extension for Chrome and Edge. It reports what plays in the browser to the Notula app on the same computer, over native messaging (host `app.notula.bridge`). Notula works fully without it.

## Build

```
npm --prefix extension run build        # type check + bundle + dev package, + store packages once store/publisher.json has the email
npm --prefix extension run build:store  # Chrome and Edge packages only; fails while store/publisher.json has no email
npm --prefix extension run typecheck  # type check only
npm --prefix extension run icons      # re-render icons from resources/icon/icon-512.png
```

No dependencies of its own: the build uses the repo's TypeScript and Vite from the root `node_modules`, and its own zip writer. Keep it that way: don't run `npm install` here.

Output, git-ignored, in `extension/dist/`:

| Path | Use |
|---|---|
| `notula-extension-<version>-chrome.zip` | Chrome Web Store upload (`store: cws`, no `key`) |
| `notula-extension-<version>-edge.zip` | Edge Add-ons upload (`store: edge`, no `key`) |
| `notula-extension-<version>-dev.zip`, `dev/` | Load unpacked; carries the committed public `key`, so its id is fixed |
| `ids.json` | The ids Notula's host manifest must allow: `dev`, and `cws`/`edge` from `store/ids.json` |

## Layout

| Path | What |
|---|---|
| `src/background/` | Service worker: native port and connection policy (`bridge.ts`), tab state and send rules (`tabs.ts`), Notula's requests (`requests.ts`), Mark this moment (`mark.ts`), sites (`sites.ts`) |
| `src/content/reader.ts` | The reader in every frame of a granted site: media, adapter, reports |
| `src/content/youtube-main.ts` | YouTube main-world script: player data, the player's own caption fetches, the replay |
| `src/content/adapters/` | YouTube, Circle, Udemy, Coursera and the generic member-area reader |
| `src/popup/`, `src/options/` | Popup and settings page |
| `src/lib/` | Shared helpers: validation, protocol parsing, keys, settings, sites, i18n |
| `_locales/en/` | Every UI string |
| `keys/dev-public-key.txt` | The dev build's public key (no private key is kept or needed) |
| `store/` | The privacy policy (packaged as `privacy.html`), the publisher contact (empty here) and the store ids |

The protocol types come from `src/shared/types/extension-protocol.ts` (frozen; compiled into both sides).

## Load the dev build

`chrome://extensions` (or `edge://extensions`) → Developer mode → Load unpacked → `extension/dist/dev`. Its id is printed by the build and stays the same on every machine.
