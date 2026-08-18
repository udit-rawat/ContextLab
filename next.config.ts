import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Pin the workspace root. Without this Turbopack walks up and finds an
  // unrelated package-lock.json in the home directory, then warns about it.
  turbopack: { root: import.meta.dirname },

  // The live-query route reads the committed index, skeleton and corpus from
  // disk at request time. Next's file tracing cannot see through readFileSync,
  // so without this the serverless bundle ships without them and every live
  // query fails with ENOENT -- while the precomputed page keeps working, which
  // makes the failure easy to miss.
  outputFileTracingIncludes: {
    '/api/query': ['./data/**/*', './corpus/**/*'],
  },
};

export default nextConfig;
