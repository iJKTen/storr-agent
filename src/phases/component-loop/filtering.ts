import type { Inventory } from '../../types.js';
import { log } from '../../log.js';

const ASSET_PREFIXES = ['Icon/', 'Asset/'];
const BUILDABLE_TYPES = new Set(['COMPONENT_SET', 'COMPONENT', 'FRAME']);
const DEV_STATUS_TYPES = new Set(['FRAME', 'SECTION', 'GROUP']);
const RESERVED_NAMES = new Set(['Link', 'Logo', 'Favicon']);
const DATA_BINDING_PATTERN = /^\{\{.*\}\}$/;

function isSkippable(item: { name: string; type: string; devStatus?: { type: string } }): boolean {
  if (!BUILDABLE_TYPES.has(item.type)) return true;
  if (RESERVED_NAMES.has(item.name)) return true;
  if (DATA_BINDING_PATTERN.test(item.name)) return true;
  if (ASSET_PREFIXES.some((p) => item.name.startsWith(p))) return true;
  if (DEV_STATUS_TYPES.has(item.type) && item.devStatus?.type !== 'READY_FOR_DEV') return true;
  return false;
}

export function collectBuildableComponents(inventories: Inventory[]): string[] {
  const names: string[] = [];
  for (const inv of inventories) {
    if (!('components' in inv)) continue;
    for (const item of inv.components) {
      if (isSkippable(item)) {
        log('component_loop', `Skipping: ${item.name}`);
        continue;
      }
      names.push(item.name);
    }
  }
  return names;
}
