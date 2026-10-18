# saltaR

**SALTA recording** — a browser client for collecting audio, video, device
acceleration and MIDI, then uploading the take into a SALTA project.

The client is static HTML, CSS and JavaScript. It runs on GitHub Pages without a
build step or a separate client backend. Its API lives in
[SALTA-Container](https://github.com/AdrianArtacho/SALTA-Container).

## Record a take

1. Open saltaR and enter your SALTA server's HTTPS address.
2. Create a device token under **API tokens** in SALTA, paste it into saltaR, and
   connect. The token stays in page memory and is not included in local drafts.
3. Choose or create a project. Select the capture sources and prepare devices.
4. Record, stop, and review the take. Download a backup if you want an independent
   copy, then upload explicitly. Keep the page open while uploading.
5. Watch each stream's status. Open processed audio/video results in SALTA, or
   download original streams from the project's recording history.

Completed takes are saved in this browser's IndexedDB when storage is available.
A failed upload keeps the draft for retry. `.saltar` backups contain the manifest
and original bytes and can be restored in the recorder. Browser storage can be
cleared or evicted; keep a downloaded backup for recordings you need to retain.
In-progress recording is not crash-safe. The first version stops after five
minutes or a 64 MiB capture threshold, and stores at most ten drafts within a 128 MiB local budget. Browser
chunk buffering can exceed the threshold before a stop event arrives.

## Capture support

| Source | Browser behavior | SALTA behavior |
| --- | --- | --- |
| Microphone | Requests permission; chooses a supported MediaRecorder format. | Audio extraction and existing segmentation pipeline. |
| Camera | Records video with its microphone audio track. | Existing video/audio pipeline using a normalized working copy. |
| Acceleration | Requires actual motion events; some phones request a separate permission. Many laptops provide no sensor data. | Validated raw JSON stored for download; no segmentation yet. |
| MIDI | Requires Web MIDI, a selected input and permission. Support varies by browser/device; SysEx is excluded. | Validated raw MIDI events stored for download; no segmentation yet. |

The recorder checks capabilities at runtime. Safari/iOS does not currently
provide Web MIDI; use a supported browser/device for that source. HTTPS is needed
for device APIs, apart from localhost development. Keep the page visible and the
device unlocked: backgrounding and screen lock can interrupt capture. A take
records interruptions and approximate stream offsets; these are not hardware
synchronization or a guarantee of continuous recording. SALTA retains offsets as
metadata; apply alignment explicitly when combining processed bundles.

Camera mode includes the microphone; audio stays in the video container. The client does not simultaneously
request a second microphone recording of the same track. Missing sensor axes stay
null and irregular timestamps are preserved. Musical MIDI is kept separate from
SALTA's older sensor-specific MIDI interpretation.

## Publish on GitHub Pages

The repository entry point is `index.html`; all assets use relative paths for the
`/saltaR/` project prefix. In **Settings → Pages**, choose **Deploy from a branch**,
branch **main**, folder **/ (root)**. The intended address is
`https://muk-labs.github.io/saltaR/`. Publishing requires that repository setting;
pushing the source alone does not prove the site is live.

Configure SALTA with:

```dotenv
SALTA_API_ALLOWED_ORIGINS=https://muk-labs.github.io
```

An origin has no `/saltaR/` path or trailing slash. Other repositories on that
GitHub Pages host share its origin, so bearer authorization is still essential.
The recorder only sends credentials to the SALTA origin explicitly entered by
the user and omits cookies. JSON/download requests reject redirects; upload
responses are checked against the selected origin. No token belongs in a URL, source
file, saved backup or GitHub secret used to build this public page.

The SALTA server must be reachable over HTTPS from the recording device. The mdw
F5/public-hostname setup is a separate deployment step; a private VM accessible
only through a Mac's SSH tunnel is not yet a phone-accessible API.

## Development and server deployment

Serve this directory locally:

```bash
python3 -m http.server 8001 --bind 127.0.0.1
```

Open `http://localhost:8001`. HTTP API addresses are accepted only for localhost
or loopback. For an existing SSH tunnel to SALTA on `http://localhost:8080`, allow
`http://localhost:8001` in the server's CORS setting. This tests the Mac, not a phone
on the same Wi-Fi.

- [SALTA deployment guide](https://github.com/AdrianArtacho/SALTA-Container/blob/main/docs/recording-api.md)
- [API v1 contract](https://github.com/AdrianArtacho/SALTA-Container/blob/main/docs/recording-api-v1.md)

Original capture downloads are owner-authenticated. Derived previews/results use
SALTA's existing media access policy; its supplied Nginx configuration currently
serves `/media/` without an authorization check. Review that deployment policy
before recording data that needs restricted access throughout processing.

The browser runtime has no third-party dependencies. Install the development-only
DOM test dependency, then run the tests with Node 22.22.2+, 24.15.0+, or 26+:

```bash
npm install
npm test
```

Tests use simulated browser devices and requests. They do not substitute for
real camera/microphone, motion, MIDI, mobile permission and end-to-end deployment
checks. Uploads are sequential whole-file transfers with progress and safe retry,
not resumable chunk uploads or guaranteed background transfers. Audio/video
extraction still depends on SALTA's deployed workers and codec support.

Developed for SALTA with Adrián Artacho.
