# Ground Circle Motion Detector (Web App)

A browser-based computer vision web application built with vanilla HTML, CSS, and modern JavaScript (ES modules). It performs real-time motion detection within an adjustable circular ground zone, runs 100% on-device with zero server or cloud dependencies, and triggers synthesized audio or fullscreen video alerts.

---

## 1. Project Overview & Folder Tree

```text
cam_motion_detector/
├── index.html           # Semantic HTML5 UI, video viewport, masking & video overlay
├── styles.css           # Modern dark-mode styling, glassmorphism, fullscreen monitor layout
├── app.js               # Application coordinator, camera lifecycle, and coordinate mapping
├── motion-detector.js   # Pure, DOM-free computer vision and motion detection engine
├── audio-alert.js       # Synthesized Web Audio API alert engine with single-voice policy
├── video-player.js      # Fullscreen video alert controller with autoplay unlocking & IndexedDB
├── assets/              # Directory for alert video assets (assets/alert-video.mp4)
└── README.md            # Complete project documentation and guide
```

---

## 2. Architecture & File Overview

### `index.html`
- **Semantic structure**: Accessibility landmarks (`<header>`, `<main>`, `<section>`, `<aside>`).
- **Live status badge**: Displays system states (`Camera Off`, `Calibrating`, `Monitoring`, `Motion Detected`, `Resuming`, `Paused`) using ARIA live regions (`aria-live="polite"`).
- **Interactive canvas overlay**: Layered over the native video element with strict `object-fit: contain` geometry and outside area masking.
- **Fullscreen Monitor View UI**: Minimal in-view status pill, floating Stop button ($\ge 48\text{px}$ touch target), and quick-actions bar (Stop, Recalibrate, Mute).
- **Fullscreen Video Player Overlay**: High z-index dialog container with video element, Skip button (appears after 2s), and fallback "Tap for Sound" unmuting button.
- **Controls**: Primary toggles, mask appearance settings (color picker + opacity slider), video alert settings (toggle, audio toggle, custom file picker, reset, test), sensitivity presets, audio controls, and collapsible advanced vision parameters.
- **Debug HUD**: Real-time analysis viewport displaying the difference mask, changed area percentage, largest blob size, processing time in ms, and current FPS.

### `styles.css`
- **Mobile-First Design**: Minimum touch targets $\ge 48\text{px}$, thumb-reachable action bar.
- **Fullscreen Monitor View (`.monitor-view-active`)**: Automatically expands the video container to $100\text{dvh} \times 100\text{dvw}$ with `position: fixed`, respecting safe-area insets and hiding background controls.
- **Outside Area Mask**: Purely visual solid or semi-transparent mask with transparent circular cutout.
- **Accessibility & Motion**: WCAG AA color contrast ratios and `@media (prefers-reduced-motion: reduce)` support.

### `app.js`
- **Coordinate Mapping**: Normalizes circle coordinates ($cx, cy, r \in [0, 1]$) relative to intrinsic video dimensions, correctly handling letterboxing and pillarboxing.
- **Visual Masking**: Uses Canvas 2D `evenodd` fill rule to cleanly render solid or semi-transparent masks outside the circle while keeping the interior transparent.
- **Monitor View Flow**: Automatically transitions to immersive monitor view when calibration finishes; locks circle dragging during monitoring.
- **Video Alert Integration**: Pauses vision analysis on motion, plays fullscreen video from start, and runs a short recalibration (~8 frames) on video end or skip before resuming monitoring.
- **Camera Lifecycle & Wake Lock**: Progressive `getUserMedia` fallback chain with wake locks and automatic pause/resume on tab interruption.
- **Demo Mode**: Built-in procedural ground and moving target generator for desktop development and automated testing without a webcam.

### `motion-detector.js`
- **Zero DOM Dependencies**: Pure computational engine suitable for Web Workers or unit testing.
- **Extended State Machine**: `IDLE` $\to$ `CALIBRATING` $\to$ `MONITORING` $\to$ `CANDIDATE` $\to$ `ALERTING` $\to$ `RESUMING` $\to$ `COOLDOWN` $\to$ `SUPPRESSED`.
- **Lighting Robustness**: Centers luminance around mean brightness to reject uniform ambient illumination changes.
- **Two-Tier Background Model**: Combines running average background differencing ($\alpha \approx 0.04$) with previous-frame delta checks.
- **Global Change Guard**: Analyzes outer guard samples to detect camera bumps or light switches, suppressing false alerts for 1.5 seconds.
- **Buffer Reuse**: Pre-allocated typed arrays (`Uint8Array`, `Float32Array`, `Int32Array`) to prevent garbage collection pauses.

### `video-player.js`
- **Autoplay Unlocking**: Synchronously primes video playback during the user's "Start Monitoring" tap to comply with iOS Safari and Android Chrome policies.
- **Muted Retry**: Automatically retries muted with a "Tap for Sound" overlay if unmuted playback is rejected.
- **Skip Button**: Unlocks after 2 seconds to allow early exit.
- **IndexedDB Persistence**: Stores custom uploaded video files in local browser IndexedDB across page reloads.

### `audio-alert.js`
- **Web Audio API**: 100% synthesized sound output without external audio files.
- **Single-Voice Policy**: Enforces playback cooldown locks to eliminate sound overlapping and audio distortion.

---

## 3. How to Replace the Bundled Video & Supported Formats

### Recommended Video Formats:
- **Container**: MP4 (`.mp4`)
- **Video Codec**: H.264 (AVC) Baseline or Main Profile, Level 3.1
- **Audio Codec**: AAC-LC (Stereo or Mono, 44.1 kHz / 48 kHz, 128 kbps)
- **Pixel Format**: YUV 4:2:0 (`yuv420p`)
- **Why?**: H.264 + AAC in an MP4 container has 100% universal hardware playback support across all versions of iOS Safari, Android Chrome, macOS Safari, Windows, and Linux.

### Replacing the Default Video:
1. Copy your MP4 file to the `assets/` directory and name it `alert-video.mp4`:
   ```bash
   cp /path/to/your/video.mp4 assets/alert-video.mp4
   ```
2. Or use the in-app **"Custom Video Source" file picker** in the settings panel to choose any video file directly from your phone or computer. The chosen video is saved to IndexedDB and persists across browser refreshes!

---

## 4. Technical Notes on iOS Safari & Browser Autoplay

1. **iOS Safari Fullscreen API Limits**:
   - On iPhones, Apple does not allow arbitrary DOM elements to enter native fullscreen via `Element.requestFullscreen()`.
   - The application handles this gracefully by detecting support and seamlessly falling back to a **CSS fixed full-viewport layout (`100dvh` / `100dvw`, `position: fixed; inset: 0; z-index: 100;`)**. This provides the identical immersive experience without throwing errors.
2. **Autoplay Unlocking Policy**:
   - Modern browsers forbid unmuted video playback unless triggered directly by a user gesture.
   - When the user taps **"Start Monitoring"**, the application synchronously calls `alertVideo.play()` and immediately pauses it. This marks the media element as user-activated, enabling subsequent programmatic playback with audio when motion is detected.
   - If an operating system policy still restricts audio, the player falls back to muted playback and displays a prominent **"🔊 Tap for Sound"** button.
3. **Esc Key & Fullscreen Exit**:
   - If the user leaves native fullscreen on desktop via the `Esc` key or gesture, the app detects `fullscreenchange` and keeps monitoring active while restoring the controls panel.

---

## 5. How to Run Locally and Test on a Real Phone

Browsers require a **Secure Context (`HTTPS` or `localhost`)** for camera access:

### A. Local Desktop Testing
```bash
python3 -m http.server 8080
```
Open `http://localhost:8080/index.html`. You can click **Demo Mode** to test the entire detector and video playback without needing a webcam.

### B. Testing on a Mobile Device over HTTPS

#### Option 1: Cloudflare Tunnel (Free & Fast)
```bash
cloudflared tunnel --url http://localhost:8080
```
Open the generated `https://<unique-name>.trycloudflare.com` URL on your phone.

#### Option 2: ngrok Tunnel
```bash
ngrok http 8080
```
Open the generated `https://xxxx.ngrok-free.app` URL on your phone.

#### Option 3: GitHub Pages
Push this repository to GitHub and enable GitHub Pages under **Repository Settings > Pages**.

---

## 6. Acceptance Criteria Verification

| # | Acceptance Criterion | Status | Implementation Details |
|---|----------------------|:------:|------------------------|
| **1** | Fullscreen view with hidden controls when calibration completes | ✅ **Passed** | Automatically activates `.monitor-view-active` CSS fullscreen + Fullscreen API request upon reaching `MONITORING`. |
| **2** | Outside area is black by default, color picker changes it live, circle interior stays clear | ✅ **Passed** | Implemented on `overlayCanvas` via Canvas 2D `evenodd` fill rule; color and opacity update live. |
| **3** | Detection results identical with mask on/off (never affects analyzed pixels) | ✅ **Passed** | Visual mask exists exclusively on display overlay canvas; detection pipeline extracts raw camera pixels. |
| **4** | Motion starts fullscreen video within ~500 ms; plays once from start | ✅ **Passed** | Pauses vision loop, resets `currentTime = 0`, and displays fullscreen video overlay immediately on `ALERTING`. |
| **5** | After video ends or is skipped, app returns to monitor view and recalibrates | ✅ **Passed** | `onVideoAlertComplete` returns to monitor view and triggers ~8-frame recalibration (`RESUMING`) to absorb screen light shift. |
| **6** | Motion during video or post-video recalibration is ignored | ✅ **Passed** | Vision loop is stopped while video is active; state machine remains in `RESUMING` until background is stable. |
| **7** | Rejected autoplay or missing video never crashes/freezes app; falls back to sound | ✅ **Passed** | Rejection caught in `playAlertVideo()`; retries muted or invokes `onError`, gracefully falling back to synthesized sound alert. |
| **8** | Stop Monitoring from any state restores normal UI and releases all resources | ✅ **Passed** | `stopMonitoring()` closes video player, exits monitor view, releases wake lock, and restores controls. |
