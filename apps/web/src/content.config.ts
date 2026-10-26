// Content collections. /changelog is built from src/content/releases/*.md, one file per release.
//
// Maintainer note:
// - One file per release (e.g. 1.0.0.md), curated by hand: a headline, up to 3 highlights and the
//   notable changes in plain words. Not one line per pull request.
// - `draft: true` hides a release until that release ships; flip it to false (or delete the line) on release day.
// - `changes[].kind` is one of: added, improved, fixed.
// - `image` is a capture name from src/assets/app without "-dark.png" (catchup, review, map, …).
// - The Markdown body is the summary paragraph under the headline.
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const releases = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/releases' }),
  schema: z.object({
    version: z.string(),
    /** Short name shown on the page, e.g. "1.0.0". Its slug is the anchor. */
    label: z.string(),
    /** Release date, shown as "Oct 16". */
    date: z.coerce.date(),
    draft: z.boolean().default(false),
    headline: z.string(),
    soft: z.string(),
    image: z.string().optional(),
    imageAlt: z.string().optional(),
    highlights: z.array(z.object({ title: z.string(), text: z.string() })).max(3).default([]),
    changes: z.array(z.object({ kind: z.enum(['added', 'improved', 'fixed']), text: z.string() })).default([]),
  }),
});

export const collections = { releases };
