/**
 * app.js
 * 
 * Main Application Controller for Ground Motion Detector.
 * Features:
 * - Camera Lifecycle & Wake Lock management
 * - Coordinate Mapping (Intrinsic Video <-> Display Viewport)
 * - Pure DOM-free Computer Vision pipeline coordination
 * - Feature 1: Animated Fire Ring Effect (Canvas 2D particle/flame engine)
 * - Feature 2: Anti-Feedback Protection (Guard Band, soft threshold falloff, flame exclusion)
 * - Feature 3: Projector Mode & Camera-to-Projector Alignment (offset, scale, flips, rotation, grid)
 * - Secondary Projector Window synchronization via BroadcastChannel
 * - 10-second Projector Stability Benchmark
 * - Fullscreen Monitor View & Motion-triggered Video Alerts
 * - Custom Video & Audio file pickers with IndexedDB persistence
 */

import { MotionDetector, EngineState, SENSITIVITY_PRESETS } from './motion-detector.js';
import { AudioAlert } from './audio-alert.js';
import { VideoAlertPlayer } from './video-player.js';
import { FireRing } from './fire-ring.js';

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

  // Mask Configuration
  maskColor: '#000000',
  maskOpacity: 1.0,

  // Video Alert Configuration
  isVideoOnMotion: true,
  isVideoAudio: true,
  isVideoPlaying: false,

  // Feature 1: Fire Ring Configuration
  isFireEnabled: true,
  fireIntensity: 2.5,
  fireThickness: 32,
  fireSpeed: 1.0,
  fireTheme: 'orange',
  fireCustomColor: '#ff4500',
  fireEmbers: true,
  fireGlow: true,
  fireCrackle: true,
  fireCrackleVolume: 0.6,

  // Feature 2: Feedback-Loop Protection & Guard Band
  guardBandPercent: 10,
  isProjectorTesting: false,

  // Feature 3: Projector Mode & Alignment
  isProjectorMode: false,
  isAlignmentGridVisible: false,
  alignment: {
    offsetX: 0,
    offsetY: 0,
    scale: 1.0,
    flipH: false,
    flipV: false,
    rotation: 0
  },

  // Zone coordinates: NORMALIZED (0.0 to 1.0) relative to intrinsic video dimensions
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
  quickBarTimer: null,
  projectorWindowRef: null
};

// Sub-modules
const detector = new MotionDetector({ guardBandPercent: state.guardBandPercent });
const audioAlert = new AudioAlert();
let videoPlayer = null;
let fireRing = null;
const projectorChannel = new BroadcastChannel('ground_motion_projector');

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
  fireCanvas: document.getElementById('fireCanvas'),
  alignmentGridCanvas: document.getElementById('alignmentGridCanvas'),
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
  debugFireFpsVal: document.getElementById('debugFireFpsVal'),
  debugActiveRadiusVal: document.getElementById('debugActiveRadiusVal'),
  btnProjectorTest: document.getElementById('btnProjectorTest'),
  projectorTestResult: document.getElementById('projectorTestResult'),

  // Header & Status
  statusBadge: document.getElementById('statusBadge'),
  statusText: document.getElementById('statusText'),
  alertBanner: document.getElementById('alertBanner'),
  alertTimestamp: document.getElementById('alertTimestamp'),

  // Primary Action Buttons
  btnStartCamera: document.getElementById('btnStartCamera'),
  btnMonitor: document.getElementById('btnMonitor'),
  btnDemo: document.getElementById('btnDemo'),
  emptyStartBtn: document.getElementById('emptyStartBtn'),
  emptyDemoBtn: document.getElementById('emptyDemoBtn'),

  // Zone Controls
  btnRecalibrate: document.getElementById('btnRecalibrate'),
  btnResetZone: document.getElementById('btnResetZone'),
  zoneSizeSlider: document.getElementById('zoneSizeSlider'),
  zoneSizeVal: document.getElementById('zoneSizeVal'),

  // Feature 1: Fire Ring Controls
  fireRingToggle: document.getElementById('fireRingToggle'),
  fireIntensitySlider: document.getElementById('fireIntensitySlider'),
  fireIntensityVal: document.getElementById('fireIntensityVal'),
  fireThicknessSlider: document.getElementById('fireThicknessSlider'),
  fireThicknessVal: document.getElementById('fireThicknessVal'),
  fireSpeedSlider: document.getElementById('fireSpeedSlider'),
  fireSpeedVal: document.getElementById('fireSpeedVal'),
  firePresets: {
    orange: document.getElementById('presetFireOrange'),
    blue: document.getElementById('presetFireBlue'),
    green: document.getElementById('presetFireGreen'),
    purple: document.getElementById('presetFirePurple')
  },
  fireCustomColorPicker: document.getElementById('fireCustomColorPicker'),
  fireCustomColorHex: document.getElementById('fireCustomColorHex'),
  fireEmbersToggle: document.getElementById('fireEmbersToggle'),
  fireGlowToggle: document.getElementById('fireGlowToggle'),
  fireCrackleToggle: document.getElementById('fireCrackleToggle'),
  crackleVolumeGroup: document.getElementById('crackleVolumeGroup'),
  fireCrackleVolumeSlider: document.getElementById('fireCrackleVolumeSlider'),
  fireCrackleVolumeVal: document.getElementById('fireCrackleVolumeVal'),

  // Feature 2: Feedback-Loop Protection Controls
  guardBandSlider: document.getElementById('guardBandSlider'),
  guardBandVal: document.getElementById('guardBandVal'),

  // Feature 3: Projector Mode & Alignment Controls
  projectorModeToggle: document.getElementById('projectorModeToggle'),
  btnToggleAlignmentGrid: document.getElementById('btnToggleAlignmentGrid'),
  btnResetAlignment: document.getElementById('btnResetAlignment'),
  btnOpenProjectorWindow: document.getElementById('btnOpenProjectorWindow'),
  projectorOffsetXSlider: document.getElementById('projectorOffsetXSlider'),
  projectorOffsetXVal: document.getElementById('projectorOffsetXVal'),
  projectorOffsetYSlider: document.getElementById('projectorOffsetYSlider'),
  projectorOffsetYVal: document.getElementById('projectorOffsetYVal'),
  projectorScaleSlider: document.getElementById('projectorScaleSlider'),
  projectorScaleVal: document.getElementById('projectorScaleVal'),
  projectorFlipHToggle: document.getElementById('projectorFlipHToggle'),
  projectorFlipVToggle: document.getElementById('projectorFlipVToggle'),
  projectorRotationSelect: document.getElementById('projectorRotationSelect'),

  // Mask Controls
  maskColorPicker: document.getElementById('maskColorPicker'),
  maskColorHex: document.getElementById('maskColorHex'),
  maskOpacitySlider: document.getElementById('maskOpacitySlider'),
  maskOpacityVal: document.getElementById('maskOpacityVal'),
  btnResetMask: document.getElementById('btnResetMask'),

  // Video Alert Settings
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
  audioFileInput: document.getElementById('audioFileInput'),
  btnResetAudio: document.getElementById('btnResetAudio'),
  audioSourceLabel: document.getElementById('audioSourceLabel'),
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

// Canvas 2D Contexts
const overlayCtx = dom.overlayCanvas.getContext('2d');
const alignmentGridCtx = dom.alignmentGridCanvas ? dom.alignmentGridCanvas.getContext('2d') : null;
const demoCtx = dom.demoCanvas.getContext('2d');
const procCtx = dom.processingCanvas.getContext('2d', { willReadFrequently: true });
const guardCtx = dom.guardCanvas.getContext('2d', { willReadFrequently: true });
const debugMaskCtx = dom.debugMaskCanvas.getContext('2d');
let debugImageData = null;

// Demo Mode variables
let demoTargetX = 0.5;
let demoTargetY = 0.5;
let demoAngle = 0;
let demoNoisePattern = null;

/* =========================================================================
   1. Coordinate Mapping & Geometry Helpers
   ========================================================================= */

/**
 * Calculates current letterboxed/pillarboxed video rendering rectangle.
 */
function getVideoRenderRect() {
  const containerW = dom.videoContainer.clientWidth;
  const containerH = dom.videoContainer.clientHeight;

  let intrinsicW = 1280;
  let intrinsicH = 720;

  if (state.isDemoMode) {
    intrinsicW = dom.demoCanvas.width;
    intrinsicH = dom.demoCanvas.height;
  } else if (dom.cameraFeed.videoWidth && dom.cameraFeed.videoHeight) {
    intrinsicW = dom.cameraFeed.videoWidth;
    intrinsicH = dom.cameraFeed.videoHeight;
  }

  const containerAspect = containerW / containerH;
  const videoAspect = intrinsicW / intrinsicH;

  let renderW, renderH, offsetX, offsetY;

  if (containerAspect > videoAspect) {
    // Pillarboxed (bars on left/right)
    renderH = containerH;
    renderW = containerH * videoAspect;
    offsetX = (containerW - renderW) / 2;
    offsetY = 0;
  } else {
    // Letterboxed (bars on top/bottom)
    renderW = containerW;
    renderH = containerW / videoAspect;
    offsetX = 0;
    offsetY = (containerH - renderH) / 2;
  }

  const minDim = Math.min(renderW, renderH);

  return {
    left: offsetX,
    top: offsetY,
    width: renderW,
    height: renderH,
    containerW,
    containerH,
    minDim,
    intrinsicW,
    intrinsicH
  };
}

/**
 * Maps normalized camera circle coordinates to projector display coordinates
 * using offset, scale, flips, and rotation.
 */
function getProjectorCoordinates(normCx, normCy, normR) {
  const align = state.alignment;
  let u = normCx - 0.5;
  let v = normCy - 0.5;

  if (align.flipH) u = -u;
  if (align.flipV) v = -v;

  const rad = (align.rotation || 0) * (Math.PI / 180);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rx = u * cos - v * sin;
  const ry = u * sin + v * cos;

  const scale = align.scale || 1.0;
  const finalCx = 0.5 + rx * scale + (align.offsetX || 0);
  const finalCy = 0.5 + ry * scale + (align.offsetY || 0);
  const finalR = normR * scale;

  return { cx: finalCx, cy: finalCy, r: finalR };
}

/**
 * Resize and scale canvases to physical display pixels.
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

  if (dom.fireCanvas && (dom.fireCanvas.width !== w * dpr || dom.fireCanvas.height !== h * dpr)) {
    dom.fireCanvas.width = w * dpr;
    dom.fireCanvas.height = h * dpr;
    dom.fireCanvas.style.width = `${w}px`;
    dom.fireCanvas.style.height = `${h}px`;
    if (fireRing) {
      fireRing.resize(w * dpr, h * dpr);
    }
  }

  if (dom.alignmentGridCanvas && (dom.alignmentGridCanvas.width !== w * dpr || dom.alignmentGridCanvas.height !== h * dpr)) {
    dom.alignmentGridCanvas.width = w * dpr;
    dom.alignmentGridCanvas.height = h * dpr;
    dom.alignmentGridCanvas.style.width = `${w}px`;
    dom.alignmentGridCanvas.style.height = `${h}px`;
    if (state.isAlignmentGridVisible) {
      drawAlignmentGrid();
    }
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

  state.zone.r = Math.max(0.08, Math.min(0.42, state.zone.r));
  state.zone.cx = Math.max(rNormX, Math.min(1 - rNormX, state.zone.cx));
  state.zone.cy = Math.max(rNormY, Math.min(1 - rNormY, state.zone.cy));

  const radiusPct = Math.round(state.zone.r * 100);
  dom.zoneSizeSlider.value = radiusPct;
  dom.zoneSizeVal.textContent = `${radiusPct}%`;
}

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

/* =========================================================================
   2. BroadcastChannel Projector Synchronization
   ========================================================================= */

function broadcastProjectorSync() {
  try {
    projectorChannel.postMessage({
      type: 'sync',
      circle: { cx: state.zone.cx, cy: state.zone.cy, r: state.zone.r },
      alignment: state.alignment,
      fireOptions: {
        enabled: state.isFireEnabled,
        intensity: state.fireIntensity,
        thickness: state.fireThickness,
        speed: state.fireSpeed,
        theme: state.fireTheme,
        customColor: state.fireCustomColor,
        embersEnabled: state.fireEmbers,
        interiorGlow: state.fireGlow
      }
    });
  } catch (err) {
    // Ignore channel closed errors
  }
}

/* =========================================================================
   3. Drawing Overlays & Fire Ring Positioning
   ========================================================================= */

/**
 * Render the interactive circular zone overlay AND Feature 1 Outside Area Mask.
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
    if (fireRing) fireRing.setCircle(0, 0, 0);
    return;
  }

  // Camera space pixel position
  const screenCx = rect.left + state.zone.cx * rect.width;
  const screenCy = rect.top + state.zone.cy * rect.height;
  const screenR = state.zone.r * rect.minDim;

  // Update Fire Ring position (applies projector alignment in Projector Mode)
  if (fireRing) {
    if (state.isProjectorMode) {
      const proj = getProjectorCoordinates(state.zone.cx, state.zone.cy, state.zone.r);
      const fireCx = (rect.left + proj.cx * rect.width) * dpr;
      const fireCy = (rect.top + proj.cy * rect.height) * dpr;
      const fireR = (proj.r * rect.minDim) * dpr;
      fireRing.setCircle(fireCx, fireCy, fireR);
    } else {
      fireRing.setCircle(screenCx * dpr, screenCy * dpr, screenR * dpr);
    }
    fireRing.setState(engineStatus);
  }

  broadcastProjectorSync();

  // Outside Masking with transparent hole (In Projector Mode, always solid black)
  const effMaskColor = state.isProjectorMode ? '#000000' : state.maskColor;
  const effMaskOpacity = state.isProjectorMode ? 1.0 : state.maskOpacity;

  if (effMaskOpacity > 0) {
    overlayCtx.save();
    overlayCtx.beginPath();
    overlayCtx.rect(0, 0, rect.containerW, rect.containerH);
    overlayCtx.arc(screenCx, screenCy, Math.max(0, screenR), 0, Math.PI * 2, true);
    overlayCtx.fillStyle = hexToRgba(effMaskColor, effMaskOpacity);
    overlayCtx.fill('evenodd');
    overlayCtx.restore();
  }

  // In Projector Mode, skip drawing UI strokes/handles onto the floor
  if (state.isProjectorMode && state.isMonitorView) {
    overlayCtx.restore();
    return;
  }

  // Determine circle border color based on status
  let strokeColor = '#06b6d4'; // Cyan default
  let fillColor = 'rgba(6, 182, 212, 0.04)';
  let glowColor = 'rgba(6, 182, 212, 0.3)';

  if (state.isMonitoring) {
    if (engineStatus === EngineState.ALERTING || state.isVideoPlaying) {
      strokeColor = '#ef4444';
      fillColor = 'rgba(239, 68, 68, 0.22)';
      glowColor = 'rgba(239, 68, 68, 0.7)';
    } else if (engineStatus === EngineState.CALIBRATING || engineStatus === EngineState.RESUMING) {
      strokeColor = '#f59e0b';
      fillColor = 'rgba(245, 158, 11, 0.08)';
      glowColor = 'rgba(245, 158, 11, 0.4)';
    } else if (engineStatus === EngineState.SUPPRESSED) {
      strokeColor = '#f97316';
      fillColor = 'rgba(249, 115, 22, 0.12)';
      glowColor = 'rgba(249, 115, 22, 0.5)';
    } else {
      strokeColor = '#10b981';
      fillColor = 'rgba(16, 185, 129, 0.06)';
      glowColor = 'rgba(16, 185, 129, 0.4)';
    }
  }

  // Alert ripple animation
  if (engineStatus === EngineState.ALERTING || state.isVideoPlaying) {
    const pulseRadius = screenR + Math.sin(performance.now() * 0.01) * 6;
    overlayCtx.beginPath();
    overlayCtx.arc(screenCx, screenCy, Math.max(1, pulseRadius), 0, Math.PI * 2);
    overlayCtx.strokeStyle = 'rgba(239, 68, 68, 0.4)';
    overlayCtx.lineWidth = 3;
    overlayCtx.stroke();
  }

  // Main Detection Circle Stroke
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
  overlayCtx.shadowBlur = 0;

  // Feature 2: Debug Mode outline for Active Detection Area (Inner Circle excluding Fire Guard Band)
  if (state.debugEnabled && state.guardBandPercent > 0) {
    const activeR = screenR * (1 - state.guardBandPercent / 100);
    overlayCtx.save();
    overlayCtx.beginPath();
    overlayCtx.arc(screenCx, screenCy, Math.max(1, activeR), 0, Math.PI * 2);
    overlayCtx.strokeStyle = 'rgba(147, 197, 253, 0.6)';
    overlayCtx.lineWidth = 1.5;
    overlayCtx.setLineDash([4, 4]);
    overlayCtx.stroke();
    overlayCtx.restore();
  }

  // Setup mode handles (Crosshair & Radius Handle)
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

    const handleX = screenCx + screenR;
    const handleY = screenCy;
    overlayCtx.beginPath();
    overlayCtx.arc(handleX, handleY, 6, 0, Math.PI * 2);
    overlayCtx.fillStyle = '#ffffff';
    overlayCtx.fill();
    overlayCtx.strokeStyle = strokeColor;
    overlayCtx.lineWidth = 2;
    overlayCtx.stroke();

    // Zone status label pill
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
    const badgePadX = 8;
    const badgeW = textWidth + badgePadX * 2;
    const badgeH = 20;
    const badgeX = screenCx - badgeW / 2;
    const badgeY = screenCy - screenR - badgeH - 6;

    if (badgeY > 4) {
      overlayCtx.fillStyle = 'rgba(9, 13, 22, 0.85)';
      overlayCtx.strokeStyle = strokeColor;
      overlayCtx.lineWidth = 1;
      overlayCtx.beginPath();
      overlayCtx.roundRect(badgeX, badgeY, badgeW, badgeH, 10);
      overlayCtx.fill();
      overlayCtx.stroke();

      overlayCtx.fillStyle = '#ffffff';
      overlayCtx.textAlign = 'center';
      overlayCtx.textBaseline = 'middle';
      overlayCtx.fillText(labelText, screenCx, badgeY + badgeH / 2);
    }
  }

  overlayCtx.restore();

  if (state.isAlignmentGridVisible) {
    drawAlignmentGrid();
  }
}

/**
 * Feature 3: Draw Camera-to-Projector Alignment Grid & Target Overlay.
 */
function drawAlignmentGrid() {
  if (!alignmentGridCtx || !dom.alignmentGridCanvas) return;

  const dpr = window.devicePixelRatio || 1;
  const w = dom.alignmentGridCanvas.width / dpr;
  const h = dom.alignmentGridCanvas.height / dpr;
  const rect = getVideoRenderRect();

  alignmentGridCtx.save();
  alignmentGridCtx.setTransform(1, 0, 0, 1, 0, 0);
  alignmentGridCtx.clearRect(0, 0, dom.alignmentGridCanvas.width, dom.alignmentGridCanvas.height);
  alignmentGridCtx.scale(dpr, dpr);

  // Background semi-dark grid
  alignmentGridCtx.strokeStyle = 'rgba(59, 130, 246, 0.22)';
  alignmentGridCtx.lineWidth = 1;

  // 10% grid lines
  for (let x = 0; x <= w; x += w / 10) {
    alignmentGridCtx.beginPath();
    alignmentGridCtx.moveTo(x, 0);
    alignmentGridCtx.lineTo(x, h);
    alignmentGridCtx.stroke();
  }
  for (let y = 0; y <= h; y += h / 10) {
    alignmentGridCtx.beginPath();
    alignmentGridCtx.moveTo(0, y);
    alignmentGridCtx.lineTo(w, y);
    alignmentGridCtx.stroke();
  }

  // Center Crosshair
  alignmentGridCtx.strokeStyle = '#38bdf8';
  alignmentGridCtx.lineWidth = 1.8;
  alignmentGridCtx.beginPath();
  alignmentGridCtx.moveTo(w / 2, 0);
  alignmentGridCtx.lineTo(w / 2, h);
  alignmentGridCtx.moveTo(0, h / 2);
  alignmentGridCtx.lineTo(w, h / 2);
  alignmentGridCtx.stroke();

  // Draw Projected Target Ring
  const proj = getProjectorCoordinates(state.zone.cx, state.zone.cy, state.zone.r);
  const pcx = rect.left + proj.cx * rect.width;
  const pcy = rect.top + proj.cy * rect.height;
  const pr = proj.r * rect.minDim;

  alignmentGridCtx.strokeStyle = '#f59e0b';
  alignmentGridCtx.lineWidth = 3;
  alignmentGridCtx.setLineDash([8, 8]);
  alignmentGridCtx.beginPath();
  alignmentGridCtx.arc(pcx, pcy, pr, 0, Math.PI * 2);
  alignmentGridCtx.stroke();
  alignmentGridCtx.setLineDash([]);

  // Orientation mark at 12 o'clock
  alignmentGridCtx.fillStyle = '#ef4444';
  alignmentGridCtx.beginPath();
  alignmentGridCtx.arc(pcx, pcy - pr, 6, 0, Math.PI * 2);
  alignmentGridCtx.fill();

  // Alignment banner
  alignmentGridCtx.fillStyle = 'rgba(15, 23, 42, 0.9)';
  alignmentGridCtx.strokeStyle = '#38bdf8';
  alignmentGridCtx.lineWidth = 1;
  alignmentGridCtx.beginPath();
  alignmentGridCtx.roundRect(w / 2 - 140, 16, 280, 28, 6);
  alignmentGridCtx.fill();
  alignmentGridCtx.stroke();

  alignmentGridCtx.fillStyle = '#ffffff';
  alignmentGridCtx.font = '600 12px var(--font-sans)';
  alignmentGridCtx.textAlign = 'center';
  alignmentGridCtx.textBaseline = 'middle';
  alignmentGridCtx.fillText('ALIGNMENT GRID ACTIVE (Tap to match floor)', w / 2, 30);

  alignmentGridCtx.restore();
}

/* =========================================================================
   4. Touch & Pointer Drag / Pinch Controls
   ========================================================================= */

function setupPointerInteractions() {
  const canvas = dom.overlayCanvas;

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    state.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (state.activePointers.size === 1) {
      const rect = getVideoRenderRect();
      const pointerX = (e.clientX - rect.left) / rect.width;
      const pointerY = (e.clientY - rect.top) / rect.height;

      state.dragStartZone = {
        pointerX,
        pointerY,
        zoneCx: state.zone.cx,
        zoneCy: state.zone.cy
      };
    } else if (state.activePointers.size === 2) {
      const pts = Array.from(state.activePointers.values());
      state.initialPinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      state.initialPinchRadius = state.zone.r;
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!state.activePointers.has(e.pointerId)) return;
    state.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // Dragging locked during active monitoring
    if (state.isMonitoring) return;

    if (state.activePointers.size === 1 && state.dragStartZone) {
      const rect = getVideoRenderRect();
      const currentX = (e.clientX - rect.left) / rect.width;
      const currentY = (e.clientY - rect.top) / rect.height;

      const deltaX = currentX - state.dragStartZone.pointerX;
      const deltaY = currentY - state.dragStartZone.pointerY;

      state.zone.cx = state.dragStartZone.zoneCx + deltaX;
      state.zone.cy = state.dragStartZone.zoneCy + deltaY;

      clampZoneCoordinates();
      drawOverlay();
      detector.resetBackground();
    } else if (state.activePointers.size === 2 && state.initialPinchDist > 0) {
      const pts = Array.from(state.activePointers.values());
      const currentDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const ratio = currentDist / state.initialPinchDist;

      state.zone.r = state.initialPinchRadius * ratio;
      clampZoneCoordinates();
      drawOverlay();
      detector.resetBackground();
    }
  });

  const onPointerUp = (e) => {
    state.activePointers.delete(e.pointerId);
    if (state.activePointers.size === 0) {
      state.dragStartZone = null;
      persistSettings();
    }
  };

  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
}

/* =========================================================================
   5. Fullscreen Monitor View & Projector Mode Transitions
   ========================================================================= */

function applyProjectorMode(isProj) {
  state.isProjectorMode = isProj;
  dom.appLayout.classList.toggle('projector-mode-active', isProj);
  drawOverlay();
}

function enterMonitorView() {
  if (state.isMonitorView) return;
  state.isMonitorView = true;
  dom.appLayout.classList.add('monitor-view-active');

  // Request native fullscreen where supported
  try {
    const el = dom.videoContainer;
    if (el.requestFullscreen) {
      el.requestFullscreen().catch(() => {});
    } else if (el.webkitRequestFullscreen) {
      el.webkitRequestFullscreen();
    }
  } catch (err) {
    // Fail silently
  }

  showMonitorQuickBar();
  resizeOverlayCanvas();
  drawOverlay();
}

function exitMonitorView() {
  if (!state.isMonitorView) return;
  state.isMonitorView = false;
  dom.appLayout.classList.remove('monitor-view-active');

  try {
    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    } else if (document.webkitFullscreenElement && document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
  } catch (err) {
    // Fail silently
  }

  if (state.quickBarTimer) {
    clearTimeout(state.quickBarTimer);
    state.quickBarTimer = null;
  }
  dom.monitorQuickBar.classList.add('hidden');

  resizeOverlayCanvas();
  drawOverlay();
}

function showMonitorQuickBar() {
  dom.monitorQuickBar.classList.remove('hidden');
  if (state.quickBarTimer) {
    clearTimeout(state.quickBarTimer);
  }
  // Auto-hide after 4 seconds
  state.quickBarTimer = setTimeout(() => {
    if (state.isMonitorView) {
      dom.monitorQuickBar.classList.add('hidden');
    }
  }, 4000);
}

// Tap container to toggle quick bar
dom.videoContainer.addEventListener('click', (e) => {
  if (!state.isMonitorView) return;
  if (e.target.closest('#monitorQuickBar') || e.target.closest('#alertVideoOverlay')) return;

  if (dom.monitorQuickBar.classList.contains('hidden')) {
    showMonitorQuickBar();
  } else {
    dom.monitorQuickBar.classList.add('hidden');
  }
});

/* =========================================================================
   6. Camera Lifecycle & Device Handling
   ========================================================================= */

async function startCamera() {
  stopCamera();
  if (state.isDemoMode) stopDemoMode();
  if (videoPlayer) {
    videoPlayer.unlockAutoplay();
  }

  updateStatusBadge('STARTING_CAMERA');
  showToast('Requesting camera access...', 'info');

  const idealConstraints = {
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1280 },
      height: { ideal: 720 }
    }
  };

  try {
    try {
      state.stream = await navigator.mediaDevices.getUserMedia(idealConstraints);
    } catch {
      // Fallback to any available camera
      state.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
    }

    dom.cameraFeed.srcObject = state.stream;
    await dom.cameraFeed.play();

    state.isCameraActive = true;
    dom.emptyCameraState.classList.add('hidden');

    // Start Fire Ring animation loop
    if (fireRing) {
      fireRing.start();
    }

    const track = state.stream.getVideoTracks()[0];
    if (track) {
      track.addEventListener('ended', onStreamEnded);
      track.addEventListener('mute', onStreamMuted);
      track.addEventListener('unmute', onStreamUnmuted);
    }

    updateUI();
    resizeOverlayCanvas();
    clampZoneCoordinates();
    drawOverlay();

    showToast('Camera active. Position circle and tap Start Monitoring', 'success');
  } catch (err) {
    console.error('Camera access error:', err);
    state.isCameraActive = false;
    updateUI();
    showToast(`Camera error: ${err.message || 'Permission denied'}`, 'error');
  }
}

function stopCamera() {
  if (state.isMonitoring) {
    stopMonitoring();
  }

  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }

  dom.cameraFeed.srcObject = null;
  state.isCameraActive = false;

  dom.emptyCameraState.classList.remove('hidden');

  if (fireRing) {
    fireRing.stop();
  }

  updateUI();
  drawOverlay();
}

function onStreamEnded() {
  showToast('Camera disconnected', 'error');
  stopCamera();
}

function onStreamMuted() {
  if (state.isMonitoring && !state.isPaused) {
    pauseMonitoring('Camera feed interrupted');
  }
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
   7. Vision Loop & Video Alert Coordination
   ========================================================================= */

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

  // Feature 2.2: Steady-state calibration
  // Calibration starts WITH the fire ring running at normal intensity, so the
  // floor's average illumination from the flames is part of the baseline.
  if (fireRing) {
    fireRing.start();
    fireRing.setState('CALIBRATING');
  }

  detector.startCalibration(12, EngineState.CALIBRATING);
  updateUI();

  showToast('Calibrating background (~2s) with fire baseline...', 'info');

  scheduleNextFrame();
}

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
  if (state.isVideoPlaying) return;

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

function onVideoFrame(now) {
  if (state.isVideoPlaying) return;

  const delta = now - state.lastProcessTimestamp;
  if (delta < state.sampleIntervalMs) {
    scheduleNextFrame();
    return;
  }
  state.lastProcessTimestamp = now;

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

  const sourceElement = state.isDemoMode ? dom.demoCanvas : dom.cameraFeed;
  const metrics = processFrame(sourceElement, now);

  drawOverlay(metrics.state, metrics.changedPercent);

  // Auto-switch to Monitor View when calibration finishes
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

  // 2. Feature 2.1: Draw guard thumbnail strictly EXCLUDING the lit fire zone
  guardCtx.clearRect(0, 0, dom.guardCanvas.width, dom.guardCanvas.height);
  guardCtx.drawImage(
    sourceElement,
    0, 0, srcW, srcH,
    0, 0, dom.guardCanvas.width, dom.guardCanvas.height
  );

  const guardScaleX = dom.guardCanvas.width / srcW;
  const guardScaleY = dom.guardCanvas.height / srcH;
  const gcx = cxPixels * guardScaleX;
  const gcy = cyPixels * guardScaleY;
  const gr = rPixels * Math.max(guardScaleX, guardScaleY) * 1.35; // Exclude circle + outer flame reach

  guardCtx.save();
  guardCtx.globalCompositeOperation = 'destination-out';
  guardCtx.beginPath();
  guardCtx.arc(gcx, gcy, Math.max(2, gr), 0, Math.PI * 2);
  guardCtx.fill();
  guardCtx.restore();

  const guardImageData = guardCtx.getImageData(0, 0, dom.guardCanvas.width, dom.guardCanvas.height);

  // 3. Process via MotionDetector
  const result = detector.process(roiImageData, guardImageData, timestamp);

  if (state.debugEnabled) {
    updateDebugHud(result);
  }

  return result;
}

/**
 * Handle motion event: triggers fire flare, then video player or sound alert.
 */
function onMotionAlert(metrics) {
  const now = new Date();
  const timeStr = now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0');
  dom.alertTimestamp.textContent = `${timeStr} (${metrics.changedPercent.toFixed(1)}% area)`;

  // Feature 1.3: Fire Ring Flare on motion!
  if (fireRing) {
    fireRing.flare(500);
  }
  projectorChannel.postMessage({ type: 'flare', duration: 500 });

  // Feature 2: Motion Video Alert
  if (state.isVideoOnMotion && videoPlayer) {
    state.isVideoPlaying = true;
    updateStatusBadge('VIDEO_PLAYING');

    projectorChannel.postMessage({
      type: 'video_play',
      src: videoPlayer.currentObjectUrl || videoPlayer.defaultVideoSrc
    });

    videoPlayer.playAlertVideo({
      onFallbackSound: () => {
        // If autoplay policy forces video muted on mobile/laptop, trigger audio alert in parallel
        audioAlert.triggerAlert();
      },
      onEnded: () => {
        onVideoPlaybackDone();
      },
      onSkipped: () => {
        onVideoPlaybackDone();
      },
      onError: (err) => {
        console.warn('Video alert playback failed:', err);
        audioAlert.triggerAlert();
        onVideoPlaybackDone();
      }
    });
  } else {
    // Sound fallback alert
    audioAlert.triggerAlert();

    // Feature 2.4: Flare suppression when video is disabled
    // Suppress detection during the 500ms flare, then run short recalibration
    setTimeout(() => {
      if (state.isMonitoring) {
        detector.startCalibration(6, EngineState.RESUMING);
      }
    }, 500);
  }
}

function onVideoPlaybackDone() {
  state.isVideoPlaying = false;
  projectorChannel.postMessage({ type: 'video_stop' });

  if (state.isMonitoring) {
    startPostVideoRecalibration();
  } else {
    updateUI();
    drawOverlay();
  }
}

function startPostVideoRecalibration() {
  updateStatusBadge('RESUMING');
  detector.startCalibration(8, EngineState.RESUMING);
  updateUI();
  drawOverlay();
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

  if (dom.debugFireFpsVal && fireRing) {
    dom.debugFireFpsVal.textContent = `${fireRing.fps} FPS (${fireRing.activeParticleCount} pts)`;
  }
  if (dom.debugActiveRadiusVal) {
    const act = Math.round((1 - state.guardBandPercent / 100) * 100);
    dom.debugActiveRadiusVal.textContent = `${act}% (${state.guardBandPercent}% guard)`;
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
   8. Feature 2.5: Projector Stability 10-Second Benchmark
   ========================================================================= */

async function runProjectorTest() {
  if (state.isProjectorTesting) return;
  if (!state.isMonitoring && !state.isDemoMode) {
    showToast('Start camera and monitoring first before testing stability!', 'warning');
    return;
  }

  state.isProjectorTesting = true;
  dom.btnProjectorTest.disabled = true;
  dom.projectorTestResult.textContent = 'Testing stability for 10s (Keep circle empty)...';
  showToast('Starting 10-second Projector Stability Benchmark...', 'info');

  const startTime = performance.now();
  const testDuration = 10000;
  let maxChanged = 0;
  let sumChanged = 0;
  let frameCount = 0;
  let falseAlerts = 0;

  const testInterval = setInterval(() => {
    const elapsed = performance.now() - startTime;
    const remaining = Math.max(0, Math.ceil((testDuration - elapsed) / 1000));

    const changed = detector.lastChangedPercent;
    maxChanged = Math.max(maxChanged, changed);
    sumChanged += changed;
    frameCount++;

    if (detector.state === EngineState.ALERTING) {
      falseAlerts++;
    }

    dom.projectorTestResult.textContent = `Testing: ${remaining}s left | Max: ${maxChanged.toFixed(1)}%`;

    if (elapsed >= testDuration) {
      clearInterval(testInterval);
      state.isProjectorTesting = false;
      dom.btnProjectorTest.disabled = false;

      const avgChanged = frameCount > 0 ? (sumChanged / frameCount).toFixed(2) : '0';
      const enterThreshold = detector.minAreaPercent;

      if (falseAlerts > 0 || maxChanged >= enterThreshold) {
        const msg = `⚠️ Warning: Max change was ${maxChanged.toFixed(1)}% (Threshold: ${enterThreshold}%). ${falseAlerts} false alerts detected. Suggest raising Guard Band slider by 3-5%.`;
        dom.projectorTestResult.textContent = msg;
        showToast(msg, 'warning');
      } else {
        const msg = `✅ Pass: 0 false alerts. Max changed ${maxChanged.toFixed(1)}% (Avg: ${avgChanged}%). Stability baseline is clean!`;
        dom.projectorTestResult.textContent = msg;
        showToast(msg, 'success');
      }
    }
  }, 200);
}

/* =========================================================================
   9. Demo Mode Simulation
   ========================================================================= */

function toggleDemoMode() {
  if (state.isDemoMode) {
    stopDemoMode();
  } else {
    startDemoMode();
  }
}

function startDemoMode() {
  stopCamera();
  state.isDemoMode = true;

  dom.demoCanvas.width = 640;
  dom.demoCanvas.height = 480;
  dom.demoCanvas.classList.remove('hidden');
  dom.emptyCameraState.classList.add('hidden');

  generateDemoNoisePattern();

  if (fireRing) {
    fireRing.start();
  }

  updateUI();
  resizeOverlayCanvas();
  drawOverlay();

  runDemoAnimationLoop();
  showToast('Demo Mode active with synthetic ground & target', 'info');
}

function stopDemoMode() {
  if (state.isMonitoring) {
    stopMonitoring();
  }
  state.isDemoMode = false;
  dom.demoCanvas.classList.add('hidden');
  dom.emptyCameraState.classList.remove('hidden');

  if (fireRing) {
    fireRing.stop();
  }

  updateUI();
  drawOverlay();
}

function generateDemoNoisePattern() {
  const w = dom.demoCanvas.width;
  const h = dom.demoCanvas.height;
  const offscreen = document.createElement('canvas');
  offscreen.width = w;
  offscreen.height = h;
  const octx = offscreen.getContext('2d');

  octx.fillStyle = '#2d2d2d';
  octx.fillRect(0, 0, w, h);

  const imgData = octx.getImageData(0, 0, w, h);
  const data = imgData.data;
  for (let i = 0; i < data.length; i += 4) {
    const grain = (Math.random() - 0.5) * 24;
    data[i] = Math.min(255, Math.max(0, data[i] + grain));
    data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + grain));
    data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + grain));
  }
  octx.putImageData(imgData, 0, 0);
  demoNoisePattern = offscreen;
}

function runDemoAnimationLoop() {
  if (!state.isDemoMode) return;

  const w = dom.demoCanvas.width;
  const h = dom.demoCanvas.height;

  demoCtx.drawImage(demoNoisePattern, 0, 0);

  // Moving synthetic target
  demoAngle += 0.025;
  demoTargetX = 0.5 + Math.cos(demoAngle) * 0.22;
  demoTargetY = 0.5 + Math.sin(demoAngle * 1.5) * 0.18;

  const tx = demoTargetX * w;
  const ty = demoTargetY * h;
  const tr = 24;

  const grad = demoCtx.createRadialGradient(tx, ty, 0, tx, ty, tr);
  grad.addColorStop(0, '#e5e7eb');
  grad.addColorStop(0.7, '#9ca3af');
  grad.addColorStop(1, '#4b5563');

  demoCtx.beginPath();
  demoCtx.arc(tx, ty, tr, 0, Math.PI * 2);
  demoCtx.fillStyle = grad;
  demoCtx.fill();

  requestAnimationFrame(runDemoAnimationLoop);
}

/* =========================================================================
   10. Wake Lock Management
   ========================================================================= */

async function acquireWakeLock() {
  if ('wakeLock' in navigator && !state.wakeLock) {
    try {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => {
        state.wakeLock = null;
      });
    } catch {
      // Wake lock not granted or unsupported
    }
  }
}

function releaseWakeLock() {
  if (state.wakeLock) {
    state.wakeLock.release().catch(() => {});
    state.wakeLock = null;
  }
}

/* =========================================================================
   11. UI State Synchronization & Settings Persistence
   ========================================================================= */

function updateUI() {
  const isReady = state.isCameraActive || state.isDemoMode;

  dom.btnMonitor.disabled = !isReady;
  dom.btnRecalibrate.disabled = !state.isMonitoring;

  if (state.isCameraActive) {
    dom.btnStartCamera.classList.remove('btn-primary');
    dom.btnStartCamera.classList.add('btn-secondary');
    dom.btnStartCamera.querySelector('.btn-text').textContent = 'Stop Camera';
  } else {
    dom.btnStartCamera.classList.add('btn-primary');
    dom.btnStartCamera.classList.remove('btn-secondary');
    dom.btnStartCamera.querySelector('.btn-text').textContent = 'Start Camera';
  }

  if (state.isMonitoring) {
    dom.btnMonitor.classList.remove('btn-success');
    dom.btnMonitor.classList.add('btn-danger');
    dom.btnMonitor.querySelector('.btn-text').textContent = 'Stop Monitoring';
    dom.btnMonitor.querySelector('.btn-icon').textContent = '⏹';
  } else {
    dom.btnMonitor.classList.add('btn-success');
    dom.btnMonitor.classList.remove('btn-danger');
    dom.btnMonitor.querySelector('.btn-text').textContent = 'Start Monitoring';
    dom.btnMonitor.querySelector('.btn-icon').textContent = '▶';
  }

  dom.btnDemo.classList.toggle('active', state.isDemoMode);
}

function updateStatusBadge(statusKey) {
  const badge = dom.statusBadge;
  const text = dom.statusText;

  badge.className = 'status-badge';

  switch (statusKey) {
    case 'STARTING_CAMERA':
      badge.classList.add('state-calibrating');
      text.textContent = 'Starting Camera...';
      break;
    case EngineState.CALIBRATING:
      badge.classList.add('state-calibrating');
      text.textContent = 'Calibrating (~2s)...';
      break;
    case EngineState.RESUMING:
      badge.classList.add('state-calibrating');
      text.textContent = 'Resuming...';
      break;
    case EngineState.MONITORING:
      badge.classList.add('state-monitoring');
      text.textContent = 'Monitoring Circle';
      break;
    case EngineState.CANDIDATE:
      badge.classList.add('state-candidate');
      text.textContent = 'Motion Candidate...';
      break;
    case EngineState.ALERTING:
      badge.classList.add('state-alert');
      text.textContent = 'MOTION DETECTED!';
      break;
    case 'VIDEO_PLAYING':
      badge.classList.add('state-alert');
      text.textContent = 'Playing Alert Video';
      break;
    case EngineState.COOLDOWN:
      badge.classList.add('state-monitoring');
      text.textContent = 'Alert Cooldown';
      break;
    case EngineState.SUPPRESSED:
      badge.classList.add('state-calibrating');
      text.textContent = 'Stabilizing Bump';
      break;
    default:
      if (state.isCameraActive || state.isDemoMode) {
        badge.classList.add('state-monitoring');
        text.textContent = 'Camera Ready';
      } else {
        badge.classList.add('state-idle');
        text.textContent = 'Camera Off';
      }
      break;
  }
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;

  dom.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 400);
  }, 3200);
}

function applyPreset(presetKey) {
  if (detector.setPreset(presetKey)) {
    state.activePreset = presetKey;
    Object.keys(dom.presetButtons).forEach((key) => {
      dom.presetButtons[key].classList.toggle('active', key === presetKey);
    });
    dom.customPresetBadge.classList.add('hidden');

    const p = SENSITIVITY_PRESETS[presetKey];
    dom.pixelThresholdSlider.value = p.pixelDiffThreshold;
    dom.pixelThresholdVal.textContent = p.pixelDiffThreshold;
    dom.areaThresholdSlider.value = p.minAreaPercent;
    dom.areaThresholdVal.textContent = `${p.minAreaPercent.toFixed(1)}%`;
    dom.confirmFramesSlider.value = p.consecutiveFrames;
    dom.confirmFramesVal.textContent = p.consecutiveFrames;

    persistSettings();
    showToast(`Applied ${presetKey.toUpperCase()} sensitivity preset`, 'info');
  }
}

function onCustomSliderChange() {
  state.activePreset = 'custom';
  Object.keys(dom.presetButtons).forEach((key) => {
    dom.presetButtons[key].classList.remove('active');
  });
  dom.customPresetBadge.classList.remove('hidden');

  detector.setParameters({
    pixelDiffThreshold: Number(dom.pixelThresholdSlider.value),
    minAreaPercent: Number(dom.areaThresholdSlider.value),
    consecutiveFrames: Number(dom.confirmFramesSlider.value),
    cooldownMs: Number(dom.cooldownSlider.value) * 1000
  });

  persistSettings();
}

function selectFireThemePreset(themeKey) {
  state.fireTheme = themeKey;
  Object.keys(dom.firePresets).forEach((k) => {
    if (dom.firePresets[k]) {
      dom.firePresets[k].classList.toggle('active', k === themeKey);
    }
  });
  if (fireRing) {
    fireRing.setOptions({ theme: themeKey });
  }
  broadcastProjectorSync();
  persistSettings();
}

function persistSettings() {
  try {
    const data = {
      zone: state.zone,
      maskColor: state.maskColor,
      maskOpacity: state.maskOpacity,
      videoOnMotion: state.isVideoOnMotion,
      videoAudio: state.isVideoAudio,
      preset: state.activePreset,
      pixelDiffThreshold: detector.pixelDiffThreshold,
      minAreaPercent: detector.minAreaPercent,
      consecutiveFrames: detector.consecutiveFrames,
      cooldown: detector.cooldownMs / 1000,
      sampleInterval: state.sampleIntervalMs,
      volume: Math.round(audioAlert.volume * 100),
      muted: audioAlert.isMuted,
      soundType: audioAlert.soundType,
      vibrate: audioAlert.vibrationEnabled,
      debug: state.debugEnabled,

      // Fire Ring
      fireEnabled: state.isFireEnabled,
      fireIntensity: state.fireIntensity,
      fireThickness: state.fireThickness,
      fireSpeed: state.fireSpeed,
      fireTheme: state.fireTheme,
      fireCustomColor: state.fireCustomColor,
      fireEmbers: state.fireEmbers,
      fireGlow: state.fireGlow,
      fireCrackle: state.fireCrackle,
      fireCrackleVolume: state.fireCrackleVolume,

      // Feedback Protection
      guardBandPercent: state.guardBandPercent,

      // Projector Mode & Alignment
      projectorMode: state.isProjectorMode,
      alignment: state.alignment,
      version: 2
    };
    localStorage.setItem('ground_motion_detector_prefs', JSON.stringify(data));
  } catch {
    // Fail silently
  }
}

function loadPersistedSettings() {
  try {
    const saved = localStorage.getItem('ground_motion_detector_prefs');
    if (!saved) return;
    const data = JSON.parse(saved);

    // Automatically migrate prior session cache to screenshot defaults
    if (!data.version || data.version < 2) {
      data.fireIntensity = 2.5;
      data.fireThickness = 32;
      data.fireSpeed = 1.0;
      data.fireTheme = 'orange';
      data.fireCustomColor = '#ff4500';
      data.fireEmbers = true;
      data.fireGlow = true;
      data.fireCrackle = true;
      data.fireCrackleVolume = 0.6;
      data.version = 2;
      localStorage.setItem('ground_motion_detector_prefs', JSON.stringify(data));
    }

    if (data.zone) {
      state.zone.cx = data.zone.cx ?? 0.5;
      state.zone.cy = data.zone.cy ?? 0.5;
      state.zone.r = data.zone.r ?? 0.20;
      clampZoneCoordinates();
    }

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

    // Fire Ring
    if (data.fireEnabled !== undefined) {
      state.isFireEnabled = Boolean(data.fireEnabled);
      dom.fireRingToggle.checked = state.isFireEnabled;
      if (fireRing) fireRing.setOptions({ enabled: state.isFireEnabled });
    }
    if (data.fireIntensity !== undefined) {
      state.fireIntensity = Number(data.fireIntensity);
      dom.fireIntensitySlider.value = state.fireIntensity;
      dom.fireIntensityVal.textContent = `${state.fireIntensity.toFixed(1)}x`;
      if (fireRing) fireRing.setOptions({ intensity: state.fireIntensity });
    }
    if (data.fireThickness !== undefined) {
      state.fireThickness = Number(data.fireThickness);
      dom.fireThicknessSlider.value = state.fireThickness;
      dom.fireThicknessVal.textContent = `${state.fireThickness}px`;
      if (fireRing) fireRing.setOptions({ thickness: state.fireThickness });
    }
    if (data.fireSpeed !== undefined) {
      state.fireSpeed = Number(data.fireSpeed);
      dom.fireSpeedSlider.value = state.fireSpeed;
      dom.fireSpeedVal.textContent = `${state.fireSpeed.toFixed(1)}x`;
      if (fireRing) fireRing.setOptions({ speed: state.fireSpeed });
    }
    if (data.fireTheme) {
      state.fireTheme = data.fireTheme;
      selectFireThemePreset(data.fireTheme);
    }
    if (data.fireCustomColor) {
      state.fireCustomColor = data.fireCustomColor;
      dom.fireCustomColorPicker.value = data.fireCustomColor;
      dom.fireCustomColorHex.textContent = data.fireCustomColor.toUpperCase();
      if (fireRing) fireRing.setOptions({ customColor: state.fireCustomColor });
    }
    if (data.fireEmbers !== undefined) {
      state.fireEmbers = Boolean(data.fireEmbers);
      dom.fireEmbersToggle.checked = state.fireEmbers;
      if (fireRing) fireRing.setOptions({ embersEnabled: state.fireEmbers });
    }
    if (data.fireGlow !== undefined) {
      state.fireGlow = Boolean(data.fireGlow);
      dom.fireGlowToggle.checked = state.fireGlow;
      if (fireRing) fireRing.setOptions({ interiorGlow: state.fireGlow });
    }
    if (data.fireCrackle !== undefined) {
      state.fireCrackle = Boolean(data.fireCrackle);
      dom.fireCrackleToggle.checked = state.fireCrackle;
      dom.crackleVolumeGroup.style.display = state.fireCrackle ? 'flex' : 'none';
      if (fireRing) fireRing.setOptions({ crackleEnabled: state.fireCrackle });
    }
    if (data.fireCrackleVolume !== undefined) {
      state.fireCrackleVolume = Number(data.fireCrackleVolume);
      dom.fireCrackleVolumeSlider.value = Math.round(state.fireCrackleVolume * 100);
      dom.fireCrackleVolumeVal.textContent = `${Math.round(state.fireCrackleVolume * 100)}%`;
      if (fireRing) fireRing.setOptions({ crackleVolume: state.fireCrackleVolume });
    }

    // Feedback Protection
    if (data.guardBandPercent !== undefined) {
      state.guardBandPercent = Number(data.guardBandPercent);
      dom.guardBandSlider.value = state.guardBandPercent;
      dom.guardBandVal.textContent = `${state.guardBandPercent}%`;
      detector.setGuardBandPercent(state.guardBandPercent);
    }

    // Projector Mode & Alignment
    if (data.projectorMode !== undefined) {
      state.isProjectorMode = Boolean(data.projectorMode);
      dom.projectorModeToggle.checked = state.isProjectorMode;
      applyProjectorMode(state.isProjectorMode);
    }
    if (data.alignment) {
      state.alignment = { ...state.alignment, ...data.alignment };
      dom.projectorOffsetXSlider.value = Math.round(state.alignment.offsetX * 100);
      dom.projectorOffsetXVal.textContent = `${Math.round(state.alignment.offsetX * 100)}%`;
      dom.projectorOffsetYSlider.value = Math.round(state.alignment.offsetY * 100);
      dom.projectorOffsetYVal.textContent = `${Math.round(state.alignment.offsetY * 100)}%`;
      dom.projectorScaleSlider.value = Math.round(state.alignment.scale * 100);
      dom.projectorScaleVal.textContent = `${Math.round(state.alignment.scale * 100)}%`;
      dom.projectorFlipHToggle.checked = state.alignment.flipH;
      dom.projectorFlipVToggle.checked = state.alignment.flipV;
      dom.projectorRotationSelect.value = String(state.alignment.rotation || 0);
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
    } else if (data.pixelDiffThreshold || data.minAreaPercent || data.consecutiveFrames) {
      detector.setParameters({
        pixelDiffThreshold: data.pixelDiffThreshold,
        minAreaPercent: data.minAreaPercent,
        consecutiveFrames: data.consecutiveFrames
      });
      dom.pixelThresholdSlider.value = detector.pixelDiffThreshold;
      dom.pixelThresholdVal.textContent = detector.pixelDiffThreshold;
      dom.areaThresholdSlider.value = detector.minAreaPercent;
      dom.areaThresholdVal.textContent = `${detector.minAreaPercent.toFixed(1)}%`;
      dom.confirmFramesSlider.value = detector.consecutiveFrames;
      dom.confirmFramesVal.textContent = detector.consecutiveFrames;
      dom.customPresetBadge.classList.remove('hidden');
    }
  } catch {
    // Fail silently
  }
}

/* =========================================================================
   12. Event Listeners & Setup
   ========================================================================= */

function initEventListeners() {
  // Primary buttons
  dom.btnStartCamera.addEventListener('click', () => {
    if (state.isCameraActive) {
      stopCamera();
    } else {
      startCamera();
    }
  });

  dom.emptyStartBtn.addEventListener('click', startCamera);

  dom.btnMonitor.addEventListener('click', () => {
    if (state.isMonitoring) {
      stopMonitoring();
    } else {
      startMonitoring();
    }
  });

  dom.btnDemo.addEventListener('click', toggleDemoMode);
  dom.emptyDemoBtn.addEventListener('click', startDemoMode);

  // Monitor View quick actions
  dom.btnQuickStop.addEventListener('click', (e) => {
    e.stopPropagation();
    stopMonitoring();
  });

  dom.btnQuickRecalibrate.addEventListener('click', (e) => {
    e.stopPropagation();
    detector.startCalibration(12, EngineState.CALIBRATING);
    showToast('Recalibrating background (~2s)...', 'info');
  });

  dom.btnQuickMute.addEventListener('click', (e) => {
    e.stopPropagation();
    const newMuted = !audioAlert.isMuted;
    audioAlert.setMuted(newMuted);
    dom.muteToggle.checked = newMuted;
    dom.btnQuickMute.textContent = newMuted ? '🔊 Unmute' : '🔇 Mute';
    showToast(newMuted ? 'Alert audio muted' : 'Alert audio unmuted', 'info');
    persistSettings();
  });

  // Zone actions
  dom.btnRecalibrate.addEventListener('click', () => {
    detector.startCalibration(12, EngineState.CALIBRATING);
    showToast('Recalibrating background (~2s)...', 'info');
  });

  dom.btnResetZone.addEventListener('click', () => {
    state.zone.cx = 0.5;
    state.zone.cy = 0.5;
    state.zone.r = 0.20;
    clampZoneCoordinates();
    drawOverlay();
    detector.resetBackground();
    persistSettings();
    showToast('Zone position reset to center', 'info');
  });

  dom.zoneSizeSlider.addEventListener('input', (e) => {
    state.zone.r = Number(e.target.value) / 100;
    clampZoneCoordinates();
    drawOverlay();
    detector.resetBackground();
    persistSettings();
  });

  // Feature 1: Fire Ring Controls
  dom.fireRingToggle.addEventListener('change', (e) => {
    state.isFireEnabled = e.target.checked;
    if (fireRing) fireRing.setOptions({ enabled: state.isFireEnabled });
    broadcastProjectorSync();
    persistSettings();
  });

  dom.fireIntensitySlider.addEventListener('input', (e) => {
    state.fireIntensity = Number(e.target.value);
    dom.fireIntensityVal.textContent = `${state.fireIntensity.toFixed(1)}x`;
    if (fireRing) fireRing.setOptions({ intensity: state.fireIntensity });
    broadcastProjectorSync();
    persistSettings();
  });

  dom.fireThicknessSlider.addEventListener('input', (e) => {
    state.fireThickness = Number(e.target.value);
    dom.fireThicknessVal.textContent = `${state.fireThickness}px`;
    if (fireRing) fireRing.setOptions({ thickness: state.fireThickness });
    broadcastProjectorSync();
    persistSettings();
  });

  dom.fireSpeedSlider.addEventListener('input', (e) => {
    state.fireSpeed = Number(e.target.value);
    dom.fireSpeedVal.textContent = `${state.fireSpeed.toFixed(1)}x`;
    if (fireRing) fireRing.setOptions({ speed: state.fireSpeed });
    broadcastProjectorSync();
    persistSettings();
  });

  Object.keys(dom.firePresets).forEach((themeKey) => {
    const btn = dom.firePresets[themeKey];
    if (btn) {
      btn.addEventListener('click', () => selectFireThemePreset(themeKey));
    }
  });

  dom.fireCustomColorPicker.addEventListener('input', (e) => {
    state.fireCustomColor = e.target.value;
    dom.fireCustomColorHex.textContent = e.target.value.toUpperCase();
    selectFireThemePreset('custom');
  });

  dom.fireEmbersToggle.addEventListener('change', (e) => {
    state.fireEmbers = e.target.checked;
    if (fireRing) fireRing.setOptions({ embersEnabled: state.fireEmbers });
    broadcastProjectorSync();
    persistSettings();
  });

  dom.fireGlowToggle.addEventListener('change', (e) => {
    state.fireGlow = e.target.checked;
    if (fireRing) fireRing.setOptions({ interiorGlow: state.fireGlow });
    broadcastProjectorSync();
    persistSettings();
  });

  dom.fireCrackleToggle.addEventListener('change', (e) => {
    state.fireCrackle = e.target.checked;
    dom.crackleVolumeGroup.style.display = state.fireCrackle ? 'flex' : 'none';
    if (fireRing) fireRing.setOptions({ crackleEnabled: state.fireCrackle });
    persistSettings();
  });

  dom.fireCrackleVolumeSlider.addEventListener('input', (e) => {
    state.fireCrackleVolume = Number(e.target.value) / 100;
    dom.fireCrackleVolumeVal.textContent = `${e.target.value}%`;
    if (fireRing) fireRing.setOptions({ crackleVolume: state.fireCrackleVolume });
    persistSettings();
  });

  // Feature 2: Guard Band Slider
  dom.guardBandSlider.addEventListener('input', (e) => {
    state.guardBandPercent = Number(e.target.value);
    dom.guardBandVal.textContent = `${state.guardBandPercent}%`;
    detector.setGuardBandPercent(state.guardBandPercent);
    drawOverlay();
    persistSettings();
  });

  // Feature 3: Projector Mode & Alignment Controls
  dom.projectorModeToggle.addEventListener('change', (e) => {
    applyProjectorMode(e.target.checked);
    persistSettings();
    showToast(state.isProjectorMode ? 'Projector Mode active (Black floor)' : 'Projector Mode disabled', 'info');
  });

  dom.btnToggleAlignmentGrid.addEventListener('click', () => {
    state.isAlignmentGridVisible = !state.isAlignmentGridVisible;
    if (dom.alignmentGridCanvas) {
      dom.alignmentGridCanvas.classList.toggle('hidden', !state.isAlignmentGridVisible);
    }
    dom.btnToggleAlignmentGrid.classList.toggle('active', state.isAlignmentGridVisible);
    if (state.isAlignmentGridVisible) {
      drawAlignmentGrid();
      showToast('Alignment grid active. Adjust sliders to match floor.', 'info');
    } else {
      showToast('Alignment grid hidden', 'info');
    }
  });

  dom.btnResetAlignment.addEventListener('click', () => {
    state.alignment = { offsetX: 0, offsetY: 0, scale: 1.0, flipH: false, flipV: false, rotation: 0 };
    dom.projectorOffsetXSlider.value = 0;
    dom.projectorOffsetXVal.textContent = '0%';
    dom.projectorOffsetYSlider.value = 0;
    dom.projectorOffsetYVal.textContent = '0%';
    dom.projectorScaleSlider.value = 100;
    dom.projectorScaleVal.textContent = '100%';
    dom.projectorFlipHToggle.checked = false;
    dom.projectorFlipVToggle.checked = false;
    dom.projectorRotationSelect.value = '0';
    drawOverlay();
    persistSettings();
    showToast('Projector alignment reset to default', 'info');
  });

  dom.btnOpenProjectorWindow.addEventListener('click', () => {
    if (!state.projectorWindowRef || state.projectorWindowRef.closed) {
      state.projectorWindowRef = window.open('projector.html', 'ProjectorWindow', 'width=1280,height=720');
      showToast('Opened popout projector window. Move it to your projector display!', 'success');
      setTimeout(broadcastProjectorSync, 500);
    } else {
      state.projectorWindowRef.focus();
    }
  });

  dom.projectorOffsetXSlider.addEventListener('input', (e) => {
    state.alignment.offsetX = Number(e.target.value) / 100;
    dom.projectorOffsetXVal.textContent = `${e.target.value}%`;
    drawOverlay();
    persistSettings();
  });

  dom.projectorOffsetYSlider.addEventListener('input', (e) => {
    state.alignment.offsetY = Number(e.target.value) / 100;
    dom.projectorOffsetYVal.textContent = `${e.target.value}%`;
    drawOverlay();
    persistSettings();
  });

  dom.projectorScaleSlider.addEventListener('input', (e) => {
    state.alignment.scale = Number(e.target.value) / 100;
    dom.projectorScaleVal.textContent = `${e.target.value}%`;
    drawOverlay();
    persistSettings();
  });

  dom.projectorFlipHToggle.addEventListener('change', (e) => {
    state.alignment.flipH = e.target.checked;
    drawOverlay();
    persistSettings();
  });

  dom.projectorFlipVToggle.addEventListener('change', (e) => {
    state.alignment.flipV = e.target.checked;
    drawOverlay();
    persistSettings();
  });

  dom.projectorRotationSelect.addEventListener('change', (e) => {
    state.alignment.rotation = Number(e.target.value);
    drawOverlay();
    persistSettings();
  });

  // Feature 2.5: Projector Test benchmark
  dom.btnProjectorTest.addEventListener('click', runProjectorTest);

  // Mask Controls
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
    showToast('Outside mask reset to solid black', 'info');
  });

  // Video Alert Controls
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

  dom.audioFileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (file && audioAlert) {
      await audioAlert.setCustomAudioFile(file);
      dom.audioSourceLabel.textContent = `Custom: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
      showToast(`Loaded custom audio: ${file.name}`, 'success');
    }
  });

  dom.btnResetAudio.addEventListener('click', async () => {
    if (audioAlert) {
      await audioAlert.resetToDefaultAudio();
      dom.audioFileInput.value = '';
      dom.audioSourceLabel.textContent = 'Default: Synthesized tone (Alarm / Beep)';
      showToast('Restored default synthesized sound', 'info');
    }
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
    drawOverlay();
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
  if (fireRing) fireRing.cleanup();
  audioAlert.cleanup();
  detector.destroy();
  projectorChannel.close();
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

  // Initialize Fire Ring engine
  fireRing = new FireRing(dom.fireCanvas, {
    enabled: state.isFireEnabled,
    intensity: state.fireIntensity,
    thickness: state.fireThickness,
    speed: state.fireSpeed,
    theme: state.fireTheme,
    customColor: state.fireCustomColor,
    embersEnabled: state.fireEmbers,
    interiorGlow: state.fireGlow,
    crackleEnabled: state.fireCrackle,
    crackleVolume: state.fireCrackleVolume
  });

  if (!AudioAlert.isVibrationSupported()) {
    dom.vibrationRow.style.display = 'none';
  }

  setupPointerInteractions();
  initEventListeners();
  loadPersistedSettings();

  // Restore persisted custom media source labels
  if (videoPlayer && videoPlayer.readyPromise) {
    videoPlayer.readyPromise.then(() => {
      if (videoPlayer.hasCustomVideo && videoPlayer.customVideoName) {
        dom.videoSourceLabel.textContent = `Custom: ${videoPlayer.customVideoName}`;
      }
    });
  }

  if (audioAlert && audioAlert.readyPromise) {
    audioAlert.readyPromise.then(() => {
      if (audioAlert.hasCustomAudio && audioAlert.customAudioName) {
        dom.audioSourceLabel.textContent = `Custom: ${audioAlert.customAudioName}`;
      }
    });
  }

  resizeOverlayCanvas();
  updateUI();
  drawOverlay();
});
