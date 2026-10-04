/**
 * SecureKeep — <lottie-player> element
 *
 * Minimal replacement for the @lottiefiles/lottie-player web component,
 * built on the lottie-web "light" build. The light build omits the
 * expression engine, so it runs without 'unsafe-eval' in the CSP.
 *
 * Supported attributes: src, loop, autoplay, speed, background.
 */

(function () {
  if (window.customElements.get('lottie-player')) return;

  class LottiePlayer extends HTMLElement {
    connectedCallback() {
      if (this._anim) return;

      const src = this.getAttribute('src');
      if (!src || !window.lottie) return;

      const background = this.getAttribute('background');
      if (background) this.style.background = background;
      this.style.display = 'block';

      this._anim = window.lottie.loadAnimation({
        container: this,
        renderer: 'svg',
        loop: this.hasAttribute('loop'),
        autoplay: this.hasAttribute('autoplay'),
        path: src,
      });

      const speed = parseFloat(this.getAttribute('speed'));
      if (Number.isFinite(speed) && speed > 0) this._anim.setSpeed(speed);
    }

    disconnectedCallback() {
      if (!this._anim) return;
      this._anim.destroy();
      this._anim = null;
    }
  }

  window.customElements.define('lottie-player', LottiePlayer);
})();
