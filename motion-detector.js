/**
 * motion-detector.js
 * 
 * Pure, DOM-independent computer vision engine for circular zone motion detection.
 * Designed for on-device processing in browser environments.
 * 
 * Key Features:
 * - 3x3 noise reduction box filter
 * - Mean luminance normalization (suppresses global lighting shifts)
 * - Two-tier background model: Running average (absorbs stationary objects) + Previous frame differencing
 * - Circular mask filtering with precomputed lookup table
 * - Single-pass noise removal (suppresses isolated noise pixels)
 * - Connected-component approximation for largest blob size
 * - Global change guard (detects camera bumps / sudden light switches & suppresses false positives)
 * - State machine with hysteresis and frame confirmation
 * - Zero per-frame object allocation (reuses typed arrays)
 */

export const EngineState = {
  IDLE: 'IDLE',
  CALIBRATING: 'CALIBRATING',
  MONITORING: 'MONITORING',
  CANDIDATE: 'CANDIDATE',
  ALERTING: 'ALERTING',
  COOLDOWN: 'COOLDOWN',
  SUPPRESSED: 'SUPPRESSED'
};

export const SENSITIVITY_PRESETS = {
  low: {
    pixelDiffThreshold: 35,
    minAreaPercent: 6.0,
    consecutiveFrames: 3
  },
  medium: {
    pixelDiffThreshold: 25,
    minAreaPercent: 3.0,
    consecutiveFrames: 2
  },
  high: {
    pixelDiffThreshold: 15,
    minAreaPercent: 1.5,
    consecutiveFrames: 1
  }
};

export class MotionDetector {
  /**
   * @param {Object} options Configuration options
   */
  constructor(options = {}) {
    // Detection parameters
    this.pixelDiffThreshold = options.pixelDiffThreshold ?? SENSITIVITY_PRESETS.medium.pixelDiffThreshold;
    this.minAreaPercent = options.minAreaPercent ?? SENSITIVITY_PRESETS.medium.minAreaPercent;
    this.consecutiveFrames = options.consecutiveFrames ?? SENSITIVITY_PRESETS.medium.consecutiveFrames;
    this.cooldownMs = options.cooldownMs ?? 2000;
    this.calibrationTotalFrames = options.calibrationFrames ?? 12; // ~2 seconds at 150ms intervals
    
    // Background model learning rate: alpha ~ 0.04
    // Gives roughly a 25-frame (~3.7s) half-life for stationary objects to assimilate
    this.learningRate = options.learningRate ?? 0.04;
    
    // Global change guard settings
    this.globalChangeThreshold = options.globalChangeThreshold ?? 0.28; // 28% change triggers suppression
    this.globalSuppressionMs = options.globalSuppressionMs ?? 1500;
    
    // Hysteresis factor: exit threshold is 70% of enter threshold
    this.hysteresisFactor = 0.70;
    this.quietFramesToExit = 2;

    // State machine
    this.state = EngineState.IDLE;
    this.calibrationFrameCount = 0;
    this.candidateFrameCount = 0;
    this.quietFrameCount = 0;
    this.lastAlertTime = 0;
    this.suppressionEndTime = 0;
    this.suppressionReason = '';

    // Buffer dimensions
    this.width = 0;
    this.height = 0;
    this.totalPixels = 0;
    this.circlePixelCount = 0;

    // Guard buffer dimensions (outer ring / full frame thumbnail)
    this.guardWidth = 0;
    this.guardHeight = 0;
    this.guardTotalPixels = 0;

    // Typed arrays for zero-allocation buffer reuse
    this.mask = null;             // Uint8Array: 1 inside circle, 0 outside
    this.currentGray = null;      // Uint8Array: Grayscale + normalized current frame
    this.blurredGray = null;      // Uint8Array: 3x3 blurred current frame
    this.backgroundModel = null;  // Float32Array: Running average background
    this.previousGray = null;     // Uint8Array: Previous processed frame
    this.diffMask = null;         // Uint8Array: 255 for changed, 0 otherwise
    this.tempBinary = null;       // Uint8Array: For connected-component / noise pass
    this.labels = null;           // Int32Array: Connected component labeling

    // Guard buffers
    this.guardCurrentGray = null;
    this.guardBackground = null;

    // Status tracking
    this.hasBackground = false;
    this.lastChangedPercent = 0;
    this.lastBlobPercent = 0;
  }

  /**
   * Configure detection buffers for given dimensions.
   * Call whenever processing ROI dimensions change.
   * @param {number} width 
   * @param {number} height 
   * @param {number} guardWidth 
   * @param {number} guardHeight 
   */
  initBuffers(width, height, guardWidth = 32, guardHeight = 24) {
    if (this.width === width && this.height === height && 
        this.guardWidth === guardWidth && this.guardHeight === guardHeight && this.mask) {
      return;
    }

    this.width = width;
    this.height = height;
    this.totalPixels = width * height;

    this.guardWidth = guardWidth;
    this.guardHeight = guardHeight;
    this.guardTotalPixels = guardWidth * guardHeight;

    this.mask = new Uint8Array(this.totalPixels);
    this.currentGray = new Uint8Array(this.totalPixels);
    this.blurredGray = new Uint8Array(this.totalPixels);
    this.backgroundModel = new Float32Array(this.totalPixels);
    this.previousGray = new Uint8Array(this.totalPixels);
    this.diffMask = new Uint8Array(this.totalPixels);
    this.tempBinary = new Uint8Array(this.totalPixels);
    this.labels = new Int32Array(this.totalPixels);

    this.guardCurrentGray = new Uint8Array(this.guardTotalPixels);
    this.guardBackground = new Float32Array(this.guardTotalPixels);

    // Precompute circular mask for the inner square ROI
    const cx = (width - 1) / 2;
    const cy = (height - 1) / 2;
    const radius = Math.min(cx, cy);
    const radiusSq = radius * radius;

    let circleCount = 0;
    for (let y = 0; y < height; y++) {
      const dy = y - cy;
      const dySq = dy * dy;
      for (let x = 0; x < width; x++) {
        const dx = x - cx;
        const idx = y * width + x;
        if (dx * dx + dySq <= radiusSq) {
          this.mask[idx] = 1;
          circleCount++;
        } else {
          this.mask[idx] = 0;
        }
      }
    }
    this.circlePixelCount = circleCount > 0 ? circleCount : this.totalPixels;

    this.resetBackground();
  }

  /**
   * Reset background model and trigger calibration.
   */
  resetBackground() {
    this.hasBackground = false;
    this.calibrationFrameCount = 0;
    this.candidateFrameCount = 0;
    this.quietFrameCount = 0;
    if (this.state !== EngineState.IDLE) {
      this.state = EngineState.CALIBRATING;
    }
  }

  /**
   * Start calibration explicitly.
   */
  startCalibration() {
    this.resetBackground();
    this.state = EngineState.CALIBRATING;
  }

  /**
   * Set sensitivity preset ('low', 'medium', 'high').
   */
  setPreset(presetName) {
    const preset = SENSITIVITY_PRESETS[presetName];
    if (!preset) return false;
    this.pixelDiffThreshold = preset.pixelDiffThreshold;
    this.minAreaPercent = preset.minAreaPercent;
    this.consecutiveFrames = preset.consecutiveFrames;
    return true;
  }

  /**
   * Set custom parameter overrides.
   */
  setParameters({ pixelDiffThreshold, minAreaPercent, consecutiveFrames, cooldownMs }) {
    if (pixelDiffThreshold !== undefined) this.pixelDiffThreshold = Number(pixelDiffThreshold);
    if (minAreaPercent !== undefined) this.minAreaPercent = Number(minAreaPercent);
    if (consecutiveFrames !== undefined) this.consecutiveFrames = Number(consecutiveFrames);
    if (cooldownMs !== undefined) this.cooldownMs = Number(cooldownMs);
  }

  /**
   * Primary processing pipeline.
   * 
   * @param {ImageData} roiImageData Cropped bounding box of circle (~96-128px)
   * @param {ImageData|null} guardImageData Downscaled full-frame or outer region thumbnail
   * @param {number} timestamp Performance timestamp in ms
   * @returns {Object} Analysis metrics and state
   */
  process(roiImageData, guardImageData = null, timestamp = performance.now()) {
    const t0 = performance.now();
    const w = roiImageData.width;
    const h = roiImageData.height;

    // Ensure buffers are allocated
    const gw = guardImageData ? guardImageData.width : 32;
    const gh = guardImageData ? guardImageData.height : 24;
    this.initBuffers(w, h, gw, gh);

    // 1. Convert ROI to Grayscale and compute Mean Luminance inside circular mask
    const srcData = roiImageData.data;
    const total = this.totalPixels;
    let sumLuminance = 0;

    for (let i = 0, p = 0; i < total; i++, p += 4) {
      // Perceived luminance: Rec. 601 coefficients
      const gray = (srcData[p] * 77 + srcData[p + 1] * 150 + srcData[p + 2] * 29) >> 8;
      this.currentGray[i] = gray;
      if (this.mask[i] === 1) {
        sumLuminance += gray;
      }
    }

    const meanLuminance = this.circlePixelCount > 0 ? (sumLuminance / this.circlePixelCount) : 128;

    // 2. Normalize ROI brightness against mean (Lighting Robustness)
    // Centering around 128 suppresses global illumination variations (clouds, indoor flickering)
    const normOffset = 128 - meanLuminance;
    for (let i = 0; i < total; i++) {
      if (this.mask[i] === 1) {
        const adjusted = this.currentGray[i] + normOffset;
        this.currentGray[i] = adjusted < 0 ? 0 : (adjusted > 255 ? 255 : adjusted);
      }
    }

    // 3. 3x3 Box Blur to suppress camera sensor high-frequency noise
    this._apply3x3Blur(this.currentGray, this.blurredGray, w, h);

    // 4. Global Change Guard Inspection (Outer region / Full Frame)
    let globalChangeDetected = false;
    let guardChangeRatio = 0;

    if (guardImageData) {
      guardChangeRatio = this._processGuard(guardImageData);
      if (guardChangeRatio >= this.globalChangeThreshold) {
        globalChangeDetected = true;
      }
    }

    // Handle Active Suppression Window
    if (timestamp < this.suppressionEndTime) {
      this.state = EngineState.SUPPRESSED;
      // Continuously absorb the scene during suppression
      this._updateBackgroundFast(this.blurredGray);
      return {
        state: this.state,
        hasMotion: false,
        alertTriggered: false,
        changedPercent: 0,
        blobPercent: 0,
        processingTimeMs: performance.now() - t0,
        isSuppressed: true,
        suppressionReason: this.suppressionReason,
        diffMask: this.diffMask,
        calibrationProgress: 0
      };
    }

    // If a sudden global change occurred (camera bump, room light switched)
    if (globalChangeDetected) {
      this.suppressionEndTime = timestamp + this.globalSuppressionMs;
      this.suppressionReason = `Camera bump / sudden lighting shift (${(guardChangeRatio * 100).toFixed(0)}% guard change)`;
      this.state = EngineState.SUPPRESSED;
      this.candidateFrameCount = 0;
      this.resetBackground();
      this.state = EngineState.SUPPRESSED; // Keep suppressed state indicator

      return {
        state: this.state,
        hasMotion: false,
        alertTriggered: false,
        changedPercent: (guardChangeRatio * 100),
        blobPercent: 0,
        processingTimeMs: performance.now() - t0,
        isSuppressed: true,
        suppressionReason: this.suppressionReason,
        diffMask: this.diffMask,
        calibrationProgress: 0
      };
    }

    // 5. Calibration Phase
    if (!this.hasBackground || this.calibrationFrameCount < this.calibrationTotalFrames) {
      this.state = EngineState.CALIBRATING;
      this._updateBackgroundCalibration(this.blurredGray, this.calibrationFrameCount);
      this.calibrationFrameCount++;

      // Copy to previous frame buffer
      this.previousGray.set(this.blurredGray);

      if (this.calibrationFrameCount >= this.calibrationTotalFrames) {
        this.hasBackground = true;
        this.state = EngineState.MONITORING;
      }

      return {
        state: EngineState.CALIBRATING,
        hasMotion: false,
        alertTriggered: false,
        changedPercent: 0,
        blobPercent: 0,
        processingTimeMs: performance.now() - t0,
        isSuppressed: false,
        suppressionReason: '',
        diffMask: this.diffMask,
        calibrationProgress: this.calibrationFrameCount / this.calibrationTotalFrames
      };
    }

    // 6. Motion Differencing inside Circular Mask
    // Combine differences against:
    // a) Long-term running background model
    // b) Previous frame (ensures sudden motion isn't masked by fast adaptations)
    let changedCount = 0;
    const threshold = this.pixelDiffThreshold;

    // Reset diff mask
    this.diffMask.fill(0);

    for (let i = 0; i < total; i++) {
      if (this.mask[i] === 0) continue;

      const curr = this.blurredGray[i];
      const bg = this.backgroundModel[i];
      const prev = this.previousGray[i];

      const diffBg = Math.abs(curr - bg);
      const diffPrev = Math.abs(curr - prev);

      // Pixel is considered changed if it differs significantly from the background model
      // OR has sudden delta from previous frame while differing from background
      if (diffBg >= threshold || (diffPrev >= threshold && diffBg >= (threshold * 0.7))) {
        this.diffMask[i] = 255;
        changedCount++;
      }
    }

    // 7. Single-Pass Noise Filtering: Suppress isolated changed pixels
    const filteredChangedCount = this._filterIsolatedNoise(this.diffMask, this.tempBinary, w, h);

    // 8. Metric Calculation: Changed Percentage inside Circle
    const changedPercent = (filteredChangedCount / this.circlePixelCount) * 100;
    this.lastChangedPercent = changedPercent;

    // 9. Largest Connected Blob Calculation (Fast 4-neighbor flood component search)
    const largestBlobPixels = this._findLargestBlobSize(this.tempBinary, w, h);
    const blobPercent = (largestBlobPixels / this.circlePixelCount) * 100;
    this.lastBlobPercent = blobPercent;

    // 10. Background Model Adaptive Update
    // Pixels NOT in motion learn at normal rate; pixels IN motion learn at a much slower rate
    // to allow stationary objects to gradually blend in without instant ghosts
    const alpha = this.learningRate;
    const slowAlpha = alpha * 0.15;

    for (let i = 0; i < total; i++) {
      if (this.mask[i] === 1) {
        const cur = this.blurredGray[i];
        const isMoving = this.tempBinary[i] === 255;
        const rate = isMoving ? slowAlpha : alpha;
        this.backgroundModel[i] = (1 - rate) * this.backgroundModel[i] + rate * cur;
      }
    }

    // Update previous frame for next sample
    this.previousGray.set(this.blurredGray);

    // 11. State Machine & Hysteresis Logic
    let alertTriggered = false;
    const enterThreshold = this.minAreaPercent;
    const exitThreshold = this.minAreaPercent * this.hysteresisFactor;

    // Check if cooldown has expired
    if (this.state === EngineState.COOLDOWN) {
      if (timestamp - this.lastAlertTime >= this.cooldownMs) {
        this.state = EngineState.MONITORING;
      }
    }

    // Evaluation
    const meetsEnterCondition = changedPercent >= enterThreshold;
    const meetsStayCondition = changedPercent >= exitThreshold;

    if (this.state === EngineState.MONITORING || this.state === EngineState.CANDIDATE) {
      if (meetsEnterCondition) {
        this.candidateFrameCount++;
        if (this.candidateFrameCount >= this.consecutiveFrames) {
          // Trigger Alert!
          this.state = EngineState.ALERTING;
          this.lastAlertTime = timestamp;
          alertTriggered = true;
          this.quietFrameCount = 0;
        } else {
          this.state = EngineState.CANDIDATE;
        }
      } else {
        this.candidateFrameCount = 0;
        this.state = EngineState.MONITORING;
      }
    } else if (this.state === EngineState.ALERTING) {
      if (!meetsStayCondition) {
        this.quietFrameCount++;
        if (this.quietFrameCount >= this.quietFramesToExit) {
          this.state = EngineState.COOLDOWN;
          this.candidateFrameCount = 0;
          this.quietFrameCount = 0;
        }
      } else {
        this.quietFrameCount = 0;
      }
    } else if (this.state === EngineState.COOLDOWN) {
      // In cooldown: alert sound does not re-trigger, but if motion remains, keep cooldown warm
      if (meetsEnterCondition) {
        this.lastAlertTime = timestamp;
      }
    }

    const processingTimeMs = performance.now() - t0;

    return {
      state: this.state,
      hasMotion: this.state === EngineState.ALERTING,
      alertTriggered,
      changedPercent,
      blobPercent,
      processingTimeMs,
      isSuppressed: false,
      suppressionReason: '',
      diffMask: this.tempBinary, // Clean binary mask for debug view
      calibrationProgress: 1.0
    };
  }

  /**
   * Fast 3x3 Box Blur implementation on typed array.
   */
  _apply3x3Blur(src, dst, w, h) {
    for (let y = 0; y < h; y++) {
      const yPrev = (y > 0 ? y - 1 : 0) * w;
      const yCurr = y * w;
      const yNext = (y < h - 1 ? y + 1 : h - 1) * w;

      for (let x = 0; x < w; x++) {
        const xPrev = x > 0 ? x - 1 : 0;
        const xNext = x < w - 1 ? x + 1 : w - 1;

        const sum =
          src[yPrev + xPrev] + src[yPrev + x] + src[yPrev + xNext] +
          src[yCurr + xPrev] + src[yCurr + x] + src[yCurr + xNext] +
          src[yNext + xPrev] + src[yNext + x] + src[yNext + xNext];

        dst[yCurr + x] = (sum * 7282) >> 16; // Fast approximation of sum / 9
      }
    }
  }

  /**
   * Process guard thumbnail (full-frame or outer ring) to detect global lighting/bump changes.
   */
  _processGuard(guardImageData) {
    const data = guardImageData.data;
    const len = this.guardTotalPixels;
    let changedPixels = 0;

    for (let i = 0, p = 0; i < len; i++, p += 4) {
      const gray = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
      this.guardCurrentGray[i] = gray;

      if (!this.hasBackground) {
        this.guardBackground[i] = gray;
      } else {
        const diff = Math.abs(gray - this.guardBackground[i]);
        if (diff > 30) {
          changedPixels++;
        }
        // Slow adaptive update of guard background
        this.guardBackground[i] = 0.95 * this.guardBackground[i] + 0.05 * gray;
      }
    }

    return changedPixels / len;
  }

  /**
   * Fast single-pass noise removal.
   * Copies src to dst, turning off changed pixels that lack sufficient 4-connected neighbors.
   */
  _filterIsolatedNoise(src, dst, w, h) {
    dst.fill(0);
    let count = 0;

    for (let y = 1; y < h - 1; y++) {
      const row = y * w;
      for (let x = 1; x < w - 1; x++) {
        const idx = row + x;
        if (src[idx] === 255) {
          // Count active 4-neighbors
          const neighbors = (src[idx - 1] === 255 ? 1 : 0) +
                            (src[idx + 1] === 255 ? 1 : 0) +
                            (src[idx - w] === 255 ? 1 : 0) +
                            (src[idx + w] === 255 ? 1 : 0);

          if (neighbors >= 2) {
            dst[idx] = 255;
            count++;
          }
        }
      }
    }
    return count;
  }

  /**
   * Approximate size of largest connected blob using BFS with buffer reuse.
   */
  _findLargestBlobSize(binary, w, h) {
    const labels = this.labels;
    labels.fill(0);
    let maxBlobSize = 0;

    // Use a pre-sized integer array as queue for BFS
    if (!this._bfsQueue || this._bfsQueue.length < this.totalPixels) {
      this._bfsQueue = new Int32Array(this.totalPixels);
    }
    const queue = this._bfsQueue;

    for (let y = 1; y < h - 1; y++) {
      const row = y * w;
      for (let x = 1; x < w - 1; x++) {
        const startIdx = row + x;
        if (binary[startIdx] === 255 && labels[startIdx] === 0) {
          // Start BFS for component
          let blobSize = 0;
          let head = 0;
          let tail = 0;

          queue[tail++] = startIdx;
          labels[startIdx] = 1;

          while (head < tail) {
            const idx = queue[head++];
            blobSize++;

            const qx = idx % w;
            const qy = (idx / w) | 0;

            // 4-connected neighbors
            if (qx > 1) {
              const nIdx = idx - 1;
              if (binary[nIdx] === 255 && labels[nIdx] === 0) {
                labels[nIdx] = 1;
                queue[tail++] = nIdx;
              }
            }
            if (qx < w - 2) {
              const nIdx = idx + 1;
              if (binary[nIdx] === 255 && labels[nIdx] === 0) {
                labels[nIdx] = 1;
                queue[tail++] = nIdx;
              }
            }
            if (qy > 1) {
              const nIdx = idx - w;
              if (binary[nIdx] === 255 && labels[nIdx] === 0) {
                labels[nIdx] = 1;
                queue[tail++] = nIdx;
              }
            }
            if (qy < h - 2) {
              const nIdx = idx + w;
              if (binary[nIdx] === 255 && labels[nIdx] === 0) {
                labels[nIdx] = 1;
                queue[tail++] = nIdx;
              }
            }
          }

          if (blobSize > maxBlobSize) {
            maxBlobSize = blobSize;
          }
        }
      }
    }

    return maxBlobSize;
  }

  /**
   * Cumulative running average during initial calibration frames.
   */
  _updateBackgroundCalibration(gray, frameIndex) {
    const total = this.totalPixels;
    const factor = 1.0 / (frameIndex + 1);

    for (let i = 0; i < total; i++) {
      if (frameIndex === 0) {
        this.backgroundModel[i] = gray[i];
      } else {
        this.backgroundModel[i] = this.backgroundModel[i] * (1 - factor) + gray[i] * factor;
      }
    }
  }

  /**
   * Fast background assimilation during suppression recovery.
   */
  _updateBackgroundFast(gray) {
    const total = this.totalPixels;
    const fastRate = 0.25;
    for (let i = 0; i < total; i++) {
      this.backgroundModel[i] = (1 - fastRate) * this.backgroundModel[i] + fastRate * gray[i];
    }
  }

  /**
   * Release all buffers and reset state.
   */
  destroy() {
    this.mask = null;
    this.currentGray = null;
    this.blurredGray = null;
    this.backgroundModel = null;
    this.previousGray = null;
    this.diffMask = null;
    this.tempBinary = null;
    this.labels = null;
    this._bfsQueue = null;
    this.state = EngineState.IDLE;
  }
}
