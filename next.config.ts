import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Pin the workspace root. Without this Turbopack walks up and finds an
  // unrelated package-lock.json in the home directory, then warns about it.
  turbopack: { root: import.meta.dirname },
};

export default nextConfig;
