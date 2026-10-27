import type { LLMClient } from "../types.js";
import type { ConversationHistory } from "../llm/index.js";
import type { BootContext } from "../figma/context.js";
import { log } from "../log.js";

function buildInventorySection(ctx: BootContext): string[] {
  const buildableInventories = ctx.project.inventories.filter((inv) =>
    ctx.yaml.buildableDirs.has(inv.page.toLowerCase()),
  );
  const dumps = buildableInventories.map(
    (inv) => "```yaml\n" + JSON.stringify(inv, null, 2) + "\n```",
  );
  return ["## Inventories", "", ...dumps];
}

function buildPlanRequirements(): string[] {
  return [
    "## Requirements", "",
    "1. List every component from the component inventories.",
    '2. Mark which components already exist in the scaffold vs need to be built. Use the "Existing Scaffold Components" table above as ground truth — components listed there MUST be classified as "Update/Reskin", not "New build".',
    "3. Define build order (dependencies first).",
    "4. Map each page YAML frame to its route file.",
    '5. Include an "Unmapped Files: None" section at the end confirming all YAML files are accounted for.',
    "",
    'Output the plan as Markdown. End with exactly "Unmapped Files: None" if all files are mapped.',
  ];
}

function buildPlanPrompt(ctx: BootContext): string {
  const yamlFileList = ctx.yaml.buildableEntries
    .map((e) => `- ${e.relativePath}`)
    .join("\n");

  return [
    "Generate a build plan for this project. Read the following inventory data and create a comprehensive plan.",
    "", ...buildInventorySection(ctx),
    "", "## All YAML Files", "", yamlFileList, "",
    ...buildExistingComponentsSection(ctx),
    ...buildPlanRequirements(),
  ].join("\n");
}

function buildExistingComponentsSection(ctx: BootContext): string[] {
  if (ctx.project.existingComponents.size === 0) return [];

  return [
    "## Existing Scaffold Components", "",
    "These components already exist in `app/components/`. They contain scaffold",
    "plumbing that MUST be preserved. Classify them as \"Update/Reskin\" in the plan.", "",
    "| Component | Path | Files |", "|---|---|---|",
    ...[...ctx.project.existingComponents.values()].map(
      (ec) => `| ${ec.name} | ${ec.directory} | ${[...ec.files.keys()].join(", ")} |`,
    ),
    "",
  ];
}

export async function plan(
  llm: LLMClient,
  history: ConversationHistory,
  ctx: BootContext,
): Promise<string> {
  if (ctx.project.inventories.length === 0) {
    log("plan", "No inventories found. Cannot generate plan.");
    throw new Error(
      "No inventory.yaml files found in .figma/build/. Run the Figma toolchain first.",
    );
  }

  history.clear();
  history.addUser(buildPlanPrompt(ctx));

  const response = await llm.chat(history.getAllForLLM());
  history.addAssistant(response.content);
  return response.content;
}

export function planEval(planContent: string): boolean {
  const stripped = planContent.replace(/\*+/g, '');
  return /Unmapped Files:\s*None/i.test(stripped);
}
