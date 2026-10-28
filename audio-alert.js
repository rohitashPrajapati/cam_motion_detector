/**
 * audio-alert.js
 * 
 * Web Audio API synthesized audio alerts with single-voice policy, custom audio file picker,
 * IndexedDB persistence across reloads, and optional vibration.
 */

const DB_NAME = 'GroundMotionDetectorDB';
const DB_STORE = 'media_assets';
const DB_KEY_CUSTOM_AUDIO = 'custom_alert_audio';
const DB_KEY_CUSTOM_AUDIO_NAME = 'custom_alert_audio_name';

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

    // Custom audio state
    this.customAudioBuffer = null;
    this.customAudioName = '';
    this.customAudioBlob = null;

    // Minimum quiet buffer between consecutive audio triggers (ms)
    this.audioCooldownMs = 300;

    this.readyPromise = this._loadPersistedAudio();
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

    // If we have a pending custom audio blob that wasn't decoded yet because audioCtx was inactive:
    if (this.customAudioBlob && !this.customAudioBuffer) {
      await this._decodeBlob(this.customAudioBlob);
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
   * Load custom audio file from user file input.
   * Persists to IndexedDB and decodes with Web Audio API.
   */
  async setCustomAudioFile(file) {
    if (!file) return;

    await this.ensureAudioContext();
    this.customAudioBlob = file;
    this.customAudioName = file.name;

    await this._decodeBlob(file);
    await this._saveAudioToDB(file, file.name);
  }

  get hasCustomAudio() {
    return Boolean(this.customAudioBuffer || this.customAudioBlob);
  }

  async _decodeBlob(blob) {
    if (!this.audioCtx) return;
    try {
      const arrayBuffer = await blob.arrayBuffer();
      // Decode audio data into AudioBuffer (supports both modern Promise and legacy callback API)
      return new Promise((resolve) => {
        let isResolved = false;
        const onSuccess = (decoded) => {
          if (isResolved) return;
          isResolved = true;
          this.customAudioBuffer = decoded;
          resolve(decoded);
        };
        const onError = (err) => {
          if (isResolved) return;
          isResolved = true;
          console.warn('Could not decode custom audio data:', err);
          this.customAudioBuffer = null;
          resolve(null);
        };

        const res = this.audioCtx.decodeAudioData(arrayBuffer, onSuccess, onError);
        if (res && typeof res.then === 'function') {
          res.then(onSuccess).catch(onError);
        }
      });
    } catch (err) {
      console.warn('Could not read custom audio arrayBuffer:', err);
      this.customAudioBuffer = null;
    }
  }

  /**
   * Reset audio back to default synthesized tones.
   */
  async resetToDefaultAudio() {
    this.customAudioBuffer = null;
    this.customAudioName = '';
    this.customAudioBlob = null;
    await this._deleteAudioFromDB();
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

      // If user uploaded a custom audio file, play it through the master gain!
      if (this.customAudioBuffer) {
        durationMs = this._playCustomAudio();
      } else if (this.soundType === 'beep') {
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
      console.error('Error during audio synthesis/playback:', err);
      this.isPlaying = false;
      return false;
    }
  }

  /**
   * User test sound preview.
   */
  async testSound() {
    await this.ensureAudioContext();
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
   * Play user-uploaded custom audio buffer.
   */
  _playCustomAudio() {
    const ctx = this.audioCtx;
    const source = ctx.createBufferSource();
    source.buffer = this.customAudioBuffer;
    source.connect(this.masterGain);
    source.start(ctx.currentTime);

    // Limit maximum alert voice duration to 4 seconds to prevent blocking
    const audioLenMs = Math.round(this.customAudioBuffer.duration * 1000);
    return Math.min(audioLenMs, 4000);
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

  /* ----------------- IndexedDB Helpers ----------------- */

  _openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          db.createObjectStore(DB_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async _saveAudioToDB(blob, name) {
    try {
      const db = await this._openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        const store = tx.objectStore(DB_STORE);
        store.put(blob, DB_KEY_CUSTOM_AUDIO);
        store.put(name, DB_KEY_CUSTOM_AUDIO_NAME);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      console.warn('Could not save audio to IndexedDB:', err);
    }
  }

  async _loadPersistedAudio() {
    try {
      const db = await this._openDB();
      return new Promise((resolve) => {
        const tx = db.transaction(DB_STORE, 'readonly');
        const store = tx.objectStore(DB_STORE);
        const reqBlob = store.get(DB_KEY_CUSTOM_AUDIO);
        const reqName = store.get(DB_KEY_CUSTOM_AUDIO_NAME);

        tx.oncomplete = () => {
          if (reqBlob.result) {
            this.customAudioBlob = reqBlob.result;
            this.customAudioName = reqName.result || 'Custom Audio';
          }
          resolve();
        };
        tx.onerror = () => resolve();
      });
    } catch {
      // Ignore
    }
  }

  async _deleteAudioFromDB() {
    try {
      const db = await this._openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        const store = tx.objectStore(DB_STORE);
        store.delete(DB_KEY_CUSTOM_AUDIO);
        store.delete(DB_KEY_CUSTOM_AUDIO_NAME);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // Ignore
    }
  }
}
