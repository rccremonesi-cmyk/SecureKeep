/**
 * SecureKeep — App Entry Point
 *
 * Initializes all modules and wires them together.
 * Handles PWA install prompt and online/offline events.
 */

import { Vault }            from './vault.js';
import { DriveSync }        from './drive.js';
import { SyncManager }      from './sync.js';
import { UI }               from './ui.js';
import { GOOGLE_CLIENT_ID } from './config.js';

// ─── Initialize Lucide Icons ──────────────────────────────────────────────────
function initLucideIcons() {
  if (typeof lucide === 'undefined') return;
  lucide.createIcons({ icons: lucide.icons });
}
// Attach globally so ui.js can call it after dynamic renders
window.skRefreshIcons = initLucideIcons;
// Run once on load for static icons (topbar, sidebar)
document.addEventListener('DOMContentLoaded', initLucideIcons);


// ─── Module instances ─────────────────────────────────────────────────────────

const vault = new Vault();
const drive = new DriveSync();
const sync  = new SyncManager(drive, vault.storage, vault);
const ui    = new UI(vault, sync, drive);

// ─── PWA: Install prompt ──────────────────────────────────────────────────────

let deferredInstallPrompt = null;

function isStandalonePwa() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function isIosDevice() {
  const ua = navigator.userAgent || '';
  return /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function hideInstallInvite() {
  document.getElementById('install-banner')?.classList.add('hidden');
  document.getElementById('btn-install-pwa')?.classList.add('hidden');
}

function showInstallBanner(ios) {
  if (isStandalonePwa() || sessionStorage.getItem('sk_install_banner_off') === '1') return;
  const banner = document.getElementById('install-banner');
  const text = document.getElementById('install-banner-text');
  const action = document.getElementById('btn-install-banner');
  if (!banner || !text || !action) return;
  if (ios) {
    text.textContent = 'Per installare SecureKeep: tocca Condividi, poi Aggiungi a Home.';
    action.classList.add('hidden');
  } else {
    text.textContent = 'Installa SecureKeep sul dispositivo per aprirla come app.';
    action.classList.remove('hidden');
  }
  banner.classList.remove('hidden');
}

async function runInstallPrompt() {
  if (isStandalonePwa()) return 'installed';
  if (!deferredInstallPrompt) return isIosDevice() ? 'ios' : 'unavailable';
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  hideInstallInvite();
  return 'done';
}

window.skRequestInstall = () => runInstallPrompt();

document.getElementById('btn-install-pwa')?.addEventListener('click', () => runInstallPrompt());
document.getElementById('btn-install-banner')?.addEventListener('click', () => runInstallPrompt());
document.getElementById('btn-install-dismiss')?.addEventListener('click', () => {
  sessionStorage.setItem('sk_install_banner_off', '1');
  document.getElementById('install-banner')?.classList.add('hidden');
});

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  document.getElementById('btn-install-pwa')?.classList.remove('hidden');
  showInstallBanner(false);
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  hideInstallInvite();
});

if (isIosDevice()) showInstallBanner(true);

// ─── Service Worker registration ──────────────────────────────────────────────

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });

      // Check for updates
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            // New version available
            const banner = document.getElementById('update-banner');
            if (banner) {
              banner.classList.remove('hidden');
              document.getElementById('btn-update-app')?.addEventListener('click', () => {
                newWorker.postMessage({ type: 'SKIP_WAITING' });
                window.location.reload();
              });
            }
          }
        });
      });
    } catch (err) {
      console.warn('Service Worker registration failed:', err);
    }
  });
}

// ─── Online / Offline handling ────────────────────────────────────────────────

const updateOnlineStatus = () => {
  const indicator = document.getElementById('offline-indicator');
  if (indicator) {
    indicator.classList.toggle('hidden', navigator.onLine);
  }

  if (navigator.onLine && drive.isAuthenticated && vault.isUnlocked) {
    // Back online — trigger sync
    sync.sync().catch(() => {});
  }
};

window.addEventListener('online',  updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);

// ─── OAuth PKCE callback handling ─────────────────────────────────────────────

async function handleOAuthCallback() {
  if (!window.location.search.includes('code=')) return false;
  try {
    const handled = await drive.handleCallback();
    if (handled && vault.isUnlocked) {
      await drive.ensureVaultStructure();
      await sync.sync();
    }
    return handled;
  } catch (err) {
    console.error('OAuth callback error:', err);
    return false;
  }
}

// ─── Theme initialization ─────────────────────────────────────────────────────

function initTheme() {
  const saved = localStorage.getItem('sk_theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (saved === 'dark' || (!saved && prefersDark)) {
    document.documentElement.classList.add('dark');
  }

  // Listen for system theme changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
    if (!localStorage.getItem('sk_theme')) {
      document.documentElement.classList.toggle('dark', e.matches);
    }
  });
}

// ─── Google Client ID check ───────────────────────────────────────────────────

function checkClientIdConfigured() {
  if (GOOGLE_CLIENT_ID === 'YOUR_GOOGLE_CLIENT_ID_HERE') {
    const banner = document.getElementById('setup-banner');
    if (banner) banner.classList.remove('hidden');
  }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function bootstrap() {
  initTheme();
  checkClientIdConfigured();
  updateOnlineStatus();

  // Check if this is an OAuth redirect
  const wasCallback = await handleOAuthCallback();

  // Restore Drive session if token is still valid
  if (!wasCallback) {
    drive.restoreSession();
  }

  // Second device: vault config lives on Drive, not in this browser yet.
  if (drive.isAuthenticated && !(await vault.exists())) {
    try {
      await drive.ensureVaultStructure();
      const remoteConfig = await drive.downloadConfig();
      if (remoteConfig) await vault.storage.saveConfig(remoteConfig);
    } catch (err) {
      console.warn('Could not restore vault config from Drive:', err);
    }
  }

  // Initialize UI (shows onboarding or lock screen as appropriate)
  await ui.init();

  // If vault was already unlocked via Drive auth callback, show app shell
  if (wasCallback && vault.isUnlocked) {
    // UI.init() will have shown the lock screen — unlock triggers _showAppShell
    // The callback flow completes setup within onboarding step 3
  }
}

bootstrap().catch(err => {
  console.error('SecureKeep bootstrap error:', err);
  document.getElementById('fatal-error')?.classList.remove('hidden');
});
