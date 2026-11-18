import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { glob } from 'astro/loaders';
import { CATEGORIES } from './config/categories';

const slugs = CATEGORIES.map((c) => c.slug) as [string, ...string[]];

const articles = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/data/articles' }),
  schema: z.object({
    title: z.string().max(110),
    description: z.string().min(50).max(170), // SEO meta description
    category: z.enum(slugs),
    tags: z.array(z.string()).default([]),
    publishedAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    draft: z.boolean().default(false),
    featured: z.boolean().default(false),
    level: z.enum(['Beginner', 'Intermediate', 'Advanced']).optional(), // optional: otherwise derived from the tags
    apiVersion: z.string().optional(), // e.g. "v66.0", only set when verified
    cover: z.string().optional(), // e.g. /images/covers/my-article.jpg; the file itself lives in src/assets/covers/ (matched by file name)
    // Every claim-bearing article should list the sources it used.
    sources: z
      .array(z.object({ title: z.string(), url: z.url() }))
      .default([]),
  }),
});

export const collections = { articles };
