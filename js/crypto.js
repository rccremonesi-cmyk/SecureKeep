/**
 * SecureKeep — Cryptography Engine
 *
 * Implements the full key hierarchy:
 *   Master Key (MK) → encrypts all vault data
 *   KEK-pwd         → wraps MK (derived from master password via Argon2id / PBKDF2)
 *   KEK-rec         → wraps MK (derived from recovery key)
 *
 * All crypto is performed with the native Web Crypto API (AES-256-GCM).
 * Never logs or exposes key material.
 */

import {
  ARGON2_MEMORY, ARGON2_ITERATIONS, ARGON2_PARALLELISM, ARGON2_HASH_LENGTH,
  PBKDF2_ITERATIONS, PBKDF2_HASH,
  RECOVERY_KEY_GROUPS, RECOVERY_KEY_GROUP_SIZE,
} from './config.js';

// Argon2id WASM library (local bundled version)
const ARGON2_LOCAL = './js/lib/argon2-bundled.min.js';

let _argon2 = null;  // cached reference after first load

export class CryptoEngine {
  // ─── Argon2id loading ───────────────────────────────────────────────────────

  /**
   * Attempt to load argon2-browser from CDN.
   * Falls back to null if unavailable (PBKDF2 will be used instead).
   */
  static async _loadArgon2() {
    if (_argon2 !== null) return _argon2;
    try {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = ARGON2_LOCAL;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
      // The library attaches itself to window.argon2
      _argon2 = window.argon2 || null;
    } catch {
      _argon2 = null; // CDN unavailable — use PBKDF2 fallback
    }
    return _argon2;
  }

  // ─── Key derivation ─────────────────────────────────────────────────────────

  /**
   * Derive a 256-bit wrapping key from a master password and salt.
   * Uses Argon2id when available, falls back to PBKDF2.
   *
   * @param {string} password
   * @param {Uint8Array} salt  - random 32-byte salt (stored in config.json)
   * @returns {CryptoKey}      - AES-256-KW key
   */
  /**
   * @param {string} password
   * @param {Uint8Array} salt
   * @param {string} [forceAlgo]  - 'argon2id' | 'pbkdf2' | undefined (auto-detect)
   * @returns {CryptoKey}
   */
  static async deriveKeyFromPassword(password, salt, forceAlgo) {
    // Determine which algorithm to use
    let useArgon2 = false;
    if (forceAlgo === 'argon2id') {
      useArgon2 = true;
    } else if (forceAlgo === 'pbkdf2') {
      useArgon2 = false;
    } else {
      // Auto-detect: use Argon2id only if the library loads successfully
      const argon2 = await CryptoEngine._loadArgon2();
      useArgon2 = Boolean(argon2);
    }

    let keyBytes;
    if (useArgon2) {
      const argon2 = await CryptoEngine._loadArgon2();
      if (!argon2) {
        const err = new Error('Argon2id non disponibile su questo browser. Riprova o aggiorna la pagina.');
        err.code = 'kdf-unavailable';
        throw err;
      }
      const result = await argon2.hash({
        pass: password,
        salt: salt,
        time: ARGON2_ITERATIONS,
        mem: ARGON2_MEMORY,
        parallelism: ARGON2_PARALLELISM,
        hashLen: ARGON2_HASH_LENGTH,
        type: argon2.ArgonType.Argon2id,
      });
      keyBytes = result.hash;
    } else {
      const enc = new TextEncoder();
      const baseKey = await crypto.subtle.importKey(
        'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
      );
      const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: PBKDF2_HASH },
        baseKey, 256
      );
      keyBytes = new Uint8Array(bits);
    }

    return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-KW' }, false, ['wrapKey', 'unwrapKey']);
  }

  /** Return which KDF is currently available ('argon2id' | 'pbkdf2'). */
  static async detectKdf() {
    const a = await CryptoEngine._loadArgon2();
    return a ? 'argon2id' : 'pbkdf2';
  }

  /**
   * Derive a wrapping key from a recovery key string.
   * Uses PBKDF2 with a fixed, well-known salt (the recovery key IS the secret).
   *
   * @param {string} recoveryKeyStr  - the hex-dash formatted recovery key
   * @returns {CryptoKey}            - AES-256-KW key
   */
  static async deriveKeyFromRecovery(recoveryKeyStr) {
    const cleaned = recoveryKeyStr.replace(/-/g, '').toUpperCase();
    const keyBytes = CryptoEngine._hexToBytes(cleaned);
    // Use the raw recovery key bytes directly as AES-KW key material
    // (the recovery key itself is the 256-bit secret)
    return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-KW' }, false, ['wrapKey', 'unwrapKey']);
  }

  // ─── Master Key ──────────────────────────────────────────────────────────────

  /**
   * Generate a fresh random AES-256-GCM Master Key.
   * Called ONCE during vault creation.
   *
   * @returns {CryptoKey}
   */
  static async generateMasterKey() {
    return crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,   // extractable — needed for wrapping
      ['encrypt', 'decrypt']
    );
  }

  // ─── Key wrapping / unwrapping ───────────────────────────────────────────────

  /**
   * Wrap (encrypt) a CryptoKey with a wrapping key using AES-KW.
   *
   * @param {CryptoKey} keyToWrap     - the Master Key to protect
   * @param {CryptoKey} wrappingKey   - KEK-pwd or KEK-rec
   * @returns {string}                - base64 encoded wrapped key
   */
  static async wrapKey(keyToWrap, wrappingKey) {
    const wrapped = await crypto.subtle.wrapKey('raw', keyToWrap, wrappingKey, 'AES-KW');
    return CryptoEngine._bytesToBase64(new Uint8Array(wrapped));
  }

  /**
   * Unwrap (decrypt) a wrapped Master Key.
   *
   * @param {string} wrappedKeyB64  - base64 encoded wrapped key
   * @param {CryptoKey} wrappingKey - KEK-pwd or KEK-rec
   * @param {boolean} [extractable] - true only while wrapping a temporary copy
   * @returns {CryptoKey}           - the decrypted Master Key
   */
  static async unwrapKey(wrappedKeyB64, wrappingKey, extractable = false) {
    const wrappedBytes = CryptoEngine._base64ToBytes(wrappedKeyB64);
    return crypto.subtle.unwrapKey(
      'raw', wrappedBytes, wrappingKey,
      'AES-KW',
      { name: 'AES-GCM', length: 256 },
      extractable,
      ['encrypt', 'decrypt']
    );
  }

  // ─── Data encryption / decryption ───────────────────────────────────────────

  /**
   * Encrypt arbitrary JSON-serializable data with AES-256-GCM.
   * A fresh random 96-bit IV is generated for every call.
   *
   * @param {any} plainObject   - data to encrypt (will be JSON-stringified)
   * @param {CryptoKey} masterKey
   * @returns {string}          - base64 encoded: [ iv (12 bytes) | ciphertext+tag ]
   */
  static async encrypt(plainObject, masterKey) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const plaintext = enc.encode(JSON.stringify(plainObject));

    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      masterKey,
      plaintext
    );

    // Prepend IV to ciphertext for single portable blob
    const result = new Uint8Array(12 + ciphertext.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(ciphertext), 12);
    return CryptoEngine._bytesToBase64(result);
  }

  /**
   * Decrypt a blob produced by {@link encrypt}.
   *
   * @param {string} encryptedB64 - base64 encoded: [ iv | ciphertext+tag ]
   * @param {CryptoKey} masterKey
   * @returns {any}               - original object
   */
  static async decrypt(encryptedB64, masterKey) {
    const data = CryptoEngine._base64ToBytes(encryptedB64);
    const iv = data.slice(0, 12);
    const ciphertext = data.slice(12);

    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      masterKey,
      ciphertext
    );

    const dec = new TextDecoder();
    return JSON.parse(dec.decode(plaintext));
  }

  // ─── Recovery key ───────────────────────────────────────────────────────────

  /**
   * Generate a random 256-bit recovery key and return it as a
   * human-readable hex string in groups of 4 separated by dashes.
   * e.g. "A1B2-C3D4-E5F6-7890-AB12-CD34-EF56-7890-AB12-CD34-EF56-7890"
   *
   * @returns {string}
   */
  static generateRecoveryKey() {
    const bytes = crypto.getRandomValues(new Uint8Array(RECOVERY_KEY_GROUPS * (RECOVERY_KEY_GROUP_SIZE / 2)));
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
    const groups = [];
    for (let i = 0; i < hex.length; i += RECOVERY_KEY_GROUP_SIZE) {
      groups.push(hex.slice(i, i + RECOVERY_KEY_GROUP_SIZE));
    }
    return groups.join('-');
  }

  /**
   * Validate that a recovery key string has the expected format.
   * @param {string} str
   * @returns {boolean}
   */
  static isValidRecoveryKey(str) {
    const cleaned = str.replace(/-/g, '');
    if (cleaned.length !== RECOVERY_KEY_GROUPS * RECOVERY_KEY_GROUP_SIZE) return false;
    return /^[0-9A-Fa-f]+$/.test(cleaned);
  }

  // ─── Salt generation ─────────────────────────────────────────────────────────

  /**
   * Generate a random 32-byte salt (stored in plaintext in config.json).
   * @returns {string} base64 encoded
   */
  static generateSalt() {
    const salt = crypto.getRandomValues(new Uint8Array(32));
    return CryptoEngine._bytesToBase64(salt);
  }

  /**
   * Decode a base64-encoded salt back to Uint8Array for use in key derivation.
   * @param {string} saltB64
   * @returns {Uint8Array}
   */
  static decodeSalt(saltB64) {
    return CryptoEngine._base64ToBytes(saltB64);
  }

  // ─── Utility ─────────────────────────────────────────────────────────────────

  static _bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  static _base64ToBytes(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  static _hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }
}
