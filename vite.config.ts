import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export const configuredAllowedHosts = (value = process.env.VITE_ALLOWED_HOSTS): string[] => [
  'trading-discovery-engine-production.up.railway.app',
  ...(value || '').split(',').map(host => host.trim()).filter(Boolean),
];

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // Keep Vite's Host-header protection enabled while allowing explicitly
      // configured deployment domains. This setting does not affect localhost.
      allowedHosts: configuredAllowedHosts(),
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
