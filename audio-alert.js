/**
 * audio-alert.js
 * 
 * Web Audio API synthesized audio alerts with single-voice policy and optional vibration.
 * Zero external audio file dependencies.
 */

export class AudioAlert {
  constructor(options = {}) {
    this.soundType = options.soundType || 'alarm'; // 'beep' | 'alarm'
    this.volume = options.volume !== undefined ? options.volume : 0.8;
    this.isMuted = options.isMuted || false;
    this.vibrationEnabled = options.vibrationEnabled || false;

    // Web Audio state
    this.audioCtx = null;
    this.masterGain = null;
    this.isPlaying = false;
    this.playEndTime = 0;

    // Minimum quiet buffer between consecutive audio triggers (ms)
    this.audioCooldownMs = 300;
  }

  /**
   * Initialize or resume the AudioContext.
   * MUST be invoked as part of a user gesture (tap/click).
   */
  async ensureAudioContext() {
    if (!this.audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        console.warn('Web Audio API is not supported on this browser.');
        return null;
      }
      this.audioCtx = new AudioContextClass();

      // Master gain node for global volume control
      this.masterGain = this.audioCtx.createGain();
      this.masterGain.gain.setValueAtTime(this.isMuted ? 0 : this.volume, this.audioCtx.currentTime);
      this.masterGain.connect(this.audioCtx.destination);
    }

    if (this.audioCtx.state === 'suspended') {
      try {
        await this.audioCtx.resume();
      } catch (err) {
        console.warn('Unable to resume AudioContext:', err);
      }
    }

    return this.audioCtx;
  }

  /**
   * Set volume level (0.0 to 1.0).
   */
  setVolume(vol) {
    this.volume = Math.max(0, Math.min(1, Number(vol)));
    if (this.masterGain && this.audioCtx) {
      const targetGain = this.isMuted ? 0 : this.volume;
      this.masterGain.gain.setTargetAtTime(targetGain, this.audioCtx.currentTime, 0.02);
    }
  }

  /**
   * Set mute status.
   */
  setMuted(muted) {
    this.isMuted = Boolean(muted);
    if (this.masterGain && this.audioCtx) {
      const targetGain = this.isMuted ? 0 : this.volume;
      this.masterGain.gain.setTargetAtTime(targetGain, this.audioCtx.currentTime, 0.02);
    }
  }

  /**
   * Set sound type ('beep' or 'alarm').
   */
  setSoundType(type) {
    if (type === 'beep' || type === 'alarm') {
      this.soundType = type;
    }
  }

  /**
   * Enable or disable haptic vibration.
   */
  setVibrationEnabled(enabled) {
    this.vibrationEnabled = Boolean(enabled);
  }

  /**
   * Check if device supports the Vibration API.
   */
  static isVibrationSupported() {
    return typeof navigator !== 'undefined' && 'vibrate' in navigator;
  }

  /**
   * Play the motion alert based on current settings.
   * Strictly enforces single-voice policy to prevent audio overlapping and distortion.
   */
  async triggerAlert() {
    const now = performance.now();
    if (this.isPlaying || now < this.playEndTime) {
      return false; // Ignored due to single-voice lock
    }

    // Trigger haptic vibration if enabled
    if (this.vibrationEnabled && AudioAlert.isVibrationSupported()) {
      try {
        navigator.vibrate([100, 60, 100]);
      } catch {
        // Fail silently if vibration blocked
      }
    }

    if (this.isMuted) {
      return true;
    }

    await this.ensureAudioContext();
    if (!this.audioCtx || this.audioCtx.state !== 'running') {
      return false;
    }

    this.isPlaying = true;

    try {
      let durationMs = 150;
      if (this.soundType === 'beep') {
        durationMs = this._synthesizeBeep();
      } else {
        durationMs = this._synthesizeAlarm();
      }

      this.playEndTime = performance.now() + durationMs + this.audioCooldownMs;
      setTimeout(() => {
        this.isPlaying = false;
      }, durationMs);

      return true;
    } catch (err) {
      console.error('Error during audio synthesis:', err);
      this.isPlaying = false;
      return false;
    }
  }

  /**
   * User test sound preview.
   */
  async testSound() {
    await this.ensureAudioContext();
    // Temporarily unmute for test if muted
    const wasMuted = this.isMuted;
    if (wasMuted && this.masterGain && this.audioCtx) {
      this.masterGain.gain.setValueAtTime(this.volume, this.audioCtx.currentTime);
    }

    this.isPlaying = false;
    this.playEndTime = 0;
    await this.triggerAlert();

    if (wasMuted && this.masterGain && this.audioCtx) {
      setTimeout(() => {
        if (this.isMuted) {
          this.masterGain.gain.setValueAtTime(0, this.audioCtx.currentTime);
        }
      }, 500);
    }
  }

  /**
   * Synthesize a clean, crisp high-priority beep.
   * @returns {number} Duration in ms
   */
  _synthesizeBeep() {
    const ctx = this.audioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(880, ctx.currentTime); // A5

    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.9, ctx.currentTime + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.14);

    osc.connect(gain);
    gain.connect(this.masterGain);

    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.15);

    return 150;
  }

  /**
   * Synthesize a modern 3-stage rising alarm.
   * Notes: D5 (587Hz) -> G5 (784Hz) -> C6 (1046Hz)
   * @returns {number} Duration in ms
   */
  _synthesizeAlarm() {
    const ctx = this.audioCtx;
    const freqs = [587.33, 783.99, 1046.50];
    const stepDuration = 0.11;
    const gap = 0.03;

    for (let i = 0; i < freqs.length; i++) {
      const startTime = ctx.currentTime + i * (stepDuration + gap);
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freqs[i], startTime);

      // Snappy attack, clean decay
      gain.gain.setValueAtTime(0.001, startTime);
      gain.gain.exponentialRampToValueAtTime(0.85, startTime + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + stepDuration);

      osc.connect(gain);
      gain.connect(this.masterGain);

      osc.start(startTime);
      osc.stop(startTime + stepDuration);
    }

    return 420;
  }

  /**
   * Cleanup and close audio context.
   */
  async cleanup() {
    this.isPlaying = false;
    if (this.audioCtx) {
      try {
        await this.audioCtx.close();
      } catch {
        // Ignore errors on close
      }
      this.audioCtx = null;
      this.masterGain = null;
    }
  }
}
