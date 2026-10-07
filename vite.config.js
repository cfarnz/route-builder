import { defineConfig } from 'vite';

// GitHub Pages serves a project site from /<repo>/, so built asset URLs need
// that prefix. Vite rewrites the absolute /src/... references in index.html at
// build time, so they stay absolute in dev and get the base in production.
export default defineConfig({
  base: process.env.GITHUB_PAGES ? '/route-builder/' : '/',
});
