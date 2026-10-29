/**
 * video-player.js
 * 
 * PlaybackController for motion-triggered fullscreen video alerts.
 * Features:
 * - Autoplay unlocking during user gesture
 * - Fallback to muted playback with "Tap for sound" button if unmuted autoplay is rejected
 * - Custom video loading with IndexedDB persistence across reloads
 * - Single-voice policy and overlap protection
 * - 2-second delayed Skip button (>=48px touch target)
 * - Graceful fallback if video file is missing or unsupported (never hangs)
 */

const DB_NAME = 'GroundMotionDetectorDB';
const DB_STORE = 'media_assets';
const DB_KEY_CUSTOM_VIDEO = 'custom_alert_video';
const DB_KEY_CUSTOM_VIDEO_NAME = 'custom_alert_video_name';

export class VideoAlertPlayer {
  constructor(options = {}) {
    this.containerEl = options.containerEl;
    this.videoEl = options.videoEl;
    this.skipBtn = options.skipBtn;
    this.unmuteBtn = options.unmuteBtn;

    this.videoEnabled = options.videoEnabled !== undefined ? options.videoEnabled : true;
    this.soundEnabled = options.soundEnabled !== undefined ? options.soundEnabled : true;
    
    this.defaultVideoSrc = 'assets/alert-video.mp4';
    this.currentObjectUrl = null;
    this.hasCustomVideo = false;
    this.customVideoName = '';

    this.isPlaying = false;
    this.isAutoplayUnlocked = false;
    this.skipTimer = null;

    // Callbacks
    this.onEndedCallback = null;
    this.onSkippedCallback = null;
    this.onErrorCallback = null;

    this._bindEvents();
    this.readyPromise = this._loadPersistedVideo();
  }

  _bindEvents() {
    if (!this.videoEl) return;

    this.videoEl.addEventListener('ended', () => {
      this._handlePlaybackEnd('ended');
    });

    this.videoEl.addEventListener('error', (err) => {
      console.warn('Alert video playback error:', err);
      if (this.isPlaying) {
        this._handlePlaybackError(err);
      }
    });

    if (this.skipBtn) {
      this.skipBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._handlePlaybackEnd('skipped');
      });
    }

    if (this.unmuteBtn) {
      this.unmuteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.videoEl.muted = false;
        this.unmuteBtn.classList.add('hidden');
      });
    }
  }

  /**
   * Unlock video playback during user interaction ("Start Monitoring" or "Test Video").
   * Crucial for iOS Safari & Android Chrome autoplay permissions.
   */
  async unlockAutoplay() {
    if (!this.videoEl) return;
    if (!this.videoEl.src || this.videoEl.src === '' || this.videoEl.src.endsWith('/')) {
      this.videoEl.src = this.currentObjectUrl || this.defaultVideoSrc;
    }
    try {
      this.videoEl.muted = !this.soundEnabled;
      const playPromise = this.videoEl.play();
      if (playPromise !== undefined) {
        await playPromise;
        this.videoEl.pause();
        try { this.videoEl.currentTime = 0; } catch (_) {}
        this.isAutoplayUnlocked = true;
      }
    } catch (err) {
      // If unmuted failed, try unlocking muted
      try {
        this.videoEl.muted = true;
        const fallbackPromise = this.videoEl.play();
        if (fallbackPromise !== undefined) {
          await fallbackPromise;
          this.videoEl.pause();
          try { this.videoEl.currentTime = 0; } catch (_) {}
          this.isAutoplayUnlocked = true;
        }
      } catch (err2) {
        console.warn('Video autoplay unlock deferred until gesture:', err2);
      }
    }
  }

  /**
   * Set custom video from user file input. Persists to IndexedDB.
   */
  async setCustomVideoFile(file) {
    if (!file) return;

    // Revoke previous object URL
    if (this.currentObjectUrl) {
      URL.revokeObjectURL(this.currentObjectUrl);
      this.currentObjectUrl = null;
    }

    this.currentObjectUrl = URL.createObjectURL(file);
    this.hasCustomVideo = true;
    this.customVideoName = file.name;
    this.videoEl.src = this.currentObjectUrl;
    this.videoEl.load();

    // Persist to IndexedDB
    await this._saveVideoToDB(file, file.name);
  }

  /**
   * Reset video back to default bundled asset.
   */
  async resetToDefaultVideo() {
    if (this.currentObjectUrl) {
      URL.revokeObjectURL(this.currentObjectUrl);
      this.currentObjectUrl = null;
    }
    this.hasCustomVideo = false;
    this.customVideoName = '';
    this.videoEl.src = this.defaultVideoSrc;
    this.videoEl.load();

    await this._deleteVideoFromDB();
  }

  /**
   * Load persisted custom video from IndexedDB.
   */
  async _loadPersistedVideo() {
    try {
      const data = await this._getVideoFromDB();
      if (data && data.blob) {
        this.currentObjectUrl = URL.createObjectURL(data.blob);
        this.hasCustomVideo = true;
        this.customVideoName = data.name || 'Custom Video';
        this.videoEl.src = this.currentObjectUrl;
      } else {
        this.videoEl.src = this.defaultVideoSrc;
      }
      this.videoEl.load();
    } catch {
      this.videoEl.src = this.defaultVideoSrc;
      this.videoEl.load();
    }
  }

  /**
   * Play the fullscreen alert video.
   * 
   * @param {Object} callbacks { onEnded, onSkipped, onError, onFallbackSound }
   * @returns {Promise<boolean>} True if video playback started, false otherwise
   */
  async playAlertVideo({ onEnded, onSkipped, onError, onFallbackSound }) {
    if (!this.videoEnabled || this.isPlaying) {
      return false;
    }

    this.isPlaying = true;
    this.onEndedCallback = onEnded;
    this.onSkippedCallback = onSkipped;
    this.onErrorCallback = onError;

    // Ensure video src is valid
    if (!this.videoEl.src || this.videoEl.src === '' || this.videoEl.src.endsWith('/')) {
      this.videoEl.src = this.currentObjectUrl || this.defaultVideoSrc;
    }

    // Configure audio
    this.videoEl.muted = !this.soundEnabled;
    try {
      this.videoEl.currentTime = 0;
    } catch (_) {}

    // Show container
    this.containerEl.classList.remove('hidden');
    if (this.unmuteBtn) this.unmuteBtn.classList.add('hidden');
    if (this.skipBtn) this.skipBtn.classList.add('hidden');

    // Show Skip button after 2.0 seconds
    if (this.skipTimer) clearTimeout(this.skipTimer);
    this.skipTimer = setTimeout(() => {
      if (this.isPlaying && this.skipBtn) {
        this.skipBtn.classList.remove('hidden');
      }
    }, 2000);

    try {
      await this.videoEl.play();
      return true;
    } catch (playErr) {
      console.warn('Initial video play rejected:', playErr);

      // Autoplay with sound may be blocked by browser policy -> Retry MUTED
      if (!this.videoEl.muted) {
        try {
          this.videoEl.muted = true;
          await this.videoEl.play();
          // If video was forced to play muted by browser policy, also trigger audio alert tone
          if (typeof onFallbackSound === 'function') {
            onFallbackSound();
          }
          // Show "Tap for sound" button so user can unmute
          if (this.unmuteBtn) {
            this.unmuteBtn.classList.remove('hidden');
          }
          return true;
        } catch (mutedErr) {
          console.error('Muted video playback also failed:', mutedErr);
        }
      }

      // If playback fails entirely (e.g. missing file or format unsupported):
      this._handlePlaybackError(playErr);
      return false;
    }
  }

  /**
   * Handle playback completion (ended or skipped).
   */
  _handlePlaybackEnd(reason) {
    if (!this.isPlaying) return;

    this._cleanupActivePlayback();

    if (reason === 'skipped' && typeof this.onSkippedCallback === 'function') {
      this.onSkippedCallback();
    } else if (typeof this.onEndedCallback === 'function') {
      this.onEndedCallback();
    }
  }

  /**
   * Handle unrecoverable video failure.
   */
  _handlePlaybackError(err) {
    this._cleanupActivePlayback();
    if (typeof this.onErrorCallback === 'function') {
      this.onErrorCallback(err);
    }
  }

  _cleanupActivePlayback() {
    this.isPlaying = false;
    if (this.skipTimer) {
      clearTimeout(this.skipTimer);
      this.skipTimer = null;
    }

    try {
      this.videoEl.pause();
    } catch {
      // Ignore
    }

    if (this.containerEl) {
      this.containerEl.classList.add('hidden');
    }
    if (this.skipBtn) {
      this.skipBtn.classList.add('hidden');
    }
    if (this.unmuteBtn) {
      this.unmuteBtn.classList.add('hidden');
    }
  }

  /**
   * Immediately abort playback and hide video (e.g., when Stop Monitoring is tapped).
   */
  stop() {
    this._cleanupActivePlayback();
  }

  /**
   * Test video preview triggered by user tap in settings.
   */
  async testPlay({ onEnded }) {
    await this.unlockAutoplay();
    await this.playAlertVideo({
      onEnded: () => {
        if (typeof onEnded === 'function') onEnded();
      },
      onSkipped: () => {
        if (typeof onEnded === 'function') onEnded();
      },
      onError: (err) => {
        console.warn('Test video failed:', err);
        if (typeof onEnded === 'function') onEnded();
      }
    });
  }

  /**
   * Cleanup resources on app destroy.
   */
  cleanup() {
    this.stop();
    if (this.currentObjectUrl) {
      URL.revokeObjectURL(this.currentObjectUrl);
      this.currentObjectUrl = null;
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

  async _saveVideoToDB(blob, name) {
    try {
      const db = await this._openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        const store = tx.objectStore(DB_STORE);
        store.put(blob, DB_KEY_CUSTOM_VIDEO);
        if (name) store.put(name, DB_KEY_CUSTOM_VIDEO_NAME);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      console.warn('Could not save video to IndexedDB:', err);
    }
  }

  async _getVideoFromDB() {
    try {
      const db = await this._openDB();
      return new Promise((resolve) => {
        const tx = db.transaction(DB_STORE, 'readonly');
        const store = tx.objectStore(DB_STORE);
        const reqBlob = store.get(DB_KEY_CUSTOM_VIDEO);
        const reqName = store.get(DB_KEY_CUSTOM_VIDEO_NAME);
        tx.oncomplete = () => {
          if (reqBlob.result) {
            resolve({
              blob: reqBlob.result,
              name: reqName.result || ''
            });
          } else {
            resolve(null);
          }
        };
        tx.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }

  async _deleteVideoFromDB() {
    try {
      const db = await this._openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        const store = tx.objectStore(DB_STORE);
        store.delete(DB_KEY_CUSTOM_VIDEO);
        store.delete(DB_KEY_CUSTOM_VIDEO_NAME);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // Ignore
    }
  }
}
