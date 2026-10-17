// Content collections. The changelog is one Markdown file per beta build, newest first on /changelog.
// The body is the release story; highlights and the full change list live in the frontmatter.
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const changelog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/changelog' }),
  schema: ({ image }) => z.object({
    /** Display name, e.g. "Beta 1". */
    title: z.string(),
    /** The build's version tag, e.g. "0.1.0-beta.1". Omit while the build is in development. */
    version: z.string().optional(),
    /** Page order, highest first. No dates (no launch or release dates until AK sets them). */
    order: z.number(),
    released: z.boolean(),
    headline: z.string(),
    /** Second half of the headline, set in a softer colour. */
    soft: z.string().optional(),
    /** Optional real capture of the biggest change (src/assets/app/, dark theme). */
    shot: image().optional(),
    shotAlt: z.string().optional(),
    highlights: z.array(z.object({ title: z.string(), text: z.string() })).max(3),
    changes: z.array(z.object({ kind: z.enum(['Added', 'Improved', 'Fixed']), text: z.string() })),
  }),
});

export const collections = { changelog };
