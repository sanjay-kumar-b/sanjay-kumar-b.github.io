import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { satteri } from '@astrojs/markdown-satteri';
import { enhanceMarkdown, codeBlockTransformer } from './src/plugins/enhance-markdown.mjs';

// Change SITE_URL when you buy your domain (or set it as an environment variable).
const site = process.env.SITE_URL || 'https://example.com';

// Pages that should not appear in the sitemap (exact paths, not substring matches).
const HIDDEN = new Set(['/maintenance/', '/404/', '/search/']);

export default defineConfig({
  site,
  output: 'static',
  integrations: [
    sitemap({
      filter: (page) => !HIDDEN.has(new URL(page).pathname),
    }),
  ],
  markdown: {
    processor: satteri({ hastPlugins: [enhanceMarkdown] }),
    shikiConfig: {
      themes: { light: 'github-light', dark: 'github-dark-dimmed' },
      wrap: false,
      transformers: [codeBlockTransformer],
    },
  },
  build: { format: 'directory' },
  prefetch: { prefetchAll: false, defaultStrategy: 'hover' },
});
