// Theme handling in the manner of heyhaigh.ai: a saved choice, a sun/moon button, and
// the T key. Loaded in <head> so the right colours are in place before the first paint.
// An address ending in ?theme=dark or ?theme=light wins, so an embedding page can match.
(() => {
  const root = document.documentElement;
  const asked = new URLSearchParams(location.search).get('theme');
  // Embedded in another site's page (/embed): light unless that page asks for dark or
  // ?theme=auto, nothing is saved, and the T key is left alone. The visitor is on someone
  // else's site, and the frame should match what its owner chose.
  const embedded = root.hasAttribute('data-embed');
  const system = () => matchMedia('(prefers-color-scheme: dark)').matches;
  let saved = null;
  if (!embedded) { try { saved = localStorage.getItem('theme'); } catch {} }
  let dark = asked === 'dark' || asked === 'light' ? asked === 'dark'
    : embedded ? asked === 'auto' && system()
    : saved === 'dark' || saved === 'light' ? saved === 'dark'
    : system();

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
  // An embedding site can give the frame its own backdrop and edge, as six-digit hex colours:
  // ?bg=dedcd4&edge=d0cec6. Anything else in those places is ignored.
  const hex = value => (/^[0-9a-fA-F]{6}$/.test(value || '') ? '#' + value : null);
  const colours = embedded ? { '--paper': hex(new URLSearchParams(location.search).get('bg')), '--edge': hex(new URLSearchParams(location.search).get('edge')) } : {};
  // On the maker's own site the credit line is redundant, so ?credit=off removes it there.
  // Elsewhere the line stays: the frame is the only sign of where the tool came from.
  const own = /^https:\/\/(www\.)?heyhaigh\.ai(\/|$)|^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(document.referrer);
  if (embedded && own && new URLSearchParams(location.search).get('credit') === 'off') root.classList.add('no-credit');
  // An embedding page whose own theme can change sends the frame a window message, so the
  // two flip together: { type: 'polymend:theme', theme: 'dark', bg: '050d18', edge: '152131' }
  // (the home page shows the call). Only that shape is read, only those fields, and nothing
  // is ever sent back.
  if (embedded) {
    window.addEventListener('message', event => {
      const data = event.data;
      if (!data || data.type !== 'polymend:theme') return;
      if (data.theme === 'dark' || data.theme === 'light') dark = data.theme === 'dark';
      for (const [name, key] of [['--paper', 'bg'], ['--edge', 'edge']]) {
        const value = hex(data[key]);
        if (value) document.body.style.setProperty(name, value); else if (key in data) document.body.style.removeProperty(name);
      }
      apply();
    });
  }
  document.addEventListener('DOMContentLoaded', () => {
    for (const [name, value] of Object.entries(colours)) if (value) document.body.style.setProperty(name, value);
    apply();
    document.getElementById('theme-toggle')?.addEventListener('click', toggle);
  });
  document.addEventListener('keydown', event => {
    if (embedded) return;
    if (event.key.toLowerCase() !== 't' || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target.closest?.('input, textarea, select, [contenteditable]')) return;
    toggle();
  });
  window.polymendTheme = { isDark: () => dark, onChange: listener => listeners.push(listener) };
})();
