/** @type {import('next').NextConfig} */
const nextConfig = {
  // firebase-admin must not be bundled by webpack — it does dynamic requires
  // and fails at runtime when bundled.
  experimental: {
    serverComponentsExternalPackages: ['firebase-admin'],
  },
}

module.exports = nextConfig
