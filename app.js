/**
 * app.js
 * 
 * Main Application Controller for Ground Motion Detector.
 * Manages Camera Lifecycle, Coordinate Mapping, Detection Loop, Fullscreen Monitor View,
 * Outside Area Masking, Video Player Integration, and Demo Mode.
 */

import { MotionDetector, EngineState, SENSITIVITY_PRESETS } from './motion-detector.js';
import { AudioAlert } from './audio-alert.js';
import { VideoAlertPlayer } from './video-player.js';

// Application State
const state = {
  isCameraActive: false,
  isMonitoring: false,
  isPaused: false,
  isDemoMode: false,
  isMonitorView: false,
  stream: null,
  activeDeviceId: null,
  availableVideoDevices: [],
  wakeLock: null,
  debugEnabled: false,
  sampleIntervalMs: 150,

  // Feature 1: Outside Mask Configuration
  maskColor: '#000000',
  maskOpacity: 1.0, // 0.0 to 1.0

  // Feature 2: Video Alert Configuration
  isVideoOnMotion: true,
  isVideoAudio: true,
  isVideoPlaying: false,

  // Zone coordinates: NORMALIZED (0.0 to 1.0) relative to intrinsic video dimensions
  // r is normalized to Math.min(videoWidth, videoHeight)
  zone: {
    cx: 0.5,
    cy: 0.5,
    r: 0.20
  },

  // Active sensitivity preset name: 'low' | 'medium' | 'high' | 'custom'
  activePreset: 'medium',

  // Animation and loop handlers
  rafLoopId: null,
  rvfcHandle: null,
  lastProcessTimestamp: 0,
  lastFpsTimestamp: 0,
  frameCount: 0,
  currentFps: 0,

  // Pointer drag and pinch tracking
  activePointers: new Map(),
  dragStartZone: null,
  initialPinchDist: 0,
  initialPinchRadius: 0,

  // Monitor view quick bar auto-hide timer
  quickBarTimer: null
};

// Sub-modules
const detector = new MotionDetector();
const audioAlert = new AudioAlert();
let videoPlayer = null;

// DOM Element References
const dom = {
  // Layout Root
  appLayout: document.getElementById('appLayout'),
  appHeader: document.getElementById('appHeader'),
  noticeBar: document.getElementById('noticeBar'),
  controlsPanel: document.getElementById('controlsPanel'),

  // Video and Canvases
  cameraFeed: document.getElementById('cameraFeed'),
  demoCanvas: document.getElementById('demoCanvas'),
  overlayCanvas: document.getElementById('overlayCanvas'),
  videoContainer: document.getElementById('videoContainer'),
  emptyCameraState: document.getElementById('emptyCameraState'),
  zoneHelperPill: document.getElementById('zoneHelperPill'),

  // Monitor View Minimal In-View UI (Toggled on tap)
  monitorQuickBar: document.getElementById('monitorQuickBar'),
  btnQuickStop: document.getElementById('btnQuickStop'),
  btnQuickRecalibrate: document.getElementById('btnQuickRecalibrate'),
  btnQuickMute: document.getElementById('btnQuickMute'),

  // Video Player Elements
  alertVideoOverlay: document.getElementById('alertVideoOverlay'),
  alertVideo: document.getElementById('alertVideo'),
  btnSkipVideo: document.getElementById('btnSkipVideo'),
  btnUnmuteVideo: document.getElementById('btnUnmuteVideo'),

  // Processing Canvases (Offscreen)
  processingCanvas: document.getElementById('processingCanvas'),
  guardCanvas: document.getElementById('guardCanvas'),

  // Debug HUD
  debugHud: document.getElementById('debugHud'),
  debugMaskCanvas: document.getElementById('debugMaskCanvas'),
  debugFpsBadge: document.getElementById('debugFpsBadge'),
  debugChangedVal: document.getElementById('debugChangedVal'),
  debugBlobVal: document.getElementById('debugBlobVal'),
  debugTimeVal: document.getElementById('debugTimeVal'),
  debugStateVal: document.getElementById('debugStateVal'),

  // Header & Status
  statusBadge: document.getElementById('statusBadge'),
  statusIcon: document.getElementById('statusIcon'),
  statusText: document.getElementById('statusText'),
  alertBanner: document.getElementById('alertBanner'),
  alertTimestamp: document.getElementById('alertTimestamp'),

  // Primary Action Buttons
  btnToggleCamera: document.getElementById('btnToggleCamera'),
  labelToggleCamera: document.getElementById('labelToggleCamera'),
  btnToggleMonitoring: document.getElementById('btnToggleMonitoring'),
  labelToggleMonitoring: document.getElementById('labelToggleMonitoring'),
  btnSwitchCamera: document.getElementById('btnSwitchCamera'),
  btnDemoMode: document.getElementById('btnDemoMode'),
  labelDemoMode: document.getElementById('labelDemoMode'),
  emptyStartBtn: document.getElementById('emptyStartBtn'),
  emptyDemoBtn: document.getElementById('emptyDemoBtn'),

  // Zone Controls
  btnRecalibrate: document.getElementById('btnRecalibrate'),
  btnResetZone: document.getElementById('btnResetZone'),
  circleRadiusSlider: document.getElementById('circleRadiusSlider'),
  circleRadiusVal: document.getElementById('circleRadiusVal'),

  // Feature 1: Mask Controls
  maskColorPicker: document.getElementById('maskColorPicker'),
  maskColorHex: document.getElementById('maskColorHex'),
  maskOpacitySlider: document.getElementById('maskOpacitySlider'),
  maskOpacityVal: document.getElementById('maskOpacityVal'),
  btnResetMask: document.getElementById('btnResetMask'),

  // Feature 2: Video Alert Settings
  videoOnMotionToggle: document.getElementById('videoOnMotionToggle'),
  videoAudioToggle: document.getElementById('videoAudioToggle'),
  videoFileInput: document.getElementById('videoFileInput'),
  btnResetVideo: document.getElementById('btnResetVideo'),
  videoSourceLabel: document.getElementById('videoSourceLabel'),
  btnTestVideo: document.getElementById('btnTestVideo'),

  // Preset Controls
  presetButtons: {
    low: document.getElementById('presetLow'),
    medium: document.getElementById('presetMedium'),
    high: document.getElementById('presetHigh')
  },
  customPresetBadge: document.getElementById('customPresetBadge'),

  // Audio Controls
  soundTypeSelect: document.getElementById('soundTypeSelect'),
  volumeSlider: document.getElementById('volumeSlider'),
  volumeVal: document.getElementById('volumeVal'),
  muteToggle: document.getElementById('muteToggle'),
  vibrateToggle: document.getElementById('vibrateToggle'),
  vibrationRow: document.getElementById('vibrationRow'),
  btnTestSound: document.getElementById('btnTestSound'),

  // Advanced Tuning Sliders
  pixelThresholdSlider: document.getElementById('pixelThresholdSlider'),
  pixelThresholdVal: document.getElementById('pixelThresholdVal'),
  areaThresholdSlider: document.getElementById('areaThresholdSlider'),
  areaThresholdVal: document.getElementById('areaThresholdVal'),
  sampleIntervalSlider: document.getElementById('sampleIntervalSlider'),
  sampleIntervalVal: document.getElementById('sampleIntervalVal'),
  confirmFramesSlider: document.getElementById('confirmFramesSlider'),
  confirmFramesVal: document.getElementById('confirmFramesVal'),
  cooldownSlider: document.getElementById('cooldownSlider'),
  cooldownVal: document.getElementById('cooldownVal'),
  debugToggle: document.getElementById('debugToggle'),

  // Toast Container
  toastContainer: document.getElementById('toastContainer')
};

// Canvas 2D Contexts with willReadFrequently optimization
const overlayCtx = dom.overlayCanvas.getContext('2d');
const procCtx = dom.processingCanvas.getContext('2d', { willReadFrequently: true });
const guardCtx = dom.guardCanvas.getContext('2d', { willReadFrequently: true });
const debugMaskCtx = dom.debugMaskCanvas.getContext('2d');
const demoCtx = dom.demoCanvas.getContext('2d');

// Image data cache for debug mask rendering
let debugImageData = null;

// Demo Mode Animation State
let demoAnim = {
  x: 0.1,
  y: 0.5,
  vx: 0.003,
  vy: 0.002,
  size: 0.12,
  groundNoisePattern: null
};

/* =========================================================================
   1. Coordinate Mapping & Visual Masking Pipeline
   ========================================================================= */

/**
 * Calculates the exact rendered video rectangle inside the container,
 * accounting for `object-fit: contain` letterboxing / pillarboxing.
 */
function getVideoRenderRect() {
  const containerW = dom.videoContainer.clientWidth;
  const containerH = dom.videoContainer.clientHeight;

  let intrinsicW = 1280;
  let intrinsicH = 720;

  if (state.isDemoMode) {
    intrinsicW = 1280;
    intrinsicH = 720;
  } else if (dom.cameraFeed.videoWidth && dom.cameraFeed.videoHeight) {
    intrinsicW = dom.cameraFeed.videoWidth;
    intrinsicH = dom.cameraFeed.videoHeight;
  }

  const containerAspect = containerW / (containerH || 1);
  const videoAspect = intrinsicW / (intrinsicH || 1);

  let renderW, renderH, offsetX, offsetY;

  if (containerAspect > videoAspect) {
    // Pillarboxed (black bars on left and right)
    renderH = containerH;
    renderW = containerH * videoAspect;
    offsetX = (containerW - renderW) / 2;
    offsetY = 0;
  } else {
    // Letterboxed (black bars on top and bottom)
    renderW = containerW;
    renderH = containerW / videoAspect;
    offsetX = 0;
    offsetY = (containerH - renderH) / 2;
  }

  return {
    left: offsetX,
    top: offsetY,
    width: renderW,
    height: renderH,
    containerW,
    containerH,
    intrinsicW,
    intrinsicH,
    minDim: Math.min(renderW, renderH)
  };
}

/**
 * Resize and scale the overlay canvas to match physical display pixels.
 */
function resizeOverlayCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = dom.videoContainer.getBoundingClientRect();
  const w = Math.round(rect.width);
  const h = Math.round(rect.height);

  if (dom.overlayCanvas.width !== w * dpr || dom.overlayCanvas.height !== h * dpr) {
    dom.overlayCanvas.width = w * dpr;
    dom.overlayCanvas.height = h * dpr;
    dom.overlayCanvas.style.width = `${w}px`;
    dom.overlayCanvas.style.height = `${h}px`;
    overlayCtx.scale(dpr, dpr);
  }
}

/**
 * Clamp normalized circle so it never leaves the video boundary.
 */
function clampZoneCoordinates() {
  const rect = getVideoRenderRect();
  const minDim = Math.min(rect.intrinsicW, rect.intrinsicH);
  const rPixels = state.zone.r * minDim;

  const rNormX = rPixels / rect.intrinsicW;
  const rNormY = rPixels / rect.intrinsicH;

  // Clamp radius
  state.zone.r = Math.max(0.08, Math.min(0.42, state.zone.r));

  // Clamp center
  state.zone.cx = Math.max(rNormX, Math.min(1 - rNormX, state.zone.cx));
  state.zone.cy = Math.max(rNormY, Math.min(1 - rNormY, state.zone.cy));

  // Update radius slider UI
  const radiusPct = Math.round(state.zone.r * 100);
  dom.circleRadiusSlider.value = radiusPct;
  dom.circleRadiusVal.textContent = `${radiusPct}%`;
}

/**
 * Convert Hex Color and Opacity to CSS RGBA string.
 */
function hexToRgba(hex, opacity) {
  let cleanHex = hex.replace('#', '');
  if (cleanHex.length === 3) {
    cleanHex = cleanHex.split('').map((c) => c + c).join('');
  }
  const num = parseInt(cleanHex, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

/**
 * Render the interactive circular zone overlay AND Feature 1 Outside Area Mask.
 * Uses canvas even-odd fill rule to cut out the circle interior cleanly.
 */
function drawOverlay(engineStatus = detector.state, changedPercent = 0) {
  const rect = getVideoRenderRect();
  const dpr = window.devicePixelRatio || 1;

  overlayCtx.save();
  overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
  overlayCtx.clearRect(0, 0, dom.overlayCanvas.width, dom.overlayCanvas.height);
  overlayCtx.scale(dpr, dpr);

  if (!state.isCameraActive && !state.isDemoMode) {
    overlayCtx.restore();
    return;
  }

  // Calculate pixel position of zone
  const screenCx = rect.left + state.zone.cx * rect.width;
  const screenCy = rect.top + state.zone.cy * rect.height;
  const screenR = state.zone.r * rect.minDim;

  // -------------------------------------------------------------
  // Feature 1: Solid Outside Masking with transparent circle hole
  // -------------------------------------------------------------
  if (state.maskOpacity > 0) {
    overlayCtx.save();
    overlayCtx.beginPath();
    // Outer canvas boundary
    overlayCtx.rect(0, 0, rect.containerW, rect.containerH);
    // Inner circular hole cutout (counter-clockwise)
    overlayCtx.arc(screenCx, screenCy, Math.max(0, screenR), 0, Math.PI * 2, true);
    overlayCtx.fillStyle = hexToRgba(state.maskColor, state.maskOpacity);
    overlayCtx.fill('evenodd');
    overlayCtx.restore();
  }

  // Determine stroke color and theme based on engine state
  let strokeColor = '#06b6d4'; // Cyan default (Idle)
  let fillColor = 'rgba(6, 182, 212, 0.04)';
  let glowColor = 'rgba(6, 182, 212, 0.3)';

  if (state.isMonitoring) {
    if (engineStatus === EngineState.ALERTING || state.isVideoPlaying) {
      strokeColor = '#ef4444'; // Crimson (Motion Detected / Video Playing)
      fillColor = 'rgba(239, 68, 68, 0.22)';
      glowColor = 'rgba(239, 68, 68, 0.7)';
    } else if (engineStatus === EngineState.CALIBRATING || engineStatus === EngineState.RESUMING) {
      strokeColor = '#f59e0b'; // Amber (Calibrating / Resuming)
      fillColor = 'rgba(245, 158, 11, 0.08)';
      glowColor = 'rgba(245, 158, 11, 0.4)';
    } else if (engineStatus === EngineState.SUPPRESSED) {
      strokeColor = '#f97316'; // Orange (Suppressed / Bump)
      fillColor = 'rgba(249, 115, 22, 0.12)';
      glowColor = 'rgba(249, 115, 22, 0.5)';
    } else {
      strokeColor = '#10b981'; // Emerald (Monitoring active)
      fillColor = 'rgba(16, 185, 129, 0.06)';
      glowColor = 'rgba(16, 185, 129, 0.4)';
    }
  }

  // 1. Outer Glow / Ripple if alerting
  if (engineStatus === EngineState.ALERTING || state.isVideoPlaying) {
    const pulseRadius = screenR + Math.sin(performance.now() * 0.01) * 6;
    overlayCtx.beginPath();
    overlayCtx.arc(screenCx, screenCy, Math.max(1, pulseRadius), 0, Math.PI * 2);
    overlayCtx.strokeStyle = 'rgba(239, 68, 68, 0.4)';
    overlayCtx.lineWidth = 3;
    overlayCtx.stroke();
  }

  // 2. Main Circle Fill and Stroke
  overlayCtx.beginPath();
  overlayCtx.arc(screenCx, screenCy, screenR, 0, Math.PI * 2);
  overlayCtx.fillStyle = fillColor;
  overlayCtx.fill();

  overlayCtx.shadowColor = glowColor;
  overlayCtx.shadowBlur = (engineStatus === EngineState.ALERTING || state.isVideoPlaying) ? 20 : 10;
  overlayCtx.strokeStyle = strokeColor;
  overlayCtx.lineWidth = 2.5;

  if (engineStatus === EngineState.CALIBRATING || engineStatus === EngineState.RESUMING) {
    overlayCtx.setLineDash([8, 6]);
    overlayCtx.lineDashOffset = -performance.now() * 0.02;
  } else {
    overlayCtx.setLineDash([]);
  }
  overlayCtx.stroke();
  overlayCtx.shadowBlur = 0; // Reset shadow

  // 3. Center Crosshair Anchor (Only visible in normal setup view, hidden in monitor view for immersion)
  if (!state.isMonitorView) {
    overlayCtx.beginPath();
    const chLen = 7;
    overlayCtx.moveTo(screenCx - chLen, screenCy);
    overlayCtx.lineTo(screenCx + chLen, screenCy);
    overlayCtx.moveTo(screenCx, screenCy - chLen);
    overlayCtx.lineTo(screenCx, screenCy + chLen);
    overlayCtx.strokeStyle = strokeColor;
    overlayCtx.lineWidth = 1.5;
    overlayCtx.setLineDash([]);
    overlayCtx.stroke();

    // 4. Radius Resize Handle at Right Edge (3 o'clock)
    const handleX = screenCx + screenR;
    const handleY = screenCy;
    overlayCtx.beginPath();
    overlayCtx.arc(handleX, handleY, 6, 0, Math.PI * 2);
    overlayCtx.fillStyle = '#ffffff';
    overlayCtx.fill();
    overlayCtx.strokeStyle = strokeColor;
    overlayCtx.lineWidth = 2;
    overlayCtx.stroke();
  }

  // 5. Zone Label Pill (In normal view)
  if (!state.isMonitorView) {
    let labelText = 'ZONE';
    if (engineStatus === EngineState.CALIBRATING) {
      labelText = 'CALIBRATING...';
    } else if (engineStatus === EngineState.RESUMING) {
      labelText = 'RESUMING...';
    } else if (engineStatus === EngineState.ALERTING || state.isVideoPlaying) {
      labelText = `MOTION! ${changedPercent.toFixed(1)}%`;
    } else if (engineStatus === EngineState.SUPPRESSED) {
      labelText = 'STABILIZING...';
    }

    overlayCtx.font = '600 11px var(--font-sans)';
    const textWidth = overlayCtx.measureText(labelText).width;
    const badgeW = textWidth + 16;
    const badgeH = 20;
    const badgeY = screenCy - screenR - badgeH - 6;

    overlayCtx.fillStyle = 'rgba(9, 13, 22, 0.85)';
    overlayCtx.strokeStyle = strokeColor;
    overlayCtx.lineWidth = 1;
    _drawRoundedRect(overlayCtx, screenCx - badgeW / 2, badgeY, badgeW, badgeH, 10);
    overlayCtx.fill();
    overlayCtx.stroke();

    overlayCtx.fillStyle = strokeColor;
    overlayCtx.textAlign = 'center';
    overlayCtx.textBaseline = 'middle';
    overlayCtx.fillText(labelText, screenCx, badgeY + badgeH / 2);
  }

  overlayCtx.restore();
}

function _drawRoundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/* =========================================================================
   2. Pointer & Touch Interactions
   ========================================================================= */

function setupPointerInteractions() {
  const canvas = dom.overlayCanvas;

  canvas.addEventListener('pointerdown', (e) => {
    // If in monitor view: tapping toggles the quick action bar (Stop, Recalibrate, Mute)
    if (state.isMonitorView) {
      toggleMonitorQuickBar();
      return;
    }

    canvas.setPointerCapture(e.pointerId);
    state.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    const rect = getVideoRenderRect();
    const canvasBounds = canvas.getBoundingClientRect();
    const clickX = e.clientX - canvasBounds.left;
    const clickY = e.clientY - canvasBounds.top;

    const screenCx = rect.left + state.zone.cx * rect.width;
    const screenCy = rect.top + state.zone.cy * rect.height;
    const screenR = state.zone.r * rect.minDim;

    const distToCenter = Math.hypot(clickX - screenCx, clickY - screenCy);
    const isNearHandle = Math.hypot(clickX - (screenCx + screenR), clickY - screenCy) < 24;

    if (state.activePointers.size === 1) {
      state.isDragging = distToCenter <= screenR * 1.2 || isNearHandle;
      state.dragStartZone = { ...state.zone };
      state.dragStartCoord = { x: clickX, y: clickY };
      state.isResizing = isNearHandle;
    } else if (state.activePointers.size === 2) {
      const pts = Array.from(state.activePointers.values());
      state.initialPinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      state.initialPinchRadius = state.zone.r;
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (state.isMonitorView) return; // Disabled while in monitor view
    if (!state.activePointers.has(e.pointerId)) return;
    state.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    const rect = getVideoRenderRect();
    const canvasBounds = canvas.getBoundingClientRect();

    if (state.activePointers.size === 2) {
      const pts = Array.from(state.activePointers.values());
      const currentDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (state.initialPinchDist > 0) {
        const scale = currentDist / state.initialPinchDist;
        state.zone.r = state.initialPinchRadius * scale;
        clampZoneCoordinates();
        drawOverlay();
        persistSettings();
      }
      return;
    }

    if (state.isResizing) {
      const clickX = e.clientX - canvasBounds.left;
      const screenCx = rect.left + state.zone.cx * rect.width;
      const newRadiusPx = Math.abs(clickX - screenCx);
      state.zone.r = newRadiusPx / rect.minDim;
      clampZoneCoordinates();
      drawOverlay();
      persistSettings();
      return;
    }

    if (state.isDragging && state.dragStartCoord) {
      const currentX = e.clientX - canvasBounds.left;
      const currentY = e.clientY - canvasBounds.top;

      const deltaX = currentX - state.dragStartCoord.x;
      const deltaY = currentY - state.dragStartCoord.y;

      state.zone.cx = state.dragStartZone.cx + (deltaX / rect.width);
      state.zone.cy = state.dragStartZone.cy + (deltaY / rect.height);

      clampZoneCoordinates();
      drawOverlay();
      persistSettings();
    }
  });

  const onPointerUp = (e) => {
    state.activePointers.delete(e.pointerId);
    try {
      if (canvas.hasPointerCapture(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Ignore
    }

    if (state.activePointers.size === 0) {
      state.isDragging = false;
      state.isResizing = false;
      state.dragStartZone = null;
      state.dragStartCoord = null;
    } else if (state.activePointers.size === 1) {
      state.initialPinchDist = 0;
    }
  };

  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);

  // Radius slider
  dom.circleRadiusSlider.addEventListener('input', (e) => {
    state.zone.r = Number(e.target.value) / 100;
    clampZoneCoordinates();
    drawOverlay();
    persistSettings();
  });
}

function toggleMonitorQuickBar() {
  if (!state.isMonitorView) return;
  dom.monitorQuickBar.classList.remove('hidden');

  if (state.quickBarTimer) clearTimeout(state.quickBarTimer);
  state.quickBarTimer = setTimeout(() => {
    dom.monitorQuickBar.classList.add('hidden');
  }, 4000);
}

/* =========================================================================
   3. Fullscreen & Monitor View Transition
   ========================================================================= */

/**
 * Enter Fullscreen Monitor View (after calibration succeeds).
 * Uses Fullscreen API where supported; falls back to CSS fullscreen (e.g. iPhone Safari).
 */
async function enterMonitorView() {
  state.isMonitorView = true;
  dom.appLayout.classList.add('monitor-view-active');
  dom.zoneHelperPill.classList.add('hidden');

  // Attempt HTML5 Fullscreen API (fail gracefully on iOS Safari)
  if (document.fullscreenEnabled || document.webkitFullscreenEnabled) {
    try {
      if (dom.videoContainer.requestFullscreen) {
        await dom.videoContainer.requestFullscreen();
      } else if (dom.videoContainer.webkitRequestFullscreen) {
        await dom.videoContainer.webkitRequestFullscreen();
      }
    } catch {
      // Rejections are expected on iOS Safari or when permission not given; CSS fullscreen covers it
    }
  }

  await acquireWakeLock();
  resizeOverlayCanvas();
  drawOverlay();
}

/**
 * Exit Fullscreen Monitor View and restore standard controls UI.
 */
async function exitMonitorView() {
  state.isMonitorView = false;
  dom.appLayout.classList.remove('monitor-view-active');
  dom.monitorQuickBar.classList.add('hidden');

  if (state.quickBarTimer) clearTimeout(state.quickBarTimer);

  if (document.fullscreenElement || document.webkitFullscreenElement) {
    try {
      if (document.exitFullscreen) {
        await document.exitFullscreen();
      } else if (document.webkitExitFullscreen) {
        await document.webkitExitFullscreen();
      }
    } catch {
      // Ignore
    }
  }

  resizeOverlayCanvas();
  drawOverlay();
}

// Fullscreen change listener (handle Esc key or system gesture)
function handleFullscreenChange() {
  const isDocFullscreen = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
  if (!isDocFullscreen && state.isMonitorView) {
    // If user pressed Esc, restore standard controls while keeping monitoring active
    exitMonitorView();
    showToast('Exited fullscreen view. Monitoring continues in standard view.', 'info');
  }
}

document.addEventListener('fullscreenchange', handleFullscreenChange);
document.addEventListener('webkitfullscreenchange', handleFullscreenChange);

/* =========================================================================
   4. Camera Lifecycle & Fallback Chain
   ========================================================================= */

async function startCamera() {
  if (state.isDemoMode) {
    stopDemoMode();
  }

  showToast('Initializing camera...', 'info');

  const constraintsList = [
    {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    },
    {
      video: {
        facingMode: 'environment'
      },
      audio: false
    },
    {
      video: true,
      audio: false
    }
  ];

  let stream = null;
  let lastError = null;

  for (const constraints of constraintsList) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (stream) break;
    } catch (err) {
      lastError = err;
      console.warn('getUserMedia constraint failed, attempting fallback:', constraints, err);
    }
  }

  if (!stream) {
    handleCameraError(lastError);
    return false;
  }

  state.stream = stream;
  dom.cameraFeed.srcObject = stream;

  try {
    await dom.cameraFeed.play();
  } catch (playErr) {
    console.error('Error starting video playback:', playErr);
  }

  state.isCameraActive = true;
  dom.emptyCameraState.classList.add('hidden');
  dom.zoneHelperPill.classList.remove('hidden');

  const track = stream.getVideoTracks()[0];
  if (track && track.applyConstraints) {
    try {
      await track.applyConstraints({
        advanced: [
          { exposureMode: 'continuous' },
          { focusMode: 'continuous' }
        ]
      });
    } catch {
      // Fail silently
    }
  }

  track.addEventListener('ended', onStreamEnded);
  track.addEventListener('mute', onStreamMuted);
  track.addEventListener('unmute', onStreamUnmuted);

  updateUI();
  await enumerateCameras();
  resizeOverlayCanvas();
  drawOverlay();

  showToast('Camera active. Drag the circle over the target ground area.', 'success');
  return true;
}

function stopCamera() {
  if (state.isMonitoring) {
    stopMonitoring();
  }

  if (state.stream) {
    state.stream.getTracks().forEach((track) => {
      track.removeEventListener('ended', onStreamEnded);
      track.removeEventListener('mute', onStreamMuted);
      track.removeEventListener('unmute', onStreamUnmuted);
      track.stop();
    });
    state.stream = null;
  }

  dom.cameraFeed.srcObject = null;
  state.isCameraActive = false;
  state.isPaused = false;

  dom.emptyCameraState.classList.remove('hidden');
  dom.zoneHelperPill.classList.add('hidden');
  dom.alertBanner.classList.add('hidden');

  exitMonitorView();
  updateUI();
  drawOverlay();
}

function handleCameraError(err) {
  let message = 'Unable to access the camera.';

  if (!err) {
    message = 'Camera device not supported or blocked.';
  } else if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
    message = 'Camera permission was denied. Please allow camera permissions in your browser address bar and reload.';
  } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
    message = 'No camera hardware found on this device.';
  } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
    message = 'Camera is currently locked or in use by another tab or app.';
  } else if (err.name === 'OverconstrainedError') {
    message = 'Requested camera resolution/mode is unsupported by this device.';
  } else {
    message = `Camera error: ${err.message || err.name}`;
  }

  showToast(message, 'error', 6000);
}

async function enumerateCameras() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    state.availableVideoDevices = devices.filter((d) => d.kind === 'videoinput');

    if (state.availableVideoDevices.length > 1) {
      dom.btnSwitchCamera.classList.remove('hidden');
    } else {
      dom.btnSwitchCamera.classList.add('hidden');
    }
  } catch (err) {
    console.warn('enumerateDevices error:', err);
  }
}

async function switchCamera() {
  if (state.availableVideoDevices.length <= 1) return;

  const currentTrack = state.stream?.getVideoTracks()[0];
  const currentId = currentTrack?.getSettings()?.deviceId;

  let nextIndex = 0;
  if (currentId) {
    const currentIndex = state.availableVideoDevices.findIndex((d) => d.deviceId === currentId);
    nextIndex = (currentIndex + 1) % state.availableVideoDevices.length;
  }
  const nextDevice = state.availableVideoDevices[nextIndex];

  stopCamera();

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: nextDevice.deviceId } },
      audio: false
    });

    state.stream = stream;
    dom.cameraFeed.srcObject = stream;
    await dom.cameraFeed.play();
    state.isCameraActive = true;
    dom.emptyCameraState.classList.add('hidden');

    updateUI();
    showToast(`Switched to: ${nextDevice.label || 'Camera ' + (nextIndex + 1)}`, 'info');
  } catch (err) {
    handleCameraError(err);
  }
}

/* =========================================================================
   5. Screen Wake Lock & Tab Interruption Handling
   ========================================================================= */

async function acquireWakeLock() {
  if ('wakeLock' in navigator && !state.wakeLock) {
    try {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => {
        state.wakeLock = null;
      });
    } catch {
      // Ignored
    }
  }
}

function releaseWakeLock() {
  if (state.wakeLock) {
    try {
      state.wakeLock.release();
    } catch {
      // Ignore
    }
    state.wakeLock = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (state.isVideoPlaying && videoPlayer) {
      videoPlayer.stop();
      state.isVideoPlaying = false;
    }
    if (state.isMonitoring) {
      pauseMonitoring('Interrupted: Tab minimized or screen locked');
    }
  } else {
    if (state.isMonitoring && state.isPaused) {
      resumeMonitoring();
    }
  }
});

function onStreamEnded() {
  if (state.isVideoPlaying && videoPlayer) {
    videoPlayer.stop();
    state.isVideoPlaying = false;
  }
  pauseMonitoring('Camera feed was terminated');
}

function onStreamMuted() {
  pauseMonitoring('Camera track muted by operating system');
}

function onStreamUnmuted() {
  if (state.isMonitoring && state.isPaused) {
    resumeMonitoring();
  }
}

function pauseMonitoring(reason) {
  state.isPaused = true;
  updateUI();
  showToast(`Monitoring paused - ${reason}`, 'warning');
}

function resumeMonitoring() {
  state.isPaused = false;
  acquireWakeLock();
  detector.startCalibration(8, EngineState.RESUMING);
  updateUI();
  showToast('Monitoring resumed. Recalibrating background...', 'info');
}

/* =========================================================================
   6. Vision Loop & Video Alert Coordination
   ========================================================================= */

/**
 * Start Monitoring loop.
 * Unlocks AudioContext AND Video Player Autoplay in this user tap!
 */
async function startMonitoring() {
  if (!state.isCameraActive && !state.isDemoMode) {
    showToast('Start camera or demo mode first!', 'warning');
    return;
  }

  // 1. Critical Autoplay Unlock during user click
  await audioAlert.ensureAudioContext();
  if (videoPlayer) {
    await videoPlayer.unlockAutoplay();
  }

  state.isMonitoring = true;
  state.isPaused = false;

  const track = state.stream?.getVideoTracks()[0];
  if (track && track.applyConstraints) {
    try {
      await track.applyConstraints({
        advanced: [
          { exposureMode: 'manual' },
          { focusMode: 'manual' }
        ]
      });
    } catch {
      // Fail silently
    }
  }

  await acquireWakeLock();
  detector.startCalibration(12, EngineState.CALIBRATING);
  updateUI();

  showToast('Calibrating background (~2s). Keep device steady...', 'info');

  scheduleNextFrame();
}

/**
 * Stop Monitoring loop. Restores normal view and releases all states.
 */
function stopMonitoring() {
  state.isMonitoring = false;
  state.isPaused = false;
  state.isVideoPlaying = false;

  if (videoPlayer) {
    videoPlayer.stop();
  }

  releaseWakeLock();

  if (state.rvfcHandle && dom.cameraFeed.cancelVideoFrameCallback) {
    dom.cameraFeed.cancelVideoFrameCallback(state.rvfcHandle);
    state.rvfcHandle = null;
  }
  if (state.rafLoopId) {
    cancelAnimationFrame(state.rafLoopId);
    state.rafLoopId = null;
  }

  detector.resetBackground();
  dom.alertBanner.classList.add('hidden');

  exitMonitorView();
  updateUI();
  drawOverlay();
}

function scheduleNextFrame() {
  if (!state.isMonitoring && !state.isDemoMode) return;
  if (state.isVideoPlaying) return; // Analysis paused while video plays

  if (state.isCameraActive && 'requestVideoFrameCallback' in dom.cameraFeed) {
    state.rvfcHandle = dom.cameraFeed.requestVideoFrameCallback((now) => {
      onVideoFrame(now);
    });
  } else {
    state.rafLoopId = requestAnimationFrame((now) => {
      onVideoFrame(now);
    });
  }
}

/**
 * Vision evaluation cycle.
 */
function onVideoFrame(now) {
  if (state.isVideoPlaying) return;

  const delta = now - state.lastProcessTimestamp;
  if (delta < state.sampleIntervalMs) {
    scheduleNextFrame();
    return;
  }
  state.lastProcessTimestamp = now;

  // FPS calculation for debug
  state.frameCount++;
  if (now - state.lastFpsTimestamp >= 1000) {
    state.currentFps = Math.round((state.frameCount * 1000) / (now - state.lastFpsTimestamp));
    state.frameCount = 0;
    state.lastFpsTimestamp = now;
    if (state.debugEnabled) {
      dom.debugFpsBadge.textContent = `${state.currentFps} FPS`;
    }
  }

  if (state.isPaused) {
    scheduleNextFrame();
    return;
  }

  // Extract ROI and Guard regions
  const sourceElement = state.isDemoMode ? dom.demoCanvas : dom.cameraFeed;
  const metrics = processFrame(sourceElement, now);

  // Redraw overlay with status & mask
  drawOverlay(metrics.state, metrics.changedPercent);

  // Auto-switch to Monitor View when calibration finishes!
  if (metrics.state === EngineState.MONITORING && !state.isMonitorView && state.isMonitoring) {
    enterMonitorView();
  }

  // Handle Motion Alert
  if (metrics.alertTriggered) {
    onMotionAlert(metrics);
  } else if (metrics.state === EngineState.ALERTING && !state.isMonitorView) {
    dom.alertBanner.classList.remove('hidden');
  } else if (metrics.state !== EngineState.ALERTING && !dom.alertBanner.classList.contains('hidden')) {
    setTimeout(() => {
      if (detector.state !== EngineState.ALERTING) {
        dom.alertBanner.classList.add('hidden');
      }
    }, 1200);
  }

  updateStatusBadge(metrics.state);

  scheduleNextFrame();
}

function processFrame(sourceElement, timestamp) {
  let srcW = 1280;
  let srcH = 720;

  if (state.isDemoMode) {
    srcW = dom.demoCanvas.width;
    srcH = dom.demoCanvas.height;
  } else if (dom.cameraFeed.videoWidth && dom.cameraFeed.videoHeight) {
    srcW = dom.cameraFeed.videoWidth;
    srcH = dom.cameraFeed.videoHeight;
  }

  const minDim = Math.min(srcW, srcH);
  const rPixels = state.zone.r * minDim;
  const cxPixels = state.zone.cx * srcW;
  const cyPixels = state.zone.cy * srcH;

  const boxX = Math.max(0, cxPixels - rPixels);
  const boxY = Math.max(0, cyPixels - rPixels);
  const boxW = Math.min(srcW - boxX, rPixels * 2);
  const boxH = Math.min(srcH - boxY, rPixels * 2);

  // 1. Draw ROI into processing canvas
  procCtx.drawImage(
    sourceElement,
    boxX, boxY, boxW, boxH,
    0, 0, dom.processingCanvas.width, dom.processingCanvas.height
  );
  const roiImageData = procCtx.getImageData(0, 0, dom.processingCanvas.width, dom.processingCanvas.height);

  // 2. Draw guard thumbnail for bump detection
  guardCtx.drawImage(
    sourceElement,
    0, 0, srcW, srcH,
    0, 0, dom.guardCanvas.width, dom.guardCanvas.height
  );
  const guardImageData = guardCtx.getImageData(0, 0, dom.guardCanvas.width, dom.guardCanvas.height);

  // 3. Process via MotionDetector
  const result = detector.process(roiImageData, guardImageData, timestamp);

  if (state.debugEnabled) {
    updateDebugHud(result);
  }

  return result;
}

/**
 * Handle motion event: triggers fullscreen video player (if enabled) or sound alert.
 */
function onMotionAlert(metrics) {
  // Update timestamp
  const now = new Date();
  const timeStr = now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0');
  dom.alertTimestamp.textContent = `${timeStr} (${metrics.changedPercent.toFixed(1)}% area)`;

  // Check if Feature 2 (Video Alert) is enabled
  if (state.isVideoOnMotion && videoPlayer) {
    state.isVideoPlaying = true;
    updateStatusBadge('VIDEO_PLAYING');

    videoPlayer.playAlertVideo({
      onEnded: () => onVideoAlertComplete(),
      onSkipped: () => onVideoAlertComplete(),
      onError: (err) => {
        console.warn('Video failed, falling back to sound alert:', err);
        state.isVideoPlaying = false;
        audioAlert.triggerAlert();
        scheduleNextFrame();
      }
    });
    return;
  }

  // Fallback to standalone sound alert
  audioAlert.triggerAlert();
  updateStatusBadge(EngineState.ALERTING);
}

/**
 * Follows the video completion return-and-recalibrate path.
 */
function onVideoAlertComplete() {
  state.isVideoPlaying = false;

  // Short recalibration (~8 frames, ~1.2s) to adjust to scene light change from phone screen
  updateStatusBadge(EngineState.RESUMING);
  detector.startCalibration(8, EngineState.RESUMING);

  // Resume motion analysis loop
  scheduleNextFrame();
}

function updateDebugHud(metrics) {
  dom.debugChangedVal.textContent = `${metrics.changedPercent.toFixed(1)}%`;
  dom.debugBlobVal.textContent = `${metrics.blobPercent.toFixed(1)}%`;
  dom.debugTimeVal.textContent = `${metrics.processingTimeMs.toFixed(1)} ms`;
  
  if (state.isVideoPlaying) {
    dom.debugStateVal.textContent = 'VIDEO PLAYING';
  } else {
    dom.debugStateVal.textContent = metrics.state;
  }

  if (metrics.diffMask) {
    if (!debugImageData) {
      debugImageData = debugMaskCtx.createImageData(dom.debugMaskCanvas.width, dom.debugMaskCanvas.height);
    }
    const d = debugImageData.data;
    const mask = metrics.diffMask;
    const len = mask.length;

    for (let i = 0, p = 0; i < len; i++, p += 4) {
      const val = mask[i];
      if (val === 255) {
        d[p] = 239;
        d[p + 1] = 68;
        d[p + 2] = 68;
        d[p + 3] = 255;
      } else {
        d[p] = 0;
        d[p + 1] = 0;
        d[p + 2] = 0;
        d[p + 3] = 255;
      }
    }
    debugMaskCtx.putImageData(debugImageData, 0, 0);
  }
}

/* =========================================================================
   7. Demo Mode Simulation
   ========================================================================= */

function toggleDemoMode() {
  if (state.isDemoMode) {
    stopDemoMode();
  } else {
    startDemoMode();
  }
}

function startDemoMode() {
  if (state.isCameraActive) {
    stopCamera();
  }

  state.isDemoMode = true;
  dom.demoCanvas.classList.remove('hidden');
  dom.emptyCameraState.classList.add('hidden');
  dom.zoneHelperPill.classList.remove('hidden');

  dom.btnDemoMode.classList.add('btn-active-stop');
  dom.labelDemoMode.textContent = 'Exit Demo';

  dom.demoCanvas.width = 1280;
  dom.demoCanvas.height = 720;

  _initDemoGroundTexture();
  _runDemoAnimationLoop();

  updateUI();
  resizeOverlayCanvas();
  drawOverlay();

  showToast('Demo Mode active: synthetic ground scene with traversing target.', 'info');
}

function stopDemoMode() {
  state.isDemoMode = false;
  dom.demoCanvas.classList.add('hidden');
  dom.btnDemoMode.classList.remove('btn-active-stop');
  dom.labelDemoMode.textContent = 'Demo Mode';

  if (!state.isCameraActive) {
    dom.emptyCameraState.classList.remove('hidden');
    dom.zoneHelperPill.classList.add('hidden');
  }

  if (state.isMonitoring) {
    stopMonitoring();
  }

  updateUI();
  drawOverlay();
}

function _initDemoGroundTexture() {
  const off = document.createElement('canvas');
  off.width = 256;
  off.height = 256;
  const ctx = off.getContext('2d');
  const imgData = ctx.createImageData(256, 256);
  const d = imgData.data;

  for (let i = 0; i < d.length; i += 4) {
    const v = 85 + (Math.random() * 30 | 0);
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v + 4;
    d[i + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
  demoAnim.groundNoisePattern = demoCtx.createPattern(off, 'repeat');
}

function _runDemoAnimationLoop() {
  if (!state.isDemoMode) return;

  const w = dom.demoCanvas.width;
  const h = dom.demoCanvas.height;

  if (demoAnim.groundNoisePattern) {
    demoCtx.fillStyle = demoAnim.groundNoisePattern;
    demoCtx.fillRect(0, 0, w, h);
  } else {
    demoCtx.fillStyle = '#555';
    demoCtx.fillRect(0, 0, w, h);
  }

  demoAnim.x += demoAnim.vx;
  demoAnim.y += demoAnim.vy;

  if (demoAnim.x < 0.05 || demoAnim.x > 0.85) demoAnim.vx = -demoAnim.vx;
  if (demoAnim.y < 0.10 || demoAnim.y > 0.80) demoAnim.vy = -demoAnim.vy;

  const objSizePx = demoAnim.size * Math.min(w, h);
  const objXPx = demoAnim.x * w;
  const objYPx = demoAnim.y * h;

  demoCtx.fillStyle = '#1e293b';
  demoCtx.fillRect(objXPx, objYPx, objSizePx, objSizePx);

  demoCtx.strokeStyle = '#f8fafc';
  demoCtx.lineWidth = 3;
  demoCtx.strokeRect(objXPx, objYPx, objSizePx, objSizePx);

  requestAnimationFrame(_runDemoAnimationLoop);
}

/* =========================================================================
   8. UI State & Extended Status Synchronization
   ========================================================================= */

function updateUI() {
  const isRunning = state.isCameraActive || state.isDemoMode;

  if (state.isCameraActive) {
    dom.btnToggleCamera.classList.add('btn-active-stop');
    dom.labelToggleCamera.textContent = 'Stop Camera';
  } else {
    dom.btnToggleCamera.classList.remove('btn-active-stop');
    dom.labelToggleCamera.textContent = 'Start Camera';
  }

  dom.btnToggleMonitoring.disabled = !isRunning;
  dom.btnRecalibrate.disabled = !state.isMonitoring;

  if (state.isMonitoring) {
    dom.btnToggleMonitoring.classList.add('btn-active-stop');
    dom.labelToggleMonitoring.textContent = 'Stop Monitoring';
  } else {
    dom.btnToggleMonitoring.classList.remove('btn-active-stop');
    dom.labelToggleMonitoring.textContent = 'Start Monitoring';
  }

  updateStatusBadge(state.isMonitoring ? detector.state : EngineState.IDLE);
}

/**
 * Extended Status Synchronization supporting:
 * Camera Off -> Calibrating -> Monitoring -> Motion Detected (Video Playing) -> Resuming -> Monitoring
 */
function updateStatusBadge(engineState) {
  dom.statusBadge.className = 'status-badge';

  if (!state.isCameraActive && !state.isDemoMode) {
    dom.statusBadge.classList.add('status-off');
    dom.statusIcon.textContent = '📷';
    dom.statusText.textContent = 'Camera Off';
    return;
  }

  if (state.isPaused) {
    dom.statusBadge.classList.add('status-paused');
    dom.statusIcon.textContent = '⏸️';
    dom.statusText.textContent = 'Monitoring Paused';
    return;
  }

  if (!state.isMonitoring) {
    dom.statusBadge.classList.add('status-off');
    dom.statusIcon.textContent = '⏸️';
    dom.statusText.textContent = 'Standby (Camera Live)';
    return;
  }

  if (state.isVideoPlaying || engineState === 'VIDEO_PLAYING') {
    dom.statusBadge.classList.add('status-video');
    dom.statusIcon.textContent = '🎬';
    dom.statusText.textContent = 'Motion Detected (Video Playing)';
    return;
  }

  switch (engineState) {
    case EngineState.CALIBRATING:
      dom.statusBadge.classList.add('status-calibrating');
      dom.statusIcon.textContent = '⏳';
      dom.statusText.textContent = 'Calibrating...';
      break;
    case EngineState.RESUMING:
      dom.statusBadge.classList.add('status-resuming');
      dom.statusIcon.textContent = '⏳';
      dom.statusText.textContent = 'Resuming...';
      break;
    case EngineState.ALERTING:
      dom.statusBadge.classList.add('status-alert');
      dom.statusIcon.textContent = '🚨';
      dom.statusText.textContent = 'Motion Detected';
      break;
    case EngineState.SUPPRESSED:
      dom.statusBadge.classList.add('status-calibrating');
      dom.statusIcon.textContent = '⚠️';
      dom.statusText.textContent = 'Stabilizing Bump';
      break;
    case EngineState.COOLDOWN:
      dom.statusBadge.classList.add('status-monitoring');
      dom.statusIcon.textContent = '🟢';
      dom.statusText.textContent = 'Monitoring (Cooldown)';
      break;
    case EngineState.MONITORING:
    case EngineState.CANDIDATE:
    default:
      dom.statusBadge.classList.add('status-monitoring');
      dom.statusIcon.textContent = '🟢';
      dom.statusText.textContent = 'Monitoring';
      break;
  }
}

function showToast(message, type = 'info', duration = 3500) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  dom.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.25s ease';
    setTimeout(() => toast.remove(), 250);
  }, duration);
}

/* =========================================================================
   9. Settings & Persistence
   ========================================================================= */

function applyPreset(presetName) {
  if (!SENSITIVITY_PRESETS[presetName]) return;

  state.activePreset = presetName;
  detector.setPreset(presetName);

  const preset = SENSITIVITY_PRESETS[presetName];
  dom.pixelThresholdSlider.value = preset.pixelDiffThreshold;
  dom.pixelThresholdVal.textContent = preset.pixelDiffThreshold;

  dom.areaThresholdSlider.value = preset.minAreaPercent;
  dom.areaThresholdVal.textContent = `${preset.minAreaPercent.toFixed(1)}%`;

  dom.confirmFramesSlider.value = preset.consecutiveFrames;
  dom.confirmFramesVal.textContent = preset.consecutiveFrames;

  Object.keys(dom.presetButtons).forEach((key) => {
    dom.presetButtons[key].classList.toggle('active', key === presetName);
  });
  dom.customPresetBadge.classList.add('hidden');

  persistSettings();
  showToast(`Applied ${presetName.toUpperCase()} sensitivity`, 'info');
}

function onCustomSliderChange() {
  state.activePreset = 'custom';
  Object.keys(dom.presetButtons).forEach((key) => {
    dom.presetButtons[key].classList.remove('active');
  });
  dom.customPresetBadge.classList.remove('hidden');

  detector.setParameters({
    pixelDiffThreshold: dom.pixelThresholdSlider.value,
    minAreaPercent: dom.areaThresholdSlider.value,
    consecutiveFrames: dom.confirmFramesSlider.value,
    cooldownMs: Number(dom.cooldownSlider.value) * 1000
  });

  state.sampleIntervalMs = Number(dom.sampleIntervalSlider.value);
  persistSettings();
}

function persistSettings() {
  try {
    const data = {
      zone: state.zone,
      preset: state.activePreset,
      pixelDiffThreshold: dom.pixelThresholdSlider.value,
      minAreaPercent: dom.areaThresholdSlider.value,
      consecutiveFrames: dom.confirmFramesSlider.value,
      cooldown: dom.cooldownSlider.value,
      sampleInterval: dom.sampleIntervalSlider.value,
      soundType: dom.soundTypeSelect.value,
      volume: dom.volumeSlider.value,
      muted: dom.muteToggle.checked,
      vibrate: dom.vibrateToggle.checked,
      debug: dom.debugToggle.checked,
      maskColor: state.maskColor,
      maskOpacity: state.maskOpacity,
      videoOnMotion: state.isVideoOnMotion,
      videoAudio: state.isVideoAudio
    };
    localStorage.setItem('ground_motion_detector_prefs', JSON.stringify(data));
  } catch (err) {
    console.warn('Could not persist settings to localStorage:', err);
  }
}

function loadPersistedSettings() {
  try {
    const saved = localStorage.getItem('ground_motion_detector_prefs');
    if (!saved) return;
    const data = JSON.parse(saved);

    if (data.zone) {
      state.zone.cx = data.zone.cx ?? 0.5;
      state.zone.cy = data.zone.cy ?? 0.5;
      state.zone.r = data.zone.r ?? 0.20;
      clampZoneCoordinates();
    }

    // Mask preferences
    if (data.maskColor) {
      state.maskColor = data.maskColor;
      dom.maskColorPicker.value = data.maskColor;
      dom.maskColorHex.textContent = data.maskColor.toUpperCase();
    }
    if (data.maskOpacity !== undefined) {
      state.maskOpacity = Number(data.maskOpacity);
      dom.maskOpacitySlider.value = Math.round(state.maskOpacity * 100);
      dom.maskOpacityVal.textContent = `${Math.round(state.maskOpacity * 100)}%`;
    }

    // Video preferences
    if (data.videoOnMotion !== undefined) {
      state.isVideoOnMotion = Boolean(data.videoOnMotion);
      dom.videoOnMotionToggle.checked = state.isVideoOnMotion;
      if (videoPlayer) videoPlayer.videoEnabled = state.isVideoOnMotion;
    }
    if (data.videoAudio !== undefined) {
      state.isVideoAudio = Boolean(data.videoAudio);
      dom.videoAudioToggle.checked = state.isVideoAudio;
      if (videoPlayer) videoPlayer.soundEnabled = state.isVideoAudio;
    }

    if (data.volume !== undefined) {
      dom.volumeSlider.value = data.volume;
      dom.volumeVal.textContent = `${data.volume}%`;
      audioAlert.setVolume(data.volume / 100);
    }

    if (data.muted !== undefined) {
      dom.muteToggle.checked = data.muted;
      audioAlert.setMuted(data.muted);
    }

    if (data.soundType) {
      dom.soundTypeSelect.value = data.soundType;
      audioAlert.setSoundType(data.soundType);
    }

    if (data.vibrate !== undefined) {
      dom.vibrateToggle.checked = data.vibrate;
      audioAlert.setVibrationEnabled(data.vibrate);
    }

    if (data.debug !== undefined) {
      dom.debugToggle.checked = data.debug;
      state.debugEnabled = data.debug;
      dom.debugHud.classList.toggle('hidden', !data.debug);
    }

    if (data.sampleInterval) {
      dom.sampleIntervalSlider.value = data.sampleInterval;
      dom.sampleIntervalVal.textContent = `${data.sampleInterval} ms`;
      state.sampleIntervalMs = Number(data.sampleInterval);
    }

    if (data.cooldown) {
      dom.cooldownSlider.value = data.cooldown;
      dom.cooldownVal.textContent = `${Number(data.cooldown).toFixed(1)} s`;
      detector.cooldownMs = Number(data.cooldown) * 1000;
    }

    if (data.preset && data.preset !== 'custom') {
      applyPreset(data.preset);
    } else if (data.pixelDiffThreshold) {
      dom.pixelThresholdSlider.value = data.pixelDiffThreshold;
      dom.pixelThresholdVal.textContent = data.pixelDiffThreshold;
      dom.areaThresholdSlider.value = data.minAreaPercent;
      dom.areaThresholdVal.textContent = `${Number(data.minAreaPercent).toFixed(1)}%`;
      dom.confirmFramesSlider.value = data.confirmFrames;
      dom.confirmFramesVal.textContent = data.confirmFrames;
      onCustomSliderChange();
    }
  } catch (err) {
    console.warn('Could not parse persisted settings:', err);
  }
}

/* =========================================================================
   10. Event Bindings & Initializer
   ========================================================================= */

function initEventListeners() {
  // Primary buttons
  dom.btnToggleCamera.addEventListener('click', () => {
    if (state.isCameraActive) {
      stopCamera();
    } else {
      startCamera();
    }
  });

  dom.emptyStartBtn.addEventListener('click', () => startCamera());

  dom.btnToggleMonitoring.addEventListener('click', () => {
    if (state.isMonitoring) {
      stopMonitoring();
    } else {
      startMonitoring();
    }
  });

  dom.btnSwitchCamera.addEventListener('click', switchCamera);
  dom.btnDemoMode.addEventListener('click', toggleDemoMode);
  dom.emptyDemoBtn.addEventListener('click', startDemoMode);

  // Monitor View in-view bottom quick bar
  dom.btnQuickStop.addEventListener('click', (e) => {
    e.stopPropagation();
    stopMonitoring();
  });
  dom.btnQuickRecalibrate.addEventListener('click', (e) => {
    e.stopPropagation();
    detector.startCalibration(12, EngineState.CALIBRATING);
    showToast('Background recalibrating...', 'info');
  });
  dom.btnQuickMute.addEventListener('click', (e) => {
    e.stopPropagation();
    const nextMuted = !dom.muteToggle.checked;
    dom.muteToggle.checked = nextMuted;
    audioAlert.setMuted(nextMuted);
    dom.btnQuickMute.textContent = nextMuted ? '🔊 Unmute' : '🔇 Mute';
    persistSettings();
    showToast(nextMuted ? 'Muted' : 'Unmuted', 'info');
  });

  // Recalibrate & Reset Zone
  dom.btnRecalibrate.addEventListener('click', () => {
    detector.startCalibration(12, EngineState.CALIBRATING);
    showToast('Background model recalibrated', 'info');
  });

  dom.btnResetZone.addEventListener('click', () => {
    state.zone.cx = 0.5;
    state.zone.cy = 0.5;
    state.zone.r = 0.20;
    clampZoneCoordinates();
    drawOverlay();
    persistSettings();
    showToast('Detection zone reset to center', 'info');
  });

  // Feature 1: Mask Controls
  dom.maskColorPicker.addEventListener('input', (e) => {
    state.maskColor = e.target.value;
    dom.maskColorHex.textContent = e.target.value.toUpperCase();
    drawOverlay();
    persistSettings();
  });

  dom.maskOpacitySlider.addEventListener('input', (e) => {
    state.maskOpacity = Number(e.target.value) / 100;
    dom.maskOpacityVal.textContent = `${e.target.value}%`;
    drawOverlay();
    persistSettings();
  });

  dom.btnResetMask.addEventListener('click', () => {
    state.maskColor = '#000000';
    state.maskOpacity = 1.0;
    dom.maskColorPicker.value = '#000000';
    dom.maskColorHex.textContent = '#000000';
    dom.maskOpacitySlider.value = 100;
    dom.maskOpacityVal.textContent = '100%';
    drawOverlay();
    persistSettings();
    showToast('Mask reset to solid black (100%)', 'info');
  });

  // Feature 2: Video Alert Controls
  dom.videoOnMotionToggle.addEventListener('change', (e) => {
    state.isVideoOnMotion = e.target.checked;
    if (videoPlayer) videoPlayer.videoEnabled = state.isVideoOnMotion;
    persistSettings();
  });

  dom.videoAudioToggle.addEventListener('change', (e) => {
    state.isVideoAudio = e.target.checked;
    if (videoPlayer) videoPlayer.soundEnabled = state.isVideoAudio;
    persistSettings();
  });

  dom.videoFileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (file && videoPlayer) {
      await videoPlayer.setCustomVideoFile(file);
      dom.videoSourceLabel.textContent = `Custom: ${file.name} (${(file.size / (1024 * 1024)).toFixed(1)} MB)`;
      showToast(`Loaded custom video: ${file.name}`, 'success');
    }
  });

  dom.btnResetVideo.addEventListener('click', async () => {
    if (videoPlayer) {
      await videoPlayer.resetToDefaultVideo();
      dom.videoFileInput.value = '';
      dom.videoSourceLabel.textContent = 'Default: assets/alert-video.mp4 (H.264 MP4 recommended)';
      showToast('Restored default bundled video', 'info');
    }
  });

  dom.btnTestVideo.addEventListener('click', async () => {
    if (videoPlayer) {
      showToast('Playing test video alert...', 'info');
      state.isVideoPlaying = true;
      updateStatusBadge('VIDEO_PLAYING');
      await videoPlayer.testPlay({
        onEnded: () => {
          state.isVideoPlaying = false;
          updateUI();
          drawOverlay();
        }
      });
    }
  });

  // Sensitivity Presets
  Object.keys(dom.presetButtons).forEach((presetKey) => {
    dom.presetButtons[presetKey].addEventListener('click', () => applyPreset(presetKey));
  });

  // Audio Controls
  dom.soundTypeSelect.addEventListener('change', (e) => {
    audioAlert.setSoundType(e.target.value);
    persistSettings();
  });

  dom.volumeSlider.addEventListener('input', (e) => {
    dom.volumeVal.textContent = `${e.target.value}%`;
    audioAlert.setVolume(Number(e.target.value) / 100);
    persistSettings();
  });

  dom.muteToggle.addEventListener('change', (e) => {
    audioAlert.setMuted(e.target.checked);
    persistSettings();
  });

  dom.vibrateToggle.addEventListener('change', (e) => {
    audioAlert.setVibrationEnabled(e.target.checked);
    persistSettings();
  });

  dom.btnTestSound.addEventListener('click', () => {
    audioAlert.testSound();
  });

  // Advanced Sliders
  dom.pixelThresholdSlider.addEventListener('input', (e) => {
    dom.pixelThresholdVal.textContent = e.target.value;
    onCustomSliderChange();
  });

  dom.areaThresholdSlider.addEventListener('input', (e) => {
    dom.areaThresholdVal.textContent = `${Number(e.target.value).toFixed(1)}%`;
    onCustomSliderChange();
  });

  dom.sampleIntervalSlider.addEventListener('input', (e) => {
    dom.sampleIntervalVal.textContent = `${e.target.value} ms`;
    onCustomSliderChange();
  });

  dom.confirmFramesSlider.addEventListener('input', (e) => {
    dom.confirmFramesVal.textContent = e.target.value;
    onCustomSliderChange();
  });

  dom.cooldownSlider.addEventListener('input', (e) => {
    dom.cooldownVal.textContent = `${Number(e.target.value).toFixed(1)} s`;
    onCustomSliderChange();
  });

  // Debug HUD Toggle
  dom.debugToggle.addEventListener('change', (e) => {
    state.debugEnabled = e.target.checked;
    dom.debugHud.classList.toggle('hidden', !state.debugEnabled);
    persistSettings();
  });

  // Window resize & orientation change
  window.addEventListener('resize', () => {
    resizeOverlayCanvas();
    drawOverlay();
  });

  window.addEventListener('orientationchange', () => {
    setTimeout(() => {
      resizeOverlayCanvas();
      drawOverlay();
    }, 150);
  });
}

/**
 * Global cleanup path.
 */
export function cleanup() {
  stopMonitoring();
  stopCamera();
  if (state.isDemoMode) stopDemoMode();
  if (videoPlayer) videoPlayer.cleanup();
  audioAlert.cleanup();
  detector.destroy();
}

// Bootstrap
window.addEventListener('DOMContentLoaded', () => {
  // Initialize VideoAlertPlayer
  videoPlayer = new VideoAlertPlayer({
    containerEl: dom.alertVideoOverlay,
    videoEl: dom.alertVideo,
    skipBtn: dom.btnSkipVideo,
    unmuteBtn: dom.btnUnmuteVideo,
    videoEnabled: state.isVideoOnMotion,
    soundEnabled: state.isVideoAudio
  });

  if (!AudioAlert.isVibrationSupported()) {
    dom.vibrationRow.style.display = 'none';
  }

  setupPointerInteractions();
  initEventListeners();
  loadPersistedSettings();
  resizeOverlayCanvas();
  updateUI();
  drawOverlay();
});
