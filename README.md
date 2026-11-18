# SF SKODE: Salesforce knowledge hub

A static, SEO-friendly site built with Astro. Articles are Markdown files. No database, no server code, which makes it easy to host anywhere (an Android phone, Cloudflare Pages, Netlify, a VPS).

## Commands (run inside this folder)

| Command | What it does |
|---|---|
| `npm install` | Install dependencies (once) |
| `npm run dev` | Live preview at http://localhost:4321 |
| `npm run build` | Build the site into `dist/` |
| `npm run preview` | Serve the built `dist/` locally |
| `npm run check` | Type-check the Astro and TypeScript code (run before every deploy) |
| `node scripts/server.mjs` | The production static server (gzip/brotli, caching, 503 maintenance mode). `PORT=4401 node scripts/server.mjs` picks a port |

## Your daily workflow

1. Ask Claude for today's article. Claude writes one Markdown file.
2. Review it. Check the code and the sources.
3. Save it in `src/data/articles/` (filename becomes the URL).
4. Set `draft: false`, or leave `draft: true` while you are still reviewing.
5. `npm run build`, then deploy `dist/`.

Set `publishedAt` to a future date to schedule an article. It stays hidden until that date arrives and the site is rebuilt.

### Article frontmatter

```yaml
---
title: "Article title"
description: "50 to 170 characters, used for SEO and cards."
category: salesforce-development   # must match a slug in src/config/categories.ts
tags: [Apex, Triggers]
publishedAt: 2026-11-05
updatedAt: 2026-11-10              # optional, shows "Recently updated"
draft: false
featured: false
apiVersion: "v66.0"                # only if verified
cover: /images/covers/my-article.jpg   # optional; the image file goes in src/assets/covers/ (matched by file name)
sources:
  - title: "Official doc title"
    url: "https://developer.salesforce.com/..."
---
```

## Things to edit

- `src/config/site.ts`: site name, your name and bio, social links, contact email, newsletter and form endpoints, analytics token.
- `src/config/categories.ts`: add, rename, reorder or remove categories.
- `SITE_URL` environment variable (or `astro.config.mjs`): your real domain, used for sitemap, canonical URLs and RSS.
- `src/pages/privacy.astro` and `terms.astro`: templates only, get them reviewed.

## Hosting

`dist/` is plain HTML, CSS and JS, so any static host works. See the hosting notes in the chat for the phone setup (Termux, Cloudflare Tunnel, Cloudflare Worker offline page).

## Project structure

```
src/
  assets/            author.jpg and covers/ (images here are resized to WebP and given width/height automatically)
  components/        Header, Footer, Palette (Ctrl/Cmd+K), ArticleCard, CoverImage, Icon, ...
  config/            site.ts (identity) and categories.ts
  data/articles/     your Markdown articles
  layouts/           BaseLayout.astro (SEO, theme, fonts)
  lib/               article helpers, cover helpers
  pages/             one file per route
  plugins/           Markdown enhancements (scrollable tables, code blocks with copy button)
  scripts/           small TypeScript modules for the browser (theme, search, palette, article page, contact form)
  styles/global.css  the whole design system (tokens first, then components, then pages)
scripts/             server.mjs and the phone hosting helper (hub)
```

To change the look of the whole site, edit the design tokens at the top of `src/styles/global.css` (colors, radii, spacing). Dark and light themes each have their own token block.

## Author photo
1. Pick a square photo (at least 400x400 px). Face centered.
2. Save it as `src/assets/author.jpg` (`.jpeg`, `.png` and `.webp` also work).
3. Set your real `name`, `role` and `bio` inside `author` in `src/config/site.ts`.
4. Run `npm run build`. The photo appears on the About page and next to your name on every article. With no photo, the site shows your initials instead.

## Logo and name
- Logo files: `public/logo.svg` (header, footer), `public/favicon.svg` (browser tab), and `public/icon-192.png`, `icon-512.png`, `apple-touch-icon.png` (phone home screen).
- To use a different logo later, replace those files and keep the same filenames.
- Site name: change `name` in `src/config/site.ts`, and the two names in `public/manifest.webmanifest`.
