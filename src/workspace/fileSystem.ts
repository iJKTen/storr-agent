import type { YAMLFileEntry } from "../types.js";

/**
 * Format YAML tree entries for inclusion in the system message.
 */
export function formatYAMLTree(entries: YAMLFileEntry[]): string {
  if (entries.length === 0) {
    return "(no YAML files found in .figma/build/)";
  }
  return entries.map((e) => `  ${e.relativePath}`).join("\n");
}
