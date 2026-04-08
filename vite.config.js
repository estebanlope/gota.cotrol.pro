import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        // Esta es la forma correcta en las versiones modernas
        manualChunks(id) {
          // Separa la librería de Supabase en su propio archivo para que cargue más rápido
          if (id.includes("@supabase")) {
            return "supabase-vendor";
          }
          // Separa otras librerías de node_modules
          if (id.includes("node_modules")) {
            return "vendor";
          }
        },
      },
    },
  },
  server: {
    port: 3000,
  },
});
