import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The repo already documents itself in README.md; don't generate AGENTS.md/CLAUDE.md.
  agentRules: false,
  // The floating dev badge sits over the timeline during a live demo.
  devIndicators: false,
};

export default nextConfig;
