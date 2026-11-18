# SF SKODE – "Command Deck" redesign

This is the COMPLETE project. Unzip it, open a terminal IN the `sf-skode-site-redesigned` folder (the one containing package.json – not `src`), then run:

    npm install
    npm run dev

Open http://localhost:4321

## Files replaced
- src/styles/global.css          – whole design system (tokens, layout, components, motion, print)
- src/layouts/BaseLayout.astro   – background FX, cursor glow, back-to-top, theme bootstrap
- src/components/*               – Header, Footer, ArticleCard, CoverImage, TrackCard, Newsletter, Palette, SectionHead, Icon
                                   + NEW: Terminal, LibraryToolbar
- src/pages/*                    – every page restyled; home, library, article, categories, search rebuilt
- src/scripts/*                  – core, article, palette, search-core, search-page, util
                                   + NEW: hero, tabs, library
- src/lib/articles.ts            – adds level helpers; src/lib/snippets.ts is NEW (hero code terminal)
- src/content.config.ts          – adds OPTIONAL `level` field

## Not touched
astro.config.mjs, package.json, src/config/*, src/plugins/*, src/data/articles/*, your images.

## Good to know
- Level (Beginner/Intermediate/Advanced): uses optional `level:` frontmatter, else a Beginner/Intermediate/Advanced tag, else a title heuristic.
- Covers: still read from src/assets/covers via src/lib/covers.ts. Missing covers fall back to generated art (never a broken box).
- Card / cover layout lives in: ArticleCard.astro, CoverImage.astro and the `.card*` / `.cover-img` rules in global.css (16:9, object-fit: cover).
- Interactive: constellation canvas, rotating headline, live code terminal, hero search, track explorer, learning-path tabs, library filter/sort/view (URL state), tilt/spotlight/magnetic buttons, command palette (/ or Ctrl+K), theme toggle (T), reading progress, TOC scroll-spy, text size, back-to-top.
- Respects prefers-reduced-motion; works without JS.
