/**
 * SecureKeep — Google Drive Integration
 *
 * Handles OAuth 2.0 PKCE flow and all Drive API v3 operations.
 * Scope: drive.file — the app only accesses files it creates.
 *
 * PKCE flow (no client secret embedded):
 *   1. Generate code_verifier (random)
 *   2. Derive code_challenge = BASE64URL(SHA-256(code_verifier))
 *   3. Redirect to Google OAuth
 *   4. Google redirects back with ?code=...
 *   5. Exchange code + code_verifier for access_token (no secret needed)
 */

import {
  GOOGLE_CLIENT_ID, GOOGLE_REDIRECT_URI, GOOGLE_SCOPES,
  DRIVE_API_BASE, DRIVE_UPLOAD_BASE, VAULT_FOLDER_NAME,
} from './config.js';

export class DriveSync {
  constructor() {
    this._accessToken = null;
    this._tokenExpiry = null;
    this._vaultFolderId = null;
    this._notesFolderId = null;
    this._configFileId = null;
    this._indexFileId = null;
  }

  // ─── OAuth PKCE ───────────────────────────────────────────────────────────────

  /**
   * Start OAuth PKCE flow — redirects to Google.
   * Call this when the user clicks "Connect Google Drive".
   */
  async startAuth() {
    await this._loadGoogleIdentity();
    return new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: GOOGLE_SCOPES,
        callback: (resp) => {
          if (!resp || resp.error) {
            reject(new Error(resp?.error_description || resp?.error || 'Accesso Google annullato'));
            return;
          }
          this._accessToken = resp.access_token;
          const expiresIn = Number(resp.expires_in) || 3600;
          this._tokenExpiry = Date.now() + (expiresIn - 60) * 1000;
          sessionStorage.setItem('sk_access_token', this._accessToken);
          sessionStorage.setItem('sk_token_expiry', String(this._tokenExpiry));
          resolve(true);
        },
      });
      client.requestAccessToken({ prompt: 'consent' });
    });
  }

  _loadGoogleIdentity() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    if (this._gisPromise) return this._gisPromise;
    this._gisPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Google non disponibile'));
      document.head.appendChild(script);
    });
    return this._gisPromise;
  }

  /**
   * Complete PKCE flow — called on page load if ?code= is in URL.
   * Exchanges the code for an access token.
   *
   * @returns {boolean} true if auth was completed
   */
  async handleCallback() {
    const params = new URLSearchParams(window.location.search);
    if (!params.get('code') && !params.get('error')) return false;
    window.history.replaceState({}, document.title, window.location.pathname);
    sessionStorage.removeItem('sk_pkce_verifier');
    return false;
  }

  /**
   * Restore token from session storage (survives page reloads within same tab).
   * @returns {boolean}
   */
  restoreSession() {
    const token  = sessionStorage.getItem('sk_access_token');
    const expiry = sessionStorage.getItem('sk_token_expiry');
    if (token && expiry && Date.now() < Number(expiry)) {
      this._accessToken = token;
      this._tokenExpiry = Number(expiry);
      return true;
    }
    return false;
  }

  /**
   * Check whether we have a valid (non-expired) access token.
   */
  get isAuthenticated() {
    return Boolean(this._accessToken && Date.now() < this._tokenExpiry);
  }

  /**
   * Sign out: clear tokens and cached folder IDs.
   */
  signOut() {
    this._accessToken = null;
    this._tokenExpiry = null;
    this._vaultFolderId = null;
    this._notesFolderId = null;
    this._configFileId  = null;
    this._indexFileId   = null;
    sessionStorage.removeItem('sk_access_token');
    sessionStorage.removeItem('sk_token_expiry');
  }

  // ─── Vault structure ─────────────────────────────────────────────────────────

  /**
   * Ensure the vault folder structure exists on Drive.
   * Creates /SecureKeepVault/ and /SecureKeepVault/notes/ if missing.
   */
  async ensureVaultStructure() {
    // Root vault folder
    this._vaultFolderId = await this._findOrCreateFolder(VAULT_FOLDER_NAME, 'root');
    // Notes subfolder
    this._notesFolderId = await this._findOrCreateFolder('notes', this._vaultFolderId);
  }

  // ─── Config file ─────────────────────────────────────────────────────────────

  /**
   * Upload / update config.json (plaintext vault metadata).
   * @param {object} configData
   */
  async uploadConfig(configData) {
    await this._ensureFolders();
    const body = JSON.stringify(configData, null, 2);
    this._configFileId = await this._upsertFile(
      'config.json', this._vaultFolderId, body, 'application/json', this._configFileId
    );
  }

  /**
   * Download config.json.
   * @returns {object|null}
   */
  async downloadConfig() {
    await this._ensureFolders();
    const fileId = await this._findFile('config.json', this._vaultFolderId);
    if (!fileId) return null;
    this._configFileId = fileId;
    const resp = await this._fetch(`${DRIVE_API_BASE}/files/${fileId}?alt=media`);
    return resp.json();
  }

  // ─── Index file ───────────────────────────────────────────────────────────────

  /**
   * Upload / update index.enc.
   * @param {string} encryptedBlob - base64 encrypted index
   * @param {number} version
   * @param {string} deviceId
   */
  async uploadIndex(encryptedBlob, version, deviceId) {
    await this._ensureFolders();
    const appProperties = { version: String(version), deviceId, updatedAt: new Date().toISOString() };
    this._indexFileId = await this._upsertFile(
      'index.enc', this._vaultFolderId, encryptedBlob,
      'application/octet-stream', this._indexFileId, appProperties
    );
  }

  /**
   * Download index.enc.
   * @returns {{ encryptedBlob: string, version: number, fileId: string }|null}
   */
  async downloadIndex() {
    await this._ensureFolders();
    const result = await this._findFileWithProps('index.enc', this._vaultFolderId);
    if (!result) return null;
    this._indexFileId = result.id;
    const resp = await this._fetch(`${DRIVE_API_BASE}/files/${result.id}?alt=media`);
    const encryptedBlob = await resp.text();
    return {
      encryptedBlob,
      version: parseInt(result.appProperties?.version || '0', 10),
      fileId: result.id,
    };
  }

  /**
   * Get current remote version of index without downloading content.
   * @returns {number}
   */
  async getIndexVersion() {
    await this._ensureFolders();
    const result = await this._findFileWithProps('index.enc', this._vaultFolderId);
    return result ? parseInt(result.appProperties?.version || '0', 10) : 0;
  }

  // ─── Note files ───────────────────────────────────────────────────────────────

  /**
   * Upload / update a note's .enc file.
   *
   * @param {string} id
   * @param {string} encryptedBlob
   * @param {object} meta  - { version, deviceId, updatedAt }
   * @param {string|null} driveFileId - existing Drive file ID if updating
   * @returns {string} Drive file ID
   */
  async uploadNote(id, encryptedBlob, meta, driveFileId = null) {
    await this._ensureFolders();
    const appProperties = {
      noteId:    id,
      version:   String(meta.version),
      deviceId:  meta.deviceId,
      updatedAt: meta.updatedAt,
    };
    return this._upsertFile(
      `${id}.enc`, this._notesFolderId, encryptedBlob,
      'application/octet-stream', driveFileId, appProperties
    );
  }

  /**
   * Download a note's .enc file.
   *
   * @param {string} driveFileId
   * @returns {{ encryptedBlob: string, version: number, appProperties: object }}
   */
  async downloadNote(driveFileId) {
    const meta = await this._getFileMetadata(driveFileId, 'appProperties');
    const resp = await this._fetch(`${DRIVE_API_BASE}/files/${driveFileId}?alt=media`);
    const encryptedBlob = await resp.text();
    return {
      encryptedBlob,
      version: parseInt(meta.appProperties?.version || '0', 10),
      appProperties: meta.appProperties || {},
    };
  }

  /**
   * List all .enc files in the notes folder with their appProperties.
   * @returns {Array<{ id, name, appProperties }>}
   */
  async listNotes() {
    await this._ensureFolders();
    const q = `'${this._notesFolderId}' in parents and trashed = false and name contains '.enc'`;
    const fields = 'files(id,name,appProperties)';
    const resp = await this._fetch(
      `${DRIVE_API_BASE}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(fields)}&pageSize=1000`
    );
    const data = await resp.json();
    return data.files || [];
  }

  /**
   * Get the current remote appProperties of a single note file (for conflict check).
   * @param {string} driveFileId
   * @returns {{ version: number, appProperties: object }}
   */
  async getNoteVersion(driveFileId) {
    const meta = await this._getFileMetadata(driveFileId, 'appProperties');
    return {
      version: parseInt(meta.appProperties?.version || '0', 10),
      appProperties: meta.appProperties || {},
    };
  }

  /**
   * Create a conflict copy of a note on Drive.
   * @param {string} id
   * @param {string} encryptedBlob
   * @param {string} deviceId
   */
  async uploadConflictCopy(id, encryptedBlob, deviceId) {
    await this._ensureFolders();
    const ts = Date.now();
    const name = `${id}__conflict__${ts}.enc`;
    const appProperties = { noteId: id, conflictOf: id, deviceId, createdAt: new Date().toISOString() };
    return this._upsertFile(
      name, this._notesFolderId, encryptedBlob,
      'application/octet-stream', null, appProperties
    );
  }

  /**
   * Soft-delete (trash) a note's Drive file.
   * @param {string} driveFileId
   */
  async deleteNote(driveFileId) {
    await this._fetch(`${DRIVE_API_BASE}/files/${driveFileId}`, {
      method: 'DELETE',
    });
  }

  // ─── Sync lock ───────────────────────────────────────────────────────────────

  async acquireLock(deviceId) {
    await this._ensureFolders();
    const content = JSON.stringify({ deviceId, acquiredAt: Date.now() });
    return this._upsertFile('sync.lock', this._vaultFolderId, content, 'application/json');
  }

  async releaseLock() {
    const fileId = await this._findFile('sync.lock', this._vaultFolderId);
    if (fileId) await this.deleteNote(fileId);
  }

  async checkLock() {
    const result = await this._findFileWithProps('sync.lock', this._vaultFolderId);
    if (!result) return null;
    const resp = await this._fetch(`${DRIVE_API_BASE}/files/${result.id}?alt=media`);
    return resp.json();
  }

  // ─── PKCE helpers ────────────────────────────────────────────────────────────

  _generateCodeVerifier() {
    const bytes = crypto.getRandomValues(new Uint8Array(64));
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  async _deriveCodeChallenge(verifier) {
    const enc = new TextEncoder();
    const hash = await crypto.subtle.digest('SHA-256', enc.encode(verifier));
    return btoa(String.fromCharCode(...new Uint8Array(hash)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  // ─── Drive API helpers ───────────────────────────────────────────────────────

  async _fetch(url, options = {}) {
    if (!this.isAuthenticated) throw new Error('Non autenticato con Google Drive');
    const resp = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this._accessToken}`,
        ...options.headers,
      },
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(`Drive API error ${resp.status}: ${err.error?.message || resp.statusText}`);
    }
    return resp;
  }

  async _findOrCreateFolder(name, parentId) {
    const existing = await this._findFolder(name, parentId);
    if (existing) return existing;

    const meta = { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] };
    const resp = await this._fetch(`${DRIVE_API_BASE}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(meta),
    });
    const data = await resp.json();
    return data.id;
  }

  async _findFolder(name, parentId) {
    const q = `name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents and trashed = false`;
    const resp = await this._fetch(
      `${DRIVE_API_BASE}/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`
    );
    const data = await resp.json();
    return data.files?.[0]?.id || null;
  }

  async _findFile(name, parentId) {
    const q = `name = '${name}' and '${parentId}' in parents and trashed = false`;
    const resp = await this._fetch(
      `${DRIVE_API_BASE}/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`
    );
    const data = await resp.json();
    return data.files?.[0]?.id || null;
  }

  async _findFileWithProps(name, parentId) {
    const q = `name = '${name}' and '${parentId}' in parents and trashed = false`;
    const resp = await this._fetch(
      `${DRIVE_API_BASE}/files?q=${encodeURIComponent(q)}&fields=files(id,appProperties)&pageSize=1`
    );
    const data = await resp.json();
    return data.files?.[0] || null;
  }

  async _getFileMetadata(fileId, fields = 'id,name,appProperties') {
    const resp = await this._fetch(`${DRIVE_API_BASE}/files/${fileId}?fields=${fields}`);
    return resp.json();
  }

  /**
   * Create or update a file using multipart upload.
   */
  async _upsertFile(name, parentId, content, mimeType, existingFileId = null, appProperties = null) {
    const metaPart = {
      name,
      mimeType,
      ...(existingFileId ? {} : { parents: [parentId] }),
      ...(appProperties ? { appProperties } : {}),
    };

    const boundary = '-------314159265358979323846';
    const body = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(metaPart),
      `--${boundary}`,
      `Content-Type: ${mimeType}`,
      '',
      content,
      `--${boundary}--`,
    ].join('\r\n');

    const url = existingFileId
      ? `${DRIVE_UPLOAD_BASE}/files/${existingFileId}?uploadType=multipart`
      : `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart`;

    const resp = await this._fetch(url, {
      method: existingFileId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': `multipart/related; boundary="${boundary}"` },
      body,
    });

    const data = await resp.json();
    return data.id;
  }

  async _ensureFolders() {
    if (!this._vaultFolderId) await this.ensureVaultStructure();
  }
}
