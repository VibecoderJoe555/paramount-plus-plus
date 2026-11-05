# Paramount++

A small Firefox extension that forces Paramount+ to play at your chosen quality
instead of the soft 540p ladder its web player defaults to.

Local build. No telemetry, no analytics, no remote code, no network requests of
its own.

## Why the player picks 540p

Paramount ships two video ladders in one DASH manifest:

| Set | Codec | Heights |
| --- | --- | --- |
| HD | `avc3` | 1080, 720 |
| SD | `avc1` | 540, 432, 360, 234 |

The player only accepts `avc1`, so it drops the HD set and plays the SD ladder.
Each set also declares its own `cenc:default_KID`, i.e. its own content key.

This extension keeps only the representations at your chosen height and removes
the sets that end up empty, so the player has nothing but the target to play.

Forcing HD usually fails once with **error 2103** because the licence for the HD
key is not granted on the ad-inserted stream. `failover.js` catches exactly that
failure and reloads the title through the player's own SDK using the alternate
CMS source, where the key *is* granted, then restores your position.

## Quality

Two modes in the popup, plus an on/off switch:

- **720p** — highest rung at or below 720p
- **1080p** — highest rung at or below 1080p (default)

If a title has no rung at the requested height, the highest available one is used
rather than leaving you with nothing.

## Install

Temporary (until Firefox closes):

1. Open `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…**
3. Pick `manifest.json` in this folder

Permanent (sign it yourself, nothing is published):

1. Zip the folder contents, `manifest.json` at the root
2. <https://addons.mozilla.org/developers/addon/submit/> → **On your own** → **unlisted**
3. Drag the signed `.xpi` into Firefox

An unlisted signature is a stamp, not a listing — nobody can download it or push
updates to you.

## What you will notice

- A **2103 flash and a short reload** when playback starts. That is the failover
  working: HD is requested, the key is refused, the source is swapped, playback
  resumes where you left off.
- If the alternate source also refuses the key, the page reloads once with the
  extension off and you get normal playback. Untick **Force highest quality** for
  that title.
- The popup shows the real decoded resolution, so you can confirm 1080p rather
  than trusting how it looks.

## Limits

- **1080p is the ceiling on desktop.** Paramount caps the web player there;
  4K needs a supported TV device.
- Live channels and some catalog titles top out lower. The popup will show what
  you actually got.
- The failover depends on the site's Smart Tag SDK. If it changes, recovery
  declines quietly and you are back to default quality — it will not break
  playback.

## How this was built

Fully vibe-coded: designed and written end to end with an AI coding agent, guided
by console logs and diagnostics captured from a real Paramount+ session. There is
no build step and no minification — the files shipped are the source, readable as-is.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest, `storage` + `paramountplus.com` only |
| `page.js` | Manifest rewriting in the page's main world |
| `failover.js` | Missing-key detection and source failover |
| `content.js` | Injects the engine, relays config/status |
| `popup.html` / `popup.js` | Toggle, quality selector, live status |

## Permissions

- `storage` — remembers the toggle and quality mode.
- `*://*.paramountplus.com/*` — the only site it can touch.

No `tabs`, `cookies`, `webRequest`, `scripting`, or `<all_urls>`.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 the Paramount++ contributors.

Not affiliated with, endorsed by, or supported by Paramount. All trademarks belong
to their respective owners.

