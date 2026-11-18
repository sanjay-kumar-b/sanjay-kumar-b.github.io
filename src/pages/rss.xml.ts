import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getArticles } from '../lib/articles';
import { SITE } from '../config/site';

export async function GET(context: APIContext) {
  const articles = await getArticles();
  return rss({
    title: SITE.name,
    description: SITE.description,
    site: context.site!,
    items: articles.slice(0, 50).map((a) => ({
      title: a.data.title,
      description: a.data.description,
      pubDate: a.data.publishedAt,
      link: `/articles/${a.id}/`,
      categories: [a.data.category, ...a.data.tags],
    })),
  });
}
