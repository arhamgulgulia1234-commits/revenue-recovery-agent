import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The repo already documents itself in README.md; don't generate AGENTS.md/CLAUDE.md.
  agentRules: false,
};

export default nextConfig;
