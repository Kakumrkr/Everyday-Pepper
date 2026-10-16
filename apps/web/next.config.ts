import type { NextConfig } from 'next';

const config: NextConfig = {
  // Self-contained server bundle for the Docker image (apps/web/Dockerfile).
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
};

export default config;
