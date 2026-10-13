// Content collections. The changelog is one Markdown file per merged change, grouped by version on /changelog.
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const changelog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/changelog' }),
  schema: z.object({
    title: z.string(),
    /** The version this change ships in. Unreleased versions say so on the page. */
    version: z.string(),
    /** Merge date into main. No other dates (no launch or release dates until the owner sets them). */
    merged: z.coerce.date(),
    kind: z.enum(['Added', 'Improved', 'Fixed', 'Behind the scenes']),
  }),
});

export const collections = { changelog };
