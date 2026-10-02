/**
 * SecureKeep — Sync Manager
 *
 * Orchestrates sync between IndexedDB (local) and Google Drive (remote).
 * Implements conflict detection as specified:
 *   - Never silently overwrites conflicting data
 *   - Creates conflict copies and marks notes as conflicted
 *   - Operations are idempotent and resumable
 */

import { SYNC_LOCK_TTL_SECONDS } from './config.js';

export class SyncManager {
  /**
   * @param {import('./drive.js').DriveSync} drive
   * @param {import('./storage.js').LocalStorage} storage
   * @param {import('./vault.js').Vault} vault
   */
  constructor(drive, storage, vault) {
    this.drive   = drive;
    this.storage = storage;
    this.vault   = vault;
    this._syncing = false;
    this._listeners = [];  // status change callbacks
  }

  // ─── Status callbacks ─────────────────────────────────────────────────────────

  onStatusChange(cb) { this._listeners.push(cb); }
  _emit(status, detail = null) {
    this._listeners.forEach(cb => cb(status, detail));
  }

  // ─── Full sync cycle ──────────────────────────────────────────────────────────

  /**
   * Perform a full sync cycle:
   *   1. Download remote list of notes
   *   2. Pull down notes that are newer on remote
   *   3. Push local notes that are newer locally
   *   4. Sync the index
   *
   * @returns {{ pulled: number, pushed: number, conflicts: number }}
   */
  async sync() {
    if (this._syncing) return { pulled: 0, pushed: 0, conflicts: 0 };
    if (!this.drive.isAuthenticated) return { pulled: 0, pushed: 0, conflicts: 0 };

    this._syncing = true;
    this._emit('syncing');

    const stats = { pulled: 0, pushed: 0, conflicts: 0, passwordsAdded: 0, passwordsAligned: 0 };

    try {
      await this._syncConfig();

      // ── Pull phase ────────────────────────────────────────────────────────────
      const remoteNotes = await this.drive.listNotes();
      const allSyncMeta = await this.storage.getAllSyncMeta();
      const syncMetaById = Object.fromEntries(allSyncMeta.map(m => [m.id, m]));
      const localMetaById = Object.fromEntries((await this.storage.getAllNotesMeta()).map(n => [n.id, n]));

      for (const remoteFile of remoteNotes) {
        // Skip conflict copies
        if (remoteFile.name.includes('__conflict__')) continue;

        const noteId        = remoteFile.appProperties?.noteId;
        const remoteVersion = parseInt(remoteFile.appProperties?.version || '0', 10);
        const localSyncMeta = syncMetaById[noteId];

        if (!noteId) continue;

        if (this.vault._tombstones().includes(noteId)) {
          try {
            await this.drive.deleteNote(remoteFile.id);
            this.vault.forgetTombstone(noteId);
          } catch {
            // Keep the tombstone and retry on the next sync.
          }
          continue;
        }

        const localKnownVersion = localSyncMeta?.remoteVersion || 0;
        const localVersion = localMetaById[noteId]?.version || 0;
        const localDirty = localVersion > localKnownVersion;

        // Remote is newer and we have no unpushed local edits — pull.
        // If both sides changed, leave the local copy and let the push create a conflict copy.
        if (remoteVersion > localKnownVersion && !localDirty) {
          const existed = !!localMetaById[noteId];
          await this._pullNote(noteId, remoteFile.id, remoteVersion);
          const pulledType = (await this.storage.getNote(noteId))?.meta?.type;
          if (pulledType === 'password') {
            if (existed) stats.passwordsAligned++;
            else stats.passwordsAdded++;
          }
          stats.pulled++;
        }
      }

      for (const id of this.vault._tombstones()) {
        const stillRemote = remoteNotes.some(f => f.appProperties?.noteId === id && !f.name.includes('__conflict__'));
        if (!stillRemote) this.vault.forgetTombstone(id);
      }

      // ── Push phase ────────────────────────────────────────────────────────────
      const localNotes = await this.storage.getAllNotesMeta();

      for (const localNote of localNotes) {
        const syncMeta = await this.storage.getSyncMeta(localNote.id);
        const localVersion = localNote.version || 1;
        const lastPushedVersion = syncMeta?.remoteVersion || 0;

        if (localVersion > lastPushedVersion) {
          const isNewOnDrive = !syncMeta?.driveFileId;
          const conflict = await this._pushNote(localNote.id, syncMeta?.driveFileId || null);
          if (conflict) stats.conflicts++;
          else {
            stats.pushed++;
            if (localNote.type === 'password') {
              if (isNewOnDrive) stats.passwordsAdded++;
              else stats.passwordsAligned++;
            }
          }
        }
      }

      // ── Index sync ────────────────────────────────────────────────────────────
      await this._syncIndex();

      this._emit('synced', stats);
    } catch (err) {
      this._emit('error', err.message);
      throw err;
    } finally {
      this._syncing = false;
    }

    return stats;
  }

  // ─── Single note push ─────────────────────────────────────────────────────────

  /**
   * Push a local note to Drive, with conflict detection.
   * @param {string} id
   * @param {string|null} driveFileId
   * @returns {boolean} true if conflict was detected
   */
  async _pushNote(id, driveFileId) {
    const localRecord = await this.storage.getNote(id);
    if (!localRecord) return false;

    const deviceId = this.vault.deviceId;

    // Before uploading: check remote version
    if (driveFileId) {
      const { version: remoteVersion } = await this.drive.getNoteVersion(driveFileId);
      const syncMeta = await this.storage.getSyncMeta(id);
      const expectedVersion = syncMeta?.remoteVersion || 0;

      if (remoteVersion > expectedVersion) {
        // CONFLICT: remote was updated by another device since our last sync
        // → Save local version as conflict copy, never overwrite remote
        await this.drive.uploadConflictCopy(id, localRecord.encryptedBlob, deviceId);

        // Mark note as conflicted in local index
        await this.vault.markNoteConflicted(id);
        return true;
      }
    }

    // Upload the version already stored locally. updateNote() increments it on edit.
    const version = localRecord.meta?.version || 1;
    const meta = {
      version,
      deviceId,
      updatedAt: localRecord.meta?.updatedAt || new Date().toISOString(),
    };

    const newDriveFileId = await this.drive.uploadNote(
      id, localRecord.encryptedBlob, meta, driveFileId
    );

    await this.storage.updateSyncMeta(id, version, newDriveFileId);
    return false;
  }

  // ─── Single note pull ─────────────────────────────────────────────────────────

  /**
   * Download a note from Drive and save to local cache.
   */
  async _pullNote(noteId, driveFileId, remoteVersion) {
    const { encryptedBlob, appProperties } = await this.drive.downloadNote(driveFileId);
    await this.vault.importRemoteNote(noteId, encryptedBlob, remoteVersion, appProperties || {});
    await this.storage.updateSyncMeta(noteId, remoteVersion, driveFileId);
  }

  async _syncConfig() {
    const local = await this.storage.getConfig();
    const remote = await this.drive.downloadConfig();
    const stamp = (c) => new Date(c?.updatedAt || c?.createdAt || 0).getTime();

    if (!local && remote) {
      await this.storage.saveConfig(remote);
      return;
    }
    if (local && !remote) {
      await this.drive.uploadConfig(local);
      return;
    }
    if (!local || !remote) return;

    if (stamp(remote) > stamp(local)) await this.storage.saveConfig(remote);
    else await this.drive.uploadConfig(local);
  }

  // ─── Index sync ───────────────────────────────────────────────────────────────

  async _syncIndex() {
    const remoteIndex = await this.drive.downloadIndex();
    const localIndexBlob = await this.storage.getIndex();

    if (!remoteIndex && localIndexBlob) {
      // No remote index yet — push local
      const localConfig = await this.storage.getConfig();
      const version = (localConfig?.indexVersion || 0) + 1;
      await this.drive.uploadIndex(localIndexBlob, version, this.vault.deviceId);
      return;
    }

    if (remoteIndex && !localIndexBlob) {
      const decrypted = await this.vault.decryptIndex(remoteIndex.encryptedBlob);
      decrypted.version = remoteIndex.version || decrypted.version || 1;
      await this.vault.adoptIndex(decrypted);
      return;
    }

    if (!remoteIndex && !localIndexBlob) return;

    // Both exist — compare versions
    const localConfig = await this.storage.getConfig();
    const localVersion = localConfig?.indexVersion || 0;

    if (remoteIndex.version > localVersion) {
      await this._mergeIndex(localIndexBlob, remoteIndex.encryptedBlob, remoteIndex.version);
    } else if (localVersion > remoteIndex.version) {
      // Local is newer — push
      await this.drive.uploadIndex(localIndexBlob, localVersion, this.vault.deviceId);
    }
    // Equal: in sync
  }

  /**
   * Merge two encrypted index blobs: union of note entries.
   * Notes present in either index are included; local wins on metadata conflicts.
   */
  _mergePlaces(remotePlaces, localPlaces) {
    const map = new Map();
    for (const place of [...(remotePlaces || []), ...(localPlaces || [])]) {
      if (place?.id) map.set(place.id, place);
    }
    return [...map.values()];
  }

  async _mergeIndex(localBlob, remoteBlob, remoteDriveVersion = 0) {
    try {
      const localIndex  = await this.vault.decryptIndex(localBlob);
      const remoteIndex = await this.vault.decryptIndex(remoteBlob);

      const merged = {
        notes: { ...(remoteIndex.notes || {}) },
        version: 0,
        tagCatalog: [...new Set([...(localIndex.tagCatalog || []), ...(remoteIndex.tagCatalog || [])])],
        places: this._mergePlaces(remoteIndex.places, localIndex.places),
      };
      for (const [id, note] of Object.entries(localIndex.notes || {})) {
        if (!merged.notes[id]) {
          merged.notes[id] = note;
        } else {
          const localTs  = new Date(note.updatedAt || 0).getTime();
          const remoteTs = new Date(merged.notes[id].updatedAt || 0).getTime();
          if (localTs >= remoteTs) merged.notes[id] = note;
        }
      }

      const localConfig = await this.storage.getConfig();
      const localVersion = localConfig?.indexVersion || 0;
      merged.version = Math.max(localVersion, remoteDriveVersion, remoteIndex.version || 0, localIndex.version || 0) + 1;
      await this.vault.adoptIndex(merged);
      const mergedBlob = await this.storage.getIndex();
      await this.drive.uploadIndex(mergedBlob, merged.version, this.vault.deviceId);
    } catch {
      await this.storage.saveIndex(remoteBlob);
      this.vault.invalidateIndexCache();
    }
  }

  // ─── Import / Export ─────────────────────────────────────────────────────────

  /**
   * Export the entire encrypted vault as a .skv file (JSON).
   * The file is self-contained: someone with the master password can restore from it.
   *
   * @returns {Blob}
   */
  async exportVault() {
    const config     = await this.storage.getConfig();
    const indexBlob  = await this.storage.getIndex();
    const allNotes   = await this.storage.getAllNotes();
    const allSync    = await this.storage.getAllSyncMeta();

    const vaultExport = {
      format:    'SecureKeepVault',
      version:   1,
      exportedAt: new Date().toISOString(),
      config,
      index:     indexBlob,
      notes:     allNotes,
      syncMeta:  allSync,
    };

    const json = JSON.stringify(vaultExport, null, 2);
    return new Blob([json], { type: 'application/json' });
  }

  /**
   * Import a vault from a .skv file.
   * Merges with existing local data (remote notes always win on conflict).
   *
   * @param {File} file
   */
  async importVault(file) {
    const text = await file.text();
    const data = JSON.parse(text);

    if (data.format !== 'SecureKeepVault') throw new Error('Formato file della cassaforte non valido');

    // Import config if we don't have one locally
    const existingConfig = await this.storage.getConfig();
    if (!existingConfig && data.config) {
      await this.storage.saveConfig(data.config);
    }

    // Import index
    if (data.index) {
      await this.storage.saveIndex(data.index);
    }

    // Import notes (don't overwrite newer local copies)
    for (const note of (data.notes || [])) {
      const existing = await this.storage.getNote(note.id);
      const importedVersion = note.meta?.version || 0;
      const localVersion    = existing?.meta?.version || 0;

      if (importedVersion > localVersion) {
        await this.storage.saveNote(note.id, note.encryptedBlob, note.meta);
      }
    }
  }
}
