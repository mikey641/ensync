import { defineConfig } from 'vite'

// Relative asset URLs keep the built PWA mounted under any HTTPS path.
// The public site serves it at https://ensync.vercel.app/mobile/.
export default defineConfig({
  base: './',
})
