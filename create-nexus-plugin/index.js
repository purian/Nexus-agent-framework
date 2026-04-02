#!/usr/bin/env node

/**
 * create-nexus-plugin — Scaffold a new Nexus plugin project.
 *
 * Usage:
 *   npx create-nexus-plugin my-plugin
 *   npx create-nexus-plugin nexus-plugin-weather
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const pluginName = process.argv[2] ?? "nexus-plugin-example";
const dir = resolve(process.cwd(), pluginName);

console.log(`\nScaffolding Nexus plugin: ${pluginName}\n`);

// Create directory structure
mkdirSync(join(dir, "src"), { recursive: true });

// package.json
writeFileSync(
  join(dir, "package.json"),
  JSON.stringify(
    {
      name: pluginName,
      version: "0.1.0",
      description: `A Nexus plugin: ${pluginName}`,
      type: "module",
      main: "dist/index.js",
      types: "dist/index.d.ts",
      scripts: {
        build: "tsc",
        dev: "tsc --watch",
        test: "vitest run",
        "test:watch": "vitest",
      },
      dependencies: {
        "nexus-agent": "^0.11.0",
      },
      devDependencies: {
        typescript: "^5.5.0",
        vitest: "^2.0.0",
        zod: "^3.23.0",
      },
      license: "MIT",
    },
    null,
    2,
  ) + "\n",
);

// tsconfig.json
writeFileSync(
  join(dir, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        declaration: true,
        outDir: "dist",
        rootDir: "src",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
      },
      include: ["src"],
    },
    null,
    2,
  ) + "\n",
);

// src/index.ts — Plugin skeleton
writeFileSync(
  join(dir, "src", "index.ts"),
  `import { z } from "zod";
import type { Plugin, Tool, NexusRuntime } from "nexus-agent";

/**
 * Example tool provided by this plugin.
 *
 * Replace this with your own tool implementations.
 */
const exampleTool: Tool<{ input: string }, string> = {
  name: "${pluginName}-hello",
  description: "An example tool that greets the user",
  inputSchema: z.object({
    input: z.string().describe("Name to greet"),
  }),
  async execute({ input }) {
    return { data: \`Hello, \${input}! (from ${pluginName})\` };
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
};

/**
 * ${pluginName} — A Nexus plugin.
 */
const plugin: Plugin = {
  name: "${pluginName}",
  version: "0.1.0",
  description: "A Nexus plugin",
  tools: [exampleTool],

  async setup(nexus: NexusRuntime) {
    // Called when the plugin is loaded.
    // Use nexus.registerTool() or nexus.registerPlatform() for dynamic registration.
  },

  async teardown() {
    // Called when the plugin is unloaded. Clean up resources here.
  },
};

export default plugin;
export { exampleTool };
`,
);

// src/index.test.ts — Basic test
writeFileSync(
  join(dir, "src", "index.test.ts"),
  `import { describe, it, expect } from "vitest";
import plugin, { exampleTool } from "./index.js";

describe("${pluginName}", () => {
  it("has correct plugin metadata", () => {
    expect(plugin.name).toBe("${pluginName}");
    expect(plugin.version).toBe("0.1.0");
    expect(plugin.tools).toHaveLength(1);
  });

  it("example tool executes correctly", async () => {
    const result = await exampleTool.execute(
      { input: "World" },
      {
        workingDirectory: "/tmp",
        abortSignal: new AbortController().signal,
        permissions: {} as never,
        config: {} as never,
      },
    );
    expect(result.data).toBe("Hello, World! (from ${pluginName})");
  });

  it("example tool is concurrency-safe and read-only", () => {
    expect(exampleTool.isConcurrencySafe({ input: "" })).toBe(true);
    expect(exampleTool.isReadOnly({ input: "" })).toBe(true);
  });
});
`,
);

// README.md
writeFileSync(
  join(dir, "README.md"),
  `# ${pluginName}

A plugin for the [Nexus Agent Framework](https://github.com/purian/Nexus-agent-framework).

## Getting Started

\`\`\`bash
npm install
npm run build
npm test
\`\`\`

## Usage

Add this plugin to your Nexus configuration:

\`\`\`json
{
  "plugins": ["./${pluginName}"]
}
\`\`\`

## Development

\`\`\`bash
npm run dev    # Watch mode
npm test       # Run tests
\`\`\`
`,
);

console.log(`  Created ${pluginName}/`);
console.log(`    package.json`);
console.log(`    tsconfig.json`);
console.log(`    src/index.ts`);
console.log(`    src/index.test.ts`);
console.log(`    README.md`);
console.log(`\nNext steps:`);
console.log(`  cd ${pluginName}`);
console.log(`  npm install`);
console.log(`  npm test\n`);
