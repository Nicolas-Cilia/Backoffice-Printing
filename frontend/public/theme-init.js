/**
 * Apply stored theme classes before React mounts.
 *
 * ThemeContext applies the same classes in a useEffect, which runs after the
 * first paint — so without this bootstrap the page flashes the light :root
 * background on every refresh while dark mode is selected.
 *
 * Kept as an external file so the SPA CSP `script-src 'self'` covers it
 * without needing 'unsafe-inline' or per-build hashes (same pattern as
 * sw-register.js).
 */
(function () {
  try {
    var MODE = { light: 1, dark: 1, system: 1 };
    var STYLES = { classic: 1, glow: 1, vibrant: 1 };
    var DARK_BG = { neutral: 1, warm: 1, cool: 1, oled: 1, slate: 1, forest: 1 };
    var LIGHT_BG = { neutral: 1, warm: 1, cool: 1 };
    var ACCENTS = {
      atos: 1, green: 1, teal: 1, blue: 1, orange: 1, purple: 1, red: 1,
    };
    var DARK_BG_HEX = {
      neutral: '#1a1a1a',
      warm: '#1c1a18',
      cool: '#181c20',
      oled: '#000000',
      slate: '#0f172a',
      forest: '#121a16',
    };
    var LIGHT_BG_HEX = {
      neutral: '#f5f5f5',
      warm: '#faf8f5',
      cool: '#f0f4f8',
    };

    function pick(raw, allowed, fallback) {
      return raw && allowed[raw] ? raw : fallback;
    }

    var stored = localStorage.getItem('theme-mode') || localStorage.getItem('theme');
    var mode = pick(stored, MODE, 'dark');
    var resolved =
      mode === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : mode;

    var root = document.documentElement;
    var style;
    var background;
    var accent;
    var hex;

    if (resolved === 'dark') {
      style = pick(localStorage.getItem('dark-style'), STYLES, 'vibrant');
      background = pick(localStorage.getItem('dark-background'), DARK_BG, 'cool');
      accent = pick(localStorage.getItem('dark-accent'), ACCENTS, 'atos');
      hex = DARK_BG_HEX[background];
      root.classList.add('dark');
    } else {
      style = pick(localStorage.getItem('light-style'), STYLES, 'classic');
      background = pick(localStorage.getItem('light-background'), LIGHT_BG, 'neutral');
      accent = pick(localStorage.getItem('light-accent'), ACCENTS, 'atos');
      hex = LIGHT_BG_HEX[background];
    }

    root.classList.add('style-' + style, 'bg-' + background, 'accent-' + accent);
    root.style.colorScheme = resolved;
    // Bridge until index.css defines --bg-primary on these classes.
    root.style.backgroundColor = hex;
  } catch (_) {
    // localStorage / matchMedia can throw in locked-down contexts; fail open.
  }
})();
