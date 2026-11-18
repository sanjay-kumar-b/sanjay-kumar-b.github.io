import { getArticles, getCategory, readingTime, levelsOf, levelLabel, levelSlug } from '../lib/articles';
import { thumbFor } from '../lib/covers';

export async function GET() {
  const articles = await getArticles();
  const index = await Promise.all(
    articles.map(async (a) => {
      const cat = getCategory(a.data.category);
      return {
        id: a.id,
        title: a.data.title,
        description: a.data.description,
        category: cat?.name ?? '',
        categorySlug: a.data.category,
        short: cat?.short ?? '',
        accent: cat?.accent ?? '#4d7cff',
        tags: a.data.tags,
        date: a.data.publishedAt.toISOString(),
        mins: readingTime(a.body),
        api: a.data.apiVersion,
        thumb: (await thumbFor(a.data.cover)) ?? null,
        level: (() => { const l = levelsOf(a); return { first: levelSlug(l[0]), last: levelSlug(l[l.length - 1]), label: levelLabel(l) }; })(),
        text: (a.body ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/[#>*_`\[\]()|]/g, ' ').replace(/\s+/g, ' ').slice(0, 2500),
      };
    }),
  );
  return new Response(JSON.stringify(index), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
