import { CryptoEngine } from './crypto.js';
import { LocalStorage } from './storage.js';
import { AUTO_LOCK_DEFAULT_MINUTES } from './config.js';

export class Vault {
  constructor(storage) {
    this.storage = storage || new LocalStorage();
    this._mk = null;            // Master Key
    this._indexCache = null;    // Decrypted index
    this._lockListeners = [];
    const storedLock = localStorage.getItem('sk_autolock_minutes');
    const parsedLock = storedLock === null ? NaN : parseInt(storedLock, 10);
    this._autoLockMinutes = Number.isNaN(parsedLock) ? AUTO_LOCK_DEFAULT_MINUTES : parsedLock;
    this._autoLockTimer = null;
    this._lastActivityTime = 0;
  }

  onLock(cb) {
    this._lockListeners.push(cb);
  }

  isUnlocked() {
    return !!this._mk;
  }

  /** Stable id for this browser, stored in localStorage. Used by sync conflict tracking. */
  get deviceId() {
    let id = localStorage.getItem('sk_device_id');
    if (!id) {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      id = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem('sk_device_id', id);
    }
    return id;
  }

  async create(password) {
    const recoveryKey = CryptoEngine.generateRecoveryKey();
    const mk = await CryptoEngine.generateMasterKey();
    const saltB64 = CryptoEngine.generateSalt();
    const saltBytes = CryptoEngine.decodeSalt(saltB64);
    const kekPwd = await CryptoEngine.deriveKeyFromPassword(password, saltBytes);
    const kekRec = await CryptoEngine.deriveKeyFromRecovery(recoveryKey);
    const wrappedMkPwd = await CryptoEngine.wrapKey(mk, kekPwd);
    const wrappedMkRec = await CryptoEngine.wrapKey(mk, kekRec);

    const config = {
      format: 'SecureKeep/1',
      version: 1,
      pwdSalt: saltB64,
      wrappedMkPwd,
      wrappedMkRec,
      kdfAlgorithm: await CryptoEngine.detectKdf(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      indexVersion: 1,
    };

    await this.storage.saveConfig(config);
    this._mk = mk;
    this._indexCache = { notes: {}, version: 1 };
    await this._saveIndex(this._indexCache);
    this.resetActivityTimer();

    // Return the object shape ui.js expects
    return { recoveryKey, config };
  }

  _decodeSalt(saltVal) {
    // The original vault may have stored salt as: Uint8Array, Array, base64 string, or hex string
    if (saltVal instanceof Uint8Array) return saltVal;
    if (Array.isArray(saltVal)) return new Uint8Array(saltVal);
    if (saltVal && typeof saltVal === 'object' && saltVal.buffer) return new Uint8Array(saltVal.buffer);
    if (typeof saltVal === 'string') {
      // Try base64 first
      try {
        return CryptoEngine.decodeSalt(saltVal);
      } catch(e) {
        // Fallback: try hex
        if (/^[0-9a-fA-F]+$/.test(saltVal)) {
          const bytes = new Uint8Array(saltVal.length / 2);
          for (let i = 0; i < bytes.length; i++) {
            bytes[i] = parseInt(saltVal.substring(i * 2, i * 2 + 2), 16);
          }
          return bytes;
        }
      }
    }
    throw new Error(`Salt debug — type: ${typeof saltVal}, constructor: ${saltVal?.constructor?.name}, value: ${JSON.stringify(saltVal)?.substring(0, 200)}`);
  }

  async getUnlockGuard() {
    return this.storage.getUnlockGuard();
  }

  _unlockLockoutMs(failures) {
    if (failures < 5) return 0;
    const steps = [30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000, 60 * 60 * 1000];
    return steps[Math.min(failures - 5, steps.length - 1)];
  }

  async _assertUnlockAllowed() {
    const guard = await this.storage.getUnlockGuard();
    const until = guard?.lockedUntil || 0;
    if (until > Date.now()) {
      const err = new Error('Troppi tentativi. Attendi prima di riprovare.');
      err.code = 'unlock-locked';
      err.lockedUntil = until;
      throw err;
    }
  }

  async _registerUnlockFailure(message) {
    const guard = await this.storage.getUnlockGuard();
    const failures = (guard?.failures || 0) + 1;
    const wait = this._unlockLockoutMs(failures);
    const lockedUntil = wait ? Date.now() + wait : 0;
    await this.storage.saveUnlockGuard({ failures, lockedUntil });
    const err = new Error(lockedUntil ? 'Troppi tentativi. Attendi prima di riprovare.' : message);
    err.code = lockedUntil ? 'unlock-locked' : 'unlock-failed';
    err.lockedUntil = lockedUntil;
    throw err;
  }

  async unlock(password) {
    await this._assertUnlockAllowed();
    const config = await this.storage.getConfig();
    if (!config) throw new Error('Vault not initialized');
    const salt = this._decodeSalt(config.pwdSalt || config.salt);
    try {
      const kekPwd = await CryptoEngine.deriveKeyFromPassword(password, salt, config.kdfAlgorithm || config.kdfAlgo);
      this._mk = await CryptoEngine.unwrapKey(config.wrappedMkPwd, kekPwd);
    } catch (err) {
      if (err?.code === 'unlock-locked' || err?.code === 'unlock-failed' || err?.code === 'kdf-unavailable') throw err;
      await this._registerUnlockFailure('Password non corretta');
    }
    await this.storage.clearUnlockGuard();
    this.resetActivityTimer();
  }

  async unlockWithRecovery(recoveryKey) {
    await this._assertUnlockAllowed();
    const config = await this.storage.getConfig();
    if (!config) throw new Error('Vault not initialized');
    try {
      const kekRec = await CryptoEngine.deriveKeyFromRecovery(recoveryKey);
      this._mk = await CryptoEngine.unwrapKey(config.wrappedMkRec, kekRec);
    } catch (err) {
      if (err?.code === 'unlock-locked' || err?.code === 'unlock-failed') throw err;
      await this._registerUnlockFailure('Chiave di ripristino non corretta');
    }
    await this.storage.clearUnlockGuard();
    this.resetActivityTimer();
  }

  async biometricSupported() {
    if (typeof PublicKeyCredential === 'undefined') return false;
    try {
      const platform = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
      if (!platform) return false;
      if (typeof PublicKeyCredential.getClientCapabilities === 'function') {
        const caps = await PublicKeyCredential.getClientCapabilities();
        if (caps && Object.prototype.hasOwnProperty.call(caps, 'prf') && !caps.prf) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  async hasBiometricUnlock() {
    const record = await this.storage.getBiometricUnlock();
    return !!(record?.credentialId && record?.prfSalt && record?.wrappedMk);
  }

  _prfFirst(credential) {
    const first = credential?.getClientExtensionResults?.()?.prf?.results?.first;
    return first ? new Uint8Array(first) : null;
  }

  async _prfKey(bytes) {
    return crypto.subtle.importKey('raw', bytes, { name: 'AES-KW' }, false, ['wrapKey', 'unwrapKey']);
  }

  _biometricCreateOptions(prfSalt) {
    return {
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: 'SecureKeep' },
        user: {
          id: crypto.getRandomValues(new Uint8Array(16)),
          name: 'securekeep',
          displayName: 'SecureKeep',
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          residentKey: 'preferred',
        },
        timeout: 60000,
        extensions: { prf: { eval: { first: prfSalt } } },
      },
    };
  }

  _biometricGetOptions(credentialId, prfSalt) {
    return {
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ type: 'public-key', id: credentialId }],
        userVerification: 'required',
        timeout: 60000,
        extensions: { prf: { eval: { first: prfSalt } } },
      },
    };
  }

  async enrollBiometric(password) {
    if (!(await this.biometricSupported())) {
      throw new Error('Questo dispositivo non supporta lo sblocco con impronta');
    }
    const config = await this.storage.getConfig();
    if (!config) throw new Error('Vault not initialized');
    const pwdSalt = this._decodeSalt(config.pwdSalt || config.salt);
    let extractableMk;
    try {
      const kekPwd = await CryptoEngine.deriveKeyFromPassword(password, pwdSalt, config.kdfAlgorithm || config.kdfAlgo);
      extractableMk = await CryptoEngine.unwrapKey(config.wrappedMkPwd, kekPwd, true);
    } catch (err) {
      if (err?.code === 'kdf-unavailable') throw err;
      throw new Error('Password non corretta');
    }
    const prfSalt = crypto.getRandomValues(new Uint8Array(32));
    let created;
    try {
      created = await navigator.credentials.create(this._biometricCreateOptions(prfSalt));
    } catch (err) {
      if (err?.name === 'NotAllowedError' || err?.name === 'AbortError') throw new Error('Attivazione annullata');
      throw new Error('Impronta non disponibile su questo dispositivo');
    }
    if (!created?.rawId) throw new Error('Impronta non disponibile su questo dispositivo');
    let prfBytes = this._prfFirst(created);
    if (!prfBytes) {
      try {
        const assertion = await navigator.credentials.get(this._biometricGetOptions(created.rawId, prfSalt));
        prfBytes = this._prfFirst(assertion);
      } catch (err) {
        if (err?.name === 'NotAllowedError' || err?.name === 'AbortError') throw new Error('Attivazione annullata');
        throw new Error('Impronta non disponibile su questo dispositivo');
      }
    }
    if (!prfBytes) throw new Error('Impronta non disponibile su questo dispositivo');
    try {
      const prfKey = await this._prfKey(prfBytes);
      const wrappedMk = await CryptoEngine.wrapKey(extractableMk, prfKey);
      await this.storage.saveBiometricUnlock({
        credentialId: CryptoEngine._bytesToBase64(new Uint8Array(created.rawId)),
        prfSalt: CryptoEngine._bytesToBase64(prfSalt),
        wrappedMk,
      });
    } catch (err) {
      if (err?.message === 'Impronta non disponibile su questo dispositivo') throw err;
      throw new Error('Impronta non disponibile su questo dispositivo');
    }
  }

  async unlockWithBiometric() {
    const record = await this.storage.getBiometricUnlock();
    if (!record?.credentialId || !record?.prfSalt || !record?.wrappedMk) {
      throw new Error('Sblocco con impronta non attivo');
    }
    const credentialId = CryptoEngine._base64ToBytes(record.credentialId);
    const prfSalt = CryptoEngine._base64ToBytes(record.prfSalt);
    let assertion;
    try {
      assertion = await navigator.credentials.get(this._biometricGetOptions(credentialId, prfSalt));
    } catch (err) {
      if (err?.name === 'NotAllowedError' || err?.name === 'AbortError') {
        const cancel = new Error('Sblocco annullato');
        cancel.code = 'biometric-cancelled';
        throw cancel;
      }
      throw new Error('Impronta non riuscita');
    }
    const prfBytes = this._prfFirst(assertion);
    if (!prfBytes) throw new Error('Impronta non riuscita');
    try {
      const prfKey = await this._prfKey(prfBytes);
      this._mk = await CryptoEngine.unwrapKey(record.wrappedMk, prfKey, false);
    } catch {
      throw new Error('Impronta non riuscita');
    }
    await this.storage.clearUnlockGuard();
    this.resetActivityTimer();
  }

  async clearBiometric() {
    await this.storage.clearBiometricUnlock();
  }

  async changePassword(oldPassword, newPassword) {
    this._requireUnlocked();
    const config = await this.storage.getConfig();
    const oldSalt = this._decodeSalt(config.pwdSalt || config.salt);
    const oldKek = await CryptoEngine.deriveKeyFromPassword(oldPassword, oldSalt, config.kdfAlgorithm || config.kdfAlgo);
    try {
      await CryptoEngine.unwrapKey(config.wrappedMkPwd, oldKek);
    } catch(err) {
      throw new Error('Vecchia password non valida');
    }
    const newSaltB64 = CryptoEngine.generateSalt();
    const newKek = await CryptoEngine.deriveKeyFromPassword(newPassword, CryptoEngine.decodeSalt(newSaltB64));
    config.pwdSalt = newSaltB64;
    config.kdfAlgorithm = await CryptoEngine.detectKdf();
    config.wrappedMkPwd = await CryptoEngine.wrapKey(this._mk, newKek);
    config.updatedAt = new Date().toISOString();
    await this.storage.saveConfig(config);
  }

  lock() {
    this._mk = null;
    this._indexCache = null;
    this._clearAutoLock();
    this._lockListeners.forEach(cb => cb());
  }

  // --- Auto-lock ---

  setAutoLockMinutes(minutes) {
    this._autoLockMinutes = minutes;
    localStorage.setItem('sk_autolock_minutes', minutes.toString());
    this._resetAutoLock();
  }

  resetActivityTimer() {
    if (this._mk) {
      this._lastActivityTime = Date.now();
      this._resetAutoLock();
    }
  }

  get lastActivityTime() { return this._lastActivityTime; }
  get autoLockMinutes() { return this._autoLockMinutes; }

  _startAutoLock() {
    this._clearAutoLock();
    if (this._autoLockMinutes === 0) return;
    this._scheduleAutoLock();
  }

  _resetAutoLock() {
    this._clearAutoLock();
    if (!this._mk || this._autoLockMinutes === 0) return;
    this._scheduleAutoLock();
  }

  _scheduleAutoLock() {
    this._autoLockTimer = setTimeout(() => {
      this.lock();
    }, this._autoLockMinutes * 60 * 1000);
  }

  _clearAutoLock() {
    if (this._autoLockTimer) {
      clearTimeout(this._autoLockTimer);
      this._autoLockTimer = null;
    }
  }

  // --- Note CRUD ---

  _generatePreview(data) {
    if (data.type === 'note') {
      return (data.content || '').substring(0, 150);
    } else if (data.type === 'password') {
      const parts = [];
      if (data.username) parts.push('U:' + data.username);
      if (data.url) parts.push('L:' + data.url);
      if (data.password) parts.push('P:••••••••••••');
      if (data.notes) parts.push('N:' + data.notes.substring(0, 100));
      return parts.join('\n').substring(0, 300);
    } else if (data.type === 'checklist') {
      const items = data.items || [];
      return items.slice(0, 4).map(i => (i.checked ? '[x] ' : '[ ] ') + i.text).join('\n').substring(0, 150);
    }
    return '';
  }

  /**
   * Create a new note.

   * @param {'password'|'note'|'checklist'} type
   * @param {object} data  - plaintext note data
   * @returns {string} new note id
   */
  async createNote(type, data) {
    this._requireUnlocked();

    const id = this._generateId();
    const now = new Date().toISOString();

    const noteData = { type, ...data, id, createdAt: now, updatedAt: now, addedAt: now };
    delete noteData.category;

    // Encrypt content
    const encryptedBlob = await CryptoEngine.encrypt(noteData, this._mk);

    // Metadata stored in plaintext in the index (not in the blob)
    const meta = {
      type,
      version:    1,
      updatedAt:  now,
      addedAt:    now,
      pinned:     data.pinned    || false,
      archived:   data.archived  || false,
      trashed:    data.trashed   || false,
      trashedAt:  data.trashed ? (data.trashedAt || null) : null,
      color:      data.color     || 'default',
      tags:       data.tags      || [],
      placeIds:   this._placeIds(data.placeIds),
      preview:    this._generatePreview(data),
      icon:       data.icon      || null,
      title:      data.title     || '',
      hasUsername: !!data.username,
      hasPassword: !!data.password,
      renewMonths: Number(data.renewMonths) || 0,
      passwordSetAt: data.passwordSetAt || null,
      thumbnail:  data.thumbnail || null,
      thumbnails: Array.isArray(data.thumbnails) ? data.thumbnails.slice(0, 3) : (data.thumbnail ? [data.thumbnail] : []),
      imageCount: data.imageCount || 0,
      conflicted: false,
    };

    await this.storage.saveNote(id, encryptedBlob, meta);
    await this._updateIndex(id, meta);

    return id;
  }

  /**
   * Update an existing note's content.
   * @param {string} id
   * @param {object} data  - full updated plaintext note data
   */
  async updateNote(id, data, updateTimestamp = true) {
    this._requireUnlocked();

    const existing = await this.storage.getNote(id);
    if (!existing) throw new Error(`Note ${id} not found`);

    const now = updateTimestamp ? new Date().toISOString() : (existing.meta?.updatedAt || new Date().toISOString());
    const trashed = data.trashed !== undefined ? data.trashed : existing.meta?.trashed || false;
    const addedAt = data.addedAt || existing.meta?.addedAt || existing.meta?.updatedAt || now;
    const noteData = { ...data, id, updatedAt: now, addedAt, trashed, trashedAt: trashed ? (data.trashedAt || existing.meta?.trashedAt || null) : null };
    delete noteData.category;

    const encryptedBlob = await CryptoEngine.encrypt(noteData, this._mk);

    const meta = {
      ...existing.meta,
      version:   (existing.meta?.version || 0) + 1,
      updatedAt: now,
      addedAt,
      title:     data.title    !== undefined ? data.title    : existing.meta?.title    || '',
      pinned:    data.pinned   !== undefined ? data.pinned   : existing.meta?.pinned   || false,
      archived:  data.archived !== undefined ? data.archived : existing.meta?.archived || false,
      trashed,
      trashedAt: trashed ? (data.trashedAt || existing.meta?.trashedAt || null) : null,
      color:     data.color    !== undefined ? data.color    : existing.meta?.color    || 'default',
      tags:      data.tags     !== undefined ? data.tags     : existing.meta?.tags     || [],
      placeIds:  data.placeIds !== undefined ? this._placeIds(data.placeIds) : this._placeIds(existing.meta?.placeIds),
      preview:   this._generatePreview(data),
      icon:      data.icon     !== undefined ? data.icon     : existing.meta?.icon     || null,
      hasUsername: data.type === 'password' ? !!data.username : existing.meta?.hasUsername || false,
      hasPassword: data.type === 'password' ? !!data.password : existing.meta?.hasPassword || false,
      renewMonths: data.renewMonths !== undefined ? (Number(data.renewMonths) || 0) : (existing.meta?.renewMonths || 0),
      passwordSetAt: data.passwordSetAt !== undefined ? (data.passwordSetAt || null) : (existing.meta?.passwordSetAt || null),
      thumbnail: data.thumbnail !== undefined ? data.thumbnail : existing.meta?.thumbnail || null,
      thumbnails: Array.isArray(data.thumbnails) ? data.thumbnails.slice(0, 3) : (existing.meta?.thumbnails || (existing.meta?.thumbnail ? [existing.meta.thumbnail] : [])),
      imageCount: data.imageCount !== undefined ? data.imageCount : existing.meta?.imageCount || 0,
      conflicted: false,
    };
    delete meta.category;

    await this.storage.saveNote(id, encryptedBlob, meta);
    await this._updateIndex(id, meta);
    this.resetActivityTimer();
  }

  /**
   * Get a note's decrypted content.
   * @param {string} id
   * @returns {object}
   */
  async getNote(id) {
    this._requireUnlocked();
    const record = await this.storage.getNote(id);
    if (!record) throw new Error(`Note ${id} not found`);
    const decrypted = await CryptoEngine.decrypt(record.encryptedBlob, this._mk);
    this.resetActivityTimer();
    return decrypted;
  }

  async findPasswordReuse(password, exceptId) {
    const secret = String(password || '');
    if (!secret) return [];
    const index = await this.getIndex();
    const matches = [];
    for (const [id, meta] of Object.entries(index.notes || {})) {
      if ((meta?.id || id) === exceptId) continue;
      if (meta?.type !== 'password' || meta?.trashed) continue;
      let note;
      try { note = await this.getNote(meta.id || id); } catch { continue; }
      if (note?.password && note.password === secret) {
        matches.push(note.title || 'Senza titolo');
      }
    }
    return matches;
  }

  /**
   * Move a note to trash.
   * @param {string} id
   */
  async trashNote(id) {
    this._requireUnlocked();
    const note = await this.getNote(id);
    const trashedAt = note.trashedAt || new Date().toISOString();
    await this.updateNote(id, { ...note, trashed: true, trashedAt }, false);
  }

  /**
   * Restore a note from trash.
   * @param {string} id
   */
  async restoreNote(id) {
    this._requireUnlocked();
    const note = await this.getNote(id);
    delete note.trashedAt;
    await this.updateNote(id, { ...note, trashed: false, trashedAt: null }, false);
  }

  /**
   * Permanently delete notes that have been in the trash for 7 days.
   * Notes already in the trash without a date start their 7 days now.
   * @returns {number} how many notes were deleted
   */
  async purgeExpiredTrash() {
    this._requireUnlocked();
    const maxAge = 7 * 24 * 60 * 60 * 1000;
    const index = await this.getIndex();
    const now = Date.now();
    let removed = 0;

    for (const meta of Object.values(index.notes || {})) {
      if (!meta?.trashed) continue;
      if (!meta.trashedAt) {
        const note = await this.getNote(meta.id);
        await this.updateNote(meta.id, { ...note, trashed: true, trashedAt: new Date().toISOString() }, false);
        continue;
      }
      const trashedAt = new Date(meta.trashedAt).getTime();
      if (!Number.isFinite(trashedAt) || now - trashedAt < maxAge) continue;
      await this.deleteNote(meta.id);
      removed++;
    }
    return removed;
  }

  /**
   * Permanently delete a note (only allowed from trash).
   * @param {string} id
   */
  async deleteNote(id) {
    this._requireUnlocked();
    const tombstones = this._tombstones();
    if (!tombstones.includes(id)) {
      tombstones.push(id);
      localStorage.setItem('sk_deleted_ids', JSON.stringify(tombstones));
    }
    await this.storage.deleteNote(id);
    await this._removeFromIndex(id);
  }

  _tombstones() {
    try { return JSON.parse(localStorage.getItem('sk_deleted_ids') || '[]'); }
    catch { return []; }
  }

  forgetTombstone(id) {
    const next = this._tombstones().filter(x => x !== id);
    localStorage.setItem('sk_deleted_ids', JSON.stringify(next));
  }

  /**
   * Archive / unarchive a note.
   * @param {string} id
   * @param {boolean} archived
   */
  async setArchived(id, archived) {
    this._requireUnlocked();
    const note = await this.getNote(id);
    await this.updateNote(id, { ...note, archived }, false);
  }

  /**
   * Pin / unpin a note.
   */
  async setPinned(id, pinned) {
    this._requireUnlocked();
    const note = await this.getNote(id);
    await this.updateNote(id, { ...note, pinned }, false);
  }

  /**
   * Set note color.
   */
  async setColor(id, color) {
    this._requireUnlocked();
    const note = await this.getNote(id);
    await this.updateNote(id, { ...note, color }, false);
  }

  /**
   * Mark a note as conflicted (called by SyncManager).
   */
  async markNoteConflicted(id) {
    const existing = await this.storage.getNote(id);
    if (!existing) return;
    existing.meta.conflicted = true;
    await this.storage.saveNote(id, existing.encryptedBlob, existing.meta);
    await this._updateIndex(id, existing.meta);
  }

  // ─── Index ────────────────────────────────────────────────────────────────────

  /**
   * Get the decrypted index (full note metadata list).
   * @returns {{ notes: Object, version: number }}
   */
  async getIndex() {
    this._requireUnlocked();
    if (this._indexCache) return this._indexCache;

    const blob = await this.storage.getIndex();
    if (!blob) return { notes: {}, version: 0 };

    this._indexCache = await CryptoEngine.decrypt(blob, this._mk);
    return this._indexCache;
  }

  /** Encrypt an index object. Used by SyncManager for merge. */
  async encryptIndex(indexObj) {
    this._requireUnlocked();
    return CryptoEngine.encrypt(indexObj, this._mk);
  }

  /** Decrypt an index blob. Used by SyncManager for merge. */
  async decryptIndex(blob) {
    this._requireUnlocked();
    return CryptoEngine.decrypt(blob, this._mk);
  }


  /** Drop the decrypted index so the next getIndex() reads IndexedDB again. */
  invalidateIndexCache() {
    this._indexCache = null;
  }

  /**
   * Store a note downloaded from Drive and rebuild its index entry from the plaintext.
   */
  async importRemoteNote(id, encryptedBlob, remoteVersion, appProperties = {}) {
    this._requireUnlocked();
    const data = await CryptoEngine.decrypt(encryptedBlob, this._mk);
    const updatedAt = data.updatedAt || appProperties.updatedAt || new Date().toISOString();
    const meta = {
      type: data.type,
      version: remoteVersion,
      updatedAt,
      addedAt: data.addedAt || data.createdAt || updatedAt,
      pinned: !!data.pinned,
      archived: !!data.archived,
      trashed: !!data.trashed,
      trashedAt: data.trashed ? (data.trashedAt || null) : null,
      color: data.color || 'default',
      tags: data.tags || [],
      placeIds: this._placeIds(data.placeIds),
      preview: this._generatePreview(data),
      icon: data.icon || null,
      title: data.title || '',
      hasUsername: data.type === 'password' ? !!data.username : false,
      hasPassword: data.type === 'password' ? !!data.password : false,
      thumbnail: data.thumbnail || null,
      thumbnails: Array.isArray(data.thumbnails) ? data.thumbnails.slice(0, 3) : (data.thumbnail ? [data.thumbnail] : []),
      imageCount: data.imageCount || (Array.isArray(data.images) ? data.images.length : 0),
      conflicted: false,
    };
    await this.storage.saveNote(id, encryptedBlob, meta);
    await this._updateIndex(id, meta);
  }

  /** Replace the local index with an already-merged object and persist its version. */
  async adoptIndex(indexObj) {
    this._requireUnlocked();
    const blob = await CryptoEngine.encrypt(indexObj, this._mk);
    await this.storage.saveIndex(blob);
    this._indexCache = indexObj;
    const config = await this.storage.getConfig();
    if (config) {
      config.indexVersion = indexObj.version || config.indexVersion || 1;
      await this.storage.saveConfig(config);
    }
  }

  async saveTagCatalog(tags) {
    const index = await this.getIndex();
    index.tagCatalog = [...new Set((tags || []).map(t => String(t).trim()).filter(Boolean))];
    await this._saveIndex(index);
  }

  _placeIds(ids) {
    return [...new Set((Array.isArray(ids) ? ids : []).map(id => String(id || '').trim()).filter(Boolean))];
  }

  async savePlaces(places) {
    const allowed = new Set([100, 200, 500, 1000, 2000]);
    const index = await this.getIndex();
    index.places = (places || []).map(p => ({
      id: String(p.id || '').trim(),
      name: String(p.name || '').trim(),
      address: String(p.address || '').trim(),
      lat: Number(p.lat),
      lng: Number(p.lng),
      radius: allowed.has(Number(p.radius)) ? Number(p.radius) : 100,
    })).filter(p => p.id && p.name && Number.isFinite(p.lat) && Number.isFinite(p.lng));
    await this._saveIndex(index);
  }

  async _saveIndex(indexObj) {
    const config = await this.storage.getConfig();
    const next = (config?.indexVersion || indexObj.version || 0) + 1;
    indexObj.version = next;
    const blob = await CryptoEngine.encrypt(indexObj, this._mk);
    await this.storage.saveIndex(blob);
    this._indexCache = indexObj;

    if (config) {
      config.indexVersion = next;
      await this.storage.saveConfig(config);
    }
  }

  async _updateIndex(id, meta) {
    const index = await this.getIndex();
    index.notes[id] = { id, ...meta };
    await this._saveIndex(index);
  }

  async _removeFromIndex(id) {
    const index = await this.getIndex();
    delete index.notes[id];
    await this._saveIndex(index);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  _requireUnlocked() {
    if (!this._mk) throw new Error('Cassaforte bloccata. Sbloccala prima di procedere.');
  }

  _generateId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Check if a vault already exists in local storage.
   */
  async exists() {
    const config = await this.storage.getConfig();
    return Boolean(config);
  }
}
