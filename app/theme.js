// Theme handling in the manner of heyhaigh.ai: a saved choice, a sun/moon button, and
// the T key. Loaded in <head> so the right colours are in place before the first paint.
// An address ending in ?theme=dark or ?theme=light wins, so an embedding page can match.
(() => {
  const root = document.documentElement;
  const asked = new URLSearchParams(location.search).get('theme');
  let saved = null;
  try { saved = localStorage.getItem('theme'); } catch {}
  let dark = asked === 'dark' || asked === 'light' ? asked === 'dark'
    : saved === 'dark' || saved === 'light' ? saved === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;

  const listeners = [];
  const apply = () => {
    root.classList.toggle('dark-mode', dark);
    document.body?.classList.toggle('dark-mode', dark);
    const button = document.getElementById('theme-toggle');
    if (button) button.textContent = dark ? '🌙' : '☀️';
    for (const listener of listeners) listener(dark);
  };
  const toggle = () => {
    dark = !dark;
    try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch {}
    apply();
  };
  apply();
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    document.getElementById('theme-toggle')?.addEventListener('click', toggle);
  });
  document.addEventListener('keydown', event => {
    if (event.key.toLowerCase() !== 't' || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target.closest?.('input, textarea, select, [contenteditable]')) return;
    toggle();
  });
  window.polymendTheme = { isDark: () => dark, onChange: listener => listeners.push(listener) };
})();
