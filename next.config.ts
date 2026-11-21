import type { NextConfig } from 'next';

const requestedBuildDir = process.env.ZEZO_NEXT_BUILD_DIR;
const buildDir = requestedBuildDir && /^\.next-[a-z0-9-]+$/.test(requestedBuildDir)
  ? requestedBuildDir
  : '.next';

const protectedPageHeaders = [
  { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive, nosnippet' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
];

const nextConfig: NextConfig = {
  distDir: buildDir,
  poweredByHeader: false,
  images: {
    // The optimizer's internal asset request does not carry the staging
    // cookie. Let the authenticated browser request the protected image.
    unoptimized: process.env.ZEZO_STAGING === 'true' || process.env.CONTEXT === 'deploy-preview'
  },
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
      ...['/team', '/activate', '/account/:path*', '/reviews/moderation'].map(source => ({ source, headers: protectedPageHeaders }))
    ];
  }
};

export default nextConfig;
