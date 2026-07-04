/** @type {import('next').NextConfig} */
const nextConfig = {
  // The Anthropic SDK and pdf/embedding libraries are server-only Node packages.
  // Keeping them external avoids bundling issues in server routes.
  serverExternalPackages: ["@anthropic-ai/sdk", "@huggingface/transformers", "pdf-parse"],
};

export default nextConfig;
