// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://releasestoday.pages.dev',
  // Astro 5+：原 hybrid 已并入 static。默认全部路由 prerender；
  // 仅 export const prerender = false 的路由进入 Worker。
  output: 'static',
  adapter: cloudflare({
    imageService: 'compile',
    platformProxy: {
      enabled: true,
    },
  }),
  vite: {
    plugins: [tailwindcss()],
  },
});
