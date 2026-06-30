'use strict';
// Canonical site origin for SEO (sitemap, canonical tags, og:url).
// Set SITE_URL in Railway to your custom domain when it's live —
// e.g. https://dairyplantatlas.com — and everything below updates.
// Falls back to the current Railway URL.
const SITE_URL = (process.env.SITE_URL || 'https://dairyplant-atlas.up.railway.app')
  .replace(/\/+$/, '');

function abs(pathname) {
  return SITE_URL + (pathname.startsWith('/') ? pathname : '/' + pathname);
}

module.exports = { SITE_URL, abs };
