import { pathToFileURL } from "node:url";
import type { NexusRuntime, Plugin } from "../types/index.js";

/**
 * PluginLoader — discovers and loads Nexus plugins.
 *
 * Plugins can provide:
 * - Additional tools
 * - Platform adapters
 * - Setup/teardown lifecycle hooks
 */
export class PluginLoader {
  private plugins: Map<string, Plugin> = new Map();

  /**
   * Load a plugin from a file path or npm package name.
   */
  async load(source: string): Promise<Plugin> {
    if (this.plugins.has(source)) {
      return this.plugins.get(source)!;
    }

    try {
      let module: { default?: Plugin; plugin?: Plugin };

      if (source.startsWith("/") || source.startsWith("./") || source.startsWith("../")) {
        // File path — dynamic import with file:// URL
        module = await import(pathToFileURL(source).href);
      } else {
        // npm package name
        module = await import(source);
      }

      const plugin = module.default ?? module.plugin;
      if (!plugin || !plugin.name) {
        throw new Error(
          `Plugin "${source}" does not export a valid Plugin object (must have a "name" property)`,
        );
      }

      this.plugins.set(source, plugin);
      return plugin;
    } catch (err) {
      throw new Error(
        `Failed to load plugin "${source}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Load multiple plugins and initialize them.
   */
  async loadAll(
    sources: string[],
    runtime: NexusRuntime,
  ): Promise<Plugin[]> {
    const loaded: Plugin[] = [];

    for (const source of sources) {
      const plugin = await this.load(source);

      // Register plugin tools
      if (plugin.tools) {
        for (const tool of plugin.tools) {
          runtime.registerTool(tool);
        }
      }

      // Register plugin platforms
      if (plugin.platforms) {
        for (const platform of plugin.platforms) {
          runtime.registerPlatform(platform);
        }
      }

      // Run plugin setup
      if (plugin.setup) {
        await plugin.setup(runtime);
      }

      loaded.push(plugin);
    }

    return loaded;
  }

  /**
   * Teardown all loaded plugins.
   */
  async teardownAll(): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (plugin.teardown) {
        try {
          await plugin.teardown();
        } catch {
          // Best-effort teardown
        }
      }
    }
    this.plugins.clear();
  }

  getLoaded(): Plugin[] {
    return Array.from(this.plugins.values());
  }
}
