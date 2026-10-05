// The site is static files, served by Cloudflare without running this code. This Worker
// runs for one address only: Google's ownership-check file. Cloudflare's file server
// redirects any address ending in .html to the same address without it, and Google
// wants the file itself, not a redirect, so that one address is answered here.
// To stay verified with Google Search Console, do not remove it.

const VERIFICATION = {
  '/googleee0bf5595899a072.html': 'google-site-verification: googleee0bf5595899a072.html',
};

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (VERIFICATION[pathname]) {
      return new Response(VERIFICATION[pathname], { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Content-Type-Options': 'nosniff' } });
    }
    return env.ASSETS.fetch(request);
  },
};
