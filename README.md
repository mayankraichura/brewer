# Brewer UI

Static web page for the V60 Brewer rig. It talks to the Brewer (ESP32-C3, K probe) and to the BrewScale over
Web Bluetooth. It replaces the page that the Brewer firmware serves over Wi-Fi (`include/page.h` in the Brewer project).
Decision and plan: `handoff/requests.md` R-014 and R-016 in the project folder (outside this repo).

**Status: skeleton.** Working now: two connect buttons, battery slots, `?demo`, offline cache, three transports, tests.
Not moved yet from the old page: chart, scaled view, reference curve, pour chips, kettle dialog, calibration.

## Run and test
    cd brewerui
    python3 -m http.server 8123       # then open http://localhost:8123/?demo
    node test.js                      # decoders, fake GATT server, fake WebSocket, page wiring

`localhost` counts as a secure context, so Web Bluetooth and the service worker work there. On GitHub Pages the page
is served over https. No build step, no libraries, no CDN.

## Buttons and modes
- **Connect to Brewer**: Bluetooth, protocol C3 (the Brewer is a proxy for the scale). Needs the C3 firmware (R-015 spike).
- **Connect to scale**: Bluetooth, contract C1. Works only when the Brewer is off or has released the scale
  (`ScaleRelease`): the scale accepts one connection. The page writes only `t` (tare) to the scale.
- `?demo`: simulated 3 minute brew, no hardware.
- `?ws=<host>`: the current Wi-Fi protocol (WebSocket), for the transition. Works only when the page is opened from
  `http://` (a page on https cannot open `ws://`). Do not put an IP address in the repo.

## Files
| File | Purpose |
|---|---|
| `index.html` | page (look of the Weight Logger: same colours, dark and light) |
| `core.js` | decoders and transports (`window.BU`, also `require` in Node) |
| `sw.js` | service worker: cache first. Change `CACHE` in it when a file changes |
| `manifest.webmanifest`, `icon.svg` | install as app |
| `test.js` | `node test.js` |

## Transports (same events: `live`, `battery`, `status`, `reply`; same methods: `connect`, `disconnect`, `send`)
- `DemoTransport`, `WsTransport` (old protocol), `BleBrewerTransport` (C3 **draft v0.1**), `BleScaleTransport` (C1).
- C3 is a draft: UUIDs and the 17-byte live packet in `core.js` follow `handoff/C3-draft.md`. They change only with
  the contract. The golden bytes in `test.js` must also go into `handoff/c3-vectors.md`.
- The Brewer's battery is optional (standard service 0x180F): the slot stays empty when the service is missing.

## Browser support
| Platform | Works? |
|---|---|
| Chrome / Edge on Windows, macOS, Linux, ChromeOS | yes |
| Chrome on Android | yes |
| iPhone / iPad | only in the **Bluefy** browser (Safari and Chrome on iOS have no Web Bluetooth) |
| Firefox | no |

## Rules
Public repo: no secrets, no passwords, no IP addresses. Pairing (passkey for write commands) is a firmware matter
(C3 draft, "Security"); the page only needs the browser's own pairing prompt.
