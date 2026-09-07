import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';

export default {
  site: 'https://releasestoday.pages.dev',
  output: 'static',
  session: false,
  adapter: cloudflare({
    imageService: 'compile',
    platformProxy: {
      enabled: true,
    },
  }),
  vite: {
    plugins: [tailwindcss()],
  },
};
