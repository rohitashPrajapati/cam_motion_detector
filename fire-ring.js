/**
 * fire-ring.js
 * 
 * High-performance, zero-allocation Canvas 2D procedural flame & particle ring engine.
 * Renders an animated circle of fire for projection onto the ground.
 * 
 * Features:
 * - Pre-allocated particle pool (500 particles, zero per-frame garbage collection)
 * - Layered procedural flame tongues & rising embers
 * - Hardware-accelerated offscreen particle sprite caching
 * - Additive blending ('lighter' composite) for radiant fire glow
 * - Flare animation on motion detection (500ms white-hot flare burst)
 * - Color themes: Classic Orange, Blue Flame, Green Toxic, Purple Magic, Custom
 * - Dynamic FPS tracking and graceful particle throttling under high load
 * - Web Audio API synthesized ambient fire crackle (pink noise + micro-impulses)
 * - Full lifecycle: start, stop, resize, setCircle, setOptions, flare, cleanup
 */

export const FIRE_PRESETS = {
  orange: {
    name: 'Classic Orange',
    core: '#ffffff',
    inner: '#ffe066',
    mid: '#ff6600',
    outer: '#cc1100',
    smoke: '#330500'
  },
  blue: {
    name: 'Blue Flame',
    core: '#ffffff',
    inner: '#cce6ff',
    mid: '#00a2ff',
    outer: '#0044ff',
    smoke: '#000f33'
  },
  green: {
    name: 'Toxic Green',
    core: '#ffffff',
    inner: '#e6ffe6',
    mid: '#39ff14',
    outer: '#009922',
    smoke: '#002208'
  },
  purple: {
    name: 'Magic Purple',
    core: '#ffffff',
    inner: '#f9e6ff',
    mid: '#da70d6',
    outer: '#8a2be2',
    smoke: '#220038'
  }
};

export class FireRing {
  /**
   * @param {HTMLCanvasElement} canvas The rendering canvas
   * @param {Object} options Configuration options
   */
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext('2d', { alpha: true }) : null;

    // Display & Circle geometry
    this.cx = 0;
    this.cy = 0;
    this.r = 0;

    // Fire tuning options
    this.enabled = options.enabled !== undefined ? options.enabled : true;
    this.intensity = options.intensity !== undefined ? options.intensity : 2.5;     // Flame height (0.5 to 2.5)
    this.thickness = options.thickness !== undefined ? options.thickness : 32;      // Ring base width in px
    this.speed = options.speed !== undefined ? options.speed : 1.0;                 // Flame animation speed
    this.embersEnabled = options.embersEnabled !== undefined ? options.embersEnabled : true;
    this.interiorGlow = options.interiorGlow !== undefined ? options.interiorGlow : true;
    this.theme = options.theme || 'orange';                                         // 'orange' | 'blue' | 'green' | 'purple' | 'custom'
    this.customColor = options.customColor || '#ff4500';

    // State & Flare animation
    this.state = 'IDLE'; // 'IDLE' | 'CALIBRATING' | 'MONITORING' | 'FLARING'
    this.isFlaring = false;
    this.flareStartTime = 0;
    this.flareDuration = 500; // ms
    this.flareMultiplier = 1.0;

    // Particle pool setup (fixed memory, zero GC)
    this.maxParticles = 500;
    this.activeParticleCount = 350;
    this.particles = new Array(this.maxParticles);
    for (let i = 0; i < this.maxParticles; i++) {
      this.particles[i] = {
        active: false,
        angle: 0,
        radialDist: 0,
        radialVel: 0,
        tangentialVel: 0,
        size: 0,
        baseSize: 0,
        life: 0,
        maxLife: 1,
        heat: 1.0,
        isEmber: false,
        x: 0,
        y: 0
      };
    }

    // Offscreen cached particle sprites for fast blitting
    this.spriteStages = 5;
    this.spriteSize = 32;
    this.sprites = [];
    this._generateSprites();

    // Animation loop & performance tracking
    this.animId = null;
    this.isRunning = false;
    this.lastTime = 0;
    this.fps = 60;
    this.frameCount = 0;
    this.fpsTimer = 0;
    this.sustainedSlowFrames = 0;

    // Audio crackle synthesis state
    this.crackleEnabled = options.crackleEnabled !== undefined ? options.crackleEnabled : true;
    this.crackleVolume = options.crackleVolume !== undefined ? options.crackleVolume : 0.6;
    this.audioCtx = null;
    this.crackleGain = null;
    this.noiseNode = null;
    this.crackleTimer = null;

    // Bind event handlers
    this._onVisibilityChange = this._onVisibilityChange.bind(this);
    document.addEventListener('visibilitychange', this._onVisibilityChange);
  }

  /**
   * Set circle geometry in canvas pixel coordinates.
   */
  setCircle(cx, cy, r) {
    this.cx = cx;
    this.cy = cy;
    this.r = Math.max(0, r);
  }

  /**
   * Resize canvas to viewport or display size.
   */
  resize(width, height) {
    if (!this.canvas) return;
    this.canvas.width = width;
    this.canvas.height = height;
  }

  /**
   * Update configuration parameters.
   */
  setOptions(newOpts = {}) {
    let updateSprites = false;

    if (newOpts.enabled !== undefined) this.enabled = Boolean(newOpts.enabled);
    if (newOpts.intensity !== undefined) this.intensity = Math.max(0.2, Math.min(3.0, Number(newOpts.intensity)));
    if (newOpts.thickness !== undefined) this.thickness = Math.max(4, Math.min(40, Number(newOpts.thickness)));
    if (newOpts.speed !== undefined) this.speed = Math.max(0.2, Math.min(3.0, Number(newOpts.speed)));
    if (newOpts.embersEnabled !== undefined) this.embersEnabled = Boolean(newOpts.embersEnabled);
    if (newOpts.interiorGlow !== undefined) this.interiorGlow = Boolean(newOpts.interiorGlow);

    if (newOpts.theme !== undefined && newOpts.theme !== this.theme) {
      this.theme = newOpts.theme;
      updateSprites = true;
    }
    if (newOpts.customColor !== undefined && newOpts.customColor !== this.customColor) {
      this.customColor = newOpts.customColor;
      if (this.theme === 'custom') updateSprites = true;
    }

    if (newOpts.crackleEnabled !== undefined) {
      this.setCrackleEnabled(newOpts.crackleEnabled);
    }
    if (newOpts.crackleVolume !== undefined) {
      this.setCrackleVolume(newOpts.crackleVolume);
    }

    if (updateSprites) {
      this._generateSprites();
    }
  }

  /**
   * Trigger the reactive white-hot flare on confirmed motion.
   */
  flare(durationMs = 500) {
    if (!this.enabled) return;
    this.isFlaring = true;
    this.flareStartTime = performance.now();
    this.flareDuration = durationMs;

    // Spawn a burst of high-energy ember sparks immediately
    const burstCount = Math.min(100, this.activeParticleCount);
    for (let i = 0; i < burstCount; i++) {
      const p = this.particles[i];
      if (!p.active) {
        this._initParticle(p, true);
        p.radialVel *= 2.2;
        p.size *= 1.4;
      }
    }
  }

  /**
   * Set engine state for visual feedback (e.g. dimmer during calibration).
   */
  setState(engineState) {
    this.state = engineState;
  }

  /**
   * Start the fire ring rendering loop.
   */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastTime = performance.now();
    this._loop(this.lastTime);

    if (this.crackleEnabled) {
      this._startCrackle();
    }
  }

  /**
   * Stop rendering loop.
   */
  stop() {
    this.isRunning = false;
    if (this.animId) {
      cancelAnimationFrame(this.animId);
      this.animId = null;
    }
    if (this.ctx && this.canvas) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
    this._stopCrackle();
  }

  /**
   * Main animation loop.
   */
  _loop(timestamp) {
    if (!this.isRunning) return;

    const dt = Math.min((timestamp - this.lastTime) / 1000, 0.1);
    this.lastTime = timestamp;

    // Track FPS
    this.frameCount++;
    this.fpsTimer += dt;
    if (this.fpsTimer >= 0.5) {
      this.fps = Math.round(this.frameCount / this.fpsTimer);
      this.frameCount = 0;
      this.fpsTimer = 0;

      // Graceful degradation: if FPS drops below 25 for sustained time, lower active particles
      if (this.fps < 25) {
        this.sustainedSlowFrames++;
        if (this.sustainedSlowFrames >= 2 && this.activeParticleCount > 180) {
          this.activeParticleCount -= 40;
        }
      } else {
        this.sustainedSlowFrames = 0;
      }
    }

    // Process Flare Animation
    if (this.isFlaring) {
      const elapsed = timestamp - this.flareStartTime;
      if (elapsed >= this.flareDuration) {
        this.isFlaring = false;
        this.flareMultiplier = 1.0;
      } else {
        const progress = elapsed / this.flareDuration; // 0 to 1
        // Sharp attack, exponential decay: starts at 2.4x
        this.flareMultiplier = 1.0 + 1.4 * Math.exp(-progress * 4.5);
      }
    } else {
      this.flareMultiplier = 1.0;
    }

    if (this.enabled && this.r > 2) {
      this._update(dt);
      this._render();
    } else if (this.ctx && this.canvas) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    this.animId = requestAnimationFrame((t) => this._loop(t));
  }

  /**
   * Update particle positions and lifecycle.
   */
  _update(dt) {
    const speedMult = this.speed;
    const intensityMult = this.intensity * this.flareMultiplier;
    const isCalibrating = this.state === 'CALIBRATING';
    const stateDim = isCalibrating ? 0.6 : 1.0;

    const count = this.activeParticleCount;

    for (let i = 0; i < count; i++) {
      const p = this.particles[i];

      if (!p.active) {
        // Emit new particle if below life threshold
        if (Math.random() < 0.28 * speedMult) {
          this._initParticle(p, false);
        }
        continue;
      }

      // Progress life
      p.life += (dt / p.maxLife) * speedMult;
      if (p.life >= 1.0) {
        p.active = false;
        continue;
      }

      // Physics: drift outward and slightly inward
      p.radialDist += p.radialVel * dt * speedMult * intensityMult;
      p.angle += p.tangentialVel * dt * speedMult;

      // Shrink size as flame rises and burns out
      const lifeLeft = 1.0 - p.life;
      p.size = p.baseSize * Math.max(0.1, lifeLeft * 1.1) * stateDim;
      p.heat = Math.max(0, lifeLeft);

      // Compute display Cartesian coordinates
      const currentRadius = this.r + p.radialDist;
      p.x = this.cx + Math.cos(p.angle) * currentRadius;
      p.y = this.cy + Math.sin(p.angle) * currentRadius;
    }
  }

  /**
   * Initialize a pooled particle.
   */
  _initParticle(p, forceBurst = false) {
    p.active = true;
    p.angle = Math.random() * Math.PI * 2;
    p.life = 0;
    p.maxLife = (0.35 + Math.random() * 0.45) / Math.max(0.4, this.speed);

    // Is this an ember spark?
    p.isEmber = !forceBurst && this.embersEnabled && Math.random() < 0.22;

    // Start near circle border with jitter proportional to thickness
    const halfThick = this.thickness * 0.5;
    const startOffset = (Math.random() - 0.5) * halfThick;
    p.radialDist = startOffset;

    // Velocity: outward with small probability of slight inward curl
    const baseVel = 25 + Math.random() * 45;
    const direction = (Math.random() < 0.82) ? 1 : -0.4;
    p.radialVel = baseVel * direction * (p.isEmber ? 1.8 : 1.0);

    // Slight swirl along perimeter
    p.tangentialVel = (Math.random() - 0.5) * 0.4;

    // Base particle size
    if (p.isEmber) {
      p.baseSize = 2.5 + Math.random() * 3.5;
    } else {
      p.baseSize = 6.0 + Math.random() * 12.0 * (this.thickness / 14);
    }
    p.size = p.baseSize;
    p.heat = 1.0;
  }

  /**
   * Render the glowing fire ring to canvas with additive blending.
   */
  _render() {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    // Clear previous frame
    ctx.clearRect(0, 0, w, h);

    if (this.r <= 2) return;

    ctx.save();
    // Additive blending for radiant fiery luminescence over dark backgrounds
    ctx.globalCompositeOperation = 'lighter';

    const isCalibrating = this.state === 'CALIBRATING';
    const stateAlpha = (isCalibrating ? 0.55 : 1.0) * Math.min(1.8, this.flareMultiplier);

    // 1. Draw glowing base ring beneath the flames
    this._renderBaseRing(ctx, stateAlpha);

    // 2. Render particle tongues & sparks
    const count = this.activeParticleCount;
    for (let i = 0; i < count; i++) {
      const p = this.particles[i];
      if (!p.active) continue;

      // Select sprite index based on heat stage
      const stageIdx = Math.min(
        this.spriteStages - 1,
        Math.floor((1.0 - p.heat) * this.spriteStages)
      );
      const sprite = this.sprites[stageIdx];
      if (!sprite) continue;

      const halfSize = p.size;
      const fullSize = halfSize * 2;

      ctx.globalAlpha = Math.min(1.0, (1.0 - p.life * 0.6) * stateAlpha);
      ctx.drawImage(
        sprite,
        p.x - halfSize,
        p.y - halfSize,
        fullSize,
        fullSize
      );
    }

    // 3. Optional interior floor glow (useful in Projector Mode)
    if (this.interiorGlow && this.r > 20) {
      this._renderInteriorGlow(ctx, stateAlpha);
    }

    ctx.restore();
  }

  /**
   * Draw glowing core ring along the circle perimeter.
   */
  _renderBaseRing(ctx, alpha) {
    const palette = this._getThemePalette();

    // Primary base arc
    ctx.save();
    ctx.beginPath();
    ctx.arc(this.cx, this.cy, this.r, 0, Math.PI * 2);

    // White-hot core flash when flaring
    if (this.isFlaring) {
      ctx.lineWidth = this.thickness * 1.5;
      ctx.strokeStyle = palette.core;
      ctx.globalAlpha = 0.9 * alpha;
      ctx.stroke();
    }

    // Primary glowing mid-stroke
    ctx.lineWidth = this.thickness * 0.9;
    ctx.strokeStyle = palette.mid;
    ctx.globalAlpha = 0.75 * alpha;
    ctx.stroke();

    // Inner bright ribbon
    ctx.lineWidth = Math.max(2, this.thickness * 0.35);
    ctx.strokeStyle = palette.inner;
    ctx.globalAlpha = 0.85 * alpha;
    ctx.stroke();

    ctx.restore();
  }

  /**
   * Draw subtle interior heat glow across the floor inside the circle.
   */
  _renderInteriorGlow(ctx, alpha) {
    const palette = this._getThemePalette();
    const grad = ctx.createRadialGradient(
      this.cx, this.cy, this.r * 0.2,
      this.cx, this.cy, this.r
    );
    grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
    grad.addColorStop(0.7, 'rgba(0, 0, 0, 0)');
    grad.addColorStop(0.95, this._hexToRgba(palette.mid, 0.12 * alpha));
    grad.addColorStop(1.0, this._hexToRgba(palette.outer, 0.25 * alpha));

    ctx.beginPath();
    ctx.arc(this.cx, this.cy, this.r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
  }

  /**
   * Pre-render offscreen particle sprites for heat gradient stages.
   */
  _generateSprites() {
    const palette = this._getThemePalette();
    const size = this.spriteSize;
    const center = size / 2;
    const stages = this.spriteStages;

    this.sprites = [];

    // Stage 0: White-hot core -> Inner glow
    // Stage 1: Inner yellow/light -> Mid orange
    // Stage 2: Mid flame -> Outer red
    // Stage 3: Deep outer -> Smoky edge
    // Stage 4: Fading smoke / dark ember
    const colorStops = [
      { start: palette.core,  end: palette.inner },
      { start: palette.inner, end: palette.mid },
      { start: palette.mid,   end: palette.outer },
      { start: palette.outer, end: palette.smoke },
      { start: palette.smoke, end: '#000000' }
    ];

    for (let s = 0; s < stages; s++) {
      const offCanvas = document.createElement('canvas');
      offCanvas.width = size;
      offCanvas.height = size;
      const offCtx = offCanvas.getContext('2d');

      const stops = colorStops[s];
      const radGrad = offCtx.createRadialGradient(center, center, 0, center, center, center);
      radGrad.addColorStop(0, stops.start);
      radGrad.addColorStop(0.4, stops.end);
      radGrad.addColorStop(1, 'rgba(0,0,0,0)');

      offCtx.fillStyle = radGrad;
      offCtx.beginPath();
      offCtx.arc(center, center, center, 0, Math.PI * 2);
      offCtx.fill();

      this.sprites.push(offCanvas);
    }
  }

  /**
   * Resolve active color theme palette.
   */
  _getThemePalette() {
    if (this.theme === 'custom' && this.customColor) {
      return this._generateCustomPalette(this.customColor);
    }
    return FIRE_PRESETS[this.theme] || FIRE_PRESETS.orange;
  }

  /**
   * Derive a 5-tier flame palette from a single base color hex.
   */
  _generateCustomPalette(baseHex) {
    return {
      name: 'Custom',
      core: '#ffffff',
      inner: this._adjustBrightness(baseHex, 70),
      mid: baseHex,
      outer: this._adjustBrightness(baseHex, -35),
      smoke: this._adjustBrightness(baseHex, -75)
    };
  }

  _adjustBrightness(hex, percent) {
    let num = parseInt(hex.replace('#', ''), 16);
    let r = (num >> 16) + percent;
    let g = ((num >> 8) & 0x00FF) + percent;
    let b = (num & 0x0000FF) + percent;

    r = Math.max(0, Math.min(255, r));
    g = Math.max(0, Math.min(255, g));
    b = Math.max(0, Math.min(255, b));

    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
  }

  _hexToRgba(hex, alpha) {
    let c = hex.replace('#', '');
    if (c.length === 3) c = c.split('').map(x => x + x).join('');
    const num = parseInt(c, 16);
    return `rgba(${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}, ${alpha})`;
  }

  /* ----------------- Web Audio Flame Crackle ----------------- */

  /**
   * Toggle ambient crackle sound.
   */
  setCrackleEnabled(enabled) {
    this.crackleEnabled = Boolean(enabled);
    if (this.crackleEnabled && this.isRunning) {
      this._startCrackle();
    } else {
      this._stopCrackle();
    }
  }

  /**
   * Set crackle volume (0.0 to 1.0).
   */
  setCrackleVolume(vol) {
    this.crackleVolume = Math.max(0, Math.min(1.0, Number(vol)));
    if (this.crackleGain && this.audioCtx) {
      this.crackleGain.gain.setTargetAtTime(this.crackleVolume * 0.25, this.audioCtx.currentTime, 0.05);
    }
  }

  /**
   * Synthesize gentle pink/brown noise and micro-burst crackles.
   */
  async _startCrackle() {
    if (this.noiseNode || !this.crackleEnabled) return;

    try {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtxClass) return;

      if (!this.audioCtx) {
        this.audioCtx = new AudioCtxClass();
      }
      if (this.audioCtx.state === 'suspended') {
        try { await this.audioCtx.resume(); } catch { return; }
      }

      // Generate 2 seconds of pink/brown filtered noise buffer
      const bufferSize = this.audioCtx.sampleRate * 2;
      const noiseBuffer = this.audioCtx.createBuffer(1, bufferSize, this.audioCtx.sampleRate);
      const output = noiseBuffer.getChannelData(0);

      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        // Pink noise filter approximation
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        output[i] = (b0 + b1 + b2) * 0.08;
      }

      this.noiseNode = this.audioCtx.createBufferSource();
      this.noiseNode.buffer = noiseBuffer;
      this.noiseNode.loop = true;

      // Bandpass filter to isolate warm fire hiss
      const filter = this.audioCtx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(650, this.audioCtx.currentTime);
      filter.Q.setValueAtTime(1.2, this.audioCtx.currentTime);

      this.crackleGain = this.audioCtx.createGain();
      this.crackleGain.gain.setValueAtTime(this.crackleVolume * 0.25, this.audioCtx.currentTime);

      this.noiseNode.connect(filter);
      filter.connect(this.crackleGain);
      this.crackleGain.connect(this.audioCtx.destination);

      this.noiseNode.start();

      // Schedule periodic random micro-crackle clicks
      this._scheduleRandomCrackles();
    } catch (err) {
      console.warn('Crackle audio synthesis error:', err);
    }
  }

  _scheduleRandomCrackles() {
    if (!this.crackleEnabled || !this.isRunning) return;

    const nextDelay = 80 + Math.random() * 280;
    this.crackleTimer = setTimeout(() => {
      this._playMicroClick();
      this._scheduleRandomCrackles();
    }, nextDelay);
  }

  _playMicroClick() {
    if (!this.audioCtx || this.audioCtx.state !== 'running' || !this.crackleEnabled) return;

    try {
      const osc = this.audioCtx.createOscillator();
      const clickGain = this.audioCtx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1200 + Math.random() * 1800, this.audioCtx.currentTime);

      const clickVol = (0.05 + Math.random() * 0.12) * this.crackleVolume;
      clickGain.gain.setValueAtTime(clickVol, this.audioCtx.currentTime);
      clickGain.gain.exponentialRampToValueAtTime(0.0001, this.audioCtx.currentTime + 0.025);

      osc.connect(clickGain);
      clickGain.connect(this.audioCtx.destination);

      osc.start();
      osc.stop(this.audioCtx.currentTime + 0.03);
    } catch {
      // Ignore click error
    }
  }

  _stopCrackle() {
    if (this.crackleTimer) {
      clearTimeout(this.crackleTimer);
      this.crackleTimer = null;
    }
    if (this.noiseNode) {
      try {
        this.noiseNode.stop();
        this.noiseNode.disconnect();
      } catch { /* ignore */ }
      this.noiseNode = null;
    }
    if (this.crackleGain) {
      try {
        this.crackleGain.disconnect();
      } catch { /* ignore */ }
      this.crackleGain = null;
    }
  }

  _onVisibilityChange() {
    if (document.hidden) {
      if (this.animId) {
        cancelAnimationFrame(this.animId);
        this.animId = null;
      }
      this._stopCrackle();
    } else if (this.isRunning) {
      this.lastTime = performance.now();
      this._loop(this.lastTime);
      if (this.crackleEnabled) {
        this._startCrackle();
      }
    }
  }

  /**
   * Cleanup all resources, animation frames, and audio contexts.
   */
  cleanup() {
    this.stop();
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
    if (this.audioCtx) {
      try { this.audioCtx.close(); } catch { /* ignore */ }
      this.audioCtx = null;
    }
    this.sprites = [];
  }
}
