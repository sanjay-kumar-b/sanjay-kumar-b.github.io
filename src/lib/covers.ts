import type { ImageMetadata } from 'astro';
import { getImage } from 'astro:assets';

// Cover images live in src/assets/covers/. The `cover` frontmatter value (for example
// "/images/covers/my-article.jpg") is matched by file name only, so existing articles keep working.
const modules = import.meta.glob<{ default: ImageMetadata }>('../assets/covers/*.{jpg,jpeg,png,webp,avif}', { eager: true });

const byFile = new Map<string, ImageMetadata>();
const byStem = new Map<string, ImageMetadata>();
for (const [path, mod] of Object.entries(modules)) {
  const file = path.split('/').pop()!.toLowerCase();
  byFile.set(file, mod.default);
  byStem.set(file.replace(/\.[^.]+$/, ''), mod.default);
}

/** Resolve a frontmatter `cover` value to an optimisable local image, if one exists. */
export function coverFor(cover?: string): ImageMetadata | undefined {
  if (!cover) return undefined;
  const file = cover.split('?')[0].split('/').pop()!.toLowerCase();
  return byFile.get(file) ?? byStem.get(file.replace(/\.[^.]+$/, ''));
}

/** A social-share sized JPEG (1200x675) for an article cover, as a path (not absolute). */
export async function ogCoverPath(cover?: string): Promise<string | undefined> {
  const meta = coverFor(cover);
  if (!meta) return cover && cover.startsWith('/') ? cover : undefined;
  const img = await getImage({ src: meta, width: 1200, height: 675, format: 'jpeg', quality: 82 });
  return img.src;
}

/** Small WebP thumbnail used by the client-side search results. */
export async function thumbFor(cover?: string): Promise<{ src: string; w: number; h: number } | undefined> {
  const meta = coverFor(cover);
  if (!meta) return undefined;
  const img = await getImage({ src: meta, width: 640, height: 360, format: 'webp', quality: 78 });
  return { src: img.src, w: 640, h: 360 };
}

/**
 * Decide which cover an article uses. Order: the `cover` frontmatter file name, then an image named
 * after the article's file name (my-article.md -> src/assets/covers/my-article.jpg). Returns the
 * frontmatter value untouched when nothing matches, so the card shows the generated fallback art.
 */
export function resolveCover(articleId: string, cover?: string): string | undefined {
  if (coverFor(cover)) return cover;
  const stem = articleId.replace(/\.[^.]+$/, '').split('/').pop()!.toLowerCase();
  const hit = [...byFile.keys()].find((f) => f.replace(/\.[^.]+$/, '') === stem);
  return hit ? `/images/covers/${hit}` : cover;
}

/** True when a real image exists for this article (used for the build-time report). */
export const hasCoverImage = (articleId: string, cover?: string) => !!coverFor(resolveCover(articleId, cover));
