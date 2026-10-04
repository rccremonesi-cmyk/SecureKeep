/**
 * SecureKeep — Local Storage (IndexedDB)
 *
 * All data is stored pre-encrypted (the Vault layer encrypts before calling here).
 * This module only handles raw byte/string I/O against IndexedDB.
 *
 * Stores:
 *   vault_config   — the plaintext config.json mirror (salt, wrapped keys, version)
 *   encrypted_notes — { id, encryptedBlob, meta }
 *   sync_meta       — per-note last-synced version info
 *   unlock_guard    — local failed-attempt counter (not exported, not synced)
 *   biometric_unlock — device passkey wrap of the master key (not exported, not synced)
 *   device_secret   — this device's copy of the vault secret key (not exported, not synced)
 */

import { IDB_NAME, IDB_VERSION } from './config.js';

export class LocalStorage {
  constructor() {
    this._db = null;
  }

  // ─── Initialization ──────────────────────────────────────────────────────────

  async open() {
    if (this._db) return;
    this._db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;

        // Config store (single record, key = 'config')
        if (!db.objectStoreNames.contains('vault_config')) {
          db.createObjectStore('vault_config');
        }

        // Encrypted notes store, keyed by note id
        if (!db.objectStoreNames.contains('encrypted_notes')) {
          const notes = db.createObjectStore('encrypted_notes', { keyPath: 'id' });
          notes.createIndex('updatedAt', 'updatedAt');
        }

        // Sync metadata store, keyed by note id
        if (!db.objectStoreNames.contains('sync_meta')) {
          db.createObjectStore('sync_meta', { keyPath: 'id' });
        }

        // Encrypted vault index (single record, key = 'index')
        if (!db.objectStoreNames.contains('vault_index')) {
          db.createObjectStore('vault_index');
        }

        if (!db.objectStoreNames.contains('unlock_guard')) {
          db.createObjectStore('unlock_guard');
        }

        if (!db.objectStoreNames.contains('biometric_unlock')) {
          db.createObjectStore('biometric_unlock');
        }

        if (!db.objectStoreNames.contains('device_secret')) {
          db.createObjectStore('device_secret');
        }
      };

      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  // ─── Generic helpers ─────────────────────────────────────────────────────────

  _tx(stores, mode = 'readonly') {
    return this._db.transaction(stores, mode);
  }

  _get(store, key) {
    return new Promise((resolve, reject) => {
      const req = this._tx(store).objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }

  _put(store, value, key) {
    return new Promise((resolve, reject) => {
      const tx = this._tx(store, 'readwrite');
      const req = key !== undefined
        ? tx.objectStore(store).put(value, key)
        : tx.objectStore(store).put(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }

  _delete(store, key) {
    return new Promise((resolve, reject) => {
      const req = this._tx(store, 'readwrite').objectStore(store).delete(key);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  }

  _getAll(store) {
    return new Promise((resolve, reject) => {
      const req = this._tx(store).objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }

  // ─── Vault config ─────────────────────────────────────────────────────────────

  /**
   * Save vault configuration (plaintext: salts, wrapped keys, version).
   * @param {object} config
   */
  async saveConfig(config) {
    await this.open();
    await this._put('vault_config', config, 'config');
  }

  /**
   * Retrieve vault configuration.
   * @returns {object|undefined}
   */
  async getConfig() {
    await this.open();
    return this._get('vault_config', 'config');
  }

  async clearConfig() {
    await this.open();
    await this._delete('vault_config', 'config');
  }

  async getUnlockGuard() {
    await this.open();
    return (await this._get('unlock_guard', 'guard')) || { failures: 0, lockedUntil: 0 };
  }

  async saveUnlockGuard(guard) {
    await this.open();
    await this._put('unlock_guard', {
      failures: guard?.failures || 0,
      lockedUntil: guard?.lockedUntil || 0,
    }, 'guard');
  }

  async clearUnlockGuard() {
    await this.saveUnlockGuard({ failures: 0, lockedUntil: 0 });
  }

  async getBiometricUnlock() {
    await this.open();
    return this._get('biometric_unlock', 'record');
  }

  async saveBiometricUnlock(record) {
    await this.open();
    await this._put('biometric_unlock', record, 'record');
  }

  async clearBiometricUnlock() {
    await this.open();
    await this._delete('biometric_unlock', 'record');
  }

  async getDeviceSecret() {
    await this.open();
    const rec = await this._get('device_secret', 'secret');
    return rec?.value || null;
  }

  async saveDeviceSecret(value) {
    await this.open();
    await this._put('device_secret', { value: String(value || '') }, 'secret');
  }

  async clearDeviceSecret() {
    await this.open();
    await this._delete('device_secret', 'secret');
  }

  // ─── Encrypted notes ──────────────────────────────────────────────────────────

  /**
   * Save an encrypted note.
   * @param {string} id
   * @param {string} encryptedBlob   - base64 AES-GCM ciphertext
   * @param {object} meta            - { type, updatedAt, version, pinned, archived, trashed, color, tags }
   */
  async saveNote(id, encryptedBlob, meta = {}) {
    await this.open();
    const encryptedMeta = meta.encryptedMeta || null;
    const updatedAt = meta.updatedAt || null;
    const version = meta.version ?? null;
    await this._put('encrypted_notes', {
      id,
      encryptedBlob,
      updatedAt,
      version,
      encryptedMeta,
      meta: encryptedMeta ? { version, updatedAt } : meta,
    });
  }

  /**
   * Retrieve an encrypted note.
   * @param {string} id
   * @returns {{ id, encryptedBlob, meta }|undefined}
   */
  async getNote(id) {
    await this.open();
    return this._get('encrypted_notes', id);
  }

  /**
   * Retrieve all notes' metadata (without blobs) for index rebuilding.
   * @returns {Array}
   */
  async getAllNotesMeta() {
    await this.open();
    const all = await this._getAll('encrypted_notes');
    return all.map((rec) => {
      const meta = rec.encryptedMeta ? { version: rec.version, updatedAt: rec.updatedAt } : (rec.meta || {});
      return { id: rec.id, updatedAt: rec.updatedAt || meta.updatedAt, ...meta, encryptedMeta: rec.encryptedMeta || null };
    });
  }

  /**
   * Retrieve all notes with full blobs (for export).
   */
  async getAllNotes() {
    await this.open();
    return this._getAll('encrypted_notes');
  }

  /**
   * Delete a note from local cache.
   * @param {string} id
   */
  async deleteNote(id) {
    await this.open();
    await this._delete('encrypted_notes', id);
    await this._delete('sync_meta', id);
  }

  async clearAllNotes() {
    await this.open();
    await new Promise((res, rej) => {
      const req = this._tx('encrypted_notes', 'readwrite').objectStore('encrypted_notes').clear();
      req.onsuccess = res; req.onerror = () => rej(req.error);
    });
    await new Promise((res, rej) => {
      const req = this._tx('sync_meta', 'readwrite').objectStore('sync_meta').clear();
      req.onsuccess = res; req.onerror = () => rej(req.error);
    });
  }

  // ─── Vault index ──────────────────────────────────────────────────────────────

  /**
   * Save the encrypted index blob.
   * @param {string} encryptedBlob
   */
  async saveIndex(encryptedBlob) {
    await this.open();
    await this._put('vault_index', encryptedBlob, 'index');
  }

  /**
   * Get the encrypted index blob.
   * @returns {string|undefined}
   */
  async getIndex() {
    await this.open();
    return this._get('vault_index', 'index');
  }

  // ─── Sync metadata ───────────────────────────────────────────────────────────

  /**
   * Get sync state for a note (last synced remote version).
   * @param {string} id
   * @returns {{ id, remoteVersion, driveFileId }|undefined}
   */
  async getSyncMeta(id) {
    await this.open();
    return this._get('sync_meta', id);
  }

  /**
   * Update sync state after successful upload/download.
   * @param {string} id
   * @param {number} remoteVersion
   * @param {string} driveFileId
   */
  async updateSyncMeta(id, remoteVersion, driveFileId) {
    await this.open();
    await this._put('sync_meta', { id, remoteVersion, driveFileId });
  }

  /**
   * Get all sync metadata records.
   * @returns {Array}
   */
  async getAllSyncMeta() {
    await this.open();
    return this._getAll('sync_meta');
  }

  // ─── Convenience ─────────────────────────────────────────────────────────────

  /**
   * Wipe all local data (called on vault reset / sign-out).
   */
  async clearAll() {
    await this.open();
    await this.clearConfig();
    await this.clearAllNotes();
    await new Promise((res, rej) => {
      const req = this._tx('vault_index', 'readwrite').objectStore('vault_index').clear();
      req.onsuccess = res; req.onerror = () => rej(req.error);
    });
    await this.clearUnlockGuard();
    await this.clearBiometricUnlock();
    await this.clearDeviceSecret();
  }
}
