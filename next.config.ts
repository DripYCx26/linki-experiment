import type { NextConfig } from "next";
import { existsSync } from "fs";
import { join } from "path";

// Open-core: the hosted MCP + its OAuth routes are a commercial (ee/) feature. When ee/
// is stripped (public build), those routes don't exist, so the well-known rewrites below
// must NOT be emitted — otherwise they'd point at 404s. Gate them on ee/ being present.
const hasEE = existsSync(join(__dirname, "ee"));
const publicPremiumStub = "./lib/premium-unavailable.ts";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["better-sqlite3", "playwright", "playwright-extra", "puppeteer-extra-plugin-stealth"],

  // The public build intentionally has no ee/ directory. Point the one optional
  // premium import at an explicit null module so Turbopack/webpack do not report
  // the expected absence as a module-resolution warning on every compilation.
  ...(hasEE ? {} : {
    turbopack: {
      resolveAlias: {
        "@/ee": publicPremiumStub,
      },
    },
  }),

  webpack(config) {
    if (!hasEE) {
      config.resolve.alias["@/ee"] = join(__dirname, "lib/premium-unavailable.ts");
    }
    return config;
  },

  // OAuth discovery for the hosted MCP server must live at /.well-known/* (RFC 8414 / 9728).
  // Map those well-known paths to the pages-router API routes that serve the metadata.
  // Present only in the commercial build (see hasEE above).
  async rewrites() {
    if (!hasEE) return [];
    return [
      {
        source: "/.well-known/oauth-authorization-server",
        destination: "/api/oauth/metadata-authorization-server",
      },
      {
        source: "/.well-known/oauth-protected-resource",
        destination: "/api/oauth/metadata-protected-resource",
      },
      {
        // Clients probe the resource-scoped variant too.
        source: "/.well-known/oauth-protected-resource/api/mcp",
        destination: "/api/oauth/metadata-protected-resource",
      },
    ];
  },
};

export default nextConfig;
