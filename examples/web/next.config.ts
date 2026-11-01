import type { NextConfig } from 'next';
import { resolveTokenEndpoint } from './src/config';

const isDev = process.env.NODE_ENV !== 'production';

// The only network destinations the page needs: the host token route, and LiveKit (signalling over
// wss, region discovery over https). Self-hosted LiveKit servers can be added with
// VB_WEB_EXTRA_CONNECT_SRC (space-separated origins). Nothing else is reachable from the page.
const tokenOrigin = new URL(resolveTokenEndpoint(process.env.NEXT_PUBLIC_VB_TOKEN_ENDPOINT)).origin;
const extraConnect = (process.env.VB_WEB_EXTRA_CONNECT_SRC ?? '').split(/\s+/).filter(Boolean);
const connectSrc = [
  "'self'",
  tokenOrigin,
  'wss://*.livekit.cloud',
  'https://*.livekit.cloud',
  ...extraConnect,
  ...(isDev ? ['ws://localhost:*'] : []),
];

const csp = [
  "default-src 'self'",
  // Next.js injects inline bootstrap scripts; dev mode also needs eval for fast refresh.
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src ${connectSrc.join(' ')}`,
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Don't generate an AGENTS.md in this directory (the repository has its own).
  agentRules: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          // Microphone for this origin only. Camera and screen capture are disabled outright.
          {
            key: 'Permissions-Policy',
            value: 'microphone=(self), camera=(), display-capture=(), geolocation=()',
          },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
    ];
  },
};

export default nextConfig;
