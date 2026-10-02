/**
 * SecureKeep — App Configuration
 *
 * BEFORE DEPLOYING:
 * 1. Create a project on Google Cloud Console: https://console.cloud.google.com/
 * 2. Enable the Google Drive API
 * 3. Create an OAuth 2.0 Client ID (Web application)
 * 4. Add your deployment URL to "Authorized JavaScript origins"
 * 5. Replace 'YOUR_GOOGLE_CLIENT_ID_HERE' below with your actual Client ID
 */

// ️ Replace this with your Google OAuth 2.0 Client ID
export const GOOGLE_CLIENT_ID = '875077205919-9e6hq72cuvk7lj67r6m82rsibjdk9qcn.apps.googleusercontent.com';

// OAuth redirect URI — automatically detected from current page
export const GOOGLE_REDIRECT_URI = window.location.origin + window.location.pathname.replace(/\/[^/]*$/, '/');

// Google Drive API
export const GOOGLE_SCOPES = 'https://www.googleapis.com/auth/drive.file';
export const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

// Vault folder name on Google Drive
export const VAULT_FOLDER_NAME = 'SecureKeepVault';

// Security settings
export const AUTO_LOCK_DEFAULT_MINUTES = 5;        // Minutes of inactivity before auto-lock
export const CLIPBOARD_CLEAR_SECONDS = 30;         // Seconds before clipboard is cleared after copy
export const SYNC_LOCK_TTL_SECONDS = 30;           // Sync lock file TTL

// Argon2id parameters (OWASP recommended minimums)
export const ARGON2_MEMORY = 65536;     // 64 MB
export const ARGON2_ITERATIONS = 3;
export const ARGON2_PARALLELISM = 4;
export const ARGON2_HASH_LENGTH = 32;   // 256-bit output for AES-256

// PBKDF2 fallback parameters
export const PBKDF2_ITERATIONS = 600000;
export const PBKDF2_HASH = 'SHA-256';

// IndexedDB
export const IDB_NAME = 'SecureKeepDB';
export const IDB_VERSION = 3;

// App version (bump on each release for SW cache busting)
export const APP_VERSION = '1.0.0';
export const CACHE_VERSION = `sk-v${APP_VERSION}`;

// Recovery key format: 16 groups of 4 hex chars (256 bits)
export const RECOVERY_KEY_GROUPS = 16;
export const RECOVERY_KEY_GROUP_SIZE = 4;

// Note colors
export const NOTE_COLORS = [
  { id: 'default', label: 'Predefinito',  light: '#ffffff', dark: '#16213E' },
  { id: 'red',     label: 'Rosso',      light: '#FFCDD2', dark: '#4A1515' },
  { id: 'pink',    label: 'Rosa',     light: '#F8BBD9', dark: '#4A1535' },
  { id: 'orange',  label: 'Arancione',   light: '#FFE0B2', dark: '#4A2E10' },
  { id: 'yellow',  label: 'Giallo',   light: '#FFF9C4', dark: '#4A4010' },
  { id: 'green',   label: 'Verde',    light: '#C8E6C9', dark: '#1B4A1E' },
  { id: 'teal',    label: 'Ottanio',     light: '#B2DFDB', dark: '#124A45' },
  { id: 'blue',    label: 'Blu',     light: '#BBDEFB', dark: '#102A4A' },
  { id: 'purple',  label: 'Viola',   light: '#E1BEE7', dark: '#2E1045' },
  { id: 'gray',    label: 'Grigio',     light: '#F5F5F5', dark: '#2A2A35' },
];

// Auto-lock options (minutes; 0 = never)
export const AUTO_LOCK_OPTIONS = [
  { value: 1,  label: '1 minuto' },
  { value: 5,  label: '5 minuti' },
  { value: 10, label: '10 minuti' },
  { value: 30, label: '30 minuti' },
  { value: 60, label: '1 ora' },
  { value: 0,  label: 'Mai' },
];

// Image compression settings
export const IMG_MAX_DIMENSION = 1920;
export const IMG_JPEG_QUALITY = 0.7;

// Export file extension
export const EXPORT_EXTENSION = '.skv';
