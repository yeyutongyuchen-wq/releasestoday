export default defineConfig({
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
});
