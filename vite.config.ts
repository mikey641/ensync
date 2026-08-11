import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export default defineConfig({
  plugins: [react()],
  server: {
    watch: {
      ignored: ['**/desktop/release/**'],
    },
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.ENSYNC_HOST_PORT ?? '43121'}`,
        configure(proxy) {
          // The renderer decodes every /api reply as JSON. Vite's default proxy
          // failure is an HTML error page, which the client can only report as
          // an unreadable Host response, so a Host that is merely not running
          // yet reads as a fault with an unknown completion state. Answer with
          // the contract the packaged app's protocol handler uses.
          proxy.on('error', (error, request, response) => {
            if (!('writeHead' in response) || response.headersSent) return
            const code = error && 'code' in error ? String(error.code) : ''
            const safeToRetry = IDEMPOTENT_METHODS.has(request.method ?? 'GET')
              || code === 'ECONNREFUSED'
            response.writeHead(502, {
              'Cache-Control': 'no-store',
              'Content-Type': 'application/json; charset=utf-8',
            })
            response.end(JSON.stringify({
              error: safeToRetry
                ? 'Ensync Host is unavailable. Nothing was delivered, so this can be retried.'
                : 'Ensync Host became unreachable while this request was in flight, so its completion state is unknown.',
              code: 'host_unavailable',
              safeToRetry,
            }))
          })
        },
      },
    },
  },
})
