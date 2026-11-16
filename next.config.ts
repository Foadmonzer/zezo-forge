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
      },
      {
        source: '/team',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive, nosnippet' },
          { key: 'Referrer-Policy', value: 'no-referrer' }
        ]
      },
      {
        source: '/activate',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive, nosnippet' },
          { key: 'Referrer-Policy', value: 'no-referrer' }
        ]
      }
    ];
  }
};

export default nextConfig;
