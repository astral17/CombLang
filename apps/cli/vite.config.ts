import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: 'dist',
    rollupOptions: {
      external: [/^node:/],
      output: {
        entryFileNames: 'main.js',
      },
    },
    ssr: 'src/main.ts',
    target: 'node22',
  },
  ssr: {
    noExternal: [/^@comblang\//],
  },
});
