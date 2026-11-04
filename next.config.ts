import type { NextConfig } from 'next';

const requestedBuildDir = process.env.ZEZO_NEXT_BUILD_DIR;
const buildDir = requestedBuildDir && /^\.next-[a-z0-9-]+$/.test(requestedBuildDir)
  ? requestedBuildDir
  : '.next';

const nextConfig: NextConfig = {
  distDir: buildDir,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' }
        ]
      }
    ];
  }
};

export default nextConfig;
