import { defineConfig } from 'vite';

const targetApi = process.env.VITE_API_URL || 'http://127.0.0.1:8080';

export default defineConfig({
  server: {
    port: 3000,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: targetApi,
        changeOrigin: true,
      },
      '/metrics': {
        target: targetApi,
        changeOrigin: true,
      },
    },
  },
  define: {
    'process.env.VITE_API_URL': JSON.stringify(process.env.VITE_API_URL || ''),
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
