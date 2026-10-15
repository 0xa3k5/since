// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { SHOW_PRICING, SITE_URL } from './src/config.ts';

/**
 * Commerce-only pages live in src/pages/_commerce/ ("_" keeps Astro from routing them) and are added here
 * only while SHOW_PRICING is true, so the beta build has no /pricing, /licence or licence docs at all.
 */
const commercePages = () => ({
  name: 'gitlanes-commerce-pages',
  hooks: {
    /** @param {{ injectRoute: (r: { pattern: string; entrypoint: string }) => void }} opts */
    'astro:config:setup': ({ injectRoute }) => {
      if (!SHOW_PRICING) return;
      injectRoute({ pattern: '/pricing', entrypoint: './src/pages/_commerce/pricing.astro' });
      injectRoute({ pattern: '/licence', entrypoint: './src/pages/_commerce/licence.astro' });
      injectRoute({ pattern: '/docs/licence-and-trial', entrypoint: './src/pages/_commerce/licence-and-trial.astro' });
    },
  },
});

export default defineConfig({
  site: SITE_URL,
  output: 'static',
  trailingSlash: 'never',
  build: { format: 'file' },
  integrations: [commercePages(), sitemap()],
});
