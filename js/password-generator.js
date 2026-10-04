/**
 * SecureKeep — Password Generator
 *
 * Uses crypto.getRandomValues() for cryptographically secure randomness.
 */

export class PasswordGenerator {
  static CHARS = {
    upper:   'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    lower:   'abcdefghijklmnopqrstuvwxyz',
    digits:  '0123456789',
    symbols: '!@#$%^&*()_+-=[]{}|;:,.<>?',
    // Characters that look similar and cause confusion
    ambiguous: 'O0Il1|`\'"',
  };

  /**
   * Generate a random password.
   *
   * @param {object} opts
   * @param {number} opts.length        - password length (default 20)
   * @param {boolean} opts.upper        - include uppercase (default true)
   * @param {boolean} opts.lower        - include lowercase (default true)
   * @param {boolean} opts.digits       - include digits (default true)
   * @param {boolean} opts.symbols      - include symbols (default true)
   * @param {boolean} opts.noAmbiguous  - exclude ambiguous characters (default false)
   * @returns {string}
   */
  static generate({
    length = 20,
    upper = true,
    lower = true,
    digits = true,
    symbols = true,
    noAmbiguous = false,
  } = {}) {
    let pool = '';
    const required = [];

    if (upper) {
      let chars = this.CHARS.upper;
      if (noAmbiguous) chars = this._removeAmbiguous(chars);
      if (chars) { pool += chars; required.push(this._randomChar(chars)); }
    }
    if (lower) {
      let chars = this.CHARS.lower;
      if (noAmbiguous) chars = this._removeAmbiguous(chars);
      if (chars) { pool += chars; required.push(this._randomChar(chars)); }
    }
    if (digits) {
      let chars = this.CHARS.digits;
      if (noAmbiguous) chars = this._removeAmbiguous(chars);
      if (chars) { pool += chars; required.push(this._randomChar(chars)); }
    }
    if (symbols) {
      let chars = this.CHARS.symbols;
      if (noAmbiguous) chars = this._removeAmbiguous(chars);
      if (chars) { pool += chars; required.push(this._randomChar(chars)); }
    }

    if (!pool) pool = this.CHARS.lower; // fallback

    // Fill remaining length with random chars from the pool
    const result = [...required];
    while (result.length < length) {
      result.push(this._randomChar(pool));
    }

    // Shuffle using Fisher-Yates with crypto randomness
    return this._shuffle(result).join('').slice(0, length);
  }

  /**
   * Evaluate password strength.
   *
   * @param {string} password
   * @returns {{ score: number, label: string, color: string }}
   *   score: 0 (very weak) … 4 (very strong)
   */
  static evaluateStrength(password) {
    if (!password) return { score: 0, label: 'Molto debole', color: '#ef5350' };

    let score = 0;

    // Length scoring
    if (password.length >= 8)  score++;
    if (password.length >= 14) score++;
    if (password.length >= 20) score++;

    // Character variety
    if (/[A-Z]/.test(password)) score++;
    if (/[a-z]/.test(password)) score++;
    if (/[0-9]/.test(password)) score++;
    if (/[^A-Za-z0-9]/.test(password)) score++;

    // Penalize repetition / sequential patterns
    if (/(.)\1{2,}/.test(password)) score--;
    if (/(?:012|123|234|345|456|567|678|789|890|abc|bcd|cde|def)/i.test(password)) score--;

    score = Math.max(0, Math.min(4, Math.round(score / 2)));

    const levels = [
      { label: 'Molto debole', color: '#ef5350' },
      { label: 'Debole',      color: '#ff7043' },
      { label: 'Discreta',      color: '#ffca28' },
      { label: 'Forte',    color: '#66bb6a' },
      { label: 'Molto forte', color: '#26a69a' },
    ];

    return { score, ...levels[score] };
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  static _removeAmbiguous(chars) {
    return chars.split('').filter(c => !this.CHARS.ambiguous.includes(c)).join('');
  }

  static _randomChar(pool) {
    const arr = new Uint32Array(1);
    // Use rejection sampling to avoid modulo bias
    const max = Math.floor(0xFFFFFFFF / pool.length) * pool.length;
    let rand;
    do {
      crypto.getRandomValues(arr);
      rand = arr[0];
    } while (rand >= max);
    return pool[rand % pool.length];
  }

  static _shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const jArr = new Uint32Array(1);
      const max = Math.floor(0xFFFFFFFF / (i + 1)) * (i + 1);
      let rand;
      do {
        crypto.getRandomValues(jArr);
        rand = jArr[0];
      } while (rand >= max);
      const j = rand % (i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}
