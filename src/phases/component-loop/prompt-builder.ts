import type { ExistingComponent, SemanticElement } from '../../types.js';
import type { FigmaNode } from '../../figma/figma-node.js';
import { resolveExistingComponent, resolveDataBindingDep } from '../../figma/context.js';
import { parseYAMLDesignData, extractSemanticElements } from '../../figma/yaml-parser.js';
import { collectComponentIds } from './dependency-graph.js';
import type { ComponentBuildInput, PromptExtras } from './types.js';

function formatExistingComponentFiles(existing: ExistingComponent): string {
  const parts: string[] = [];
  for (const [filename, content] of existing.files) {
    const ext = filename.substring(filename.lastIndexOf('.') + 1);
    const lang = ext === 'tsx' || ext === 'ts' ? 'tsx' : ext === 'css' ? 'css' : ext;
    parts.push(`### ${filename}`, '', `\`\`\`${lang}`, content, '```', '');
  }
  return parts.join('\n');
}

export function resolveScaffoldDeps(
  nodes: FigmaNode[],
  componentIdIndex: Map<string, string>,
  existingComponents: Map<string, ExistingComponent>,
  currentName: string,
): ExistingComponent[] {
  const deps = new Map<string, ExistingComponent>();
  const ids = collectComponentIds(nodes);
  for (const id of ids) {
    const name = componentIdIndex.get(id);
    if (!name || name === currentName) continue;
    const resolved = resolveExistingComponent(name, existingComponents)
      ?? resolveDataBindingDep(name, existingComponents);
    if (resolved && !deps.has(resolved.name)) {
      deps.set(resolved.name, resolved);
    }
  }
  return [...deps.values()];
}

function buildUpdatePreamble(input: ComponentBuildInput): string[] {
  if (!input.existing) return [];
  return [
    `UPDATE the existing scaffold component based on this YAML design data.`,
    `Do NOT rebuild from scratch — reskin the existing component.`,
    '', '```yaml', input.yaml, '```', '',
    '## Existing Source Files', '',
    `These files currently exist in \`${input.existing.directory}/\`:`, '',
    formatExistingComponentFiles(input.existing),
    '## CRITICAL UPDATE RULES', '',
    '- **PRESERVE**: All existing props, hooks, Shopify/Hydrogen imports, analytics, cart plumbing, context providers',
    '- **INTEGRATE**: If scaffold component dependencies are listed below, ADD their imports and use them in your output',
    '- **RESKIN**: CSS classes, JSX structure, static text — using the YAML design data above',
    '- **Sub-component files are untouched**: `write_component` only writes index.tsx, CSS, and content.ts. Other files in the directory (e.g. HeaderCtas.tsx, CartToggle.tsx) remain as-is — keep importing them.',
    '- **Icon replacement**: If a sub-component (e.g. CartToggle) renders text but the YAML shows an IMAGE-SVG icon at that position, render the SVG icon directly in index.tsx with `useAside()` for the click handler. Do NOT rely on the sub-component to display the icon.', '',
  ];
}

function buildNewPreamble(yaml: string): string[] {
  return [
    `Build the component based on this YAML design data.`,
    '', '```yaml', yaml, '```', '',
  ];
}

function buildClassNameSection(): string[] {
  return [
    '## className Prop', '',
    'The root element must accept an optional `className` prop and merge it with the CSS module class:',
    "`className={[styles.<rootClass>, className].filter(Boolean).join(' ')}`",
    "Add `className?: string` to the component's props interface.", '',
  ];
}

function formatPackageDep(pkg: string): string[] {
  return [
    `- \`${pkg}\` (already installed via npm).`,
    `  Import and use its API as needed.`, '',
  ];
}

function buildPackageSection(names?: string[]): string[] {
  if (!names?.length) return [];
  return ['## Package Dependencies', '', ...names.flatMap(formatPackageDep)];
}

function buildHookSection(hooks?: Array<{ path: string; content: string }>): string[] {
  if (!hooks || hooks.length === 0) return [];
  const parts = [
    '## Pre-built Source Files (read-only — do NOT modify these files)', '',
    'These files are already built. Use their exports in your component.', '',
  ];
  for (const hook of hooks) {
    parts.push(`### ${hook.path}`, '', '```tsx', hook.content, '```', '');
  }
  return parts;
}

function buildScaffoldDepsSection(deps?: ExistingComponent[]): string[] {
  if (!deps || deps.length === 0) return [];
  const parts = [
    '## Scaffold Component Dependencies (read-only)', '',
    'These components already exist. Import and use them — do NOT rebuild.', '',
  ];
  for (const dep of deps) {
    parts.push(`### ${dep.name} (\`${dep.directory}/\`)`, '');
    parts.push(formatExistingComponentFiles(dep));
  }
  return parts;
}

function buildPreviouslyBuiltInterfacesSection(
  interfaces?: Map<string, string>,
): string[] {
  if (!interfaces || interfaces.size === 0) return [];
  return [
    '## Previously Built Component Interfaces (read-only reference)', '',
    'These are TypeScript interfaces for components already built in this codebase.',
    'If the scaffold code imports any of these components, use ONLY the props listed here.',
    'Do NOT pass props (like `className`) unless the interface defines them.', '',
    ...Array.from(interfaces.entries()).flatMap(([name, iface]) => [
      `### ${name}`, '```typescript', iface, '```', '',
    ]),
  ];
}

function formatCSSChecklist(classNames: string[]): string[] {
  return [
    '**CSS classes** — your CSS module MUST define all of these selectors:',
    ...classNames.map((c) => `- \`.${c}\``), '',
  ];
}

function formatTextChecklist(texts: string[]): string[] {
  return [
    '**Text content** — these exact strings must appear in your TSX or content.ts:',
    ...texts.map((t) => `- \`${t}\``), '',
  ];
}

function formatSvgChecklist(svgNodes: Array<{ name: string; assetPath?: string }>): string[] {
  return [
    '**SVG imports** — each IMAGE-SVG node requires a matching import:',
    ...svgNodes.map((entry) => {
      const slug = entry.name.toLowerCase().replace(/[\s_]+/g, '-');
      const importPath = entry.assetPath
        ? `~/` + entry.assetPath.replace(/^app\//, '')
        : `~/assets/${slug}.svg`;
      return `- \`${entry.name}\` → \`import from '${importPath}'\``;
    }), '',
  ];
}

function formatPropTextChecklist(propTexts: Array<{ text: string; propName: string }>): string[] {
  return [
    '**Component property text** — these are instance-configurable props, NOT static content.',
    'Do NOT put these in content.ts. Accept them as required props:',
    ...propTexts.map((p) => {
      const propKey = p.propName.charAt(0).toLowerCase() + p.propName.slice(1).replace(/\s+/g, '');
      return `- \`${propKey}: string\` (Figma prop: "${p.propName}", default: "${p.text}")`;
    }), '',
  ];
}

function buildStaticTextDirective(hasTexts: boolean): string[] {
  if (!hasTexts) {
    return [
      '**No static text** — the YAML data contains no hardcoded text for this component.',
      'Do NOT create a `content.ts` file. Omit the `contentTsContent` parameter entirely.', '',
    ];
  }
  return [
    '**Static text** — extract all hardcoded text into `content.ts`.',
    'Populate the `contentTsContent` parameter with the file contents.',
    'Import and reference the `content` object in your TSX — do not inline these strings.', '',
  ];
}

function buildEvalChecklist(designData: { classNames: string[]; texts: string[]; propTexts: Array<{ text: string; propName: string }>; svgNodes: Array<{ name: string; assetPath?: string }> }): string[] {
  const hasContent = designData.classNames.length > 0 || designData.texts.length > 0 || designData.propTexts.length > 0 || designData.svgNodes.length > 0;
  if (!hasContent) return [];

  const parts = ['## Eval Checklist (your output will be validated against these)', ''];
  parts.push(...buildStaticTextDirective(designData.texts.length > 0));
  if (designData.classNames.length > 0) parts.push(...formatCSSChecklist(designData.classNames));
  if (designData.texts.length > 0) parts.push(...formatTextChecklist(designData.texts));
  if (designData.propTexts.length > 0) parts.push(...formatPropTextChecklist(designData.propTexts));
  if (designData.svgNodes.length > 0) parts.push(...formatSvgChecklist(designData.svgNodes));
  return parts;
}

function formatSemanticTag(e: SemanticElement): string {
  if (e.type) return `<${e.element} type="${e.type}" name="${e.type}" id="${e.type}" />`;
  return `<${e.element}>`;
}

function buildSemanticSection(
  elements: SemanticElement[],
): string[] {
  if (elements.length === 0) return [];
  return [
    '**Semantic HTML** — these nodes MUST be rendered as their named element, not `<div>`:',
    ...elements.map((e) => {
      const hint = e.className ? ` (class: \`${e.className}\`)` : '';
      return `- \`${e.element}\`${hint} → render as \`${formatSemanticTag(e)}\``;
    }),
    '',
  ];
}

function buildDataBindingImageSection(yaml: string): string[] {
  if (!/\{\{product\.image/.test(yaml)) return [];
  return [
    '## Data-Binding Image Props', '',
    'The YAML contains `{{product.images}}` and `{{product.image}}` data-binding frames.',
    'These represent DYNAMIC product images loaded from the Shopify API at runtime — NOT static assets.', '',
    'You MUST:',
    '- Accept an `images` prop typed as `Array<{ url: string; altText?: string | null; width?: number; height?: number }>`',
    '- Accept `onSelectImage?: (index: number) => void` for thumbnail click handling',
    '- Accept `selectedIndex?: number` for highlighting the active thumbnail',
    '- Import `Image` from `@shopify/hydrogen` and render each image with `<Image data={img} sizes="..." />`',
    '  Always pass a `sizes` prop: use `"(min-width: 1024px) 50vw, 100vw"` for the primary image,',
    '  and a pixel value matching the thumbnail height (e.g. `"120px"`) for thumbnails.',
    '- Map over the `images` array dynamically — do NOT hardcode a fixed number of images',
    '- Do NOT import static image assets from `~/assets/` for product images',
    '- Do NOT use raw `<img>` tags — use Hydrogen\'s `<Image>` component',
    '- Use the CSS classes from the `{{product.images}}` container and `{{product.image}}` item nodes',
    '  (these are in the YAML\'s `generatedCSS` fields but excluded from the eval checklist)',
    '- Wrap the `{{product.images}}` container in `<Swiper>` / `<SwiperSlide>` using the carousel system rules',
    '- The Swiper handles scroll/pagination — arrows ONLY scroll the carousel, they do NOT change the selected image',
    '- Adjacent chevron/arrow IMAGE-SVG nodes are Swiper navigation buttons — render them as',
    '  `<button>` elements with `useRef` and wire via `navigation: { prevEl, nextEl }`.',
    '  These arrows let the user scroll through more images. They are static SVG imports',
    '  (keep importing from `~/assets/`), NOT data-binding nodes', '',
  ];
}

export function buildRootTagSection(
  elements: SemanticElement[],
): string[] {
  if (elements.length > 0) return [];
  return [
    '**Root element** — The route handles `<section>` wrapping.',
    'Your root element MUST be `<div>`. Do not use `<section>`,',
    '`<main>`, `<nav>`, `<article>`, or `<aside>` unless listed above.',
    '',
  ];
}

export function buildComponentPrompt(
  input: ComponentBuildInput,
  extras: PromptExtras,
): string {
  const preamble = input.existing
    ? buildUpdatePreamble(input)
    : buildNewPreamble(input.yaml);

  const designData = parseYAMLDesignData(input.yaml);
  const semanticElements = extractSemanticElements(input.yaml);

  return [
    ...preamble,
    ...buildClassNameSection(),
    ...buildPackageSection(extras.packageNames),
    ...buildHookSection(extras.hookSources),
    ...buildScaffoldDepsSection(extras.scaffoldDeps),
    ...buildPreviouslyBuiltInterfacesSection(extras.previouslyBuiltInterfaces),
    ...(extras.variantUsageSection ?? []),
    ...buildEvalChecklist(designData),
    ...buildDataBindingImageSection(input.yaml),
    ...buildSemanticSection(semanticElements),
    ...buildRootTagSection(semanticElements),
    'Build plan context:', '```markdown', input.plan, '```', '',
    'You MUST call the `write_component` tool with the complete file contents.',
    'Follow all rules from the system prompt exactly.',
  ].join('\n');
}
