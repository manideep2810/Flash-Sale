/** @type {import('next').NextConfig} */
const config = {
  // Every page starts its API calls from an effect, and the gateway rate limits those per user (join
  // is 5 a minute). Strict mode runs each effect twice in development, which would double them.
  reactStrictMode: false,
  // The app is used through the gateway (http://localhost:8080), not on the dev server's own port, so
  // the dev server has to accept its hot-reload requests from that origin.
  allowedDevOrigins: ["localhost", "127.0.0.1"],
  // Types are checked by `pnpm typecheck`, like every other workspace; the build does not repeat it.
  typescript: { ignoreBuildErrors: true },
};

export default config;
