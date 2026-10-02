/**
 * SecureKeep — UI Controller
 *
 * Manages all views, modals, and user interactions.
 * No DOM state is stored in cleartext — all displayed data is decrypted on demand.
 */

import { NOTE_COLORS, AUTO_LOCK_OPTIONS, CLIPBOARD_CLEAR_SECONDS, IMG_MAX_DIMENSION, IMG_JPEG_QUALITY, EXPORT_EXTENSION } from './config.js';
import { PasswordGenerator } from './password-generator.js';

const PWD_ICONS = [
  { name: 'key', color: '#8B5CF6' },
  { name: 'globe', color: '#3B82F6' },
  { name: 'mail', color: '#EF4444' },
  { name: 'building-2', color: '#64748B' },
  { name: 'shopping-cart', color: '#F59E0B' },
  { name: 'briefcase', color: '#10B981' },
  { name: 'gamepad-2', color: '#EC4899' },
  { name: 'cloud', color: '#0EA5E9' },
  { name: 'smartphone', color: '#14B8A6' },
  { name: 'home', color: '#F97316' },
  { name: 'star', color: '#EAB308' },
  { name: 'credit-card', color: '#06B6D4' },
  { name: 'tv', color: '#4F46E5' },
  { name: 'shield', color: '#22C55E' },
  { name: 'wifi', color: '#84CC16' }
];

const getIconColor = (name) => {
  const icon = PWD_ICONS.find(i => i.name === name);
  return icon ? icon.color : 'var(--accent)';
};

export class UI {
  /**
   * @param {import('./vault.js').Vault} vault
   * @param {import('./sync.js').SyncManager} sync
   * @param {import('./drive.js').DriveSync} drive
   */
  constructor(vault, sync, drive) {
    this.vault = vault;
    this.sync  = sync;
    this.drive = drive;

    this._currentView    = 'all';     // all | pinned | archive | trash | tags
    this._searchQuery    = '';
    this._searchType     = null;
    this._selectedIds    = new Set();
    this._multiSelectMode = false;
    this._clipboardTimer = null;
    this._currentNoteId  = null;
    this._resizeTimeout = null;
    this._lastWidth = window.innerWidth;
    window.addEventListener('resize', () => {
      clearTimeout(this._resizeTimeout);
      this._resizeTimeout = setTimeout(() => {
        if (this._lastWidth !== window.innerWidth) {
          this._lastWidth = window.innerWidth;
          this._renderNoteGrid();
        }
      }, 200);
    });
    this._currentFilter  = { tag: null };

    // Onboarding state
    this._onboardingStep = 1;
    this._pendingConfig  = null;

    // Password generator state
    this._pwGenOptions = {
      length: 20, upper: true, lower: true,
      digits: true, symbols: true, noAmbiguous: false,
    };
  }

  // ─── Initialization ───────────────────────────────────────────────────────────

  async init() {
    this._bindGlobalEvents();
    this._bindSyncEvents();

    const vaultExists = await this.vault.exists();
    if (vaultExists) {
      this._showLockScreen();
    } else {
      this._showOnboarding();
    }
  }

  _bindGlobalEvents() {
    setInterval(() => this._updateIdleTimer(), 1000);

    // Exit bulk selection on background click
    document.addEventListener('click', (e) => {
      if (this._multiSelectMode) {
        if (e.target.closest('.note-card') || 
            e.target.closest('#bulk-toolbar') || 
            e.target.closest('#sidebar') || 
            e.target.closest('.modal') ||
            e.target.closest('button') ||
            e.target.closest('a')) {
          return;
        }
        this._exitMultiSelect();
      }
    });

    // Activity tracking for auto-lock
    ['click', 'keydown', 'mousemove', 'touchstart'].forEach(evt => {
      document.addEventListener(evt, () => this.vault.resetActivityTimer(), { passive: true });
    });
    // Vault lock listener
    this.vault.onLock(() => {
      this._renewToastShown = false;
      this._drivePromptDismissed = false;
      this._clearForcedGeo(false);
      this._showLockScreen();
    });

    // Search
    const searchClear = document.getElementById('search-clear');
    const searchInput = document.getElementById('search-input');
    this._onInput('search-input', e => {
      this._searchQuery = e.target.value.trim().toLowerCase();
      if (searchClear) searchClear.classList.toggle('hidden', e.target.value.length === 0);
      this._renderNoteGrid();
    });
    this._onClick('search-clear', () => {
      if (searchInput) searchInput.value = '';
      this._searchQuery = '';
      if (searchClear) searchClear.classList.add('hidden');
      this._renderNoteGrid();
      if (searchInput) searchInput.focus();
    });
    document.querySelectorAll('.search-type-btn').forEach(btn => {
      btn.addEventListener('click', () => this._setSearchType(btn.dataset.type));
    });

    // Sidebar nav
    document.querySelectorAll('[data-nav]').forEach(el => {
      el.addEventListener('click', () => {
        this._currentView = el.dataset.nav;
        this._currentFilter = { tag: null };
        if (this._multiSelectMode) this._exitMultiSelect();
        this._renderNoteGrid();
        this._updateSidebarActive();
        this._closeSidebar();
      });
    });

    // FAB — create new note
    this._onClick('fab-btn', () => {
      this._showCreateMenu();
    });
    this._onClick('fab-drive', () => this._toggleDriveConnection());

    const modalEmptyTrash = document.getElementById('modal-empty-trash');
    this._onClick('btn-empty-trash', () => {
      if (modalEmptyTrash) modalEmptyTrash.classList.remove('hidden');
    });
    this._onClick('btn-cancel-empty-trash', () => {
      if (modalEmptyTrash) modalEmptyTrash.classList.add('hidden');
    });
    this._onClick('btn-confirm-empty-trash', async () => {
      if (modalEmptyTrash) modalEmptyTrash.classList.add('hidden');
      await this._emptyTrash();
    });

    // View Password Modal
    this._onClick('btn-close-view-password', () => {
      const m = document.getElementById('modal-view-password');
      if (m) m.classList.add('hidden');
    });
    const pwdBox = document.getElementById('view-password-box');
    if (pwdBox) {
      pwdBox.addEventListener('click', (e) => {
        if (e.target.id === 'btn-close-view-password') return;
        const txt = document.getElementById('view-password-text');
        if (txt) {
          if (txt.style.filter === 'none') {
            txt.style.filter = 'blur(10px)';
          } else {
            txt.style.filter = 'none';
          }
        }
      });
    }

    // Quick Create Bar
    this._onClick('quick-create-input', () => this._showNoteEditor({ type: 'note' }));
    this._onClick('quick-create-checklist', () => this._showChecklistEditor({ type: 'checklist' }));
    this._onClick('quick-create-password', () => this._showPasswordEditor({ type: 'password' }));

    this._compactNotes = localStorage.getItem('sk_compact_notes') === '1';
    this._applyCompactNotes();
    this._onClick('btn-compact-notes', () => {
      this._compactNotes = !this._compactNotes;
      localStorage.setItem('sk_compact_notes', this._compactNotes ? '1' : '0');
      this._applyCompactNotes();
    });

    // Lock button
    this._onClick('btn-lock', () => {
      this.vault.lock();
    });

    this._onClick('btn-manage-tags', () => this._openManageTags());
    this._onClick('btn-close-manage-tags', () => this._closeManageTags());
    this._onClick('btn-close-manage-tags-footer', () => this._closeManageTags());
    document.getElementById('form-manage-tag-create')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('manage-tag-new');
      this._createTag(input?.value || '');
    });
    this._onClick('manage-tags-backdrop', () => this._closeManageTags());
    this._onClick('btn-manage-places', () => this._openManagePlaces());
    this._onClick('btn-close-manage-places', () => this._closeManagePlaces());
    this._onClick('btn-close-manage-places-footer', () => this._closeManagePlaces());
    this._onClick('manage-places-backdrop', () => this._closeManagePlaces());
    this._onClick('btn-close-place-lock', () => this._closePlaceLock());
    this._onClick('btn-close-place-lock-footer', () => this._closePlaceLock());
    this._onClick('place-lock-backdrop', () => this._closePlaceLock());
    document.getElementById('form-manage-place-create')?.addEventListener('submit', (e) => {
      e.preventDefault();
      this._createPlace();
    });
    document.getElementById('manage-place-address')?.addEventListener('input', () => this._suggestPlaces());
    document.getElementById('manage-place-radius')?.addEventListener('change', () => {
      if (!this._placePick) return;
      this._drawPlaceRadius(this._placePick.lat, this._placePick.lng, Number(document.getElementById('manage-place-radius')?.value || 500));
    });

    // Sidebar toggle (mobile)
    this._onClick('btn-sidebar-toggle', () => {
      const isMobile = window.innerWidth <= 700;
      if (isMobile) {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebar-overlay');
        if (sidebar && overlay) {
          const isOpen = sidebar.classList.toggle('open');
          document.body.classList.toggle('nav-open', isOpen);
          if (isOpen) {
            overlay.style.display = 'block';
            setTimeout(() => overlay.classList.add('open'), 10);
          } else {
            overlay.classList.remove('open');
            setTimeout(() => overlay.style.display = 'none', 300);
          }
        }
      } else {
        document.body.classList.toggle('sidebar-collapsed');
        setTimeout(() => window.dispatchEvent(new Event('resize')), 300);
      }
    });
    this._onClick('sidebar-overlay', () => this._closeSidebar());
    this._bindSidebarSwipe();
    this._placeTopbarActions();
    const placeChrome = () => this._placeTopbarActions();
    window.matchMedia('(max-width: 700px)').addEventListener('change', placeChrome);
    window.addEventListener('resize', placeChrome);

    // Settings
    this._onClick('btn-settings', () => this._showSettings());

    // Settings actions
    this._onClick('btn-settings-close', () => document.getElementById('modal-settings')?.classList.add('hidden'));
    this._onClick('btn-settings-close-footer', () => document.getElementById('modal-settings')?.classList.add('hidden'));
    this._onClick('btn-settings-change-pwd', () => {
      document.getElementById('modal-settings')?.classList.add('hidden');
      const modal = document.getElementById('modal-change-pwd');
      if (modal) modal.classList.remove('hidden');
    });
    this._onClick('btn-close-change-pwd', () => document.getElementById('modal-change-pwd')?.classList.add('hidden'));
    this._onClick('btn-close-change-pwd-footer', () => document.getElementById('modal-change-pwd')?.classList.add('hidden'));
    this._onClick('btn-save-change-pwd', () => this._changeMasterPassword());
    this._onClick('btn-settings-export', () => this._exportVault());
    this._onClick('btn-export-reminder', () => this._exportVault());
    this._onClick('btn-close-export-reminder', () => this._closeExportReminder());
    this._onClick('btn-close-export-reminder-footer', () => this._closeExportReminder());
    this._onClick('export-reminder-backdrop', () => this._closeExportReminder());
    this._onClick('btn-settings-import', () => document.getElementById('settings-import-file')?.click());
    const importInput = document.getElementById('settings-import-file');
    if (importInput) {
      importInput.addEventListener('change', () => this._importVaultFile(importInput));
    }
    this._onClick('btn-settings-drive', () => this._toggleDriveConnection({ openSettings: true }));
    this._onClick('settings-drive-prompt', () => this._toggleDrivePromptSetting());
    this._onClick('btn-drive-prompt-connect', () => this._confirmDrivePrompt());
    this._onClick('btn-drive-prompt-local', () => this._dismissDrivePrompt());
    this._onClick('btn-drive-prompt-close', () => this._dismissDrivePrompt());
    this._onClick('drive-prompt-backdrop', () => this._dismissDrivePrompt());
    this._onClick('btn-settings-biometric', () => this._toggleBiometricSetting());
    this._onClick('btn-settings-install', () => this._installFromSettings());
    this._onClick('btn-settings-geo', () => this._refreshSettingsGeo());
    this._onClick('btn-settings-geo-force', () => this._forceSettingsGeo());
    this._onClick('btn-settings-geo-device', () => this._clearForcedGeo());
    document.getElementById('settings-geo-address')?.addEventListener('input', () => this._suggestForcedGeo());
    this._onClick('btn-close-biometric', () => this._closeBiometricModal());
    this._onClick('btn-close-biometric-footer', () => this._closeBiometricModal());
    this._onClick('biometric-backdrop', () => this._closeBiometricModal());
    const biometricForm = document.getElementById('form-biometric');
    if (biometricForm) biometricForm.onsubmit = (e) => { e.preventDefault(); this._confirmBiometric(); };

    // Theme toggle
    this._onClick('btn-theme', () => this._toggleTheme());

    // Multi-select toolbar
    this._onClick('bulk-archive',  (e) => { e.stopPropagation(); this._bulkAction('archive'); });
    this._onClick('bulk-restore',  (e) => { e.stopPropagation(); this._bulkAction('restore'); });
    this._onClick('bulk-trash',    (e) => { e.stopPropagation(); this._bulkAction('trash'); });
    this._onClick('bulk-color',    (e) => { e.stopPropagation(); this._bulkColor(); });
    this._onClick('bulk-cancel',   () => this._exitMultiSelect());
    this._onClick('bulk-select-all', () => {
      const allCards = document.querySelectorAll('.note-card');
      if (allCards.length === 0) return;
      const allSelected = this._selectedIds.size === allCards.length;
      if (allSelected) {
        // Deseleziona tutti
        this._selectedIds.clear();
        allCards.forEach(c => {
          c.classList.remove('selected');
          const cb = c.querySelector('.card-checkbox');
          if (cb) cb.checked = false;
        });
        this._exitMultiSelect();
      } else {
        // Seleziona tutti
        allCards.forEach(c => {
          const id = c.dataset.id;
          if (id) {
            this._selectedIds.add(id);
            c.classList.add('selected');
            const cb = c.querySelector('.card-checkbox');
            if (cb) cb.checked = true;
          }
        });
        this._updateBulkCount();
      }
    });


    // Draft picker events
    document.addEventListener('click', (e) => {
      const draftColorBtn = e.target.closest('.draft-color-btn');
      if (draftColorBtn) {
        e.stopImmediatePropagation();
        this._showDraftColorPicker(draftColorBtn);
        return;
      }

      const draftTagBtn = e.target.closest('.draft-tags-btn');
      if (draftTagBtn) {
        e.stopImmediatePropagation();
        this._showDraftTagPicker(draftTagBtn);
        return;
      }
      
      const draftPinBtn = e.target.closest('.draft-pin-btn');
      if (draftPinBtn) this._toggleDraftPin(draftPinBtn);
      
      const draftTrashBtn = e.target.closest('.draft-trash-btn');
      if (draftTrashBtn) this._trashModalNote(draftTrashBtn);
    });
    // Keyboard shortcuts
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        this._closeAllModals();
        if (this._multiSelectMode) this._exitMultiSelect();
      }
    });

    // Global paste to create note with image
    document.addEventListener('paste', async (e) => {
      if (document.querySelector('.modal:not(.hidden)')) return;
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      
      const files = this._collectImageFiles(e.clipboardData);
      if (!files.length) return;
      e.preventDefault();
      await this._quickCreateNoteWithImage(files);
    });
  }

  async _quickCreateNoteWithImage(files) {
    const list = Array.isArray(files) ? files : [files];
    try {
      this._toast(list.length > 1 ? 'Creazione nota con immagini...' : 'Creazione nota con immagine...', 'info');
      const images = [];
      for (const file of list) {
        images.push(await this._compressImage(file));
      }
      const thumbnails = await this._buildImageThumbs(images);
      
      const data = {
        type: 'note',
        title: '',
        content: '',
        images,
        thumbnail: thumbnails[0] || null,
        thumbnails,
        imageCount: images.length,
        tags: [],
        color: 'default',
        pinned: false,
      };
      await this.vault.createNote('note', data);
      this._renderNoteGrid();
      this._toast('Nota con immagine creata', 'success');
      this.sync.sync().catch(() => {});
    } catch (err) {
      this._toast(`Errore creazione: ${err.message}`, 'error');
    }
  }

  _bindSyncEvents() {
    const SYNC_ICONS = {
      syncing: `<i data-lucide="refresh-cw"></i>`,
      synced:  `<i data-lucide="cloud"></i>`,
      error:   `<i data-lucide="cloud-off"></i>`,
      offline: `<i data-lucide="wifi-off"></i>`,
    };

    let lastSyncTime = null;

    const updateSyncText = (isSyncing = false) => {
      const timeEl = document.getElementById('sync-time');
      if (!timeEl) return;
      
      if (isSyncing) {
        timeEl.textContent = 'Sincronizzazione in corso...';
        return;
      }

      if (!lastSyncTime) {
        timeEl.textContent = '';
        return;
      }

      const diffMins = Math.floor((Date.now() - lastSyncTime) / 60000);
      if (diffMins === 0) {
        timeEl.textContent = 'Aggiornato ora';
      } else if (diffMins === 1) {
        timeEl.textContent = 'Aggiornato 1 minuto fa';
      } else if (diffMins < 60) {
        timeEl.textContent = `Aggiornato ${diffMins} minuti fa`;
      } else {
        const hours = Math.floor(diffMins / 60);
        timeEl.textContent = `Aggiornato ${hours} or${hours === 1 ? 'a' : 'e'} fa`;
      }
    };

    this.sync.onStatusChange((status, detail) => {
      const el = document.getElementById('sync-status');
      if (!el) return;
      el.dataset.status = status;
      const statusMap = { syncing: 'Sincronizzazione...', synced: 'Sincronizzato', error: 'Errore', offline: 'Offline' };
      el.title = status === 'error' ? `Errore sinc: ${detail}` : (statusMap[status] || status);
      el.innerHTML = SYNC_ICONS[status] || SYNC_ICONS.synced;
      
      if (status === 'synced') {
        lastSyncTime = Date.now();
        updateSyncText(false);
        this._renderNoteGrid();
        if (detail && typeof detail === 'object') this._toastSyncResult(detail);
      } else if (status === 'syncing') {
        updateSyncText(true);
      } else if (status === 'offline' || status === 'error') {
        const timeEl = document.getElementById('sync-time');
        if (timeEl) timeEl.textContent = status === 'offline' ? 'Non connesso' : 'Errore';
      }
      
      if (window.skRefreshIcons) window.skRefreshIcons(el);
      this._refreshDriveFab();
    });

    // Run immediately to set initial state if not authenticated
    if (!this.drive.isAuthenticated) {
      this.sync._emit('offline', 'Not authenticated');
    }

    // Update the relative time every minute
    setInterval(() => {
      if (lastSyncTime && document.getElementById('sync-status')?.dataset.status === 'synced') {
        updateSyncText(false);
      }
    }, 60000);
  }

  // ─── Onboarding ───────────────────────────────────────────────────────────────

  _showOnboarding() {
    document.getElementById('app-shell').classList.add('hidden');
    document.getElementById('lock-screen').classList.add('hidden');
    const ob = document.getElementById('onboarding');
    ob.classList.remove('hidden');
    this._goToOnboardingStep(1);
  }

  _goToOnboardingStep(step) {
    this._onboardingStep = step;
    document.querySelectorAll('.ob-step').forEach(el => el.classList.add('hidden'));
    const stepEl = document.getElementById(`ob-step-${step}`);
    stepEl?.classList.remove('hidden');
    if (window.skRefreshIcons && stepEl) window.skRefreshIcons(stepEl);

    if (step === 1) this._setupStep1();
    if (step === 2) this._setupStep2();
    if (step === 3) this._setupStep3();
  }

  _setupStep1() {
    const form       = document.getElementById('ob-step-1');
    const pwdInput   = document.getElementById('ob-password');
    const confirmPwd = document.getElementById('ob-password-confirm');
    const strengthEl = document.getElementById('ob-strength');
    const nextBtn    = document.getElementById('ob-step1-next');

    pwdInput.addEventListener('input', () => {
      const s = PasswordGenerator.evaluateStrength(pwdInput.value);
      strengthEl.textContent = s.label;
      strengthEl.style.color  = s.color;
      const bar = document.getElementById('ob-strength-bar');
      if (bar) {
        bar.style.width = `${(s.score / 4) * 100}%`;
        bar.style.backgroundColor = s.color;
      }
    });

    nextBtn.addEventListener('click', async () => {
      const pwd = pwdInput.value;
      const cfm = confirmPwd.value;

      if (pwd.length < 8) return this._toast('La password deve contenere almeno 8 caratteri', 'error');
      if (pwd !== cfm)    return this._toast('Le password non corrispondono', 'error');

      nextBtn.disabled = true;
      nextBtn.textContent = 'Creating vault…';
      try {
        const { recoveryKey, config } = await this.vault.create(pwd);
        this._pendingConfig = { recoveryKey, config };
        this._goToOnboardingStep(2);
      } catch (err) {
        this._toast(`Errore: ${err.message}`, 'error');
      } finally {
        nextBtn.disabled = false;
        nextBtn.textContent = 'Continue';
      }
    });

    document.getElementById('ob-restore-drive')?.addEventListener('click', async () => {
      const restoreBtn = document.getElementById('ob-restore-drive');
      if (restoreBtn) restoreBtn.disabled = true;
      try {
        await this.drive.startAuth();
        await this.drive.ensureVaultStructure();
        if (!(await this.vault.exists())) {
          const remoteConfig = await this.drive.downloadConfig();
          if (remoteConfig) await this.vault.storage.saveConfig(remoteConfig);
        }
        if (await this.vault.exists()) this._showLockScreen();
        else this._toast('Nessuna cassaforte trovata su Drive');
      } catch (err) {
        this._toast(`Errore Drive: ${err.message}`, 'error');
        if (restoreBtn) restoreBtn.disabled = false;
      }
    });
  }

  _setupStep2() {
    const { recoveryKey } = this._pendingConfig;

    // Display recovery key in formatted groups
    const displayEl = document.getElementById('recovery-key-display');
    if (displayEl) displayEl.textContent = recoveryKey;

    // Copy button
    this._onClick('btn-copy-recovery', () => {
      navigator.clipboard.writeText(recoveryKey).then(() => {
        this._toast('Chiave di ripristino copiata!');
      });
    });

    // Print button
    this._onClick('btn-print-recovery', () => {
      window.print();
    });

    // Confirmation checkbox + next
    const checkbox = document.getElementById('ob-recovery-confirmed');
    const nextBtn  = document.getElementById('ob-step2-next');
    nextBtn.disabled = true;

    checkbox.addEventListener('change', () => {
      nextBtn.disabled = !checkbox.checked;
    });

    nextBtn.addEventListener('click', () => {
      this._goToOnboardingStep(3);
    });
  }

  _setupStep3() {
    // Google Drive connection
    const connectBtn = document.getElementById('ob-connect-drive');
    const skipBtn    = document.getElementById('ob-skip-drive');

    connectBtn?.addEventListener('click', async () => {
      connectBtn.disabled = true;
      connectBtn.textContent = 'Connecting…';
      try {
        await this.drive.startAuth();
        await this.drive.ensureVaultStructure();
        this.sync.sync().catch(() => {});
        this._finishOnboarding();
      } catch (err) {
        this._toast(`Errore Drive: ${err.message}`, 'error');
        connectBtn.disabled = false;
        connectBtn.textContent = 'Connetti a Google Drive';
      }
    });

    skipBtn?.addEventListener('click', () => {
      this._finishOnboarding();
    });
  }

  _finishOnboarding() {
    document.getElementById('onboarding').classList.add('hidden');
    this._showAppShell();
    this._toast('Vault created successfully! ');
  }

  // ─── Lock screen ──────────────────────────────────────────────────────────────

  _showLockScreen() {
    if (this._trashPurgeTimer) {
      clearInterval(this._trashPurgeTimer);
      this._trashPurgeTimer = null;
    }
    this._closeContextMenus();
    if (this._multiSelectMode) this._exitMultiSelect();
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
    document.getElementById('app-shell').classList.add('hidden');
    document.getElementById('onboarding').classList.add('hidden');
    const ls = document.getElementById('lock-screen');
    ls.classList.remove('hidden');
    if (window.skRefreshIcons) window.skRefreshIcons(ls);
    
    const lastLoginEl = document.getElementById('lock-last-login');
    if (lastLoginEl) {
      const last = localStorage.getItem('sk_lastLogin');
      if (last) {
        const d = new Date(parseInt(last, 10));
        lastLoginEl.textContent = 'Ultimo accesso: ' + d.toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
      } else {
        lastLoginEl.textContent = '';
      }
    }

    const pwdInput = document.getElementById('lock-password');
    const unlockBtn = document.getElementById('btn-unlock');
    const recBtn    = document.getElementById('btn-use-recovery');
    const recSection = document.getElementById('lock-recovery-section');

        // Reset state
    if (pwdInput) pwdInput.value = '';
    const recInput = document.getElementById('lock-recovery-key');
    if (recInput) recInput.value = '';
    if (recSection) recSection.classList.add('hidden');
    document.getElementById('form-unlock')?.classList.remove('hidden');
    document.getElementById('lock-tab-password')?.classList.add('active');
    document.getElementById('btn-use-recovery')?.classList.remove('active');
    if (unlockBtn) unlockBtn.textContent = 'Sblocca';
    this._applyUnlockGuard();
    this._refreshBiometricLockButton();
    this._onClick('btn-unlock-biometric', () => this._doBiometricUnlock());

    const unlockForm = document.getElementById('form-unlock');
    const passwordTab = document.getElementById('lock-tab-password');
    const setLockMode = (mode) => {
      const recovery = mode === 'recovery';
      recSection?.classList.toggle('hidden', !recovery);
      unlockForm?.classList.toggle('hidden', recovery);
      passwordTab?.classList.toggle('active', !recovery);
      passwordTab?.setAttribute('aria-selected', recovery ? 'false' : 'true');
      recBtn?.classList.toggle('active', recovery);
      recBtn?.setAttribute('aria-selected', recovery ? 'true' : 'false');
      setTimeout(() => (recovery ? recInput : pwdInput)?.focus(), 30);
    };
    if (unlockForm) unlockForm.onsubmit = (e) => { e.preventDefault(); this._doUnlock(); };

    this._onClick('btn-unlock', (e) => { e.preventDefault(); this._doUnlock(); });
    this._onClick('lock-tab-password', () => setLockMode('password'));
    this._onClick('btn-use-recovery', () => setLockMode('recovery'));
    const visBtn = document.getElementById('btn-lock-pwd-vis');
    if (visBtn && pwdInput) {
      visBtn.onclick = () => {
        const show = pwdInput.type === 'password';
        pwdInput.type = show ? 'text' : 'password';
        visBtn.innerHTML = `<i data-lucide="${show ? 'eye-off' : 'eye'}"></i>`;
        visBtn.setAttribute('aria-label', show ? 'Nascondi password' : 'Mostra password');
        if (window.skRefreshIcons) window.skRefreshIcons(visBtn);
      };
    }
    if (pwdInput) {
      pwdInput.onkeydown = e => {
        if (e.key === 'Enter') { e.preventDefault(); this._doUnlock(); }
      };
    }

    const recoveryForm = document.getElementById('form-recovery');
    if (recoveryForm) {
      recoveryForm.onsubmit = async (e) => {
        e.preventDefault();
        const key = document.getElementById('lock-recovery-key').value.trim();
        if (!key) return this._toast('Inserisci la tua chiave di ripristino', 'error');
        const recSubmit = document.getElementById('btn-unlock-recovery');
        if (recSubmit?.disabled) return;
        try {
          if (recSubmit) recSubmit.disabled = true;
          await this.vault.unlockWithRecovery(key);
          this._stopUnlockCountdown();
          this._showAppShell();
        } catch (err) {
          this._toastUnlockError(err, 'Chiave di ripristino non corretta');
          await this._applyUnlockGuard();
          if (recSubmit && !document.getElementById('lock-password')?.disabled) recSubmit.disabled = false;
        }
      };
    }

    setTimeout(() => pwdInput?.focus(), 100);
  }

  async _refreshBiometricLockButton() {
    const btn = document.getElementById('btn-unlock-biometric');
    if (!btn) return;
    let enrolled = false;
    try { enrolled = await this.vault.hasBiometricUnlock(); } catch { enrolled = false; }
    btn.classList.toggle('hidden', !enrolled);
    btn.disabled = false;
  }

  async _doBiometricUnlock() {
    const btn = document.getElementById('btn-unlock-biometric');
    if (!btn || btn.disabled || btn.classList.contains('hidden')) return;
    btn.disabled = true;
    this._holdLock = true;
    try {
      await this.vault.unlockWithBiometric();
      localStorage.setItem('sk_lastLogin', Date.now().toString());
      this._stopUnlockCountdown();
      this._showAppShell();
    } catch (err) {
      btn.disabled = false;
      if (err?.code === 'biometric-cancelled') return;
      this._toast(err?.message || 'Impronta non riuscita', 'error');
    } finally {
      this._holdLock = false;
    }
  }

  async _doUnlock() {
    const pwdInput  = document.getElementById('lock-password');
    const unlockBtn = document.getElementById('btn-unlock');
    const pwd = pwdInput?.value;

    if (!pwd || unlockBtn.disabled) return;

    unlockBtn.disabled = true;
    unlockBtn.textContent = 'Sblocco...';

    try {
      await this.vault.unlock(pwd);
      localStorage.setItem('sk_lastLogin', Date.now().toString());
      this._stopUnlockCountdown();
      this._showAppShell();
    } catch (err) {
      this._toastUnlockError(err, 'Password non corretta');
      await this._applyUnlockGuard();
      if (unlockBtn && !unlockBtn.disabled) {
        unlockBtn.disabled = false;
        unlockBtn.textContent = 'Sblocca';
        pwdInput?.select();
      }
    }
  }

  _toastUnlockError(err, fallback) {
    if (err?.code === 'unlock-locked') {
      this._toast('Troppi tentativi. Attendi prima di riprovare.', 'error');
      return;
    }
    if (err?.code === 'unlock-failed') {
      this._toast(fallback, 'error');
      return;
    }
    this._toast(fallback, 'error');
  }

  _stopUnlockCountdown() {
    if (this._unlockCountdown) {
      clearInterval(this._unlockCountdown);
      this._unlockCountdown = null;
    }
  }

  _formatUnlockWait(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    if (mins > 0) return `${mins}:${String(secs).padStart(2, '0')}`;
    return `${secs} s`;
  }

  async _applyUnlockGuard() {
    this._stopUnlockCountdown();
    const status = document.getElementById('lock-attempt-status');
    const pwdInput = document.getElementById('lock-password');
    const unlockBtn = document.getElementById('btn-unlock');
    const recInput = document.getElementById('lock-recovery-key');
    const recBtn = document.getElementById('btn-unlock-recovery');
    [pwdInput, unlockBtn, recInput, recBtn].forEach(el => {
      if (el) el.disabled = true;
    });
    let until = 0;
    try {
      const guard = await this.vault.getUnlockGuard();
      until = guard?.lockedUntil || 0;
    } catch {
      until = 0;
    }
    const paint = () => {
      const left = until - Date.now();
      const locked = left > 0;
      [pwdInput, unlockBtn, recInput, recBtn].forEach(el => {
        if (el) el.disabled = locked;
      });
      if (unlockBtn) unlockBtn.textContent = 'Sblocca';
      if (!locked) {
        if (status) {
          status.textContent = '';
          status.classList.add('hidden');
        }
        this._stopUnlockCountdown();
        return;
      }
      if (status) {
        status.textContent = `Troppi tentativi. Riprova tra ${this._formatUnlockWait(left)}.`;
        status.classList.remove('hidden');
      }
    };
    paint();
    if (until > Date.now()) this._unlockCountdown = setInterval(paint, 1000);
  }

  // ─── App shell ────────────────────────────────────────────────────────────────

  _startTrashPurge() {
    if (this._trashPurgeTimer) clearInterval(this._trashPurgeTimer);
    const run = async () => {
      if (!this.vault.isUnlocked()) return;
      try {
        const removed = await this.vault.purgeExpiredTrash();
        if (removed > 0) {
          this._renderNoteGrid();
          this.sync.sync().catch(() => {});
        }
      } catch { /* vault locked or a single note failed; retry on the next pass */ }
    };
    run();
    this._trashPurgeTimer = setInterval(run, 24 * 60 * 60 * 1000);
  }

  _showAppShell() {
    this._stopUnlockCountdown();
    document.getElementById('lock-screen').classList.add('hidden');
    document.getElementById('onboarding').classList.add('hidden');
    document.getElementById('app-shell').classList.remove('hidden');

    // Re-run Lucide icon rendering now that app-shell is visible
    if (window.skRefreshIcons) window.skRefreshIcons();

    this._renderSidebar();
    this._startTrashPurge();
    this._renderNoteGrid();
    this._updateSidebarActive();
    this._remindPasswordRenewals();
    this._refreshDriveFab();
    this._ensureGeo().then(() => {
      if (this.vault.isUnlocked()) this._renderNoteGrid();
    });

    if (this._shouldPromptDrive()) this._showDrivePrompt();
    else this._maybeRemindLocalExport();

    // Trigger sync
    if (this.drive.isAuthenticated) {
      this.sync.sync().catch(() => {});
    }
  }

  _closeExportReminder() {
    document.getElementById('modal-export-reminder')?.classList.add('hidden');
  }

  _localExportIsDue() {
    try {
      const raw = localStorage.getItem('sk_last_local_export');
      const at = raw ? Number(raw) : 0;
      if (!at) return true;
      return Date.now() - at >= 30 * 24 * 60 * 60 * 1000;
    } catch {
      return false;
    }
  }

  _markLocalExport() {
    try {
      localStorage.setItem('sk_last_local_export', String(Date.now()));
    } catch { /* reminder stays due if storage is blocked */ }
  }

  _maybeRemindLocalExport() {
    if (!this._localExportIsDue()) return;
    const modal = document.getElementById('modal-export-reminder');
    if (!modal) return;
    modal.classList.remove('hidden');
    if (window.skRefreshIcons) window.skRefreshIcons(modal);
  }

  // ─── Note grid ────────────────────────────────────────────────────────────────

  async _renderSidebar() {
    const index = await this.vault.getIndex();
    const notes = Object.values(index.notes || {});

    const tagContainer = document.getElementById('sidebar-tags');
    if (tagContainer) {
      tagContainer.innerHTML = '';
      const allTags = this._allTagNames(index);
      allTags.forEach(tag => {
        const isActive = this._currentView === 'tags' && this._currentFilter.tag === tag;
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.className = 'sidebar-item' + (isActive ? ' active' : '');
        btn.dataset.tag = tag;
        btn.innerHTML = `<i data-lucide="tag"></i> <span style="flex:1;text-align:left;text-overflow:ellipsis;overflow:hidden;white-space:nowrap">${this._escHtml(tag)}</span>`;
        btn.onclick = () => {
          this._currentFilter = { tag };
          this._setCurrentView('tags');
        };
        li.appendChild(btn);
        tagContainer.appendChild(li);
      });
    }
    if (window.skRefreshIcons) window.skRefreshIcons(document.getElementById('sidebar'));
    this._updateSidebarActive();
  }

  _updateSidebarActive() {
    document.querySelectorAll('#sidebar [data-nav]').forEach(el => {
      const isMain = el.dataset.nav === this._currentView && this._currentView !== 'tags';
      el.classList.toggle('active', isMain);
    });
    document.querySelectorAll('#sidebar-tags .sidebar-item').forEach(el => {
      el.classList.toggle('active', this._currentView === 'tags' && el.dataset.tag === this._currentFilter.tag);
    });
  }

  _allTagNames(index) {
    const fromNotes = Object.values(index?.notes || {}).flatMap(n => n.tags || []);
    const extra = Array.isArray(index?.tagCatalog) ? index.tagCatalog : [];
    return [...new Set([...fromNotes, ...extra].map(t => String(t).trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'it'));
  }

  async _createTag(raw) {
    const next = String(raw || '').trim();
    if (!next || this._tagEditBusy) return;
    this._tagEditBusy = true;
    try {
      const index = await this.vault.getIndex();
      const existing = this._allTagNames(index);
      if (existing.some(t => t.localeCompare(next, 'it', { sensitivity: 'accent' }) === 0)) {
        this._toast('Questa etichetta esiste già');
        return;
      }
      const catalog = Array.isArray(index.tagCatalog) ? [...index.tagCatalog] : [];
      catalog.push(next);
      await this.vault.saveTagCatalog(catalog);
      const input = document.getElementById('manage-tag-new');
      if (input) input.value = '';
      this._renderSidebar();
      this._renderManageTagsList();
      this.sync.sync().catch(() => {});
      this._toast('Etichetta aggiunta');
    } catch (err) {
      this._toast(err.message || 'Errore creando l’etichetta', 'error');
    } finally {
      this._tagEditBusy = false;
    }
  }

  _openManageTags() {
    const modal = document.getElementById('modal-manage-tags');
    if (!modal) return;
    modal.classList.remove('hidden');
    this._renderManageTagsList();
    setTimeout(() => document.getElementById('manage-tag-new')?.focus(), 50);
  }

  _closeManageTags() {
    document.getElementById('modal-manage-tags')?.classList.add('hidden');
  }

  async _renderManageTagsList() {
    const list = document.getElementById('manage-tags-list');
    if (!list) return;
    const index = await this.vault.getIndex();
    const tags = this._allTagNames(index);
    list.innerHTML = '';
    if (!tags.length) {
      const empty = document.createElement('p');
      empty.className = 'manage-tags-empty';
      empty.textContent = 'Nessuna etichetta';
      list.appendChild(empty);
      return;
    }
    tags.forEach(tag => {
      const row = document.createElement('div');
      row.className = 'manage-tag-row';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = tag;
      input.setAttribute('aria-label', `Nome etichetta ${tag}`);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          input.blur();
        }
      });
      input.addEventListener('blur', () => {
        const next = input.value.trim();
        if (!next || next === tag) {
          input.value = tag;
          return;
        }
        this._renameTag(tag, next);
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn-icon manage-tag-delete';
      remove.title = 'Elimina etichetta';
      remove.setAttribute('aria-label', `Elimina etichetta ${tag}`);
      remove.innerHTML = '<i data-lucide="trash-2" style="width:16px;height:16px"></i>';
      remove.addEventListener('mousedown', (e) => e.preventDefault());
      remove.addEventListener('click', () => this._deleteTag(tag));
      row.append(input, remove);
      list.appendChild(row);
    });
    if (window.skRefreshIcons) window.skRefreshIcons(list);
  }

  async _notesWithTag(tag) {
    const index = await this.vault.getIndex();
    return Object.values(index.notes || {}).filter(n => (n.tags || []).includes(tag));
  }

  async _setNoteTags(id, tags) {
    const note = await this.vault.getNote(id);
    await this.vault.updateNote(id, { ...note, tags }, false);
  }

  async _renameTag(from, to) {
    const next = String(to || '').trim();
    if (!next || next === from || this._tagEditBusy) return;
    this._tagEditBusy = true;
    try {
      const metas = await this._notesWithTag(from);
      for (const meta of metas) {
        const tags = [...new Set((meta.tags || []).map(t => t === from ? next : t))];
        await this._setNoteTags(meta.id, tags);
      }
      if (this._currentFilter?.tag === from) this._currentFilter = { tag: next };
      const index = await this.vault.getIndex();
      const catalog = (Array.isArray(index.tagCatalog) ? index.tagCatalog : [])
        .map(t => t === from ? next : t);
      if (!catalog.includes(next)) catalog.push(next);
      await this.vault.saveTagCatalog([...new Set(catalog)]);
      this._renderSidebar();
      this._renderNoteGrid();
      this._renderManageTagsList();
      this.sync.sync().catch(() => {});
    } catch (err) {
      this._toast(err.message || 'Errore rinominando l’etichetta', 'error');
      this._renderManageTagsList();
    } finally {
      this._tagEditBusy = false;
    }
  }

  async _deleteTag(tag) {
    if (this._tagEditBusy) return;
    this._tagEditBusy = true;
    try {
      const metas = await this._notesWithTag(tag);
      const ids = metas.map(meta => meta.id);
      for (const meta of metas) {
        const tags = (meta.tags || []).filter(t => t !== tag);
        await this._setNoteTags(meta.id, tags);
      }
      if (this._currentFilter?.tag === tag) {
        this._currentFilter = { tag: null };
        this._currentView = 'all';
      }
      const index = await this.vault.getIndex();
      const catalog = (Array.isArray(index.tagCatalog) ? index.tagCatalog : []).filter(t => t !== tag);
      await this.vault.saveTagCatalog(catalog);
      this._renderSidebar();
      this._renderNoteGrid();
      this._renderManageTagsList();
      this.sync.sync().catch(() => {});
      this._toast(`Etichetta «${tag}» eliminata`, 'success', {
        label: 'Annulla',
        onClick: async () => {
          try {
            for (const id of ids) {
              const note = await this.vault.getNote(id);
              const tags = [...(note.tags || [])];
              if (!tags.includes(tag)) tags.push(tag);
              await this.vault.updateNote(id, { ...note, tags }, false);
            }
            const restored = await this.vault.getIndex();
            const catalog = Array.isArray(restored.tagCatalog) ? [...restored.tagCatalog] : [];
            if (!catalog.includes(tag)) catalog.push(tag);
            await this.vault.saveTagCatalog(catalog);
            this._renderSidebar();
            this._renderNoteGrid();
            this._renderManageTagsList();
            this.sync.sync().catch(() => {});
          } catch (err) {
            this._toast(err.message || 'Errore annullamento', 'error');
          }
        }
      });
    } catch (err) {
      this._toast(err.message || 'Errore eliminando l’etichetta', 'error');
    } finally {
      this._tagEditBusy = false;
    }
  }

  _setSearchType(type) {
    this._searchType = this._searchType === type ? null : type;
    document.querySelectorAll('.search-type-btn').forEach(btn => {
      const on = btn.dataset.type === this._searchType;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    this._renderNoteGrid();
  }

  _setCurrentView(view) {
    if (view === 'places') {
      this._geoSeq = (this._geoSeq || 0) + 1;
      this._geo = null;
      this._geoState = null;
      this._geoPromise = null;
    }
    this._currentView = view;
    if (view !== 'tags') this._currentFilter = { tag: null };
    
    this._searchQuery = '';
    const searchInp = document.getElementById('search-input');
    if (searchInp) searchInp.value = '';

    this._exitMultiSelect();
    this._updateSidebarActive();
    this._renderNoteGrid();
    this._closeSidebar();
  }

  async _renderNoteGrid() {
    const container = document.getElementById('notes-grid');
    if (!container) return;

    container.innerHTML = '<div class="loading-spinner"></div>';

    try {
      const index = await this.vault.getIndex();
      this._places = Array.isArray(index.places) ? index.places : [];
      let notes = Object.values(index.notes || {});

      // Filter by view
      switch (this._currentView) {
        case 'all':        notes = notes.filter(n => !n.archived && !n.trashed); break;
        case 'pinned':     notes = notes.filter(n => n.pinned && !n.archived && !n.trashed); break;
        case 'archive':    notes = notes.filter(n => n.archived && !n.trashed); break;
        case 'trash':      notes = notes.filter(n => n.trashed); break;
        case 'places':     notes = notes.filter(n => !n.archived && !n.trashed && this._notePlaceIds(n).length); break;
        case 'tags':
          if (this._currentFilter.tag) {
            notes = notes.filter(n => !n.archived && !n.trashed && n.tags?.includes(this._currentFilter.tag));
          } break;
      }

      const btnEmptyTrash = document.getElementById('btn-empty-trash');
      if (btnEmptyTrash) {
        if (this._currentView === 'trash' && notes.length > 0) {
          btnEmptyTrash.classList.remove('hidden');
        } else {
          btnEmptyTrash.classList.add('hidden');
        }
      }
      const fab = document.getElementById('fab-btn');
      if (fab) fab.classList.toggle('hidden', this._currentView === 'trash');
      if (this._currentView === 'trash') document.querySelector('.fab-menu')?.remove();

      if (this._searchType) {
        notes = notes.filter(n => (n.type || 'note') === this._searchType);
      }

      // Search filter
      if (this._searchQuery) {
        const q = this._searchQuery;
        notes = notes.filter(n =>
          (n.title || '').toLowerCase().includes(q) ||
          (n.tags || []).some(t => t.toLowerCase().includes(q))
        );
      }

      // Pinned stay in their block. Within a block, order is insertion time:
      // new notes first, and saving does not move a note.
      const orderKey = (n) => {
        const t = new Date(n.addedAt || n.updatedAt || 0).getTime();
        return Number.isFinite(t) ? t : 0;
      };
      notes.sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return orderKey(b) - orderKey(a);
      });

      container.innerHTML = '';

      if (this._currentView === 'trash') {
        const retention = document.createElement('p');
        retention.className = 'trash-retention-note';
        retention.textContent = 'Le note nel Cestino vengono eliminate dopo 7 giorni.';
        container.appendChild(retention);
      }

      if (notes.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" style="opacity:.25;margin-bottom:1rem"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
          <p>${this._currentView === 'trash' ? 'Il cestino è vuoto' : this._currentView === 'places' ? 'Nessuna nota legata a un luogo.' : 'Nessuna nota. Tocca + per crearne una.'}</p>`;
        container.appendChild(empty);
        this._updateSidebarCounts(index.notes || {});
        this._renderSidebar();
        if (window.skRefreshIcons) window.skRefreshIcons(document.getElementById('sidebar'));
        return;
      }

      // Render pinned section header if needed
      if (this._currentView === 'places') {
        await this._ensureGeo();
        this._renderPlacesSections(container, notes);
      } else {
      const pinned   = notes.filter(n => n.pinned);
      const unpinned = notes.filter(n => !n.pinned);

      // Do not show pinned/unpinned sections in Trash view
      if (this._currentView !== 'trash' && pinned.length && unpinned.length) {
        container.appendChild(this._sectionHeader(`Fissate in alto (${pinned.length})`, 'pin'));
        this._renderMasonry(container, pinned);
        container.appendChild(this._sectionHeader(`Altre (${unpinned.length})`));
        this._renderMasonry(container, unpinned);
      } else {
        this._renderMasonry(container, notes);
      }
      }

      this._updateSidebarCounts(index.notes || {});
      this._renderSidebar();
      
      if (window.skRefreshIcons) { window.skRefreshIcons(container); window.skRefreshIcons(document.getElementById('sidebar')); }

    } catch (err) {
      container.innerHTML = `<div class="empty-state error-state">
        <p>Errore durante il caricamento delle note: ${err.message}</p>
      </div>`;
    }
  }

  _notePlaceIds(meta) {
    const ids = meta?.placeIds || meta?.placeId;
    return [...new Set((Array.isArray(ids) ? ids : ids ? [ids] : []).map(id => String(id || '').trim()).filter(Boolean))];
  }

  _samePlaceIds(a, b) {
    const left = this._notePlaceIds({ placeIds: a }).sort();
    const right = this._notePlaceIds({ placeIds: b }).sort();
    return left.length === right.length && left.every((id, i) => id === right[i]);
  }

  _draftPlaceIds(prefix) {
    return (document.getElementById(`${prefix}-draft-places`)?.value || '').split(',').map(id => id.trim()).filter(Boolean);
  }

  _metersBetween(a, b) {
    const R = 6371000;
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLng = (b.lng - a.lng) * Math.PI / 180;
    const lat1 = a.lat * Math.PI / 180;
    const lat2 = b.lat * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  _readGeo(enableHighAccuracy, timeout, maximumAge = 120000) {
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ ok: true, pos }),
        (err) => resolve({ ok: false, code: err?.code || 0 }),
        { enableHighAccuracy, timeout, maximumAge }
      );
    });
  }

  _ensureGeo() {
    if (this._geoOverride) {
      this._geo = {
        lat: this._geoOverride.lat,
        lng: this._geoOverride.lng,
        accuracy: 0,
        forced: true,
        address: this._geoOverride.address,
      };
      this._geoState = 'ok';
      return Promise.resolve();
    }
    if (this._geo) return Promise.resolve();
    if (this._geoState === 'denied') return Promise.resolve();
    if (this._geoPromise) return this._geoPromise;
    if (!navigator.geolocation) {
      this._geoState = 'denied';
      return Promise.resolve();
    }
    const seq = this._geoSeq || 0;
    const maximumAge = Number.isFinite(this._geoMaxAge) ? this._geoMaxAge : 120000;
    this._geoMaxAge = 120000;
    this._geoPromise = (async () => {
      if (this._geoOverride) return;
      let result = await this._readGeo(false, 20000, maximumAge);
      if (seq !== this._geoSeq || this._geoOverride) return;
      if (!result.ok && result.code !== 1) result = await this._readGeo(true, 15000, maximumAge);
      if (seq !== this._geoSeq || this._geoOverride) return;
      const networkAccuracy = Number(result.pos?.coords?.accuracy);
      if (result.ok && networkAccuracy > 5000) {
        const precise = await this._readGeo(true, 15000, 0);
        if (seq !== this._geoSeq || this._geoOverride) return;
        const preciseAccuracy = Number(precise.pos?.coords?.accuracy);
        if (precise.ok && Number.isFinite(preciseAccuracy) && preciseAccuracy < networkAccuracy) result = precise;
      }
      if (this._geoOverride) return;
      if (result.ok && result.pos?.coords) {
        const coords = result.pos.coords;
        this._geo = { lat: coords.latitude, lng: coords.longitude, accuracy: coords.accuracy };
        this._geoState = 'ok';
      } else if (result.code === 1) {
        this._geo = null;
        this._geoState = 'denied';
      } else {
        this._geo = null;
        this._geoState = 'unknown';
      }
      if (seq === this._geoSeq) this._geoPromise = null;
    })();
    return this._geoPromise;
  }

  _placeContains(place) {
    if (!this._geo || !place) return false;
    const distance = this._metersBetween(this._geo, place);
    const accuracy = Number(this._geo.accuracy);
    const slack = Number.isFinite(accuracy) ? Math.min(Math.max(accuracy, 0), 200) : 0;
    return distance <= Number(place.radius || 0) + slack;
  }

  _formatMeters(meters) {
    if (!Number.isFinite(meters)) return '';
    if (meters < 1000) return `${Math.max(1, Math.round(meters))} m`;
    return `${(meters / 1000).toLocaleString('it-IT', { maximumFractionDigits: 1 })} km`;
  }

  _isNoteLocked(meta) {
    const ids = this._notePlaceIds(meta);
    if (!ids.length) return false;
    const places = (this._places || []).filter(p => ids.includes(String(p.id)));
    if (!places.length) return false;
    return !places.some(place => this._placeContains(place));
  }

  _notePlaceNames(meta) {
    const ids = this._notePlaceIds(meta);
    return (this._places || []).filter(p => ids.includes(String(p.id))).map(p => p.name);
  }

  _renderPlacesSections(container, notes) {
    const places = this._places || [];
    if (!places.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = '<p>Nessun luogo. Usa la matita accanto a Luoghi per crearne uno.</p>';
      container.appendChild(empty);
      return;
    }
    const here = places.filter(place => this._placeContains(place));
    const rest = places.filter(place => !this._placeContains(place));
    const paint = (place, hereSection) => {
      const linked = notes.filter(n => this._notePlaceIds(n).includes(String(place.id)));
      if (!linked.length && !hereSection) return;
      container.appendChild(this._sectionHeader(hereSection ? `Qui · ${place.name} (${linked.length})` : `${place.name} (${linked.length})`, 'map-pin'));
      if (linked.length) this._renderMasonry(container, linked);
    };
    if (here.length) here.forEach(place => paint(place, true));
    else {
      const missing = document.createElement('p');
      missing.className = 'trash-retention-note';
      missing.textContent = !this._geo
        ? 'Posizione non disponibile. Le note legate a un luogo restano chiuse.'
        : 'Non risulti dentro nessun luogo.';
      container.appendChild(missing);
    }
    rest.forEach(place => paint(place, false));
  }

  async _fillPlacePicker(prefix, selected) {
    const box = document.getElementById(`${prefix}-place-picker`);
    const hidden = document.getElementById(`${prefix}-draft-places`);
    if (!box || !hidden) return;
    let places = this._places;
    if (!places) {
      try {
        const index = await this.vault.getIndex();
        places = Array.isArray(index.places) ? index.places : [];
        this._places = places;
      } catch { places = []; }
    }
    const chosen = new Set(this._notePlaceIds({ placeIds: selected }));
    const paint = () => {
      hidden.value = [...chosen].join(',');
      box.innerHTML = '';
      if (!places.length) {
        const empty = document.createElement('p');
        empty.className = 'settings-desc';
        empty.textContent = 'Nessun luogo creato.';
        box.appendChild(empty);
        return;
      }
      places.forEach(place => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'place-chip' + (chosen.has(place.id) ? ' active' : '');
        btn.textContent = place.name;
        btn.addEventListener('click', () => {
          if (chosen.has(place.id)) chosen.delete(place.id);
          else chosen.add(place.id);
          paint();
        });
        box.appendChild(btn);
      });
    };
    paint();
  }

  _openManagePlaces() {
    const modal = document.getElementById('modal-manage-places');
    if (!modal) return;
    this._placePick = null;
    const address = document.getElementById('manage-place-address');
    const name = document.getElementById('manage-place-name');
    if (address) address.value = '';
    if (name) name.value = '';
    document.getElementById('manage-place-suggestions')?.classList.add('hidden');
    modal.classList.remove('hidden');
    this._resetPlaceMap();
    this._renderManagePlacesList();
    if (window.skRefreshIcons) window.skRefreshIcons(modal);
    setTimeout(() => name?.focus(), 50);
  }

  _closeManagePlaces() {
    document.getElementById('modal-manage-places')?.classList.add('hidden');
  }

  _closePlaceLock() {
    document.getElementById('modal-place-lock')?.classList.add('hidden');
  }

  _showPlaceLock(meta) {
    const names = this._notePlaceNames(meta);
    const text = document.getElementById('place-lock-text');
    if (text) {
      const places = (this._places || []).filter(p => this._notePlaceIds(meta).includes(String(p.id)));
      let where = names.length
        ? `Questa nota si legge solo dentro ${names.map(name => `«${name}»`).join(' o ')}.`
        : 'Questa nota si legge solo dentro il raggio del luogo assegnato.';
      if (!this._geo) {
        where += ' La posizione del dispositivo non è arrivata, quindi resta chiusa.';
      } else if (places.length) {
        const nearest = places
          .map(place => ({ place, distance: this._metersBetween(this._geo, place) }))
          .sort((a, b) => a.distance - b.distance)[0];
        where += ` Ora sei a circa ${this._formatMeters(nearest.distance)} da «${nearest.place.name}», il raggio è ${nearest.place.radius} m.`;
      }
      text.textContent = where;
    }
    const modal = document.getElementById('modal-place-lock');
    modal?.classList.remove('hidden');
    if (window.skRefreshIcons) window.skRefreshIcons(modal);
  }

  _ensurePlaceMap() {
    const el = document.getElementById('place-map');
    if (!el || this._placeMap || typeof L === 'undefined') return;
    this._placeMap = L.map(el, {
      zoomControl: true,
      scrollWheelZoom: false,
      attributionControl: true,
    }).setView([41.9, 12.5], 5);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(this._placeMap);
  }

  _clearPlaceCircle() {
    if (this._placeCircle && this._placeMap) this._placeMap.removeLayer(this._placeCircle);
    if (this._placeCenter && this._placeMap) this._placeMap.removeLayer(this._placeCenter);
    this._placeCircle = null;
    this._placeCenter = null;
  }

  _resetPlaceMap() {
    this._ensurePlaceMap();
    this._clearPlaceCircle();
    document.getElementById('place-map-empty')?.classList.remove('hidden');
    requestAnimationFrame(() => this._placeMap?.invalidateSize());
  }

  _drawPlaceRadius(lat, lng, radius) {
    this._ensurePlaceMap();
    const pointLat = Number(lat);
    const pointLng = Number(lng);
    const meters = Number(radius);
    if (!this._placeMap || !Number.isFinite(pointLat) || !Number.isFinite(pointLng)) return;
    this._clearPlaceCircle();
    const color = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#4F46E5';
    const point = [pointLat, pointLng];
    this._placeCircle = L.circle(point, {
      radius: Number.isFinite(meters) ? meters : 500,
      color,
      weight: 2,
      fillColor: color,
      fillOpacity: 0.2,
    }).addTo(this._placeMap);
    this._placeCenter = L.circleMarker(point, {
      radius: 6,
      color: '#fff',
      weight: 2,
      fillColor: color,
      fillOpacity: 1,
    }).addTo(this._placeMap);
    document.getElementById('place-map-empty')?.classList.add('hidden');
    const fit = () => {
      if (!this._placeMap || !this._placeCircle) return;
      this._placeMap.invalidateSize();
      this._placeMap.fitBounds(this._placeCircle.getBounds(), { padding: [28, 28], maxZoom: 17 });
    };
    requestAnimationFrame(fit);
  }

  async _suggestPlaces() {
    const input = document.getElementById('manage-place-address');
    const box = document.getElementById('manage-place-suggestions');
    if (!input || !box) return;
    const q = input.value.trim();
    this._placePick = null;
    this._resetPlaceMap();
    const seq = (this._placeSuggestSeq = (this._placeSuggestSeq || 0) + 1);
    if (q.length < 3) {
      box.classList.add('hidden');
      box.innerHTML = '';
      return;
    }
    clearTimeout(this._placeSuggestTimer);
    this._placeSuggestTimer = setTimeout(async () => {
      try {
        const res = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=5`);
        if (!res.ok || seq !== this._placeSuggestSeq) return;
        const data = await res.json();
        if (seq !== this._placeSuggestSeq) return;
        const features = data.features || [];
        box.innerHTML = '';
        if (!features.length) {
          box.classList.add('hidden');
          return;
        }
        features.forEach(feature => {
          const props = feature.properties || {};
          const label = [props.name, [props.street, props.housenumber].filter(Boolean).join(' '), props.city, props.country]
            .filter(Boolean).filter((part, i, all) => all.indexOf(part) === i).join(', ');
          const [lng, lat] = feature.geometry?.coordinates || [];
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'place-suggestion';
          btn.textContent = label || q;
          btn.addEventListener('click', () => {
            input.value = label || q;
            this._placePick = { address: label || q, lat: Number(lat), lng: Number(lng) };
            box.classList.add('hidden');
            const radius = Number(document.getElementById('manage-place-radius')?.value || 500);
            this._drawPlaceRadius(this._placePick.lat, this._placePick.lng, radius);
          });
          box.appendChild(btn);
        });
        box.classList.remove('hidden');
      } catch {
        box.classList.add('hidden');
      }
    }, 300);
  }

  async _createPlace() {
    const name = document.getElementById('manage-place-name')?.value.trim() || '';
    const radius = Number(document.getElementById('manage-place-radius')?.value || 500);
    if (!name) return this._toast('Scrivi il nome del luogo');
    if (!this._placePick || !Number.isFinite(this._placePick.lat)) {
      return this._toast('Scegli un indirizzo dai suggerimenti');
    }
    const index = await this.vault.getIndex();
    const places = Array.isArray(index.places) ? [...index.places] : [];
    places.push({
      id: this.vault._generateId(),
      name,
      address: this._placePick.address,
      lat: this._placePick.lat,
      lng: this._placePick.lng,
      radius,
    });
    await this.vault.savePlaces(places);
    this._places = places;
    this._placePick = null;
    this._resetPlaceMap();
    const address = document.getElementById('manage-place-address');
    const nameEl = document.getElementById('manage-place-name');
    if (address) address.value = '';
    if (nameEl) nameEl.value = '';
    this._renderManagePlacesList();
    this._renderNoteGrid();
    this.sync.sync().catch(() => {});
    this._toast('Luogo aggiunto');
  }

  async _renderManagePlacesList() {
    const list = document.getElementById('manage-places-list');
    if (!list) return;
    const index = await this.vault.getIndex();
    const places = Array.isArray(index.places) ? index.places : [];
    this._places = places;
    list.innerHTML = '';
    if (!places.length) {
      const empty = document.createElement('p');
      empty.className = 'manage-tags-empty';
      empty.textContent = 'Nessun luogo';
      list.appendChild(empty);
      return;
    }
    places.forEach(place => {
      const row = document.createElement('div');
      row.className = 'manage-place-row';
      const name = document.createElement('input');
      name.type = 'text';
      name.value = place.name;
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); name.blur(); } });
      name.addEventListener('blur', () => this._renamePlace(place.id, name.value));
      const address = document.createElement('p');
      address.className = 'settings-desc';
      address.textContent = `${place.address} · ${place.radius} m`;
      address.title = 'Mostra sulla mappa';
      address.addEventListener('click', () => this._drawPlaceRadius(place.lat, place.lng, place.radius));
      const radius = document.createElement('select');
      [100, 200, 500, 1000, 2000].forEach(value => {
        const option = document.createElement('option');
        option.value = String(value);
        option.textContent = `${value} m`;
        if (Number(place.radius) === value) option.selected = true;
        radius.appendChild(option);
      });
      radius.addEventListener('change', () => this._setPlaceRadius(place.id, Number(radius.value)));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn-icon manage-tag-delete';
      remove.setAttribute('aria-label', `Elimina luogo ${place.name}`);
      remove.innerHTML = '<i data-lucide="trash-2" style="width:16px;height:16px"></i>';
      remove.addEventListener('click', () => this._deletePlace(place.id));
      const copy = document.createElement('div');
      copy.className = 'manage-place-copy';
      copy.append(name, address);
      row.append(copy, radius, remove);
      list.appendChild(row);
    });
    if (window.skRefreshIcons) window.skRefreshIcons(list);
  }

  async _renamePlace(id, raw) {
    const next = String(raw || '').trim();
    const places = [...(this._places || [])];
    const place = places.find(p => p.id === id);
    if (!place || !next || next === place.name) return;
    place.name = next;
    await this.vault.savePlaces(places);
    this._places = places;
    this._renderNoteGrid();
    this.sync.sync().catch(() => {});
  }

  async _setPlaceRadius(id, radius) {
    const places = [...(this._places || [])];
    const place = places.find(p => p.id === id);
    if (!place || place.radius === radius) return;
    place.radius = radius;
    await this.vault.savePlaces(places);
    this._places = places;
    this._drawPlaceRadius(place.lat, place.lng, radius);
    this._renderManagePlacesList();
    this._renderNoteGrid();
    this.sync.sync().catch(() => {});
  }

  async _deletePlace(id) {
    const index = await this.vault.getIndex();
    const places = (index.places || []).filter(p => p.id !== id);
    await this.vault.savePlaces(places);
    this._places = places;
    const notes = Object.values(index.notes || {}).filter(n => this._notePlaceIds(n).includes(id));
    for (const meta of notes) {
      const note = await this.vault.getNote(meta.id);
      await this.vault.updateNote(meta.id, { ...note, placeIds: this._notePlaceIds(note).filter(placeId => placeId !== id) }, false);
    }
    this._renderManagePlacesList();
    this._renderNoteGrid();
    this.sync.sync().catch(() => {});
    this._toast('Luogo eliminato');
  }

  _renderMasonry(container, notes) {
    if (!notes || notes.length === 0) return;
    const masonry = document.createElement('div');
    masonry.className = 'masonry-grid-js';
    masonry.style.display = 'flex';
    masonry.style.gap = 'var(--sp-4)';
    masonry.style.alignItems = 'flex-start';
    masonry.style.marginBottom = 'var(--sp-8)';

    const w = window.innerWidth;
    let colCount = 4;
    if (w <= 900) colCount = 3;
    if (w <= 700) colCount = 2;
    if (w <= 400) colCount = 1;

    const cols = [];
    for(let i=0; i<colCount; i++) {
      const col = document.createElement('div');
      col.style.flex = '1';
      col.style.display = 'flex';
      col.style.flexDirection = 'column';
      col.style.gap = 'var(--sp-4)';
      col.style.minWidth = '0';
      cols.push(col);
      masonry.appendChild(col);
    }
    
    container.appendChild(masonry);

    notes.forEach((n, i) => {
      cols[i % colCount].appendChild(this._buildCard(n));
    });
  }

  _masonryOrder(masonry) {
    const cols = [...masonry.children];
    const lists = cols.map(col => [...col.children]);
    const rows = Math.max(0, ...lists.map(list => list.length));
    const items = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols.length; col++) {
        if (lists[col][row]) items.push(lists[col][row]);
      }
    }
    return items;
  }

  _reflowMasonry(masonry, items) {
    const cols = [...masonry.children];
    if (!cols.length) return;
    this._reflowGen = (this._reflowGen || 0) + 1;
    const prev = new Map();
    items.forEach(el => {
      if (!el.classList.contains('note-card')) return;
      prev.set(el, el.getBoundingClientRect());
    });
    items.forEach((el, i) => cols[i % cols.length].appendChild(el));
    items.forEach(el => {
      const old = prev.get(el);
      if (!old) return;
      const next = el.getBoundingClientRect();
      const dx = old.left - next.left;
      const dy = old.top - next.top;
      if (!dx && !dy) return;
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      const gen = this._reflowGen;
      requestAnimationFrame(() => {
        if (gen !== this._reflowGen) return;
        el.style.transition = 'transform 320ms cubic-bezier(0.22, 1, 0.36, 1)';
        el.style.transform = '';
      });
    });
  }

  _swallowNextClick() {
    this._clearDragClickTrap();
    const swallow = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this._clearDragClickTrap();
    };
    this._dragClickTrap = swallow;
    document.addEventListener('click', swallow, true);
  }

  _clearDragClickTrap() {
    clearTimeout(this._dragClickTrapTimer);
    this._dragClickTrapTimer = null;
    if (!this._dragClickTrap) return;
    document.removeEventListener('click', this._dragClickTrap, true);
    this._dragClickTrap = null;
  }

  _releaseDragClickTrap() {
    clearTimeout(this._dragClickTrapTimer);
    this._dragClickTrapTimer = setTimeout(() => this._clearDragClickTrap(), 80);
  }

  _layoutBox(el) {
    const r = el.getBoundingClientRect();
    const t = el.style.transform || '';
    const m = t.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
    const dx = m ? parseFloat(m[1]) : 0;
    const dy = m ? parseFloat(m[2]) : 0;
    return {
      left: r.left - dx,
      top: r.top - dy,
      width: r.width,
      height: r.height,
      right: r.left - dx + r.width,
      bottom: r.top - dy + r.height,
    };
  }

  _beginNoteDrag(card, meta, e) {
    const masonry = card.closest('.masonry-grid-js');
    if (!masonry || this._drag) return;
    const rect = card.getBoundingClientRect();
    const placeholder = document.createElement('div');
    placeholder.className = 'note-card-placeholder';
    placeholder.style.height = `${rect.height}px`;
    card.before(placeholder);
    document.body.appendChild(card);
    card.classList.remove('is-lifted');
    card.classList.add('is-dragging');
    card.style.transition = 'none';
    card.style.transform = 'rotate(1.5deg)';
    card.style.position = 'fixed';
    card.style.left = `${rect.left}px`;
    card.style.top = `${rect.top}px`;
    card.style.width = `${rect.width}px`;
    card.style.margin = '0';
    card.style.zIndex = '2000';
    card.style.pointerEvents = 'none';
    document.body.classList.add('is-note-dragging');
    this._swallowNextClick();
    this._drag = {
      card,
      meta,
      masonry,
      placeholder,
      dx: e.clientX - rect.left,
      dy: e.clientY - rect.top,
      origin: this._masonryOrder(masonry).map(el => el === placeholder ? meta.id : el.dataset.id).join('|'),
      sig: '',
    };
    this._onNoteDragMove = (ev) => this._moveNoteDrag(ev);
    this._onNoteDragEnd = () => this._endNoteDrag();
    document.addEventListener('pointermove', this._onNoteDragMove, { passive: false });
    document.addEventListener('pointerup', this._onNoteDragEnd);
    document.addEventListener('pointercancel', this._onNoteDragEnd);
    this._moveNoteDrag(e);
  }

  _moveNoteDrag(e) {
    const drag = this._drag;
    if (!drag) return;
    e.preventDefault();
    window.getSelection()?.removeAllRanges();
    drag.card.style.left = `${e.clientX - drag.dx}px`;
    drag.card.style.top = `${e.clientY - drag.dy}px`;
    const cards = this._masonryOrder(drag.masonry).filter(el => el !== drag.placeholder);
    if (!cards.length) return;
    const x = e.clientX;
    const y = e.clientY;
    const boxes = cards.map(el => this._layoutBox(el));
    let hit = -1;
    boxes.forEach((box, i) => {
      const insetX = Math.min(10, Math.max(0, (box.width - 1) / 2));
      const insetY = Math.min(10, Math.max(0, (box.height - 1) / 2));
      const inside = x >= box.left + insetX && x <= box.right - insetX && y >= box.top + insetY && y <= box.bottom - insetY;
      if (inside) hit = i;
    });
    if (hit < 0) return;
    const hitBox = boxes[hit];
    const placeAfter = y >= hitBox.top + hitBox.height / 2;
    const next = cards.slice();
    next.splice(hit + (placeAfter ? 1 : 0), 0, drag.placeholder);
    const sig = next.map(el => el.dataset.id || 'ph').join('|');
    if (sig === drag.sig) return;
    drag.sig = sig;
    this._reflowMasonry(drag.masonry, next);
  }

  async _endNoteDrag() {
    const drag = this._drag;
    if (!drag) return;
    this._drag = null;
    document.removeEventListener('pointermove', this._onNoteDragMove);
    document.removeEventListener('pointerup', this._onNoteDragEnd);
    document.removeEventListener('pointercancel', this._onNoteDragEnd);
    document.body.classList.remove('is-note-dragging');
    document.body.classList.remove('is-note-holding');
    window.getSelection()?.removeAllRanges();
    this._releaseDragClickTrap();
    const ids = this._masonryOrder(drag.masonry).map(el => el === drag.placeholder ? drag.meta.id : el.dataset.id).filter(Boolean);
    const changed = ids.join('|') !== drag.origin;
    this._reflowGen = (this._reflowGen || 0) + 1;
    drag.masonry.querySelectorAll('.note-card').forEach(el => {
      el.style.transition = '';
      el.style.transform = '';
    });
    if (drag.placeholder.isConnected) drag.placeholder.replaceWith(drag.card);
    drag.card.classList.remove('is-dragging');
    drag.card.removeAttribute('style');
    document.querySelectorAll('body > .note-card').forEach(el => el.remove());
    if (!changed) {
      this._renderNoteGrid();
      return;
    }
    try {
      await this._persistNoteOrder(ids);
    } catch (err) {
      this._toast(err.message || 'Errore spostamento', 'error');
    }
    this._renderNoteGrid();
  }

  async _persistNoteOrder(ids) {
    const index = await this.vault.getIndex();
    const metas = ids.map(id => index.notes?.[id]).filter(Boolean);
    const stamps = metas.map(meta => {
      const t = new Date(meta.addedAt || meta.updatedAt || 0).getTime();
      return Number.isFinite(t) ? t : 0;
    }).sort((a, b) => b - a);
    for (let i = 1; i < stamps.length; i++) {
      if (stamps[i] >= stamps[i - 1]) stamps[i] = stamps[i - 1] - 1;
    }
    let changed = false;
    for (let i = 0; i < metas.length; i++) {
      const current = new Date(metas[i].addedAt || metas[i].updatedAt || 0).getTime();
      if (current === stamps[i]) continue;
      const note = await this.vault.getNote(metas[i].id);
      await this.vault.updateNote(metas[i].id, { ...note, addedAt: new Date(stamps[i]).toISOString() }, false);
      changed = true;
    }
    if (changed) this.sync.sync().catch(() => {});
  }

  _sectionHeader(text, iconName = null) {
    const h = document.createElement('div');
    h.className = 'section-header';
    if (iconName) {
      h.innerHTML = `<span style="display:flex;align-items:center;gap:6px;"><i data-lucide="${iconName}" style="width:16px;height:16px"></i>${this._escHtml(text)}</span>`;
    } else {
      h.textContent = text;
    }
    return h;
  }


  _linkify(html) {
    const urlRegex = /(https?:\/\/[^\s<]+)/g;
    const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/g;
    let linked = html.replace(urlRegex, '<a href="$1" target="_blank" rel="noopener noreferrer" style="color:var(--accent);text-decoration:underline;">$1</a>');
    linked = linked.replace(emailRegex, '<a href="mailto:$1" style="color:var(--accent);text-decoration:underline;">$1</a>');
    return linked;
  }

  _updateDetectedLinks(text, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/g;
    
    const urls = [...new Set(text.match(urlRegex) || [])];
    const emails = [...new Set(text.match(emailRegex) || [])];
    
    container.innerHTML = '';
    
    const createChip = (icon, text, href) => {
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.className = 'link-chip';
      a.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:4px 10px;background:var(--bg-hover);border:1px solid var(--border);border-radius:16px;font-size:12px;color:var(--text);text-decoration:none;transition:0.2s;';
      a.innerHTML = `<i data-lucide="${icon}" style="width:12px;height:12px"></i> ${text.length > 30 ? text.substring(0,30)+'...' : text}`;
      a.onmouseenter = () => a.style.borderColor = 'var(--accent)';
      a.onmouseleave = () => a.style.borderColor = 'var(--border)';
      return a;
    };
    
    urls.forEach(url => container.appendChild(createChip('link', url, url)));
    emails.forEach(email => container.appendChild(createChip('mail', email, 'mailto:'+email)));
    
    if (window.skRefreshIcons) window.skRefreshIcons(container);
  }

  _buildCard(meta) {

    const card = document.createElement('div');
    card.className = `note-card note-color-${meta.color || 'default'}`;
    card.dataset.id = meta.id;
    card.dataset.color = meta.color || 'default';
    if (meta.pinned)     card.classList.add('pinned');
    if (meta.archived)   card.classList.add('archived');
    if (meta.conflicted) card.classList.add('conflicted');
    if (this._selectedIds.has(meta.id)) card.classList.add('selected');

    // Type icon (Lucide SVG, stroke-width 1.5)
    const typeIconMap = {
      password: 'key',
      note: 'file-text',
      checklist: 'check-square',
    };
    const typeIcon = typeIconMap[meta.type] || typeIconMap.note;

    const pinIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>`;
    const moreIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>`;

    let customIconHtml = '';
    if (meta.icon) {
      if (meta.icon.startsWith('data:image/')) {
        customIconHtml = `<img src="${meta.icon}" style="width:25px;height:25px;flex-shrink:0;border-radius:6px;background:#fff;padding:2px;object-fit:contain;margin-top:0px;box-shadow:0 1px 3px rgba(0,0,0,0.1);">`;
      } else if (/^[a-z0-9-]+$/.test(meta.icon)) {
        const color = getIconColor(meta.icon);
        customIconHtml = `<span style="display:flex;align-items:center;justify-content:center;flex-shrink:0;width:25px;height:25px;color:${color};margin-top:0px;"><i data-lucide="${meta.icon}" style="width:22px;height:22px;"></i></span>`;
      } else {
        customIconHtml = `<span style="display:flex;align-items:center;justify-content:center;flex-shrink:0;width:25px;height:25px;margin-top:0px;font-size:20px;">${meta.icon}</span>`;
      }
    }

    const titleText = this._escHtml(meta.title || '');
    const renewDue = meta.type === 'password' && this._passwordRenewDue(meta);
    const placeLocked = this._isNoteLocked(meta);
    const placeNames = this._notePlaceNames(meta);

    if (placeLocked) {
      card.classList.add('place-locked');
      card.innerHTML = `
        <div class="card-header">
          <span class="card-type-icon" style="margin-top:5px;"><i data-lucide="map-pin"></i></span>
          <span class="card-title"><span style="flex:1;">Protetta dal luogo</span></span>
        </div>
        <div class="card-preview">${placeNames.map(name => `<div>${this._escHtml(name)}</div>`).join('') || 'Fuori dal raggio'}</div>
      `;
      card.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._showPlaceLock(meta);
      });
      return card;
    }

    card.innerHTML = `
      <div class="card-header">
        <span class="card-type-icon" style="margin-top:5px;"><i data-lucide="${typeIcon}"></i></span>
        <span class="card-title" style="display:flex;align-items:flex-start;gap:8px;">${customIconHtml}<span style="flex:1;">${titleText}${renewDue ? '<div class="pwd-renew-flag">Da rinnovare</div>' : ''}</span></span>
        <div class="card-actions">
          <button class="btn-icon pin-btn${meta.pinned ? ' active' : ''}" title="${meta.pinned ? 'Rimuovi dai fissati' : 'Fissa in alto'}">${pinIconSvg}</button>
          <button class="btn-icon more-btn" title="More">${moreIconSvg}</button>
        </div>
      </div>
      ${this._cardThumbsHtml(meta)}
      ${meta.preview ? `<div class="card-preview${meta.type === 'checklist' ? ' card-preview-checklist' : ''}">${
        meta.type === 'checklist'
          ? meta.preview.split('\n').map(line => {
              const checked = line.startsWith('[x] ');
              const empty   = line.startsWith('[ ] ');
              if (checked || empty) {
                const text = this._escHtml(line.substring(4));
                return `<span class="cp-item${checked ? ' cp-checked' : ''}">` +
                  (checked
                    ? `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1" y="1" width="14" height="14" rx="3" fill="currentColor" stroke="currentColor" stroke-width="1.5"/><path d="M4.2 8.2 6.6 10.6 11.8 5.2" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`
                    : `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1" y="1" width="14" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`) +
                  `<span>${text}</span></span>`;
              }
              return `<span class="cp-item">${this._escHtml(line)}</span>`;
            }).join('')
          : meta.type === 'password'
          ? meta.preview.split('\n').map(line => {
              if (line.startsWith('U:')) return `<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;"><i data-lucide="user" style="width:14px;height:14px;opacity:0.7;"></i> <span style="text-overflow:ellipsis;overflow:hidden;white-space:nowrap;">${this._escHtml(line.substring(2))}</span></div>`;
              if (line.startsWith('L:')) return `<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;"><i data-lucide="link" style="width:14px;height:14px;opacity:0.7;"></i> <span style="text-overflow:ellipsis;overflow:hidden;white-space:nowrap;">${this._escHtml(line.substring(2))}</span></div>`;
              if (line.startsWith('P:')) return `<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;"><i data-lucide="key" style="width:14px;height:14px;opacity:0.7;"></i> <span>••••••••••••</span></div>`;
              if (line.startsWith('N:')) return `<div style="margin-top:8px;font-style:italic;opacity:0.8;">${this._escHtml(line.substring(2))}</div>`;
              return `<div style="margin-bottom:2px;">${this._escHtml(line)}</div>`;
            }).join('')
          : this._escHtml(meta.preview.replace(/\p{Emoji}/gu, '').replace(/[ \t]+/g, ' ').trim()).replace(/\n/g, '<br>')
      }</div>` : ''}
      ${meta.conflicted ? `<div class="card-meta"><div class="conflict-badge"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> Conflitto</div></div>` : ''}
      ${meta.tags?.length ? `<div class="card-tags">${meta.tags.map(t => `<span class="tag">${this._escHtml(t)}</span>`).join('')}</div>` : ''}
      <div class="card-footer">
        <span class="card-date">${this._formatDate(meta.updatedAt)}</span>
        <button class="btn-icon card-color-btn" title="Colore" style="width: 24px; height: 24px;">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"></circle><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"></circle><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"></circle><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"></circle><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"></path></svg>
        </button>
        <input type="checkbox" class="card-checkbox" ${this._selectedIds.has(meta.id) ? 'checked' : ''}>
      </div>
    `;

    // Password quick copy actions
    if (meta.type === 'password') {
      const qa = document.createElement('div');
      qa.className = 'pwd-quick-actions';
      qa.style.display = 'flex';
      qa.style.gap = 'var(--sp-2)';
      qa.style.marginTop = 'var(--sp-2)';
      const hasUser = meta.hasUsername !== undefined ? meta.hasUsername : !!meta.preview;
      const hasPwd = meta.hasPassword !== undefined ? meta.hasPassword : (meta.preview?.includes('••••••••••••') || meta.preview?.includes('*********'));

      qa.innerHTML = `
        ${hasUser ? `<button class="btn-icon btn-cp-usr" style="width:32px;height:32px;padding:0;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-btn);" title="Copia Username">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        </button>` : ''}
        ${hasPwd ? `<button class="btn-icon btn-cp-pwd" style="width:32px;height:32px;padding:0;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-btn);" title="Copia Password">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        </button>
        <button class="btn-icon btn-vw-pwd" style="width:32px;height:32px;padding:0;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-btn);" title="Vedi password">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>` : ''}
      `;
      
      const btnUser = qa.querySelector('.btn-cp-usr');
      const btnPwd = qa.querySelector('.btn-cp-pwd');
      const btnVw = qa.querySelector('.btn-vw-pwd');
      
      if (btnUser) {
        btnUser.onclick = async (e) => {
          e.stopPropagation();
          try {
            const data = await this.vault.getNote(meta.id);
            if (data.username) this._copyToClipboard(data.username, 'Username copiato!');
            else this._toast('Nessun username salvato', 'error');
          } catch (err) { this._toast('Errore: '+err.message, 'error'); }
        };
      }
      
      if (btnPwd) {
        btnPwd.onclick = async (e) => {
          e.stopPropagation();
          try {
            const data = await this.vault.getNote(meta.id);
            if (data.password) this._copyToClipboard(data.password, 'Password copiata!');
            else this._toast('Nessuna password salvata', 'error');
          } catch (err) { this._toast('Errore: '+err.message, 'error'); }
        };
      }
      
      if (btnVw) {
        btnVw.onclick = async (e) => {
          e.stopPropagation();
          try {
            const data = await this.vault.getNote(meta.id);
            if (data.password) {
              const m = document.getElementById('modal-view-password');
              const txt = document.getElementById('view-password-text');
              if (m && txt) {
                txt.textContent = data.password;
                txt.style.filter = 'blur(10px)';
                m.classList.remove('hidden');
              }
            }
            else this._toast('Nessuna password salvata', 'error');
          } catch (err) { this._toast('Errore: '+err.message, 'error'); }
        };
      }
      
      const tagsEl = card.querySelector('.card-tags');
      const footerEl = card.querySelector('.card-footer');
      (tagsEl || footerEl)?.before(qa);
    }

    card.querySelector('.card-checkbox')?.addEventListener('change', e => {
      e.stopPropagation();
      this._enterMultiSelect();
      this._toggleSelect(meta.id, card);
    });

    let holdTimer = null;
    let lifted = false;
    let tracking = false;
    let pressX = 0;
    let pressY = 0;
    let pointerId = null;

    const blockSelect = (ev) => ev.preventDefault();
    const stopTracking = () => {
      clearTimeout(holdTimer);
      holdTimer = null;
      tracking = false;
      lifted = false;
      card.classList.remove('is-lifted');
      if (!this._drag) document.body.classList.remove('is-note-holding');
      document.removeEventListener('selectstart', blockSelect);
      document.removeEventListener('pointermove', onDocMove);
      document.removeEventListener('pointerup', onDocUp);
      document.removeEventListener('pointercancel', onDocUp);
    };
    const onDocMove = (e) => {
      if (!tracking || e.pointerId !== pointerId || this._drag) return;
      const dist = Math.hypot(e.clientX - pressX, e.clientY - pressY);
      if (!lifted) {
        if (dist > 36) stopTracking();
        return;
      }
      e.preventDefault();
      window.getSelection()?.removeAllRanges();
      if (dist < 3) return;
      this._beginNoteDrag(card, meta, e);
    };
    const onDocUp = (e) => {
      if (e.pointerId !== pointerId) return;
      const wasLifted = lifted && !this._drag;
      stopTracking();
      if (wasLifted) {
        this._swallowNextClick();
        this._releaseDragClickTrap();
      }
    };

    card.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.target.closest('button, a, .card-checkbox, .pwd-quick-actions')) return;
      if (this._drag || this._multiSelectMode || tracking) return;
      tracking = true;
      lifted = false;
      pointerId = e.pointerId;
      pressX = e.clientX;
      pressY = e.clientY;
      document.body.classList.add('is-note-holding');
      document.addEventListener('selectstart', blockSelect);
      document.addEventListener('pointermove', onDocMove, { passive: false });
      document.addEventListener('pointerup', onDocUp);
      document.addEventListener('pointercancel', onDocUp);
      holdTimer = setTimeout(() => {
        holdTimer = null;
        if (!tracking) return;
        lifted = true;
        card.classList.add('is-lifted');
      }, 300);
    });

    card.addEventListener('click', e => {
      if (this._suppressNextCardClick) {
        this._suppressNextCardClick = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.target.closest('button') || e.target.closest('.card-checkbox') || e.target.closest('a')) return;
      if (this._multiSelectMode) {
        this._toggleSelect(meta.id, card);
      } else {
        this._openNoteEditor(meta.id, meta.type);
      }
    });

    card.querySelector('.card-color-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      const btn = e.currentTarget;
      if (this._activeMenuTrigger === btn) {
        this._closeContextMenus();
        return;
      }
      this._showColorPicker(meta, card, btn);
    });

    card.querySelector('.pin-btn')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await this.vault.setPinned(meta.id, !meta.pinned);
      this._renderNoteGrid();
      this.sync.sync().catch(() => {});
    });

    card.querySelector('.more-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      const btn = e.currentTarget;
      if (this._activeMenuTrigger === btn) {
        this._closeContextMenus();
        return;
      }
      this._showCardMenu(meta, card, btn);
    });

    return card;
  }

  // ─── Card context menu ────────────────────────────────────────────────────────

  _showCardMenu(meta, cardEl, btnEl) {
    this._closeContextMenus();
    this._activeMenuTrigger = btnEl;
    if (cardEl) cardEl.classList.add('menu-open');
    const menu = document.createElement('div');
    menu.className = 'context-menu';

    const isTrash = this._currentView === 'trash';

    const items = isTrash ? [
      { label: 'Ripristina',               action: async () => { await this.vault.restoreNote(meta.id); this._renderNoteGrid(); } },
      { label: 'Elimina definitivamente',  action: () => this._confirmDeleteForever(meta.id) },
    ] : [
      { label: 'Clona', action: async () => {
          const note = await this.vault.getNote(meta.id);
          const cloneData = { ...note };
          delete cloneData.id;
          delete cloneData.createdAt;
          delete cloneData.updatedAt;
          cloneData.title = `Copia - ${cloneData.title || ''}`.trim();
          if (cloneData.title === 'Copia -') cloneData.title = 'Copia';
          
          const newId = await this.vault.createNote(note.type, cloneData);
          this._renderNoteGrid();
          this.sync.sync().catch(() => {});
          
          this._toast('Nota copiata', 'success', {
            label: 'Annulla',
            onClick: async () => {
              await this.vault.deleteNote(newId);
              this._renderNoteGrid();
              this.sync.sync().catch(() => {});
            }
          });
      } },
      { label: meta.archived ? "Estrai dall'archivio" : 'Archivia',
        action: async () => {
          const archiving = !meta.archived;
          await this.vault.setArchived(meta.id, archiving);
          this._renderNoteGrid();
          this.sync.sync().catch(() => {});
          if (archiving) {
            this._toast('Nota archiviata', 'success', {
              label: 'Annulla',
              onClick: async () => {
                await this.vault.setArchived(meta.id, false);
                this._renderNoteGrid();
                this.sync.sync().catch(() => {});
              }
            });
          } else {
            this._toast('Nota estratta');
          }
        } 
      },
      { label: 'Colore',           action: () => this._showColorPicker(meta, cardEl) },
      { label: 'Etichette',        action: () => this._showTagEditor(meta) },
      { label: 'Sposta nel cestino', action: async () => {
          await this.vault.trashNote(meta.id);
          this._renderNoteGrid();
          this.sync.sync().catch(() => {});
          this._toast(this._trashToastLabel(meta.title), 'success', {
            label: 'Annulla',
            onClick: async () => {
              await this.vault.restoreNote(meta.id);
              this._renderNoteGrid();
              this.sync.sync().catch(() => {});
            }
          });
        }
      },
    ];

    if (meta.conflicted) {
      items.unshift({ label: 'Risolvi conflitto', action: () => this._showConflictResolver(meta.id) });
    }

    items.forEach(({ label, action }) => {
      const btn = document.createElement('button');
      btn.className = 'context-menu-item';
      btn.textContent = label;
      btn.addEventListener('click', (e) => {
        e.stopPropagation(); // prevent document listener from eating this click
        this._closeContextMenus();
        action();
      });
      menu.appendChild(btn);
    });

    this._placeAnchoredPopup(menu, cardEl.getBoundingClientRect(), { align: 'right', gap: 4 });

    setTimeout(() => {
      document.addEventListener('click', (e) => {
        if (!menu.contains(e.target)) this._closeContextMenus();
      }, { once: true });
    }, 10);


  }

  _closeContextMenus() {
    this._activeMenuTrigger = null;
    document.querySelectorAll('.context-menu').forEach(m => m.remove());
    document.querySelectorAll('.note-card.menu-open').forEach(c => c.classList.remove('menu-open'));
  }

  _placeAnchoredPopup(popup, rect, { align = 'left', gap = 8 } = {}) {
    popup.style.position = 'fixed';
    popup.style.bottom = 'auto';
    popup.style.zIndex = '9999';
    if (!popup.isConnected) document.body.appendChild(popup);
    const width = popup.offsetWidth;
    const height = popup.offsetHeight;
    const spaceBelow = window.innerHeight - rect.bottom - gap;
    const spaceAbove = rect.top - gap;
    const openUp = spaceBelow < height && spaceAbove > spaceBelow;
    const top = openUp
      ? Math.max(8, rect.top - gap - height)
      : Math.min(rect.bottom + gap, Math.max(8, window.innerHeight - height - 8));
    let left = align === 'right' ? rect.right - width : rect.left;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    popup.style.top = `${top}px`;
    popup.style.left = `${left}px`;
  }

  _dismissMenuOnOutside(popup) {
    setTimeout(() => {
      if (!popup.isConnected) return;
      document.addEventListener('click', (e) => {
        if (!popup.isConnected || popup.contains(e.target)) return;
        if (e.target.closest('.draft-color-btn, .draft-tags-btn')) return;
        this._closeContextMenus();
      }, { once: true });
    }, 0);
  }

  _showTextSelectionMenu(e, selected) {
    this._closeContextMenus();
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'context-menu-item';
    btn.innerHTML = '<i data-lucide="search"></i><span>Cerca in Google</span>';
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this._closeContextMenus();
      const url = 'https://www.google.com/search?q=' + encodeURIComponent(selected);
      window.open(url, '_blank', 'noopener,noreferrer');
    });
    menu.appendChild(btn);
    menu.style.position = 'fixed';
    menu.style.zIndex = '9999';
    document.body.appendChild(menu);
    if (window.skRefreshIcons) window.skRefreshIcons(menu);

    const rect = menu.getBoundingClientRect();
    const left = Math.min(e.clientX, window.innerWidth - rect.width - 8);
    const top = Math.min(e.clientY, window.innerHeight - rect.height - 8);
    menu.style.left = Math.max(8, left) + 'px';
    menu.style.top = Math.max(8, top) + 'px';

    setTimeout(() => {
      document.addEventListener('click', (ev) => {
        if (!menu.contains(ev.target)) this._closeContextMenus();
      }, { once: true });
    }, 10);
  }

  // ─── Color picker ─────────────────────────────────────────────────────────────

  _showDraftColorPicker(btnEl) {
    if (this._activeMenuTrigger === btnEl) { this._closeContextMenus(); return; }
    this._closeContextMenus();
    this._activeMenuTrigger = btnEl;
    const modal = btnEl.closest('.modal');
    const prefix = modal.id === 'modal-checklist' ? 'cl' : (modal.id === 'modal-password' ? 'pwd' : 'note');
    
    const picker = document.createElement('div');
    picker.className = 'color-picker-popup context-menu';
    
    NOTE_COLORS.forEach(color => {
      const swatch = document.createElement('button');
      const inputEl = document.getElementById(prefix + '-draft-color');
      const currentColor = inputEl ? inputEl.value : 'default';
      
      let cls = 'color-swatch';
      if (currentColor === color.id) cls += ' active';
      swatch.className = cls;
      swatch.style.backgroundColor = color.light;
      swatch.title = color.label;
      swatch.addEventListener('click', (e) => {
        e.stopPropagation();
        if (inputEl) inputEl.value = color.id;
        const box = modal.querySelector('.modal-box');
        if (box) box.className = 'modal-box note-color-' + color.id;
        this._closeContextMenus();
        this._commitEditorHistory?.();
      });
      picker.appendChild(swatch);
    });
    
    const rect = btnEl.getBoundingClientRect();
    picker.style.position = 'fixed';
    picker.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
    picker.style.left = rect.left + 'px';
    picker.style.zIndex = '9999';
    picker.addEventListener('click', (e) => e.stopPropagation());
    document.body.appendChild(picker);
    this._dismissMenuOnOutside(picker);
  }

  async _showDraftTagPicker(btnEl) {
    if (this._activeMenuTrigger === btnEl) { this._closeContextMenus(); return; }
    this._closeContextMenus();
    this._activeMenuTrigger = btnEl;
    const modal = btnEl.closest('.modal');
    if (!modal) return;
    const prefix = modal.id === 'modal-checklist' ? 'cl' : (modal.id === 'modal-password' ? 'pwd' : 'note');
    const inputEl = document.getElementById(prefix + '-draft-tags');
    if (!inputEl) return;
    let selectedTags = inputEl.value.split(',').map(t => t.trim()).filter(Boolean);

    const index = await this.vault.getIndex();
    if (this._activeMenuTrigger !== btnEl) return;
    const known = this._allTagNames(index);

    const popup = document.createElement('div');
    popup.className = 'context-menu tag-picker';
    popup.innerHTML = `
      <div class="tag-picker-title">ETICHETTE</div>
      <div id="tag-picker-list" class="tag-picker-list"></div>
      <div class="tag-picker-create">
        <input type="text" id="tag-picker-new" placeholder="Nuova etichetta..." autocomplete="off">
        <button type="button" id="tag-picker-add" class="btn btn-primary tag-picker-add">Aggiungi</button>
      </div>`;

    const listEl = popup.querySelector('#tag-picker-list');
    const syncInput = () => {
      inputEl.value = selectedTags.join(',');
      this._updateDraftTagsVisual(modal, selectedTags);
      this._commitEditorHistory?.();
    };
    const renderList = () => {
      const names = [...new Set([...known, ...selectedTags])].sort((a, b) => a.localeCompare(b, 'it'));
      listEl.innerHTML = '';
      if (!names.length) {
        const empty = document.createElement('div');
        empty.className = 'tag-picker-empty';
        empty.textContent = 'Nessuna etichetta';
        listEl.appendChild(empty);
        return;
      }
      names.forEach((tag) => {
        const on = selectedTags.includes(tag);
        const row = document.createElement('div');
        row.className = 'tag-picker-row' + (on ? ' is-on' : '');

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'tag-picker-toggle';
        const mark = document.createElement('span');
        mark.className = 'tag-picker-check';
        const name = document.createElement('span');
        name.className = 'tag-picker-name';
        name.textContent = tag;
        toggle.append(mark, name);
        toggle.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (selectedTags.includes(tag)) selectedTags = selectedTags.filter(t => t !== tag);
          else selectedTags.push(tag);
          syncInput();
          queueMicrotask(renderList);
        });
        row.appendChild(toggle);

        if (on) {
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'tag-picker-remove';
          remove.title = 'Rimuovi etichetta';
          remove.setAttribute('aria-label', 'Rimuovi etichetta');
          remove.textContent = '×';
          remove.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            selectedTags = selectedTags.filter(t => t !== tag);
            syncInput();
            queueMicrotask(renderList);
          });
          row.appendChild(remove);
        }
        listEl.appendChild(row);
      });
    };
    renderList();

    const keepOpen = (e) => e.stopPropagation();
    popup.addEventListener('mousedown', keepOpen);
    popup.addEventListener('click', keepOpen);

    const newInp = popup.querySelector('#tag-picker-new');
    const addNew = () => {
      const t = newInp.value.trim();
      if (!t) return;
      if (!known.includes(t)) known.push(t);
      if (!selectedTags.includes(t)) selectedTags.push(t);
      syncInput();
      newInp.value = '';
      renderList();
      newInp.focus();
    };
    popup.querySelector('#tag-picker-add').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      addNew();
    });
    newInp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        addNew();
      }
    });

    const rect = btnEl.getBoundingClientRect();
    popup.style.position = 'fixed';
    popup.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
    popup.style.left = Math.max(8, rect.left) + 'px';
    popup.style.zIndex = '9999';
    document.body.appendChild(popup);
    this._dismissMenuOnOutside(popup);
  }

  _paintNoteColor(id, color) {
    const safeId = window.CSS && CSS.escape ? CSS.escape(id) : id;
    const card = document.querySelector(`.note-card[data-id="${safeId}"]`);
    if (!card) return;
    const next = color || 'default';
    [...card.classList].forEach(cls => {
      if (cls.startsWith('note-color-')) card.classList.remove(cls);
    });
    card.classList.add(`note-color-${next}`);
    card.dataset.color = next;
  }

  _showColorPicker(meta, cardEl, btnEl) {
    this._closeContextMenus();
    const anchor = btnEl || cardEl;
    if (!anchor) return;
    this._activeMenuTrigger = anchor;
    if (cardEl) cardEl.classList.add('menu-open');
    const picker = document.createElement('div');
    picker.className = 'color-picker-popup context-menu';

    NOTE_COLORS.forEach(color => {
      const swatch = document.createElement('button');
      let cls = 'color-swatch note-color-' + color.id;
      if ((cardEl?.dataset.color || meta.color) === color.id) cls += ' active';
      swatch.className = cls;
      swatch.style.backgroundColor = color.light;
      swatch.title = color.label;
      swatch.addEventListener('click', (e) => {
        e.stopPropagation();
        this._closeContextMenus();
        meta.color = color.id;
        this._paintNoteColor(meta.id, color.id);
        this.vault.setColor(meta.id, color.id)
          .then(() => this.sync.sync().catch(() => {}))
          .catch((err) => this._toast(err.message || 'Errore colore', 'error'));
      });
      picker.appendChild(swatch);
    });

    this._placeAnchoredPopup(picker, anchor.getBoundingClientRect(), { align: 'left', gap: 8 });

    setTimeout(() => {
      document.addEventListener('click', (e) => { if (!picker.contains(e.target)) this._closeContextMenus(); }, { once: true });
    }, 10);
  }

  _bulkColor() {
    const btnEl = document.getElementById('bulk-color');
    if (this._activeMenuTrigger === btnEl) { this._closeContextMenus(); return; }
    this._closeContextMenus();
    this._activeMenuTrigger = btnEl;
    const picker = document.createElement('div');
    picker.className = 'color-picker-popup context-menu';
    picker.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;padding:12px;';

    NOTE_COLORS.forEach(color => {
      const swatch = document.createElement('button');
      swatch.className = 'color-swatch note-color-' + color.id;
      swatch.style.backgroundColor = color.light;
      swatch.title = color.label;
      swatch.addEventListener('click', async (e) => {
        e.stopPropagation();
        this._closeContextMenus();
        const ids = [...this._selectedIds];
        ids.forEach(id => this._paintNoteColor(id, color.id));
        this._exitMultiSelect();
        Promise.all(ids.map(id => this.vault.setColor(id, color.id)))
          .then(() => this.sync.sync().catch(() => {}))
          .catch((err) => this._toast(err.message || 'Errore colore', 'error'));
      });
      picker.appendChild(swatch);
    });

    const rect = btnEl.getBoundingClientRect();
    picker.style.position = 'fixed';
    picker.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
    picker.style.left = rect.left + 'px';
    document.body.appendChild(picker);

    setTimeout(() => {
      document.addEventListener('click', (e) => { if (!picker.contains(e.target)) this._closeContextMenus(); }, { once: true });
    }, 10);
  }

  _showPasswordEditor(data = {}) {
    this._commitEditorHistory = null;
    const isNew = !data.id;
    this._currentNoteId = data.id || null;
    document.getElementById('pwd-title').value = data.title || '';
    document.getElementById('pwd-username').value = data.username || '';
    this._fillPlacePicker('pwd', data.placeIds);
    const pwdInput = document.getElementById('pwd-password');
    pwdInput.value = data.password || '';
    pwdInput.type = 'password';
    pwdInput.oninput = () => {
      this._updatePwdStrength(pwdInput.value);
      this._checkPasswordSignals(pwdInput.value);
      this._refreshRenewDue(data);
    };
    this._updatePwdStrength(pwdInput.value);
    const renewSelect = document.getElementById('pwd-renew');
    if (renewSelect) {
      renewSelect.value = String(Number(data.renewMonths) || 0);
      renewSelect.onchange = () => {
        this._refreshRenewDue(data);
        this._commitEditorHistory?.();
      };
    }
    this._checkPasswordSignals(pwdInput.value);
    this._refreshRenewDue(data);

    const visBtn = document.getElementById('btn-toggle-pwd-vis');
    const setPwdVisible = (show) => {
      pwdInput.type = show ? 'text' : 'password';
      visBtn.innerHTML = `<i data-lucide="${show ? 'eye-off' : 'eye'}"></i>`;
      if (window.skRefreshIcons) window.skRefreshIcons(visBtn);
    };
    setPwdVisible(false);
    visBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      setPwdVisible(pwdInput.type === 'password');
    };

    document.getElementById('btn-copy-pwd').onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!pwdInput.value) return this._toast('Nessuna password da copiare', 'error');
      this._copyToClipboard(pwdInput.value, 'Password copiata!');
    };

    document.getElementById('btn-generate-pwd').onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._showPasswordGenerator((pwd) => {
        pwdInput.value = pwd;
        setPwdVisible(true);
        this._updatePwdStrength(pwd);
        this._commitEditorHistory?.();
      });
    };

    document.getElementById('pwd-url').value = data.url || '';
    document.getElementById('pwd-notes').value = data.notes || '';
    document.getElementById('pwd-draft-color').value = data.color || 'default';
    document.getElementById('pwd-draft-tags').value = (data.tags || []).join(',');
    document.getElementById('pwd-draft-pinned').value = data.pinned ? 'true' : 'false';

    this._updateDraftPinVisual(document.querySelector('#modal-password .draft-pin-btn'), data.pinned);
    this._updateDraftTagsVisual(document.getElementById('modal-password'), data.tags);

    const box = document.querySelector('#modal-password .modal-box');
    box.className = 'modal-box note-color-' + (data.color || 'default');

    const history = data.passwordHistory || data.history || [];
    const historyBtn = document.getElementById('btn-pwd-history');
    if (isNew || !history.length) {
      historyBtn.style.display = 'none';
    } else {
      historyBtn.style.display = 'flex';
      const historyLabel = document.getElementById('pwd-history-label');
      if (historyLabel) historyLabel.textContent = `Storico (${history.length})`;
      historyBtn.onclick = () => this._showPasswordHistory(history, (entry) => this._restorePasswordRevision(entry, {
        modal,
        pwdInput,
        iconPicker,
        customIconGroup,
        customIconImg,
        customIconInput,
        iconPickerWrap,
      }));
    }

    const modal = document.getElementById('modal-password');
    modal.classList.remove('hidden');

    // Populate icon picker
    const iconPicker = document.getElementById('icon-picker');
    if (iconPicker) {
      iconPicker.innerHTML = '';
      PWD_ICONS.forEach(iconObj => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'icon-option' + ((data.icon === iconObj.name || (!data.icon && iconObj.name === 'key')) ? ' active' : '');
        btn.dataset.icon = iconObj.name;
        btn.innerHTML = `<i data-lucide="${iconObj.name}" style="color:${iconObj.color}; width:20px; height:20px;"></i>`;
        btn.onclick = () => {
          iconPicker.querySelectorAll('.icon-option').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          this._commitEditorHistory?.();
        };
        iconPicker.appendChild(btn);
      });
      if (window.skRefreshIcons) window.skRefreshIcons();
    }

    const customIconGroup = document.getElementById('custom-icon-preview-wrap');
    const customIconImg = document.getElementById('custom-icon-preview');
    const customIconInput = document.getElementById('pwd-custom-icon');
    
    const iconPickerWrap = modal.querySelector('.icon-picker-wrap');
    const applyCustomIcon = (base64) => {
      customIconGroup.style.display = 'flex';
      customIconImg.src = base64;
      customIconImg.dataset.base64 = base64;
      if (customIconInput) customIconInput.value = base64;
      if (iconPickerWrap) iconPickerWrap.style.display = 'none';
      this._commitEditorHistory?.();
    };
    
    const removeBtn = document.getElementById('btn-remove-custom-icon');
    if (removeBtn) {
      removeBtn.onclick = () => {
        customIconGroup.style.display = 'none';
        customIconImg.src = '';
        customIconImg.dataset.base64 = '';
        if (customIconInput) customIconInput.value = '';
        if (iconPickerWrap) iconPickerWrap.style.display = 'block';
        this._commitEditorHistory?.();
      };
    }

    // Is it a base64 string?
    if (data.icon && data.icon.startsWith('data:image')) {
      applyCustomIcon(data.icon);
    } else {
      customIconGroup.style.display = 'none';
      customIconImg.src = '';
      customIconImg.dataset.base64 = '';
      if (customIconInput) customIconInput.value = '';
      if (iconPickerWrap) iconPickerWrap.style.display = 'block';
    }

    const fetchIconBtn = document.getElementById('btn-fetch-favicon');
    fetchIconBtn.onclick = async () => {
      let url = document.getElementById('pwd-url').value.trim();
      if (!url) return this._toast("Inserisci un URL per scaricare l'icona", 'error');
      if (!url.startsWith('http')) url = 'https://' + url;
      try {
        const domain = new URL(url).hostname;
        this._toast('Download icona...', 'info');
        
        const base64 = await new Promise((resolve, reject) => {
          const img = new Image();
          img.crossOrigin = 'Anonymous';
          img.onload = () => {
            const canvas = document.createElement('canvas');
            const width = 64;
            const height = 64;
            canvas.width = width;
            canvas.height = height;
            canvas.getContext('2d').drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL('image/png'));
          };
          img.onerror = () => reject(new Error('Non trovato'));
          // Use icon.horse API
          img.src = 'https://icon.horse/icon/' + domain;
        });

        applyCustomIcon(base64);
        this._toast('Logo scaricato!', 'success');
      } catch (err) {
        this._toast('Logo inaccessibile o non trovato', 'error');
      } finally {
        fetchIconBtn.disabled = false;
        fetchIconBtn.innerHTML = '<i data-lucide="download-cloud"></i>';
        if (window.skRefreshIcons) window.skRefreshIcons(fetchIconBtn.parentElement);
      }
    };

    // Save
    const saveAndClosePwd = async () => {
      if (modal.classList.contains('hidden')) return;
      modal.classList.add('hidden');
      await this._savePasswordNote(data);
    };
    this._onClick('btn-save-pwd', saveAndClosePwd);

    // Close (header X and footer Cancel)
    const closeModal = () => modal.classList.add('hidden');
    this._onClick('btn-close-pwd', closeModal);
    this._onClick('btn-close-pwd-footer', closeModal);
    const mb = modal.querySelector('.modal-backdrop');
    if (mb) mb.onclick = (e) => this._onModalBackdrop(e, saveAndClosePwd);
    this._bindEditorHistory(modal, () => ({
      title: document.getElementById('pwd-title').value,
      username: document.getElementById('pwd-username').value,
      password: document.getElementById('pwd-password').value,
      url: document.getElementById('pwd-url').value,
      notes: document.getElementById('pwd-notes').value,
      color: document.getElementById('pwd-draft-color').value,
      tags: document.getElementById('pwd-draft-tags').value,
      pinned: document.getElementById('pwd-draft-pinned').value,
      customIcon: document.getElementById('pwd-custom-icon').value || '',
      icon: document.querySelector('#icon-picker .icon-option.active')?.dataset.icon || 'key',
      renew: document.getElementById('pwd-renew')?.value || '0',
    }), (snap) => {
      document.getElementById('pwd-title').value = snap.title;
      document.getElementById('pwd-username').value = snap.username;
      document.getElementById('pwd-password').value = snap.password;
      document.getElementById('pwd-url').value = snap.url;
      document.getElementById('pwd-notes').value = snap.notes;
      document.getElementById('pwd-draft-color').value = snap.color;
      document.getElementById('pwd-draft-tags').value = snap.tags;
      document.getElementById('pwd-draft-pinned').value = snap.pinned;
      this._paintModalColor(modal, snap.color);
      this._updateDraftPinVisual(modal.querySelector('.draft-pin-btn'), snap.pinned === 'true');
      this._updateDraftTagsVisual(modal, snap.tags);
      this._updatePwdStrength(snap.password);
      const renewEl = document.getElementById('pwd-renew');
      if (renewEl && snap.renew != null) renewEl.value = snap.renew;
      this._checkPasswordSignals(snap.password);
      this._refreshRenewDue(data);
      if (snap.customIcon) applyCustomIcon(snap.customIcon);
      else if (removeBtn) removeBtn.onclick?.();
      iconPicker?.querySelectorAll('.icon-option').forEach(b => {
        b.classList.toggle('active', b.dataset.icon === snap.icon);
      });
    });
  }

  async _savePasswordNote(existingData) {
    const title    = document.getElementById('pwd-title').value.trim();
    const username = document.getElementById('pwd-username').value;
    const password = document.getElementById('pwd-password').value;
    const url      = document.getElementById('pwd-url').value;
    const notes    = document.getElementById('pwd-notes').value;

    const customIcon = document.getElementById('pwd-custom-icon').value;
    const activeIconBtn = document.querySelector('#icon-picker .icon-option.active');
    const selectedIcon  = activeIconBtn ? activeIconBtn.dataset.icon : null;
    const finalIcon = customIcon ? customIcon : selectedIcon;

    
    const draftTags = document.getElementById('pwd-draft-tags').value.split(',').map(t=>t.trim()).filter(Boolean);
    const draftColor = document.getElementById('pwd-draft-color').value || 'default';
    const draftPinned = document.getElementById('pwd-draft-pinned').value === 'true';
    
    const determinedIcon = finalIcon !== null ? finalIcon : (existingData.icon || null);

    if (!this._currentNoteId) {
      if (!title && !username && !password && !url && !notes) return;
    } else {
      const extTags = existingData.tags || [];
      const isTagsSame = draftTags.length === extTags.length && draftTags.every((v, i) => v === extTags[i]);
      if (
        title === (existingData.title || '') &&
        username === (existingData.username || '') &&
        password === (existingData.password || '') &&
        url === (existingData.url || '') &&
        notes === (existingData.notes || '') &&
        determinedIcon === (existingData.icon || null) &&
        draftColor === (existingData.color || 'default') &&
        draftPinned === (existingData.pinned || false) &&
        Number(document.getElementById('pwd-renew')?.value || 0) === (Number(existingData.renewMonths) || 0) &&
        isTagsSame &&
        this._samePlaceIds(this._draftPlaceIds('pwd'), existingData.placeIds)
      ) {
        return;
      }
    }

    let passwordHistory = [...(existingData.passwordHistory || existingData.history || [])];
    if (this._currentNoteId) {
      const prev = this._passwordRevision(existingData);
      const hadContent = [prev.title, prev.username, prev.password, prev.url, prev.notes].some(v => String(v || '').trim()) || prev.tags.length;
      const latest = passwordHistory[0];
      const sameAsLatest = latest && JSON.stringify(this._passwordRevision(latest)) === JSON.stringify(prev);
      if (hadContent && !sameAsLatest) {
        passwordHistory.unshift({ ...prev, timestamp: new Date().toISOString() });
        passwordHistory = passwordHistory.slice(0, 30);
      }
    }
    const renewMonths = Number(document.getElementById('pwd-renew')?.value || 0) || 0;
    let passwordSetAt = existingData.passwordSetAt || null;
    if (password !== (existingData.password || '') || (renewMonths && !passwordSetAt)) {
      passwordSetAt = password ? new Date().toISOString() : null;
    }
      const data = {
      type:     'password',
      title,
      username,
      password,
      url,
      notes,
      icon:            determinedIcon,
      passwordHistory,
      renewMonths,
      passwordSetAt,
      tags:            draftTags,
      placeIds:        this._draftPlaceIds('pwd'),
      color: draftColor,
      pinned:          draftPinned,
    };

    if (this._currentNoteId) {
      await this.vault.updateNote(this._currentNoteId, data);
    } else {
      this._currentNoteId = await this.vault.createNote('password', data);
    }

    this._renderNoteGrid();
    this._toast('Salvato');
    this.sync.sync().catch(() => {});
  }

  _updatePwdStrength(pwd) {
    const s  = PasswordGenerator.evaluateStrength(pwd);
    const el = document.getElementById('pwd-strength-label');
    const bar = document.getElementById('pwd-strength-bar');
    if (el)  { el.textContent = s.label; el.style.color = s.color; }
    if (bar) { bar.style.width = `${(s.score / 4) * 100}%`; bar.style.backgroundColor = s.color; }
  }

  _checkPasswordSignals(password) {
    clearTimeout(this._pwdCheckTimer);
    const run = () => {
      const seq = (this._pwdCheckSeq = (this._pwdCheckSeq || 0) + 1);
      this._showPasswordReuse(password, seq);
      this._showPasswordBreach(password, seq);
    };
    if (!password) { run(); return; }
    this._pwdCheckTimer = setTimeout(run, 400);
  }

  async _showPasswordReuse(password, seq) {
    const el = document.getElementById('pwd-reuse-warning');
    if (!el) return;
    if (!password) {
      el.textContent = '';
      el.classList.add('hidden');
      return;
    }
    let titles = [];
    try { titles = await this.vault.findPasswordReuse(password, this._currentNoteId); } catch { titles = []; }
    if (seq !== this._pwdCheckSeq) return;
    if (!titles.length) {
      el.textContent = '';
      el.classList.add('hidden');
      return;
    }
    const shown = titles.slice(0, 2).map(t => `«${t}»`).join(' e ');
    const extra = titles.length > 2 ? ` e altre ${titles.length - 2}` : '';
    el.textContent = `Già usata in ${shown}${extra}.`;
    el.classList.remove('hidden');
  }

  async _showPasswordBreach(password, seq) {
    const el = document.getElementById('pwd-breach-warning');
    if (!el) return;
    if (!password) {
      el.textContent = '';
      el.classList.add('hidden');
      return;
    }
    let count = null;
    try { count = await this._pwnedCount(password); } catch { count = null; }
    if (seq !== this._pwdCheckSeq) return;
    if (!count) {
      el.textContent = '';
      el.classList.add('hidden');
      return;
    }
    const formatted = Number(count).toLocaleString('it-IT');
    el.textContent = `Trovata in ${formatted} fughe di dati. Scegline un’altra.`;
    el.classList.remove('hidden');
  }

  async _pwnedCount(password) {
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(password));
    const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    const res = await fetch(`https://api.pwnedpasswords.com/range/${hex.slice(0, 5)}`, {
      headers: { 'Add-Padding': 'true' },
    });
    if (!res.ok) return null;
    const suffix = hex.slice(5);
    for (const line of (await res.text()).split('\n')) {
      const [suf, count] = line.trim().split(':');
      if (suf === suffix) return Number(count) || 0;
    }
    return 0;
  }

  _passwordRenewDue(meta) {
    const months = Number(meta?.renewMonths) || 0;
    if (!months || !meta?.passwordSetAt) return false;
    const start = new Date(meta.passwordSetAt);
    if (Number.isNaN(start.getTime())) return false;
    const due = new Date(start);
    due.setMonth(due.getMonth() + months);
    return Date.now() >= due.getTime();
  }

  _refreshRenewDue(data) {
    const el = document.getElementById('pwd-renew-due');
    if (!el) return;
    const months = Number(document.getElementById('pwd-renew')?.value || 0) || 0;
    const current = document.getElementById('pwd-password')?.value || '';
    const unchanged = current === (data?.password || '');
    const due = unchanged && this._passwordRenewDue({ renewMonths: months, passwordSetAt: data?.passwordSetAt });
    el.classList.toggle('hidden', !due);
  }

  async _remindPasswordRenewals() {
    if (this._renewToastShown || !this.vault.isUnlocked()) return;
    try {
      const index = await this.vault.getIndex();
      const due = Object.values(index.notes || {}).filter(n =>
        n?.type === 'password' && !n.trashed && !n.archived && this._passwordRenewDue(n)
      );
      if (!due.length) return;
      this._renewToastShown = true;
      this._toast(due.length === 1 ? '1 password da rinnovare' : `${due.length} password da rinnovare`);
    } catch { /* vault still locked */ }
  }

  // ─── Password generator modal ─────────────────────────────────────────────────

  _showPasswordGenerator(onApply) {
    const modal = document.getElementById('modal-generator');
    modal.classList.remove('hidden');

    const generate = () => {
      const pwd = PasswordGenerator.generate(this._pwGenOptions);
      document.getElementById('gen-preview').value = pwd;
      return pwd;
    };

    // Bind controls
    const lenInput = document.getElementById('gen-length');
    lenInput.value = this._pwGenOptions.length;
    document.getElementById('gen-length-display').textContent = this._pwGenOptions.length;

    lenInput.oninput = () => {
      this._pwGenOptions.length = parseInt(lenInput.value);
      document.getElementById('gen-length-display').textContent = this._pwGenOptions.length;
      generate();
    };

    ['upper','lower','digits','symbols','noAmbiguous'].forEach(key => {
      const cb = document.getElementById(`gen-${key}`);
      if (cb) {
        cb.checked = this._pwGenOptions[key];
        cb.onchange = () => { this._pwGenOptions[key] = cb.checked; generate(); };
      }
    });

    this._onClick('btn-gen-refresh', () => generate());

    this._onClick('btn-gen-apply', () => {
      onApply(document.getElementById('gen-preview').value);
      modal.classList.add('hidden');
    });

    this._onClick('btn-gen-close', () => {
      modal.classList.add('hidden');
    });
    this._onClick('btn-gen-close-footer', () => {
      modal.classList.add('hidden');
    });

    generate();
  }

  // ─── Note (text) editor ───────────────────────────────────────────────────────

  _showNoteEditor(data) {
    this._commitEditorHistory = null;
    this._currentNoteId = data.id || null;
    this._fillPlacePicker('note', data.placeIds);
    const modal = document.getElementById('modal-note');
    const modalBox = modal.querySelector('.modal-box');
    modalBox.className = 'modal-box';
    if (data.color && data.color !== 'default') modalBox.classList.add('note-color-' + data.color);
    modal.classList.remove('hidden');
    if (window.skRefreshIcons) window.skRefreshIcons(modal);

    document.getElementById('note-title').value   = data.title || '';
    setTimeout(() => document.getElementById('note-title').focus(), 100);
    document.getElementById('note-content').value = data.content || '';

    // Update detected links initially and on input
    const updateLinks = () => this._updateDetectedLinks(document.getElementById('note-content').value, 'note-detected-links');
    updateLinks();
    document.getElementById('note-content').oninput = updateLinks;


    // Populate draft fields
    document.getElementById('note-draft-tags').value = (data.tags || []).join(', ');
    document.getElementById('note-draft-color').value = data.color || 'default';
    document.getElementById('note-draft-pinned').value = data.pinned ? 'true' : 'false';
    this._updateDraftPinVisual(document.getElementById('note-draft-pin-btn'), !!data.pinned);
    this._updateDraftTagsVisual(modal, data.tags);

    const textContentEl = document.getElementById('note-content');
    textContentEl.oncontextmenu = (e) => {
      const selected = textContentEl.value.substring(textContentEl.selectionStart, textContentEl.selectionEnd).trim();
      if (!selected) return;
      e.preventDefault();
      this._showTextSelectionMenu(e, selected);
    };

    // Image paste & drag-drop
    const content = document.getElementById('note-content');
    content.onpaste = e => this._handleImagePaste(e, data);
    const dropZone = document.getElementById('note-drop-zone');
    if(dropZone) dropZone.ondragover = e => { e.preventDefault(); dropZone.classList.add('drag-over'); };
    if(dropZone) dropZone.ondragleave = () => dropZone.classList.remove('drag-over');
    if(dropZone) dropZone.ondrop = e => { e.preventDefault(); dropZone.classList.remove('drag-over'); this._handleImageDrop(e, data); };

    if (!Array.isArray(data.images)) data.images = [];
    this._noteImagesOriginal = data.images.slice();
    this._noteImages = data.images;

    // Render existing images
    this._renderNoteImages(data.images || []);

    const saveAndCloseNote = async () => {
      if (modal.classList.contains('hidden')) return;
      modal.classList.add('hidden');
      await this._saveNote(data);
    };
    this._onClick('btn-save-note', saveAndCloseNote);

    const closeNote = () => modal.classList.add('hidden');
    this._onClick('btn-close-note', closeNote);
    this._onClick('btn-close-note-footer', closeNote);
    const mb = modal.querySelector('.modal-backdrop');
    if (mb) mb.onclick = (e) => this._onModalBackdrop(e, saveAndCloseNote);
    this._bindEditorHistory(modal, () => ({
      title: document.getElementById('note-title').value,
      content: document.getElementById('note-content').value,
      color: document.getElementById('note-draft-color').value,
      tags: document.getElementById('note-draft-tags').value,
      pinned: document.getElementById('note-draft-pinned').value,
      images: (this._noteImages || []).slice(),
    }), (snap) => {
      document.getElementById('note-title').value = snap.title;
      document.getElementById('note-content').value = snap.content;
      document.getElementById('note-draft-color').value = snap.color;
      document.getElementById('note-draft-tags').value = snap.tags;
      document.getElementById('note-draft-pinned').value = snap.pinned;
      this._noteImages.splice(0, this._noteImages.length, ...snap.images);
      this._renderNoteImages(this._noteImages);
      this._paintModalColor(modal, snap.color);
      this._updateDraftPinVisual(modal.querySelector('.draft-pin-btn'), snap.pinned === 'true');
      this._updateDraftTagsVisual(modal, snap.tags);
      this._updateDetectedLinks(snap.content, 'note-detected-links');
    });
  }

  async _saveNote(existingData) {
    const title   = document.getElementById('note-title').value.trim();
    const content = document.getElementById('note-content').value;
    const draftTags = document.getElementById('note-draft-tags').value.split(',').map(t=>t.trim()).filter(Boolean);
    const draftColor = document.getElementById('note-draft-color').value || 'default';
    const draftPinned = document.getElementById('note-draft-pinned').value === 'true';

    const images = this._noteImages || existingData.images || [];

    if (!this._currentNoteId) {
      if (!title && !content && images.length === 0) return;
    } else {
      const extTags = existingData.tags || [];
      const isTagsSame = draftTags.length === extTags.length && draftTags.every((v, i) => v === extTags[i]);
      if (
        title === (existingData.title || '') &&
        content === (existingData.content || '') &&
        draftColor === (existingData.color || 'default') &&
        draftPinned === (existingData.pinned || false) &&
        isTagsSame &&
        this._samePlaceIds(this._draftPlaceIds('note'), existingData.placeIds) &&
        JSON.stringify(images) === JSON.stringify(this._noteImagesOriginal || [])
      ) {
        return;
      }
    }

    const thumbnails = await this._buildImageThumbs(images);

      const data = {
      type:    'note',
      title,
      content,
      images,
      thumbnail: thumbnails[0] || null,
      thumbnails,
      imageCount: images.length,
      tags:     draftTags,
      placeIds: this._draftPlaceIds('note'),
      color: draftColor,
      pinned:   draftPinned,
    };

    if (this._currentNoteId) {
      await this.vault.updateNote(this._currentNoteId, data);
    } else {
      this._currentNoteId = await this.vault.createNote('note', data);
    }
    this._renderNoteGrid();
    this._toast('Salvato');
    this.sync.sync().catch(() => {});
  }

  _collectImageFiles(dataTransfer) {
    if (!dataTransfer) return [];
    const files = [];
    const seen = new Set();
    const push = (file) => {
      if (!file) return;
      const type = file.type || '';
      const looksImage = type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|avif|heic|heif)$/i.test(file.name || '');
      if (!looksImage) return;
      const key = [file.name, file.size, file.type, file.lastModified].join('|');
      if (seen.has(key)) return;
      seen.add(key);
      files.push(file);
    };
    const fromList = Array.from(dataTransfer.files || []).filter(f => (f.type || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|avif|heic|heif)$/i.test(f.name || ''));
    if (fromList.length) {
      fromList.forEach(push);
      return files;
    }
    for (const item of Array.from(dataTransfer.items || [])) {
      if (item.kind === 'file') push(item.getAsFile());
    }
    return files;
  }

  async _addImageFiles(files, data) {
    let added = 0;
    for (const file of files) {
      try {
        const compressed = await this._compressImage(file);
        if (!Array.isArray(this._noteImages)) {
          this._noteImages = Array.isArray(data.images) ? data.images : [];
        }
        data.images = this._noteImages;
        this._noteImages.push(compressed);
        added++;
      } catch (err) {
        this._toast(`Errore immagine: ${err.message}`, 'error');
      }
    }
    if (!added) return;
    this._renderNoteImages(this._noteImages);
    this._commitEditorHistory?.();
  }

  async _handleImagePaste(e, data) {
    const files = this._collectImageFiles(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    await this._addImageFiles(files, data);
  }

  async _handleImageDrop(e, data) {
    const files = this._collectImageFiles(e.dataTransfer);
    if (!files.length) return;
    await this._addImageFiles(files, data);
  }


  async _buildImageThumbs(images) {
    const thumbs = [];
    for (const src of (images || []).slice(0, 3)) {
      const thumb = await this._createThumbnail(src);
      if (thumb) thumbs.push(thumb);
    }
    return thumbs;
  }

  _cardThumbsHtml(meta) {
    const stored = Array.isArray(meta.thumbnails) && meta.thumbnails.length
      ? meta.thumbnails
      : (meta.thumbnail ? [meta.thumbnail] : []);
    const thumbs = stored.slice(0, 3).filter(Boolean);
    if (!thumbs.length) return '';
    const count = meta.imageCount || thumbs.length;
    const fullExtra = count - 1;
    const compactExtra = count - thumbs.length;
    const more = (n, kind) => n > 0
      ? `<div class="card-thumb-more card-thumb-more-${kind}">+${n}</div>`
      : '';
    return `<div class="card-thumbnail-wrapper">
      <div class="card-thumbs">${thumbs.map((src, i) => `<img class="card-thumb${i ? ' card-thumb-extra' : ''}" src="${this._escHtml(src)}" alt="">`).join('')}</div>
      ${more(fullExtra, 'full')}${more(compactExtra, 'compact')}
    </div>`;
  }

  _createThumbnail(base64Str) {
    return new Promise((resolve) => {
      if (!base64Str) return resolve(null);
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        const max = 300;
        if (width > max || height > max) {
          const ratio = Math.min(max / width, max / height);
          width  = Math.round(width  * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width  = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.5));
      };
      img.onerror = () => resolve(null);
      img.src = base64Str;
    });
  }

  _compressImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        let { width, height } = img;
        const max = IMG_MAX_DIMENSION;
        if (width > max || height > max) {
          const ratio = Math.min(max / width, max / height);
          width  = Math.round(width  * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width  = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', IMG_JPEG_QUALITY));
      };
      img.onerror = reject;
      img.src = url;
    });
  }


  _openLightbox(images, startIndex) {
    if (!images || images.length === 0) return;
    let currentIndex = startIndex;

    const overlay = document.createElement('div');
    overlay.className = 'lightbox-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.9);z-index:10000;display:flex;align-items:center;justify-content:center;flex-direction:column;';

    const img = document.createElement('img');
    img.style.cssText = 'max-width:90vw;max-height:85vh;object-fit:contain;';
    img.src = images[currentIndex];

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn-icon';
    closeBtn.innerHTML = '<i data-lucide="x"></i>';
    closeBtn.style.cssText = 'position:absolute;top:16px;right:16px;color:#fff;background:rgba(255,255,255,0.2);padding:8px;border-radius:50%;';
    closeBtn.onclick = () => overlay.remove();

    const prevBtn = document.createElement('button');
    prevBtn.className = 'btn-icon';
    prevBtn.innerHTML = '<i data-lucide="chevron-left"></i>';
    prevBtn.style.cssText = 'position:absolute;left:16px;top:50%;transform:translateY(-50%);color:#fff;background:rgba(255,255,255,0.2);padding:12px;border-radius:50%;';

    const nextBtn = document.createElement('button');
    nextBtn.className = 'btn-icon';
    nextBtn.innerHTML = '<i data-lucide="chevron-right"></i>';
    nextBtn.style.cssText = 'position:absolute;right:16px;top:50%;transform:translateY(-50%);color:#fff;background:rgba(255,255,255,0.2);padding:12px;border-radius:50%;';

    const counter = document.createElement('div');
    counter.style.cssText = 'position:absolute;bottom:16px;color:#fff;font-size:14px;background:rgba(0,0,0,0.5);padding:4px 12px;border-radius:12px;';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = 'Salva immagine';
    saveBtn.title = 'Scarica l’immagine sul dispositivo';
    saveBtn.style.cssText = 'position:absolute;bottom:56px;color:#fff;font-size:14px;font-weight:600;background:rgba(255,255,255,0.16);border:1px solid rgba(255,255,255,0.4);padding:8px 16px;border-radius:999px;cursor:pointer;';
    saveBtn.onclick = (e) => {
      e.stopPropagation();
      this._downloadNoteImage(images[currentIndex], currentIndex);
    };

    const updateView = () => {
      img.src = images[currentIndex];
      counter.textContent = String(currentIndex + 1) + ' / ' + String(images.length);
      prevBtn.style.display = images.length > 1 ? 'block' : 'none';
      nextBtn.style.display = images.length > 1 ? 'block' : 'none';
    };

    prevBtn.onclick = (e) => { e.stopPropagation(); currentIndex = (currentIndex - 1 + images.length) % images.length; updateView(); };
    nextBtn.onclick = (e) => { e.stopPropagation(); currentIndex = (currentIndex + 1) % images.length; updateView(); };

    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    document.addEventListener('keydown', function onKey(e) {
      if (!document.body.contains(overlay)) {
        document.removeEventListener('keydown', onKey);
        return;
      }
      if (e.key === 'Escape') overlay.remove();
      if (e.key === 'ArrowLeft') prevBtn.click();
      if (e.key === 'ArrowRight') nextBtn.click();
    });

    overlay.append(img, closeBtn, prevBtn, nextBtn, saveBtn, counter);
    document.body.appendChild(overlay);
    if (window.skRefreshIcons) window.skRefreshIcons(overlay);
    updateView();
  }

  _downloadNoteImage(src, index) {
    if (!src) return;
    const match = String(src).match(/^data:image\/([a-zA-Z0-9.+-]+)/);
    const kind = (match?.[1] || 'jpeg').toLowerCase();
    const ext = kind === 'jpeg' ? 'jpg' : kind;
    const a = document.createElement('a');
    a.href = src;
    a.download = `immagine-${index + 1}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  _renderNoteImages(images) {
    const container = document.getElementById('note-images');
    if (!container) return;
    container.innerHTML = '';
    container.style.display = 'flex';
    container.style.flexWrap = 'wrap';
    container.style.gap = '12px';
    container.style.marginTop = '16px';
    container.style.marginBottom = '16px';

    images.forEach((src, i) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'note-image-wrapper';
      wrapper.style.display = 'flex';
      wrapper.style.flexDirection = 'column';
      wrapper.style.border = '1px solid var(--border)';
      wrapper.style.borderRadius = 'var(--radius-card)';
      wrapper.style.overflow = 'hidden';
      wrapper.style.background = 'var(--bg-hover)';

      const img = document.createElement('img');
      img.src = src;
      img.className = 'note-image';
      img.style.cursor = 'pointer';
      img.title = 'Clicca per ingrandire';
      img.addEventListener('click', () => this._openLightbox(images, i));

      const actions = document.createElement('div');
      actions.style.display = 'flex';
      actions.style.justifyContent = 'flex-end';
      actions.style.alignItems = 'center';
      actions.style.padding = '4px 8px';

      const del = document.createElement('button');
      del.className = 'btn-icon';
      del.innerHTML = '<i data-lucide="trash-2"></i>';
      del.style.width = '28px';
      del.style.height = '28px';
      del.style.color = 'var(--danger)';
      del.title = 'Rimuovi immagine';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        images.splice(i, 1);
        this._renderNoteImages(images);
        this._commitEditorHistory?.();
      });

      actions.append(del);
      wrapper.append(img, actions);
      container.appendChild(wrapper);
    });
    if (window.skRefreshIcons) window.skRefreshIcons(container);
  }

  // ─── Checklist editor ─────────────────────────────────────────────────────────

  _showChecklistEditor(data) {
    this._commitEditorHistory = null;
    this._currentNoteId = data.id || null;
    this._fillPlacePicker('cl', data.placeIds);
    const modal = document.getElementById('modal-checklist');
    const modalBox = modal.querySelector('.modal-box');
    modalBox.className = 'modal-box';
    if (data.color && data.color !== 'default') modalBox.classList.add('note-color-' + data.color);
    modal.classList.remove('hidden');
    if (window.skRefreshIcons) window.skRefreshIcons(modal);

    const isNew = !data.id;
    this._currentNoteId = data.id || null;

    document.getElementById('cl-title').value = data.title || '';

    document.getElementById('cl-draft-tags').value = (data.tags || []).join(', ');
    document.getElementById('cl-draft-color').value = data.color || 'default';
    document.getElementById('cl-draft-pinned').value = data.pinned ? 'true' : 'false';
    this._updateDraftPinVisual(document.getElementById('cl-draft-pin-btn'), !!data.pinned);
    this._updateDraftTagsVisual(modal, data.tags);

    const items = Array.isArray(data.items)
      ? data.items.map(i => ({ text: i.text || '', checked: !!i.checked }))
      : [];
    if (isNew && items.length === 0) items.push({ text: '', checked: false });
    this._renderChecklistItems(items);
    setTimeout(() => {
      const focusEl = isNew
        ? document.querySelector('#cl-items-list .cl-text')
        : document.getElementById('cl-title');
      focusEl?.focus();
    }, 100);

    this._onClick('btn-add-cl-item', () => {
      items.push({ text: '', checked: false });
      this._renderChecklistItems(items);
      this._commitEditorHistory?.();
    });

    const saveAndCloseCl = async () => {
      if (modal.classList.contains('hidden')) return;
      modal.classList.add('hidden');
      await this._saveChecklist(data, items);
    };
    this._onClick('btn-save-cl', saveAndCloseCl);

    const closeCl = () => modal.classList.add('hidden');
    this._onClick('btn-close-cl', closeCl);
    this._onClick('btn-close-cl-footer', closeCl);
    const mb = modal.querySelector('.modal-backdrop');
    if (mb) mb.onclick = (e) => this._onModalBackdrop(e, saveAndCloseCl);
    this._bindEditorHistory(modal, () => ({
      title: document.getElementById('cl-title').value,
      color: document.getElementById('cl-draft-color').value,
      tags: document.getElementById('cl-draft-tags').value,
      pinned: document.getElementById('cl-draft-pinned').value,
      items: items.map(i => ({ text: i.text || '', checked: !!i.checked })),
    }), (snap) => {
      document.getElementById('cl-title').value = snap.title;
      document.getElementById('cl-draft-color').value = snap.color;
      document.getElementById('cl-draft-tags').value = snap.tags;
      document.getElementById('cl-draft-pinned').value = snap.pinned;
      items.splice(0, items.length, ...snap.items.map(i => ({ text: i.text || '', checked: !!i.checked })));
      this._renderChecklistItems(items);
      this._paintModalColor(modal, snap.color);
      this._updateDraftPinVisual(modal.querySelector('.draft-pin-btn'), snap.pinned === 'true');
      this._updateDraftTagsVisual(modal, snap.tags);
    });
  }

  _renderChecklistItems(items) {
    const list = document.getElementById('cl-items-list');
    if (!list) return;
    list.innerHTML = '';

    items.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = `cl-item${item.checked ? ' checked' : ''}`;
      row.draggable = true;
      row.dataset.index = i;

      row.innerHTML = `
        <span class="drag-handle"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="12" r="1"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/></svg></span>
        <input type="checkbox" class="cl-check" ${item.checked ? 'checked' : ''}>
        <input type="text" class="cl-text" value="${this._escHtml(item.text)}" placeholder="Elemento della lista...">
        <button class="btn-delete-cl-item" title="Rimuovi voce"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
      `;

      row.querySelector('.cl-check').addEventListener('change', e => {
        item.checked = e.target.checked;
        row.classList.toggle('checked', item.checked);
      });
      row.querySelector('.cl-text').addEventListener('input', e => {
        item.text = e.target.value;
      });
      row.querySelector('.btn-delete-cl-item').addEventListener('click', () => {
        items.splice(i, 1);
        this._renderChecklistItems(items);
        this._commitEditorHistory?.();
      });

      // Drag & drop reordering
      row.addEventListener('dragstart', e => {
        e.dataTransfer.setData('text/plain', i);
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', e => { e.preventDefault(); row.classList.add('drag-target'); });
      row.addEventListener('dragleave', () => row.classList.remove('drag-target'));
      row.addEventListener('drop', e => {
        e.preventDefault();
        row.classList.remove('drag-target');
        const from = parseInt(e.dataTransfer.getData('text/plain'));
        const to   = i;
        if (from !== to) {
          const [moved] = items.splice(from, 1);
          items.splice(to, 0, moved);
          this._renderChecklistItems(items);
          this._commitEditorHistory?.();
        }
      });

      list.appendChild(row);
    });
  }

  async _saveChecklist(existingData, items) {
    const title = document.getElementById('cl-title').value.trim();
    const draftTags = document.getElementById('cl-draft-tags').value.split(',').map(t=>t.trim()).filter(Boolean);
    const draftColor = document.getElementById('cl-draft-color').value || 'default';
    const draftPinned = document.getElementById('cl-draft-pinned').value === 'true';

    const savedItems = items
      .map(i => ({ text: (i.text || '').trim(), checked: !!i.checked }))
      .filter(i => i.text);

    if (!this._currentNoteId) {
      if (!title && savedItems.length === 0) return;
    } else {
      const extTags = existingData.tags || [];
      const isTagsSame = draftTags.length === extTags.length && draftTags.every((v, i) => v === extTags[i]);
      const simpleItems = savedItems;
      const simpleExtItems = (existingData.items || []).map(i => ({ text: (i.text || '').trim(), checked: !!i.checked })).filter(i => i.text);
      
      if (
        title === (existingData.title || '') &&
        draftColor === (existingData.color || 'default') &&
        draftPinned === (existingData.pinned || false) &&
        isTagsSame &&
        this._samePlaceIds(this._draftPlaceIds('cl'), existingData.placeIds) &&
        JSON.stringify(simpleItems) === JSON.stringify(simpleExtItems)
      ) {
        return;
      }
    }

    const data  = {
      type: 'checklist',
      title,
      items: savedItems,
      tags:     draftTags,
      placeIds: this._draftPlaceIds('cl'),
      color: draftColor,
      pinned:   draftPinned,
    };

    if (this._currentNoteId) {
      await this.vault.updateNote(this._currentNoteId, data);
    } else {
      this._currentNoteId = await this.vault.createNote('checklist', data);
    }
    this._renderNoteGrid();
    this._toast('Salvato');
    this.sync.sync().catch(() => {});
  }

  // ─── Tag editor ───────────────────────────────────────────────────────────────

  async _showTagEditor(meta) {
    const modal = document.getElementById('modal-tags');
    modal.classList.remove('hidden');

    const input   = document.getElementById('tag-input');
    const tagList = document.getElementById('current-tags');
    const tags    = [...(meta.tags || [])];

    // Collect all existing tags across all notes
    const index = await this.vault.getIndex();
    const allTags = this._allTagNames(index);

    const render = () => {
      tagList.innerHTML = '';
      tags.forEach((t, i) => {
        const span = document.createElement('span');
        span.className = 'tag editable';
        span.innerHTML = `${this._escHtml(t)} <button data-i="${i}">×</button>`;
        span.querySelector('button').addEventListener('click', () => {
          tags.splice(i, 1);
          render();
        });
        tagList.appendChild(span);
      });

      // Suggestions: existing tags not already selected
      const suggestionsWrap = document.getElementById('tag-suggestions');
      if (suggestionsWrap) {
        suggestionsWrap.innerHTML = '';
        const suggestions = allTags.filter(t => !tags.includes(t));
        if (suggestions.length) {
          suggestions.forEach(t => {
            const chip = document.createElement('button');
            chip.className = 'tag-suggestion';
            chip.textContent = t;
            chip.addEventListener('click', () => {
              if (!tags.includes(t)) { tags.push(t); render(); }
            });
            suggestionsWrap.appendChild(chip);
          });
        }
      }
    };
    render();

    input.value = '';
    this._onClick('btn-add-tag', () => {
      const t = input.value.trim();
      if (t && !tags.includes(t)) { tags.push(t); render(); input.value = ''; }
    });

    input.onkeydown = e => {
      if (e.key === 'Enter') { e.preventDefault(); document.getElementById('btn-add-tag')?.click(); }
    };

    this._onClick('btn-save-tags', async () => {
      const note = await this.vault.getNote(meta.id);
      await this.vault.updateNote(meta.id, { ...note, tags }, false);
      modal.classList.add('hidden');
      this._renderNoteGrid();
      this._renderSidebar();
      this.sync.sync().catch(() => {});
    });

    const closeTag = () => modal.classList.add('hidden');
    this._onClick('btn-close-tags', closeTag);
    this._onClick('btn-close-tags-footer', closeTag);
    const mbTags = modal.querySelector('.modal-backdrop');
    if (mbTags) mbTags.onclick = closeTag;
  }


  _onClick(id, fn) {
    const el = document.getElementById(id);
    if (el) el.onclick = fn;
  }

  _onInput(id, fn) {
    const el = document.getElementById(id);
    if (el) el.oninput = fn;
  }

  _updateIdleTimer() {
    if (!this.vault || !this.vault.isUnlocked()) return;
    const autoLockMins = this.vault.autoLockMinutes;
    const textEl = document.getElementById('idle-timer-text');
    const barEl = document.getElementById('idle-progress-bar');
    
    if (autoLockMins <= 0) {
      if (textEl) textEl.textContent = 'Mai';
      if (barEl) barEl.style.width = '100%';
      return;
    }
    
    const elapsed = Date.now() - (this.vault.lastActivityTime || Date.now());
    const total = autoLockMins * 60 * 1000;
    const remaining = Math.max(0, total - elapsed);
    
    if (remaining === 0) {
      this.vault.lock();
      return;
    }
    
    if (textEl) {
      const mins = Math.floor(remaining / 60000);
      const secs = Math.floor((remaining % 60000) / 1000);
      textEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
    }
    if (barEl) {
      const pct = Math.max(0, Math.min(100, (remaining / total) * 100));
      barEl.style.width = `${pct}%`;
    }
  }

  _trashToastLabel(title) {
    const name = String(title || '').replace(/\s+/g, ' ').trim();
    return name ? `«${name}» spostata nel cestino` : 'Spostata nel cestino';
  }

  _toast(msg, type = 'info', action = null) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    let html = `<span style="flex:1">${this._escHtml(msg)}</span>`;
    if (action) {
      html += `<button class="btn btn-ghost btn-toast-action" style="margin-left:12px;padding:4px 8px;font-size:12px">${this._escHtml(action.label)}</button>`;
    }
    toast.innerHTML = html;
    
    if (action) {
      toast.querySelector('.btn-toast-action').onclick = () => {
        action.onClick();
        toast.remove();
      };
    }
    
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('visible'));

    const hide = () => {
      if (!toast.isConnected) return;
      toast.classList.remove('visible');
      setTimeout(() => toast.remove(), 300);
    };
    const timer = setTimeout(hide, action ? 5000 : 2800);
    if (action) {
      const btn = toast.querySelector('.btn-toast-action');
      const previous = btn.onclick;
      btn.onclick = () => {
        clearTimeout(timer);
        previous?.call(btn);
      };
    }
  }

  _escHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  _closeAllModals() {
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
    this._closeContextMenus();
  }

  _copyToClipboard(text, msg = 'Copiato negli appunti') {
    const done = () => {
      this._toast(msg, 'success');
      this._armClipboardClear(text);
    };
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(done)
        .catch(() => this._toast('Errore durante la copia', 'error'));
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        done();
      } catch (err) {
        this._toast('Errore durante la copia', 'error');
      }
      document.body.removeChild(ta);
    }
  }

  _armClipboardClear(text) {
    clearTimeout(this._clipboardTimer);
    this._clipboardSecret = text;
    this._clipboardTimer = setTimeout(() => this._clearClipboardIfUnchanged(), CLIPBOARD_CLEAR_SECONDS * 1000);
  }

  async _clearClipboardIfUnchanged() {
    const secret = this._clipboardSecret;
    this._clipboardSecret = null;
    if (!secret || !navigator.clipboard?.readText || !navigator.clipboard?.writeText) return;
    try {
      const current = await navigator.clipboard.readText();
      if (current !== secret) return;
      await navigator.clipboard.writeText('');
    } catch { /* il browser non consente di svuotare gli appunti in background */ }
  }

  _formatDate(ts) {
    if (!ts) return '';
    const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
    if (diff < 60) return 'ora';
    if (diff < 3600) return Math.floor(diff / 60) + ' min';
    if (diff < 86400) return Math.floor(diff / 3600) + ' h';
    if (diff < 604800) return Math.floor(diff / 86400) + ' g';
    const d = new Date(ts);
    return d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
  }

  async _changeMasterPassword() {
    const oldP = document.getElementById('old-password')?.value || '';
    const newP = document.getElementById('new-password')?.value || '';
    const confirmP = document.getElementById('confirm-new-password')?.value || '';
    if (newP.length < 8) return this._toast('La nuova password deve contenere almeno 8 caratteri', 'error');
    if (newP !== confirmP) return this._toast('Le password non corrispondono', 'error');
    try {
      await this.vault.changePassword(oldP, newP);
      document.getElementById('modal-change-pwd')?.classList.add('hidden');
      ['old-password', 'new-password', 'confirm-new-password'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      this._toast('Master password aggiornata');
      this.sync.sync().catch(() => {});
    } catch (err) {
      this._toast(err.message || 'Errore', 'error');
    }
  }

  async _exportVault() {
    try {
      const blob = await this.sync.exportVault();
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 10);
      a.href = URL.createObjectURL(blob);
      a.download = `securekeep-${stamp}${EXPORT_EXTENSION}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      this._markLocalExport();
      this._closeExportReminder();
      this._toast('Backup scaricato');
    } catch (err) {
      this._toast(err.message || 'Export fallito', 'error');
    }
  }

  async _importVaultFile(input) {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      await this.sync.importVault(file);
      this.vault.invalidateIndexCache();
      this._renderNoteGrid();
      document.getElementById('modal-settings')?.classList.add('hidden');
      this._toast('Backup importato');
      this.sync.sync().catch(() => {});
    } catch (err) {
      this._toast(err.message || 'Import fallito', 'error');
    }
  }

  _drivePromptEnabled() {
    try { return localStorage.getItem('sk_drive_prompt') === '1'; }
    catch { return false; }
  }

  _toggleDrivePromptSetting() {
    const btn = document.getElementById('settings-drive-prompt');
    const next = !this._drivePromptEnabled();
    try { localStorage.setItem('sk_drive_prompt', next ? '1' : '0'); } catch { /* preferenza non salvata */ }
    if (btn) btn.setAttribute('aria-checked', next ? 'true' : 'false');
    this._toast(next ? 'All’accesso verrà chiesto il collegamento a Drive' : 'Richiesta di collegamento disattivata');
  }

  _shouldPromptDrive() {
    return this._drivePromptEnabled() && !this.drive.isAuthenticated && !this._drivePromptDismissed && this.vault.isUnlocked();
  }

  _showDrivePrompt() {
    const modal = document.getElementById('modal-drive-prompt');
    if (!modal) return;
    modal.classList.remove('hidden');
    if (window.skRefreshIcons) window.skRefreshIcons(modal);
  }

  _dismissDrivePrompt() {
    this._drivePromptDismissed = true;
    document.getElementById('modal-drive-prompt')?.classList.add('hidden');
    this._maybeRemindLocalExport();
  }

  async _confirmDrivePrompt() {
    document.getElementById('modal-drive-prompt')?.classList.add('hidden');
    this._drivePromptDismissed = true;
    await this._toggleDriveConnection();
  }

  _toastSyncResult(stats) {
    const added = Number(stats.passwordsAdded) || 0;
    const aligned = Number(stats.passwordsAligned) || 0;
    const parts = ['Vault aggiornato.'];
    if (!added && !aligned) {
      parts.push('Nessuna password nuova o da allineare.');
    } else {
      if (added === 1) parts.push('1 password aggiunta.');
      else if (added) parts.push(`${added} password aggiunte.`);
      if (aligned === 1) parts.push('1 password allineata.');
      else if (aligned) parts.push(`${aligned} password allineate.`);
    }
    this._toast(parts.join(' '));
  }

  _refreshDriveFab() {
    const btn = document.getElementById('fab-drive');
    if (!btn) return;
    const on = this.drive.isAuthenticated;
    btn.dataset.connected = on ? 'on' : 'off';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    const label = on ? 'Google Drive collegato. Tocca per scollegare' : 'Collega Google Drive';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.innerHTML = `<i data-lucide="${on ? 'cloud' : 'cloud-off'}"></i><span class="fab-drive-dot" aria-hidden="true"></span>`;
    if (window.skRefreshIcons) window.skRefreshIcons(btn);
  }

  async _toggleDriveConnection(options = {}) {
    if (this.drive.isAuthenticated) {
      this.drive.signOut();
      this.sync._emit('offline');
      this._toast('Google Drive scollegato');
      this._refreshDriveFab();
      if (options.openSettings) this._showSettings();
      return;
    }
    try {
      await this.drive.startAuth();
      await this.drive.ensureVaultStructure();
      this._refreshDriveFab();
      this._toast('Google Drive collegato');
      if (this.vault.isUnlocked()) this.sync.sync().catch(() => {});
    } catch (err) {
      this._toast(err.message || 'Errore Drive', 'error');
    }
  }

  _showSettings() {
    const m = document.getElementById('modal-settings');
    if (!m) return;
    const lockSelect = document.getElementById('settings-autolock');
    if (lockSelect) {
      lockSelect.innerHTML = AUTO_LOCK_OPTIONS.map(o =>
        `<option value="${o.value}"${o.value === this.vault.autoLockMinutes ? ' selected' : ''}>${o.label}</option>`
      ).join('');
      lockSelect.onchange = () => {
        const minutes = parseInt(lockSelect.value, 10);
        this.vault.setAutoLockMinutes(minutes);
        const label = AUTO_LOCK_OPTIONS.find(o => o.value === minutes)?.label || '';
        this._toast(minutes === 0 ? 'Blocco automatico disattivato' : `Blocco automatico: ${label}`);
      };
    }
    const drivePrompt = document.getElementById('settings-drive-prompt');
    if (drivePrompt) drivePrompt.setAttribute('aria-checked', this._drivePromptEnabled() ? 'true' : 'false');
    const driveStatus = document.getElementById('settings-drive-status');
    if (driveStatus) {
      driveStatus.textContent = this.drive.isAuthenticated
        ? 'Collegato in questa sessione.'
        : 'Non collegato. Le note restano su questo dispositivo.';
    }
    const driveLabel = document.querySelector('#btn-settings-drive .settings-label');
    if (driveLabel) driveLabel.textContent = this.drive.isAuthenticated ? 'Scollega Google Drive' : 'Collega Google Drive';
    this._refreshBiometricSettings();
    m.classList.remove('hidden');
    if (window.skRefreshIcons) window.skRefreshIcons(m);
    this._showSettingsGeo();
  }

  _ensureSettingsGeoMap() {
    const el = document.getElementById('settings-geo-map');
    if (!el || this._settingsGeoMap || typeof L === 'undefined') return;
    this._settingsGeoMap = L.map(el, {
      zoomControl: true,
      scrollWheelZoom: false,
      attributionControl: true,
    }).setView([41.9, 12.5], 5);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(this._settingsGeoMap);
  }

  _paintSettingsGeo() {
    this._ensureSettingsGeoMap();
    document.getElementById('btn-settings-geo-device')?.classList.toggle('hidden', !this._geoOverride);
    const empty = document.getElementById('settings-geo-empty');
    const status = document.getElementById('settings-geo-status');
    const map = this._settingsGeoMap;
    if (!map) {
      if (status) status.textContent = 'Mappa non disponibile.';
      return;
    }
    if (this._settingsGeoMarker) map.removeLayer(this._settingsGeoMarker);
    if (this._settingsGeoAccuracy) map.removeLayer(this._settingsGeoAccuracy);
    this._settingsGeoMarker = null;
    this._settingsGeoAccuracy = null;
    if (!this._geo) {
      empty?.classList.remove('hidden');
      if (status) {
        status.textContent = this._geoState === 'denied'
          ? 'Posizione negata. Consenti l’accesso dal browser e ricalcola.'
          : 'Posizione non disponibile. Ricalcola per riprovare.';
      }
      requestAnimationFrame(() => map.invalidateSize());
      return;
    }
    empty?.classList.add('hidden');
    const color = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#4F46E5';
    const point = [this._geo.lat, this._geo.lng];
    const accuracy = Number(this._geo.accuracy);
    if (Number.isFinite(accuracy) && accuracy > 0) {
      this._settingsGeoAccuracy = L.circle(point, {
        radius: accuracy,
        color,
        weight: 1,
        fillColor: color,
        fillOpacity: 0.12,
      }).addTo(map);
    }
    this._settingsGeoMarker = L.circleMarker(point, {
      radius: 7,
      color: '#fff',
      weight: 2,
      fillColor: color,
      fillOpacity: 1,
    }).addTo(map);
    const fit = () => {
      map.invalidateSize();
      if (this._settingsGeoAccuracy) map.fitBounds(this._settingsGeoAccuracy.getBounds(), { padding: [24, 24], maxZoom: 17 });
      else map.setView(point, 16);
    };
    requestAnimationFrame(fit);
    document.getElementById('btn-settings-geo-device')?.classList.toggle('hidden', !this._geoOverride);
    if (status) {
      if (this._geoOverride) {
        status.textContent = `Posizione forzata su ${this._geoOverride.address}. Vale fino al prossimo blocco e non viene salvata.`;
      } else {
        const acc = Number.isFinite(accuracy) ? ` Precisione circa ${this._formatMeters(accuracy)}.` : '';
        status.textContent = Number.isFinite(accuracy) && accuracy > 5000
          ? `Il browser ti colloca in questa zona, con una precisione di circa ${this._formatMeters(accuracy)}. Su un PC fisso di solito non c’è il GPS, quindi il punto può cadere in un’altra regione.`
          : `Posizione aggiornata.${acc} Le note legate a un luogo usano questo punto.`;
      }
    }
  }

  _showSettingsGeo() {
    this._paintSettingsGeo();
    if (this._geo || this._geoState === 'denied') return;
    const status = document.getElementById('settings-geo-status');
    if (status) status.textContent = 'Lettura della posizione...';
    this._ensureGeo().then(() => {
      if (!document.getElementById('modal-settings')?.classList.contains('hidden')) this._paintSettingsGeo();
    });
  }

  async _refreshSettingsGeo() {
    if (this._geoOverride) {
      this._paintSettingsGeo();
      if (this.vault.isUnlocked()) await this._renderNoteGrid();
      this._toast('La posizione forzata resta fino al blocco');
      return;
    }
    const btn = document.getElementById('btn-settings-geo');
    const status = document.getElementById('settings-geo-status');
    if (btn) btn.disabled = true;
    if (status) status.textContent = 'Ricalcolo in corso...';
    this._geoSeq = (this._geoSeq || 0) + 1;
    this._geo = null;
    this._geoState = null;
    this._geoPromise = null;
    this._geoMaxAge = 0;
    try {
      await this._ensureGeo();
      this._paintSettingsGeo();
      if (this.vault.isUnlocked()) await this._renderNoteGrid();
      if (this._geo) this._toast('Posizione aggiornata');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  _suggestForcedGeo() {
    const input = document.getElementById('settings-geo-address');
    const box = document.getElementById('settings-geo-suggestions');
    if (!input || !box) return;
    const q = input.value.trim();
    this._forcedPick = null;
    const seq = (this._forcedSuggestSeq = (this._forcedSuggestSeq || 0) + 1);
    if (q.length < 3) {
      box.classList.add('hidden');
      box.innerHTML = '';
      return;
    }
    clearTimeout(this._forcedSuggestTimer);
    this._forcedSuggestTimer = setTimeout(async () => {
      try {
        const res = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=5`);
        if (!res.ok || seq !== this._forcedSuggestSeq) return;
        const data = await res.json();
        if (seq !== this._forcedSuggestSeq) return;
        const features = data.features || [];
        box.innerHTML = '';
        if (!features.length) {
          box.classList.add('hidden');
          return;
        }
        features.forEach(feature => {
          const props = feature.properties || {};
          const label = [props.name, [props.street, props.housenumber].filter(Boolean).join(' '), props.city, props.country]
            .filter(Boolean).filter((part, i, all) => all.indexOf(part) === i).join(', ');
          const [lng, lat] = feature.geometry?.coordinates || [];
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'place-suggestion';
          btn.textContent = label || q;
          btn.addEventListener('click', () => {
            input.value = label || q;
            this._forcedPick = { address: label || q, lat: Number(lat), lng: Number(lng) };
            box.classList.add('hidden');
          });
          box.appendChild(btn);
        });
        box.classList.remove('hidden');
      } catch {
        box.classList.add('hidden');
      }
    }, 300);
  }

  async _forceSettingsGeo() {
    if (!this._forcedPick || !Number.isFinite(this._forcedPick.lat) || !Number.isFinite(this._forcedPick.lng)) {
      return this._toast('Scegli un indirizzo dai suggerimenti');
    }
    this._geoOverride = {
      lat: this._forcedPick.lat,
      lng: this._forcedPick.lng,
      address: this._forcedPick.address,
    };
    this._geoSeq = (this._geoSeq || 0) + 1;
    this._geoPromise = null;
    this._geo = null;
    await this._ensureGeo();
    this._paintSettingsGeo();
    if (this.vault.isUnlocked()) await this._renderNoteGrid();
    this._toast('Posizione forzata fino al blocco');
  }

  _clearForcedGeo(readDevice = true) {
    const hadOverride = !!this._geoOverride;
    this._geoOverride = null;
    this._forcedPick = null;
    this._geoSeq = (this._geoSeq || 0) + 1;
    this._geo = null;
    this._geoState = null;
    this._geoPromise = null;
    const input = document.getElementById('settings-geo-address');
    const box = document.getElementById('settings-geo-suggestions');
    if (input) input.value = '';
    if (box) {
      box.classList.add('hidden');
      box.innerHTML = '';
    }
    document.getElementById('btn-settings-geo-device')?.classList.add('hidden');
    if (readDevice && hadOverride && this.vault.isUnlocked()) this._refreshSettingsGeo();
  }

  async _refreshBiometricSettings() {
    const btn = document.getElementById('btn-settings-biometric');
    if (!btn) return;
    let enrolled = false;
    let supported = false;
    try {
      enrolled = await this.vault.hasBiometricUnlock();
      supported = enrolled || await this.vault.biometricSupported();
    } catch {
      supported = false;
    }
    btn.classList.remove('hidden');
    const label = btn.querySelector('.settings-label');
    const desc = btn.querySelector('.settings-desc');
    if (label) label.textContent = enrolled ? 'Disattiva sblocco con impronta' : 'Sblocca con impronta';
    if (desc) desc.textContent = enrolled
      ? 'L’impronta è attiva su questo dispositivo.'
      : 'Decidi se entrare con l’impronta di questo dispositivo.';
    btn.dataset.mode = enrolled ? 'off' : 'on';
    btn.dataset.supported = supported ? '1' : '0';
  }

  async _toggleBiometricSetting() {
    const btn = document.getElementById('btn-settings-biometric');
    if (!btn || btn.dataset.mode !== 'off') {
      if (btn?.dataset.supported !== '1') {
        this._toast('L’impronta non è disponibile su questo browser');
        return;
      }
      const input = document.getElementById('biometric-password');
      if (input) input.value = '';
      document.getElementById('modal-biometric')?.classList.remove('hidden');
      if (window.skRefreshIcons) window.skRefreshIcons(document.getElementById('modal-biometric'));
      setTimeout(() => input?.focus(), 50);
      return;
    }
    await this.vault.clearBiometric();
    this._toast('Sblocco con impronta disattivato');
    await this._refreshBiometricSettings();
  }

  _closeBiometricModal() {
    document.getElementById('modal-biometric')?.classList.add('hidden');
    const input = document.getElementById('biometric-password');
    if (input) input.value = '';
  }

  async _confirmBiometric() {
    const input = document.getElementById('biometric-password');
    const confirmBtn = document.getElementById('btn-biometric-confirm');
    const password = input?.value || '';
    if (!password || confirmBtn?.disabled) return;
    if (confirmBtn) confirmBtn.disabled = true;
    this._holdLock = true;
    try {
      await this.vault.enrollBiometric(password);
      this._closeBiometricModal();
      this._toast('Sblocco con impronta attivo');
      await this._refreshBiometricSettings();
    } catch (err) {
      if (err?.message !== 'Attivazione annullata') {
        this._toast(err?.message || 'Impronta non disponibile su questo dispositivo', 'error');
      }
    } finally {
      this._holdLock = false;
      if (confirmBtn) confirmBtn.disabled = false;
    }
  }

  _toggleTheme() {
    const isDark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('sk_theme', isDark ? 'dark' : 'light');
  }

  _applyCompactNotes() {
    document.body.classList.toggle('compact-notes', !!this._compactNotes);
    const btn = document.getElementById('btn-compact-notes');
    if (!btn) return;
    btn.classList.toggle('active', !!this._compactNotes);
    btn.title = this._compactNotes ? 'Mostra anteprime' : 'Vista compatta';
    btn.setAttribute('aria-pressed', this._compactNotes ? 'true' : 'false');
    btn.setAttribute('aria-label', btn.title);
    btn.innerHTML = `<i data-lucide="${this._compactNotes ? 'rows-2' : 'gallery-vertical'}"></i>`;
    if (window.skRefreshIcons) window.skRefreshIcons(btn);
  }

  _enterMultiSelect() {
    if (this._multiSelectMode) return;
    this._multiSelectMode = true;
    this._selectedIds.clear();
    document.body.classList.add('multi-select-mode');
    this._updateBulkCount();
  }

  _exitMultiSelect() {
    this._multiSelectMode = false;
    this._selectedIds.clear();
    document.body.classList.remove('multi-select-mode');
    document.querySelectorAll('.note-card.selected').forEach(c => {
      c.classList.remove('selected');
      const cb = c.querySelector('.card-checkbox');
      if (cb) cb.checked = false;
    });
    this._updateBulkCount();
  }

  _toggleSelect(id, cardEl = null) {
    if (this._selectedIds.has(id)) {
      this._selectedIds.delete(id);
      if (cardEl) {
        cardEl.classList.remove('selected');
        const cb = cardEl.querySelector('.card-checkbox');
        if (cb) cb.checked = false;
      }
    } else {
      this._selectedIds.add(id);
      if (cardEl) {
        cardEl.classList.add('selected');
        const cb = cardEl.querySelector('.card-checkbox');
        if (cb) cb.checked = true;
      }
    }
    this._updateBulkCount();
    if (this._selectedIds.size === 0 && this._multiSelectMode) this._exitMultiSelect();
  }

  _updateBulkCount() {
    const countEl = document.getElementById('bulk-count');
    if (countEl) countEl.textContent = `${this._selectedIds.size} selezionati`;
    const bar = document.getElementById('bulk-toolbar');
    if (bar) this._setBulkBarVisible(this._selectedIds.size > 0);
  }

  _setBulkBarVisible(visible) {
    const bar = document.getElementById('bulk-toolbar');
    if (!bar) return;
    clearTimeout(bar._hideTimer);

    if (visible) {
      bar.classList.remove('hidden');
      requestAnimationFrame(() => requestAnimationFrame(() => bar.classList.add('is-open')));
      return;
    }

    if (bar.classList.contains('hidden')) return;
    bar.classList.remove('is-open');
    const finish = () => {
      if (!bar.classList.contains('is-open')) bar.classList.add('hidden');
    };
    const onEnd = (e) => {
      if (e.target !== bar || e.propertyName !== 'transform') return;
      bar.removeEventListener('transitionend', onEnd);
      clearTimeout(bar._hideTimer);
      finish();
    };
    bar.addEventListener('transitionend', onEnd);
    bar._hideTimer = setTimeout(() => {
      bar.removeEventListener('transitionend', onEnd);
      finish();
    }, 420);
  }

  async _bulkAction(action) {
    if (this._selectedIds.size === 0) return;
    const ids = Array.from(this._selectedIds);
    let singleTrashTitle = '';
    if (action === 'trash' && ids.length === 1) {
      const index = await this.vault.getIndex();
      singleTrashTitle = index.notes?.[ids[0]]?.title || '';
    }
    this._exitMultiSelect();
    
    for (const id of ids) {
      if (action === 'archive') {
        await this.vault.setArchived(id, true);
      } else if (action === 'restore') {
        await this.vault.restoreNote(id);
      } else if (action === 'trash') {
        await this.vault.trashNote(id);
      }
    }
    this._renderNoteGrid();
    this.sync.sync().catch(() => {});
    
    if (action === 'archive') {
      this._toast(ids.length === 1 ? 'Nota archiviata' : `${ids.length} note archiviate`, 'success', {
        label: 'Annulla',
        onClick: async () => {
          for (const id of ids) await this.vault.setArchived(id, false);
          this._renderNoteGrid();
          this.sync.sync().catch(() => {});
        }
      });
    } else if (action === 'trash') {
      this._toast(ids.length === 1 ? this._trashToastLabel(singleTrashTitle) : `${ids.length} note spostate nel cestino`, 'success', {
        label: 'Annulla',
        onClick: async () => {
          for (const id of ids) await this.vault.restoreNote(id);
          this._renderNoteGrid();
          this.sync.sync().catch(() => {});
        }
      });
    } else if (action === 'restore') {
      this._toast(ids.length === 1 ? 'Nota ripristinata' : `${ids.length} note ripristinate`);
    }
  }

  _updateSidebarCounts(notesObj) {
    const notes = Object.values(notesObj || {});
    const set = (id, n) => {
      const el = document.getElementById(id);
      if (el) el.textContent = n ? String(n) : '';
    };
    set('count-all', notes.filter(n => !n.archived && !n.trashed).length);
    set('count-pinned', notes.filter(n => n.pinned && !n.archived && !n.trashed).length);
    set('count-archive', notes.filter(n => n.archived && !n.trashed).length);
    set('count-trash', notes.filter(n => n.trashed).length);
  }

  _showCreateMenu() {
    const btn = document.getElementById('fab-btn');
    if (!btn) return;
    const existing = document.querySelector('.fab-menu');
    if (existing) {
      existing.remove();
      return;
    }
    const menu = document.createElement('div');
    menu.className = 'context-menu fab-menu';
    menu.innerHTML = `
      <button class="context-menu-item" data-type="note" type="button"><i data-lucide="file-text"></i><span>Nuova nota</span></button>
      <button class="context-menu-item" data-type="checklist" type="button"><i data-lucide="check-square"></i><span>Nuova checklist</span></button>
      <button class="context-menu-item" data-type="password" type="button"><i data-lucide="key"></i><span>Nuova password</span></button>
    `;
    menu.addEventListener('click', (e) => {
      const t = e.target.closest('.context-menu-item');
      if (t) {
        const type = t.dataset.type;
        menu.remove();
        this._openNewNoteEditor(type);
      }
    });
    document.body.appendChild(menu);
    if (window.skRefreshIcons) window.skRefreshIcons(menu);
    const rect = btn.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.bottom = `${window.innerHeight - rect.top + 8}px`;
    menu.style.right = `${window.innerWidth - rect.right}px`;

    setTimeout(() => {
      document.addEventListener('click', (e) => {
        if (!menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) menu.remove();
      }, { once: true });
    }, 10);
  }

  async _openNoteEditor(id, type) {
    const index = await this.vault.getIndex();
    this._places = Array.isArray(index.places) ? index.places : [];
    const meta = Object.values(index.notes || {}).find(n => (n.id || n) === id) || { id, type };
    if (this._isNoteLocked(meta)) {
      this._showPlaceLock(meta);
      return;
    }
    const note = await this.vault.getNote(id);
    if (!note) return;
    const data = { ...meta, ...note, id };
    if (data.type === 'password') this._showPasswordEditor(data);
    else if (data.type === 'checklist') this._showChecklistEditor(data);
    else this._showNoteEditor(data);
  }

  _closeSidebar() {
    const isMobile = window.innerWidth <= 700;
    if (isMobile) {
      const sidebar = document.getElementById('sidebar');
      const overlay = document.getElementById('sidebar-overlay');
      if (sidebar) sidebar.classList.remove('open');
      document.body.classList.remove('nav-open');
      if (overlay) {
        overlay.classList.remove('open');
        setTimeout(() => overlay.style.display = 'none', 300);
      }
    }
  }

  _bindSidebarSwipe() {
    let startX = 0;
    let startY = 0;
    let tracking = false;
    const begin = (e) => {
      if (!document.getElementById('sidebar')?.classList.contains('open')) return;
      const touch = e.changedTouches?.[0];
      if (!touch) return;
      startX = touch.clientX;
      startY = touch.clientY;
      tracking = true;
    };
    const end = (e) => {
      if (!tracking) return;
      tracking = false;
      const touch = e.changedTouches?.[0];
      if (!touch) return;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (dx < -48 && Math.abs(dx) > Math.abs(dy)) this._closeSidebar();
    };
    ['sidebar', 'sidebar-overlay'].forEach(id => {
      const el = document.getElementById(id);
      el?.addEventListener('touchstart', begin, { passive: true });
      el?.addEventListener('touchend', end, { passive: true });
    });
  }

  async _installFromSettings() {
    const result = await window.skRequestInstall?.();
    if (result === 'installed') this._toast('SecureKeep è già installata');
    else if (result === 'done') this._toast('Installazione avviata');
    else if (result === 'ios') this._toast('Tocca Condividi, poi Aggiungi a Home');
    else this._toast('Da questo browser usa il menu e scegli Aggiungi a schermata Home');
  }

  async _emptyTrash() {
    const notes = Object.values((await this.vault.getIndex()).notes || {}).filter(n => n.trashed);
    for (const n of notes) {
      await this.vault.deleteNote(n.id);
    }
    this._renderNoteGrid();
    this.sync.sync().catch(() => {});
  }
  
  async _confirmDeleteForever(metaOrId) {
    const id = typeof metaOrId === 'string' ? metaOrId : metaOrId?.id;
    if (!id) return;
    if (confirm('Vuoi davvero eliminare questa nota per sempre?')) {
      await this.vault.deleteNote(id);
      this._renderNoteGrid();
      this.sync.sync().catch(() => {});
    }
  }

  async _trashModalNote(btnEl) {
    if (this._currentNoteId) {
      const idToTrash = this._currentNoteId;
      const modal = btnEl.closest('.modal');
      const title = modal?.querySelector('#pwd-title, #note-title, #cl-title')?.value || '';
      await this.vault.trashNote(idToTrash);
      this._closeAllModals();
      this._renderNoteGrid();
      this.sync.sync().catch(() => {});
      this._toast(this._trashToastLabel(title), 'success', {
        label: 'Annulla',
        onClick: async () => {
          await this.vault.restoreNote(idToTrash);
          this._renderNoteGrid();
          this.sync.sync().catch(() => {});
        }
      });
    }
  }

  _toggleDraftPin(btnEl) {
    const modal = btnEl.closest('.modal');
    if (!modal) return;
    const prefix = modal.id === 'modal-checklist' ? 'cl' : (modal.id === 'modal-password' ? 'pwd' : 'note');
    const inputEl = document.getElementById(prefix + '-draft-pinned');
    if (!inputEl) return;
    const isPinned = inputEl.value === 'true';
    inputEl.value = isPinned ? 'false' : 'true';
    this._updateDraftPinVisual(btnEl, !isPinned);
    this._commitEditorHistory?.();
  }
  
  _paintModalColor(modal, color) {
    const box = modal?.querySelector('.modal-box');
    if (!box) return;
    box.className = 'modal-box note-color-' + (color || 'default');
  }

  _bindEditorHistory(modal, capture, restore) {
    if (this._historyAbort) this._historyAbort.abort();
    const ac = new AbortController();
    this._historyAbort = ac;
    const signal = ac.signal;

    let current = capture();
    const past = [];
    const future = [];
    let restoring = false;
    let timer = null;
    const undoBtn = modal.querySelector('.draft-undo-btn');
    const redoBtn = modal.querySelector('.draft-redo-btn');
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    const paint = () => {
      if (undoBtn) undoBtn.disabled = past.length === 0;
      if (redoBtn) redoBtn.disabled = future.length === 0;
    };
    const commit = () => {
      clearTimeout(timer);
      timer = null;
      if (restoring) return;
      const next = capture();
      if (same(next, current)) return;
      past.push(current);
      if (past.length > 80) past.shift();
      current = next;
      future.length = 0;
      paint();
    };
    const schedule = () => {
      if (restoring) return;
      clearTimeout(timer);
      timer = setTimeout(commit, 400);
    };
    const apply = (snap) => {
      restoring = true;
      clearTimeout(timer);
      timer = null;
      restore(snap);
      restoring = false;
      paint();
    };
    const undo = () => {
      commit();
      if (!past.length) return;
      future.push(current);
      current = past.pop();
      apply(current);
    };
    const redo = () => {
      clearTimeout(timer);
      timer = null;
      if (!future.length) return;
      past.push(current);
      current = future.pop();
      apply(current);
    };

    this._commitEditorHistory = commit;
    modal.addEventListener('input', schedule, { signal });
    modal.addEventListener('change', schedule, { signal });
    undoBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      undo();
    }, { signal });
    redoBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      redo();
    }, { signal });
    modal.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault();
        redo();
      }
    }, { signal });
    paint();
  }

  _updateDraftPinVisual(btnEl, isPinned) {
    if (!btnEl) return;
    btnEl.classList.toggle('active', !!isPinned);
  }

  _updateDraftTagsVisual(modalEl, tags) {
    const btn = modalEl?.querySelector('.draft-tags-btn');
    if (!btn) return;
    const list = Array.isArray(tags)
      ? tags.map(t => String(t).trim()).filter(Boolean)
      : String(tags || '').split(',').map(t => t.trim()).filter(Boolean);
    btn.classList.toggle('active', list.length > 0);
  }

  _onModalBackdrop(e, save) {
    if (document.querySelector('.context-menu, .color-picker-popup')) {
      e.stopPropagation();
      this._closeContextMenus();
      return;
    }
    save();
  }

  _passwordRevision(src) {
    return {
      title: src.title || '',
      username: src.username || '',
      password: src.password || '',
      url: src.url || '',
      notes: src.notes || '',
      icon: src.icon || null,
      tags: [...(src.tags || [])],
      color: src.color || 'default',
      pinned: !!src.pinned,
    };
  }

  _restorePasswordRevision(entry, refs) {
    const has = (key) => Object.prototype.hasOwnProperty.call(entry, key);
    const { modal, pwdInput, iconPicker, customIconGroup, customIconImg, customIconInput, iconPickerWrap } = refs;
    if (has('title')) document.getElementById('pwd-title').value = entry.title || '';
    if (has('username')) document.getElementById('pwd-username').value = entry.username || '';
    if (has('password')) {
      pwdInput.value = entry.password || '';
      this._updatePwdStrength(pwdInput.value);
    }
    if (has('url')) document.getElementById('pwd-url').value = entry.url || '';
    if (has('notes')) document.getElementById('pwd-notes').value = entry.notes || '';
    if (has('color')) {
      document.getElementById('pwd-draft-color').value = entry.color || 'default';
      this._paintModalColor(modal, entry.color || 'default');
    }
    if (has('tags')) {
      const tags = entry.tags || [];
      document.getElementById('pwd-draft-tags').value = tags.join(',');
      this._updateDraftTagsVisual(modal, tags);
    }
    if (has('pinned')) {
      document.getElementById('pwd-draft-pinned').value = entry.pinned ? 'true' : 'false';
      this._updateDraftPinVisual(modal.querySelector('.draft-pin-btn'), !!entry.pinned);
    }
    if (has('icon')) {
      const icon = entry.icon || '';
      if (icon && String(icon).startsWith('data:image')) {
        if (customIconGroup) customIconGroup.style.display = 'flex';
        if (customIconImg) {
          customIconImg.src = icon;
          customIconImg.dataset.base64 = icon;
        }
        if (customIconInput) customIconInput.value = icon;
        if (iconPickerWrap) iconPickerWrap.style.display = 'none';
      } else {
        if (customIconGroup) customIconGroup.style.display = 'none';
        if (customIconImg) customIconImg.src = '';
        if (customIconInput) customIconInput.value = '';
        if (iconPickerWrap) iconPickerWrap.style.display = 'block';
        iconPicker?.querySelectorAll('.icon-option').forEach(b => {
          b.classList.toggle('active', b.dataset.icon === (icon || 'key'));
        });
      }
    }
    this._commitEditorHistory?.();
    document.getElementById('modal-pwd-history')?.classList.add('hidden');
    const when = entry.timestamp || entry.changedAt;
    const whenDate = when ? new Date(when) : null;
    const whenText = whenDate && !Number.isNaN(whenDate.getTime())
      ? whenDate.toLocaleString('it-IT', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '';
    this._toast(whenText ? `Versione del ${whenText} ripristinata nel modulo` : 'Versione ripristinata nel modulo');
  }

  _placeTopbarActions() {
    const mobile = window.matchMedia('(max-width: 700px)').matches;
    const search = document.getElementById('search-input');
    if (search) search.placeholder = mobile ? 'Cerca' : 'Cerca per titolo o etichetta...';
    const actions = document.getElementById('topbar-actions');
    const topbar = document.getElementById('topbar');
    const slot = document.getElementById('sidebar-actions');
    if (!actions || !topbar || !slot) return;
    const parent = mobile ? slot : topbar;
    if (actions.parentElement !== parent) parent.appendChild(actions);
  }

  _showPasswordHistory(history, onRestore) {
    const modal = document.getElementById('modal-pwd-history');
    const list = document.getElementById('pwd-history-list');
    if (!modal || !list) return;
    const box = modal.querySelector('.modal-box');
    const source = document.querySelector('#modal-password .modal-box');
    if (box) {
      const color = [...(source?.classList || [])].find(cls => cls.startsWith('note-color-')) || 'note-color-default';
      box.className = 'modal-box ' + color;
    }
    list.innerHTML = '';
    const entries = history || [];
    if (!entries.length) {
      list.innerHTML = '<p class="pwd-history-empty">Nessuna versione precedente.</p>';
    }
    entries.forEach((entry) => {
      const full = Object.prototype.hasOwnProperty.call(entry, 'title') || Object.prototype.hasOwnProperty.call(entry, 'username');
      const when = entry.timestamp || entry.changedAt;
      const card = document.createElement('article');
      card.className = 'pwd-history-card';
      const fields = full
        ? [
            ['Titolo', entry.title],
            ['Username', entry.username],
            ['Password', entry.password],
            ['URL', entry.url],
            ['Note', entry.notes],
            ['Etichette', (entry.tags || []).join(', ')],
          ]
        : [['Password', entry.password]];
      const rows = document.createElement('div');
      fields.forEach(([label, value]) => {
        const text = String(value || '').trim();
        const row = document.createElement('div');
        row.className = 'pwd-history-row';
        const name = document.createElement('span');
        name.textContent = label;
        row.appendChild(name);
        if ((label === 'Password' || label === 'Username') && text) {
          const wrap = document.createElement('div');
          wrap.className = 'pwd-history-secret';
          const strong = document.createElement('strong');
          strong.textContent = label === 'Password' ? '••••••••' : text;
          const copy = document.createElement('button');
          copy.type = 'button';
          copy.className = 'btn-icon pwd-history-eye';
          copy.title = label === 'Password' ? 'Copia password' : 'Copia username';
          copy.innerHTML = '<i data-lucide="copy"></i>';
          copy.addEventListener('click', () => {
            this._copyToClipboard(text, label === 'Password' ? 'Password copiata!' : 'Username copiato!');
          });
          wrap.append(strong, copy);
          if (label === 'Password') {
            const eye = document.createElement('button');
            eye.type = 'button';
            eye.className = 'btn-icon pwd-history-eye';
            eye.title = 'Mostra password';
            eye.innerHTML = '<i data-lucide="eye"></i>';
            let shown = false;
            eye.addEventListener('click', () => {
              shown = !shown;
              strong.textContent = shown ? text : '••••••••';
              eye.title = shown ? 'Nascondi password' : 'Mostra password';
              eye.innerHTML = `<i data-lucide="${shown ? 'eye-off' : 'eye'}"></i>`;
              if (window.skRefreshIcons) window.skRefreshIcons(eye);
            });
            wrap.appendChild(eye);
          }
          row.appendChild(wrap);
        } else {
          const strong = document.createElement('strong');
          strong.textContent = text || '—';
          row.appendChild(strong);
        }
        rows.appendChild(row);
      });
      const whenText = when
        ? new Date(when).toLocaleString('it-IT', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
        : 'Data sconosciuta';
      card.innerHTML = `
        <div class="pwd-history-head">
          <time>${this._escHtml(whenText)}</time>
          <button type="button" class="btn btn-outline pwd-history-restore">Ripristina</button>
        </div>
        ${full ? '' : '<p class="pwd-history-legacy">Versione precedente: era salvata solo la password.</p>'}`;
      card.appendChild(rows);
      card.querySelector('.pwd-history-restore').addEventListener('click', () => onRestore?.(entry));
      list.appendChild(card);
    });
    modal.classList.remove('hidden');
    if (window.skRefreshIcons) window.skRefreshIcons(modal);
    const close = () => modal.classList.add('hidden');
    this._onClick('btn-close-pwd-history', close);
    const backdrop = modal.querySelector('.modal-backdrop');
    if (backdrop) backdrop.onclick = close;
  }

  _showConflictResolver(id) {
    this._toast('Conflitto rilevato: è stata tenuta la copia locale. Su Drive c’è anche una copia della modifica in conflitto.', 'error');
    if (typeof id === 'string') this._openNoteEditor(id);
  }

  _openNewNoteEditor(type) {
    this._currentNoteId = null;
    const emptyData = { type, title: '', tags: [], color: 'default' };
    switch (type) {
      case 'password': this._showPasswordEditor(emptyData); break;
      case 'checklist': this._showChecklistEditor(emptyData); break;
      default: this._showNoteEditor(emptyData);
    }
  }
}