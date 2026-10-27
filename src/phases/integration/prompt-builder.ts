import type { IntegrationTarget, SemanticElement } from '../../types.js';
import type { InstanceSizing } from '../../figma/page-sizing.js';
import type { ResolvedInstanceProp } from '../../figma/component-meta.js';
import type { WrapperHint } from '../../figma/yaml-parser.js';
import { resolveInstanceWidth, resolveInstanceHeight } from '../../figma/page-sizing.js';
import { buildInstanceSizingCSS } from './css-generation.js';
import * as path from 'node:path';

interface PromptContentSources {
  existingContent: string;
  yamlContents: string[];
  componentSources: string[];
  hookSources: string[];
}

interface NameResolution {
  resolvedComponentNames: string[];
  instanceNameMap: Map<string, string>;
  /** Maps instance name → variant prop value (e.g. "hoverImage") for variant-resolved instances. */
  instanceVariantMap: Map<string, string>;
}

interface PromptCSSInfo {
  cssModuleRelPath?: string;
  cssModuleClassNames: string[];
  sizingClasses: Array<{ componentName: string; className: string }>;
  sizingModulePath?: string;
}

interface SizingContext {
  sizingIndex: Map<string, InstanceSizing[]>;
  handledComponents: Set<string>;
}

function buildNameMappingSection(instanceNameMap: Map<string, string>): string[] {
  if (instanceNameMap.size === 0) return [];
  const lines: string[] = [
    '## Instance Name Mapping', '',
    'The following page YAML instance names map to these components:',
  ];
  for (const [instanceName, resolvedName] of instanceNameMap) {
    lines.push(`- \`${instanceName}\` → use \`${resolvedName}\` component`);
  }
  lines.push('');
  return lines;
}

function buildComponentSourcesSection(componentSources: string[]): string[] {
  return [
    '## Built Component Sources', '',
    'These components were already built. Check their props interfaces — only pass props that are actually required. Static text is already in each component\'s content.ts.', '',
    ...componentSources, '',
  ];
}

/**
 * Builds a "Component API Reference" prompt section from extracted TypeScript
 * interface blocks. This gives the LLM an authoritative prop contract, preventing
 * it from inventing non-existent props or missing required ones.
 */
function buildPropInterfacesSection(
  propInterfaces: Map<string, string>,
): string[] {
  if (propInterfaces.size === 0) return [];
  const lines: string[] = [
    '## Component API Reference', '',
    'Use ONLY the props listed here when rendering these child components.',
    'Do NOT invent, add, or assume props not in these interfaces.', '',
  ];
  for (const [name, iface] of propInterfaces) {
    lines.push(`### ${name}`, '```typescript', iface, '```', '');
  }
  return lines;
}

function parseRequiredProps(interfaceText: string): string[] {
  const optionalPattern = /^\s*(\w+)\s*\?:/gm;
  const optionalProps = new Set<string>();
  let match;
  while ((match = optionalPattern.exec(interfaceText)) !== null) {
    optionalProps.add(match[1]);
  }

  const required: string[] = [];
  const allPattern = /^\s*(\w+)\s*\??:/gm;
  while ((match = allPattern.exec(interfaceText)) !== null) {
    if (!optionalProps.has(match[1])) {
      required.push(match[1]);
    }
  }
  return required;
}

function buildRequiredPropsChecklistSection(
  propInterfaces: Map<string, string>,
): string[] {
  if (propInterfaces.size === 0) return [];

  const entries: string[] = [];
  for (const [name, iface] of propInterfaces) {
    const required = parseRequiredProps(iface);
    if (required.length > 0) {
      entries.push(`- **${name}**: ${required.join(', ')} — ALL REQUIRED`);
    }
  }

  if (entries.length === 0) return [];

  return [
    '## Required Props Checklist', '',
    'Quick reference — these props MUST be provided (typecheck will fail if missing):', '',
    ...entries, '',
  ];
}

function buildCSSModuleSection(
  cssModuleRelPath: string | undefined,
  cssModuleClassNames: string[],
): string[] {
  if (!cssModuleRelPath || cssModuleClassNames.length === 0) return [];
  return [
    '## Pre-generated CSS Module', '',
    `A CSS module has been pre-generated at \`~/styles/${path.basename(cssModuleRelPath)}\`.`,
    `Import it: \`import styles from '~/styles/${path.basename(cssModuleRelPath)}';\``,
    'Apply these classNames to wrapper elements matching the page layout:',
    ...cssModuleClassNames.map((cn) => `- \`styles.${cn}\``), '',
  ];
}

function buildSizingModuleSection(
  sizingClasses: Array<{ componentName: string; className: string }>,
  sizingModulePath?: string,
): string[] {
  if (sizingClasses.length === 0) return [];
  const relPath = sizingModulePath ?? 'app/styles/page-layout-sizing.module.css';
  const importPath = relPath.replace(/^app\//, '~/');
  return [
    '## Component Instance Sizing (CSS Module)', '',
    `A pre-built CSS module exists at \`${relPath}\`.`,
    `Import it: \`import sizingStyles from '${importPath}';\``,
    'Pass the className to each component:',
    ...sizingClasses.map((sc) => `- ${sc.componentName}: \`sizingStyles.${sc.className}\``), '',
  ];
}

function collectSizingEntries(
  resolvedComponentNames: string[],
  sizingCtx: SizingContext,
): Map<string, string[]> {
  const pageMap = new Map<string, string[]>();

  for (const resolved of resolvedComponentNames) {
    if (sizingCtx.handledComponents.has(resolved)) continue;
    const entries = sizingCtx.sizingIndex.get(resolved.toLowerCase());
    if (!entries || entries.length === 0) continue;

    for (const entry of entries) {
      const props: string[] = [];
      if (entry.width) props.push(`width: ${entry.width}`);
      if (entry.height) props.push(`height: ${entry.height}`);
      if (props.length > 0) {
        const lines = pageMap.get(entry.pageName) ?? [];
        lines.push(`- ${resolved}: ${props.join('; ')}`);
        pageMap.set(entry.pageName, lines);
      }
    }
  }
  return pageMap;
}

function buildTextSizingSection(
  resolvedComponentNames: string[],
  sizingCtx: SizingContext,
): string[] {
  const pageMap = collectSizingEntries(resolvedComponentNames, sizingCtx);
  if (pageMap.size === 0) return [];

  const sizingLines: string[] = [];
  for (const [pageName, lines] of pageMap) {
    sizingLines.push(`${pageName}:`, ...lines, '');
  }

  return [
    '## Component Instance Sizing', '',
    'Apply these sizing CSS properties from the page design:',
    '', ...sizingLines,
  ];
}

function buildWrapperInstructionLines(wrappers: WrapperInfo[]): string[] {
  return wrappers.map((w) => {
    const names = w.children.join(', ');
    return `Wrap ${names} in a \`<div className={styles.${w.className}}>\`.`;
  });
}

function buildPageLayoutInstructions(
  wrappers: WrapperInfo[],
  hasMainCSS: boolean,
): string {
  const wrapperLines = wrappers.length > 0
    ? [
        ...buildWrapperInstructionLines(wrappers),
        "Ensure `styles` is imported from the co-located CSS module.",
      ]
    : ['Insert PromoBar-type components BEFORE the `<Header>` component.'];

  return [
    'This is a PageLayout file (global chrome).',
    ...wrapperLines,
    ...(hasMainCSS
      ? ['A `.main` class has been pre-generated in the co-located CSS module.',
         'Add `className={styles.main}` to the `<main>` element.']
      : ['Do NOT modify the `<main>{children}</main>` structure.']),
    'Insert aside-type components after existing aside elements.',
    'Do NOT modify Aside.Provider or search aside.',
    'For the cart aside: remove the heading prop when MiniCart provides its own header.',
    'If a navigation component exists, render it as a child of the mobile menu aside.',
  ].join('\n');
}

function buildDataBindingRouteInstructions(): string {
  return [
    'This is a route file with data-binding components.',
    'You MUST modify the loader to fetch data for data-binding components:',
    '1. Import `productGids` from `~/content/bindings` and `getProductsByGids` from `~/lib/services/product`.',
    '2. Add `getProductsByGids(storefront, productGids)` to the existing `Promise.all`.',
    '3. Add the result to the loader return object.',
    '   IMPORTANT: `getProductsByGids` returns `Maybe<T>[]` — items can be null.',
    '   Filter nulls: `const products = rawNodes.filter((n): n is ProductCardItemFragment => Boolean(n));`',
    '   Import `ProductCardItemFragment` from `storefrontapi.generated`.',
    '4. Use `useLoaderData()` to access the data in the component.',
    '5. If the page YAML contains a `{{collection.gid.XXX}}` FRAME node:',
    '   a. Also import `collectionGids` from `~/content/bindings` and `getCollectionProductsByGids` from `~/lib/services/collection`.',
    '   b. Count the Product/INSTANCE children inside the collection FRAME — that count is how many products to show.',
    '   c. Add `getCollectionProductsByGids(storefront, collectionGids, <count>)` to the `Promise.all`.',
    '   d. Each entry in the result is a collection with a `products.nodes` array. Map over the products and render `<ProductCard>` for each.',
    'Keep existing loader logic intact. Do not modify `action`, `meta`, or `ErrorBoundary`.',
    'Do not add `<header>`, `<footer>`, or `<main>` — PageLayout handles those.',
    'Use a React Fragment `<>` if returning multiple elements.',
  ].join('\n');
}

function buildPlainRouteInstructions(): string {
  return [
    'This is a route file.',
    'If a built component requires data props (e.g. a products array) that the loader does not currently provide, modify the loader to fetch the data using the service functions listed below. Add the result to the loader return and pass it via useLoaderData().',
    'Do not modify `action`, `meta`, or `ErrorBoundary`.',
    'Do not add `<header>`, `<footer>`, or `<main>` — PageLayout handles those.',
    'Use a React Fragment `<>` if returning multiple elements.',
  ].join('\n');
}

function buildGallerySlotInstructions(): string[] {
  return [
    'Gallery slot: Render `<PDPImageGallery>` with dynamic product images.',
    'Derive `selectedColor` via `getColorFromVariant(selectedVariant)` from `~/lib/product/product`.',
    'Filter images for selected colour: `getImagesForColor(product.media.nodes, selectedColor)` from `~/lib/product/images`.',
    'Track selected image index with `const [selectedImageIndex, setSelectedImageIndex] = useState(0)`.',
    'Add a `useEffect` that resets the image index when the colour changes:',
    '  `useEffect(() => { setSelectedImageIndex(0); }, [selectedColor]);`',
    'Use `selectedVariant.image` as initial image, fall back to first filtered image.',
    'Build `galleryImages` by mapping filtered images to the PDPGalleryImage type.',
    'Include ONLY the fields in PDPGalleryImage — do NOT include `id`. Convert null to undefined:',
    '  `{ url: img.url, altText: img.altText ?? undefined, width: img.width ?? undefined, height: img.height ?? undefined }`',
    'Render with these EXACT prop names — do NOT rename them:',
    '  `<PDPImageGallery images={galleryImages} selectedIndex={selectedImageIndex} onSelectImage={setSelectedImageIndex} />`',
    'Any static `~/assets/` image imports in built gallery components are Figma placeholders — the actual images come from `product.media.nodes` filtered by the selected variant colour.',
  ];
}

function buildDetailSlotInstructions(): string[] {
  return [
    'Detail slot: Render `<PDPDetail>` with props:',
    '- title: product.title, price: selectedVariant.price, compareAtPrice: selectedVariant.compareAtPrice',
    '- selectedColor: `getColorFromVariant(selectedVariant)` from `~/lib/product/product`',
    '- description: product.description — standalone text, NOT inside accordion',
    '- quantity + onDecrease/onIncrease: Local useState(1) — quantity is UI state',
    '- accordionItems: Array of { title, content } for FAQ sections (NOT product description).',
    '  Define the array inline — do NOT import a type from PDPDetail. TypeScript structural typing handles it.',
    '- swatches: Build a `swatchColors` map using the same pattern as `useProductCard.ts`',
    '  (see the hook file in Pre-built Utility Files). Use `useMemo` keyed on',
    '  `[selectedVariant, product.adjacentVariants]` to build the map from variant metafields.',
    '  Then for each colorOption.optionValues entry, render <ColorSwatch> with props:',
    '  color={value.name}, hexColor={swatchColors[value.name]?.hex ?? value.name},',
    '  borderColor={swatchColors[value.name]?.borderColor}, groupName="pdp-color",',
    '  isSelected={value.selected}, onChange that navigates to `?${value.variantUriQuery}`',
    '  with replace + preventScrollReset. Do NOT use value.swatch?.color.',
    '- Import `useAside` from `~/components/Aside` and call `const { open } = useAside()` in the component body.',
    '- cartAction: <AddToCartButton> wrapping <AddToBag>. Pass `onClick={() => open(\'cart\')}` to auto-open the mini cart drawer:',
    '  ```',
    '  const cartAction = (',
    '    <AddToCartButton',
    '      disabled={!selectedVariant.availableForSale}',
    '      onClick={() => open(\'cart\')}',
    '      lines={[{merchandiseId: selectedVariant.id, quantity, selectedVariant}]}',
    '    >',
    '      <AddToBag text="Add to bag" />',
    '    </AddToCartButton>',
    '  );',
    '  ```',
  ];
}

function buildTemplateInstructions(): string {
  return [
    'This is a scaffold template. Extend it to render the Figma PDP design.',
    'Preserve the existing props interface. Import and compose Figma components — do NOT inline their markup.',
    'Render `<PDP gallery={…} detail={…}>` composing two slots:',
    ...buildGallerySlotInstructions(),
    ...buildDetailSlotInstructions(),
    'Do not modify the route loader. Do not add header/footer/main.',
  ].join('\n');
}

function buildTypeInstructions(
  targetType: 'pageLayout' | 'route' | 'template',
  hasDataBindings: boolean,
  layout: LayoutContext,
): string {
  if (targetType === 'pageLayout') return buildPageLayoutInstructions(layout.wrappers, layout.hasMainCSS);
  if (targetType === 'template') return buildTemplateInstructions();
  if (hasDataBindings) return buildDataBindingRouteInstructions();
  return buildPlainRouteInstructions();
}

export interface IntegrationPromptInput {
  target: IntegrationTarget;
  content: PromptContentSources;
  names: NameResolution;
  css: PromptCSSInfo;
}

export interface DataBindingExtras {
  hasBindings: boolean;
  bindingsContent?: string;
  serviceSources: string[];
  querySources: string[];
}

export interface IntegrationPromptExtras {
  sizingCtx: SizingContext;
  dataBinding: DataBindingExtras;
  semanticElements: SemanticElement[];
  resolvedInstanceProps: ResolvedInstanceProp[];
  propInterfaces: Map<string, string>;
}

export interface WrapperInfo {
  className: string;
  children: string[];
}

export interface LayoutContext {
  hasMainCSS: boolean;
  wrapperHints: WrapperHint[];
  wrappers: WrapperInfo[];
}

function buildBindingsSection(bindingsContent?: string): string[] {
  if (!bindingsContent) return [];
  return ['## Bindings (app/content/bindings.ts)', '', '```typescript', bindingsContent, '```', ''];
}

function buildServiceSection(serviceSources: string[]): string[] {
  if (serviceSources.length === 0) return [];
  return [
    '## Service Functions (app/lib/services/)', '',
    'These service functions are available. Check their return types.',
    '', ...serviceSources, '',
  ];
}

function buildQuerySection(querySources: string[]): string[] {
  if (querySources.length === 0) return [];
  return [
    '## Query Fragments (app/lib/queries/)', '',
    'These query fragments define the Shopify data shape returned by service functions.',
    '', ...querySources, '',
  ];
}

function buildHookSourcesSection(hookSources: string[]): string[] {
  if (hookSources.length === 0) return [];
  return [
    '## Pre-built Utility Files (read-only)', '',
    'These utility files are already built. Use their exports — do NOT recreate.',
    '', ...hookSources, '',
  ];
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
    '## Semantic HTML Elements', '',
    'These YAML nodes MUST be rendered as their named HTML element, not `<div>`:',
    ...elements.map((e) => `- \`${e.element}\` → render as \`${formatSemanticTag(e)}\``),
    '',
  ];
}

function escapeJsxValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildInstancePropsSection(
  resolved: ResolvedInstanceProp[],
): string[] {
  if (resolved.length === 0) return [];
  return [
    '## Component Instance Props', '',
    'Pass these exact prop values when rendering each component instance.',
    'These are set by the page design — do NOT use component defaults for these:', '',
    ...resolved.map(r => {
      const propList = r.props
        .map(p => `${p.propKey}={"${escapeJsxValue(p.value)}"}`)
        .join(' ');
      const suffix = r.componentName !== r.instanceName ? ` (${r.componentName})` : '';
      return `- ${r.instanceName}${suffix}: ${propList}`;
    }), '',
  ];
}

function buildWrapperHintsSection(hints: WrapperHint[]): string[] {
  if (hints.length === 0) return [];
  const lines: string[] = [
    '## Component Wrapper Hierarchy', '',
    'The page YAML shows these components must be wrapped in semantic elements with CSS classes:',
  ];
  for (const hint of hints) {
    lines.push(`- \`<${hint.element} className={styles.${hint.className}}>\`: ${hint.children.join(', ')}`);
  }
  lines.push('');
  return lines;
}

function buildVariantPropsSection(
  instanceNameMap: Map<string, string>,
  instanceVariantMap: Map<string, string>,
): string[] {
  if (instanceVariantMap.size === 0) return [];

  // Group by resolved component name → variant values used
  const componentVariants = new Map<string, Set<string>>();
  for (const [instanceName, variantValue] of instanceVariantMap) {
    const componentName = instanceNameMap.get(instanceName) ?? instanceName;
    const variants = componentVariants.get(componentName) ?? new Set();
    variants.add(variantValue);
    componentVariants.set(componentName, variants);
  }

  const lines: string[] = [
    '## Component Variant Props', '',
    'Some component instances use non-default variants. Pass the `variant` prop as shown:', '',
  ];

  for (const [componentName, variants] of componentVariants) {
    for (const variant of variants) {
      lines.push(`- \`<${componentName} variant="${variant}" />\` — instances that use the ${variant} variant`);
    }
  }

  lines.push('', 'Instances without a variant prop use the default variant.', '');
  return lines;
}

export function buildIntegrationPrompt(
  input: IntegrationPromptInput,
  extras: IntegrationPromptExtras,
  layout: LayoutContext,
): string {
  const names = input.names.resolvedComponentNames;
  const instructions = buildTypeInstructions(input.target.targetType, extras.dataBinding.hasBindings, layout);
  const importText = names.map((n) => `import {${n}} from '~/components/${n}'`).join(', ');

  const preamble = input.target.targetType === 'template'
    ? `Extend this template component to render the Figma design.\nComponents to integrate: ${names.join(', ')}`
    : `Integrate these components into the target file: ${names.join(', ')}`;

  const blocks: (string | string[])[] = [
    preamble,
    `## Target File: ${input.target.targetFile}\n\`\`\`tsx\n${input.content.existingContent}\n\`\`\``,
    `## Page YAML Data\n${input.content.yamlContents.join('\n')}`,
    buildNameMappingSection(input.names.instanceNameMap),
    buildInstancePropsSection(extras.resolvedInstanceProps),
    buildVariantPropsSection(input.names.instanceNameMap, input.names.instanceVariantMap),
    buildComponentSourcesSection(input.content.componentSources),
    buildPropInterfacesSection(extras.propInterfaces),
    buildRequiredPropsChecklistSection(extras.propInterfaces),
    buildBindingsSection(extras.dataBinding.bindingsContent),
    buildServiceSection(extras.dataBinding.serviceSources),
    buildQuerySection(extras.dataBinding.querySources),
    buildHookSourcesSection(input.content.hookSources),
    buildCSSModuleSection(input.css.cssModuleRelPath, input.css.cssModuleClassNames),
    buildSizingModuleSection(input.css.sizingClasses, input.css.sizingModulePath),
    buildTextSizingSection(names, extras.sizingCtx),
    buildSemanticSection(extras.semanticElements),
    buildWrapperHintsSection(layout.wrapperHints),
    `## Instructions\n${instructions}`,
    `Add imports for: ${importText}`,
    'Call the `update_file` tool with the complete updated file. Do not output code as text.',
  ];

  // Flatten nested arrays and filter out explicitly empty strings, keeping strict types
  return blocks.flat().filter((block) => block !== '').join('\n\n');
}

export function computeSizingClasses(
  resolvedComponentNames: string[],
  instanceSizingIndex: Map<string, InstanceSizing[]>,
): { sizingClasses: Array<{ componentName: string; className: string; uniform?: { width?: string; height?: string } }>; handled: Set<string> } {
  const sizingClasses: Array<{ componentName: string; className: string; uniform?: { width?: string; height?: string } }> = [];
  const handled = new Set<string>();

  for (const resolved of resolvedComponentNames) {
    const entries = instanceSizingIndex.get(resolved.toLowerCase());
    if (!entries || entries.length === 0) continue;

    const resolvedWidth = resolveInstanceWidth(entries);
    const resolvedHeight = resolveInstanceHeight(entries);

    if (resolvedWidth !== undefined && resolvedHeight !== undefined) {
      // Both resolve uniformly — create a simple non-responsive class
      const className = resolved.charAt(0).toLowerCase() + resolved.slice(1);
      sizingClasses.push({ componentName: resolved, className, uniform: { width: resolvedWidth, height: resolvedHeight } });
      handled.add(resolved);
      continue;
    }

    // At least one dimension varies across pages — use responsive logic
    const sizing = buildInstanceSizingCSS(resolved, entries);
    if (sizing) {
      sizingClasses.push({ componentName: resolved, className: sizing.className });
      handled.add(resolved);
    }
  }

  return { sizingClasses, handled };
}
