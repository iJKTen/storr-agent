import { readFile, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentConfig, AgentState } from '../types.js';

// ── Always-included modules ──

const ALWAYS_MODULES = ['core.md', 'typescript.md', 'css-core.md'];

// ── Phase modules ──

const PHASE_MODULES: Partial<Record<AgentState, string[]>> = {
  foundation: ['phase-foundation.md'],
  plan: [
    'phase-plan.md',
    'yaml-interpretation.md',
    'figma-directives.md',
    'scaffold.md',
    'routes.md',
    'service-layer.md',
    'storefront-types.md',
  ],
  component_loop: [
    'phase-component.md',
    'yaml-interpretation.md',
    'figma-directives.md',
    'accessibility.md',
  ],
  integration: [
    'phase-integration.md',
    'yaml-interpretation.md',
    'scaffold.md',
    'routes.md',
    'service-layer.md',
  ],
  final_audit: ['phase-audit.md'],
};

// ── Component detection heuristics ──

interface DetectionRule {
  module: string;
  namePatterns: RegExp[];
  yamlPatterns: RegExp[];
  hookFiles?: string[];
}

interface DetectionRuleJSON {
  module: string;
  namePatterns: string[];
  yamlPatterns: string[];
  hookFiles?: string[];
}

function compileRules(raw: DetectionRuleJSON[]): DetectionRule[] {
  return raw.map((r) => ({
    module: r.module,
    namePatterns: r.namePatterns.map((p) => new RegExp(p, 'i')),
    yamlPatterns: r.yamlPatterns.map((p) => new RegExp(p)),
    hookFiles: r.hookFiles,
  }));
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const rawRules = JSON.parse(
  readFileSync(join(__dirname, 'detection-rules.json'), 'utf-8'),
) as DetectionRuleJSON[];

const DETECTION_RULES: DetectionRule[] = compileRules(rawRules);

export interface RuleSelection {
  modules: string[];
  hookFiles: string[];
}

function matchDetectionRules(
  componentName: string | undefined,
  yamlContent: string | undefined,
): { modules: Set<string>; hookFiles: Set<string> } {
  const modules = new Set<string>();
  const hookFiles = new Set<string>();

  for (const rule of DETECTION_RULES) {
    let matched = false;
    if (componentName) {
      matched = rule.namePatterns.some((p) => p.test(componentName));
    }
    if (!matched && yamlContent) {
      matched = rule.yamlPatterns.some((p) => p.test(yamlContent));
    }
    if (matched) {
      modules.add(rule.module);
      if (rule.hookFiles) {
        for (const hf of rule.hookFiles) hookFiles.add(hf);
      }
    }
  }

  return { modules, hookFiles };
}

function collectPhaseModules(phase: AgentState): Set<string> {
  const modules = new Set<string>(ALWAYS_MODULES);
  const phaseModules = PHASE_MODULES[phase];
  if (phaseModules) {
    for (const mod of phaseModules) modules.add(mod);
  }
  return modules;
}

export function selectRulesWithHooks(
  phase: AgentState,
  componentName?: string,
  yamlContent?: string,
): RuleSelection {
  const modules = collectPhaseModules(phase);
  const hookFiles = new Set<string>();

  if (phase === 'component_loop' && (componentName || yamlContent)) {
    const detected = matchDetectionRules(componentName, yamlContent);
    for (const mod of detected.modules) modules.add(mod);
    for (const hf of detected.hookFiles) hookFiles.add(hf);
  }

  return { modules: [...modules], hookFiles: [...hookFiles] };
}

export function selectRules(
  phase: AgentState,
  componentName?: string,
  yamlContent?: string,
): string[] {
  return selectRulesWithHooks(phase, componentName, yamlContent).modules;
}

export function resolveHookFiles(componentNames: string[]): string[] {
  const hookFiles = new Set<string>();
  for (const name of componentNames) {
    const detected = matchDetectionRules(name, undefined);
    for (const hf of detected.hookFiles) hookFiles.add(hf);
  }
  return [...hookFiles];
}

async function readRuleModule(rulesPath: string, filename: string): Promise<string> {
  return readFile(join(rulesPath, filename), 'utf-8');
}

export interface AssembledRules {
  content: string;
  hookFiles: string[];
}

export async function assembleSystemMessage(
  config: AgentConfig,
  phase: AgentState,
  componentName?: string,
  yamlContent?: string,
): Promise<AssembledRules> {
  const { modules, hookFiles } = selectRulesWithHooks(phase, componentName, yamlContent);
  const parts: string[] = [];

  for (const name of modules) {
    const content = await readRuleModule(config.paths.rulesPath, name);
    parts.push(content);
  }

  return { content: parts.join('\n\n---\n\n'), hookFiles };
}

export async function listRuleModules(rulesPath: string): Promise<string[]> {
  const entries = await readdir(rulesPath);
  return entries.filter((e) => e.endsWith('.md')).sort();
}
