import { getCollection, type CollectionEntry } from 'astro:content';
import { CATEGORIES, getCategory } from '../config/categories';
import { resolveCover, hasCoverImage } from './covers';

export type Article = CollectionEntry<'articles'>;

const isLive = (a: Article) => !a.data.draft && a.data.publishedAt.getTime() <= Date.now();

let reported = false;

/** All publishable articles, newest first. Future-dated and draft articles are hidden. */
export async function getArticles(): Promise<Article[]> {
  const all = await getCollection('articles', isLive);
  // Covers: match by the `cover` file name, else by an image named after the article (slug.jpg).
  for (const a of all) a.data.cover = resolveCover(a.id, a.data.cover);
  if (!reported) {
    reported = true;
    const missing = all.filter((a) => !hasCoverImage(a.id, a.data.cover)).map((a) => a.id);
    if (missing.length) console.warn(`\n[covers] ${missing.length} article(s) have no image in src/assets/covers (fallback art is used):\n  - ${missing.join('\n  - ')}\n`);
    else console.log(`[covers] all ${all.length} articles have a cover image.`);
  }
  // Tie-break on id so articles published on the same day keep a stable order across builds.
  return all.sort((a, b) => b.data.publishedAt.getTime() - a.data.publishedAt.getTime() || a.id.localeCompare(b.id));
}

export function readingTime(body = ''): number {
  const words = body.replace(/```[\s\S]*?```/g, ' ').split(/\s+/).filter(Boolean).length;
  const code = (body.match(/```/g)?.length ?? 0) / 2;
  return Math.max(1, Math.round(words / 220 + code * 0.5));
}

export const fmtDate = (d: Date) =>
  d.toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'Asia/Kolkata' });

export const isoDate = (d: Date) => d.toISOString();

export const tagSlug = (t: string) =>
  t.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function allTags(articles: Article[]) {
  const map = new Map<string, { name: string; slug: string; count: number }>();
  for (const a of articles) {
    const seen = new Set<string>(); // count an article once per tag even if the tag is repeated
    for (const t of a.data.tags) {
      const slug = tagSlug(t);
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      const cur = map.get(slug);
      if (cur) cur.count++;
      else map.set(slug, { name: t, slug, count: 1 });
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Related = same category + shared tags, scored. */
export function related(current: Article, pool: Article[], limit = 3): Article[] {
  const tags = new Set(current.data.tags.map(tagSlug));
  return pool
    .filter((a) => a.id !== current.id)
    .map((a) => ({
      a,
      score:
        (a.data.category === current.data.category ? 2 : 0) +
        a.data.tags.filter((t) => tags.has(tagSlug(t))).length,
    }))
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score || y.a.data.publishedAt.getTime() - x.a.data.publishedAt.getTime())
    .slice(0, limit)
    .map((x) => x.a);
}

export const categoryCounts = (articles: Article[]) =>
  CATEGORIES.map((c) => ({ ...c, count: articles.filter((a) => a.data.category === c.slug).length }));

/** JSON for <script type="application/ld+json">: escapes "<" so content can never close the script tag. */
export const safeJson = (o: unknown) => JSON.stringify(o).replace(/</g, '\\u003c');

export const LEVELS = ['Beginner', 'Intermediate', 'Advanced'] as const;
export type Level = (typeof LEVELS)[number];

/**
 * Difficulty levels of an article, lowest first.
 * Order of precedence: the `level` frontmatter field, then Beginner/Intermediate/Advanced tags
 * (an article tagged with several, like "zero to advanced", belongs to each), then a guess from the title.
 */
export function levelsOf(a: Article): Level[] {
  const explicit = a.data.level ? [a.data.level] : LEVELS.filter((l) => a.data.tags.includes(l));
  if (explicit.length) return [...explicit].sort((x, y) => LEVELS.indexOf(x) - LEVELS.indexOf(y));
  const t = `${a.data.title} ${a.id}`;
  if (/zero|from scratch|first|basics|introduction|getting started|fundamentals|roadmap|what is/i.test(t)) return ['Beginner'];
  if (/advanced|architecture|reliab|idempot|graph|internals|deep|patterns|performance/i.test(t)) return ['Advanced'];
  return ['Intermediate'];
}

/** Short label for a badge: "Beginner" or "Beginner to Advanced". */
export function levelLabel(levels: Level[]): string {
  return levels.length > 1 ? `${levels[0]} to ${levels[levels.length - 1]}` : levels[0];
}

export const levelSlug = (l: Level) => l.toLowerCase();

export { CATEGORIES, getCategory };
