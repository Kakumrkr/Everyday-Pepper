import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
import { SECURITY_HEADERS, SERVICE_WORKER_HEADERS } from './lib/security-headers';

const config: NextConfig = {
  // Self-contained server bundle for the Docker image (apps/web/Dockerfile).
  output: 'standalone',
  // Trace files from the monorepo root so workspace packages land in the standalone bundle.
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  poweredByHeader: false,
  reactStrictMode: true,
  headers() {
    return Promise.resolve([
      { source: '/:path*', headers: [...SECURITY_HEADERS] },
      { source: '/sw.js', headers: [...SERVICE_WORKER_HEADERS] },
    ]);
  },
};

export default config;
