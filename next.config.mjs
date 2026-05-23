// next.config.mjs

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    GROK_API_KEY: process.env.GROK_API_KEY,
  },
};

module.exports = nextConfig;