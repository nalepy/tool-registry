/**
 * seed.ts — populate Cloudflare KV from manifest.json
 *
 * Usage:
 *   npm run seed              # generate + upload to KV
 *   npm run seed:generate     # generate seed-data.json only (then: npx wrangler kv:bulk put --binding REGISTRY seed-data.json)
 *
 * Requires wrangler to be logged in: npx wrangler login
 */

import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

interface ManifestEntry {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  parameters?: Record<string, unknown>;
  invoke: Record<string, unknown>;
}

interface KVEntry {
  key: string;
  value: string;
}

function buildKVEntries(manifest: ManifestEntry[]): KVEntry[] {
  const entries: KVEntry[] = [];

  // Individual tool entries
  for (const tool of manifest) {
    const id = tool.id
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "");

    entries.push({
      key: `tool:${id}`,
      value: JSON.stringify({
        id,
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? {},
        invoke: tool.invoke,
        tags: tool.tags ?? [],
        createdAt: new Date().toISOString(),
      }),
    });
  }

  // Index entry (for fast search)
  const index = manifest.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    tags: t.tags ?? [],
  }));

  entries.push({
    key: "index",
    value: JSON.stringify(index),
  });

  return entries;
}

const manifestPath = join(ROOT, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ManifestEntry[];
const entries = buildKVEntries(manifest);

const outputPath = join(ROOT, "seed-data.json");
writeFileSync(outputPath, JSON.stringify(entries, null, 2));
console.log(`Generated ${entries.length} KV entries → seed-data.json`);
console.log(`  Tool entries: ${entries.length - 1}`);
console.log(`  Index entry:  1 (${manifest.length} tools)`);

const generateOnly = process.argv.includes("--generate-only");
if (generateOnly) {
  console.log("\nDry run. To upload:");
  console.log("  npx wrangler kv bulk put --binding REGISTRY seed-data.json");
  process.exit(0);
}

// Upload via wrangler
console.log("\nUploading to Cloudflare KV...");
try {
  execSync(`npx wrangler kv bulk put --binding REGISTRY "${outputPath}"`, {
    stdio: "inherit",
    cwd: ROOT,
  });
  console.log(`\n✓ ${manifest.length} tools seeded into KV registry`);
} catch (e) {
  console.error("Upload failed. Make sure wrangler is logged in: npx wrangler login");
  console.error("Or upload manually: npx wrangler kv:bulk put --binding REGISTRY seed-data.json");
  process.exit(1);
}
