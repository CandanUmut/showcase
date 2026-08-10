// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// The hub is served from a project path, so `base` has to be reflected in every
// internal href. Use the `url()` helper in src/lib/paths.js rather than
// hand-writing paths, and this stays the only place the prefix is declared.
export default defineConfig({
  site: 'https://candanumut.github.io',
  base: '/showcase',
  output: 'static',
  trailingSlash: 'always',
  integrations: [sitemap()],
  build: {
    // Keep CSS in a real stylesheet so the @font-face URLs in public/fonts
    // always resolve relative to a known directory instead of the page depth.
    inlineStylesheets: 'never'
  }
});
