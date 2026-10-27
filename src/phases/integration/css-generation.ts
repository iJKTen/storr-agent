import type { FigmaNode } from '../../figma/figma-node.js';
import type { InstanceSizing } from '../../figma/page-sizing.js';

// ── Container Frame Extraction ──

export interface ContainerFrame {
  className: string;
  base: string;
}

/** Layout container properties that control internal layout (the component's concern, not the route's). */
const INSTANCE_LAYOUT_PROPS = new Set([
  'display',
  'flex-direction',
  'flex-wrap',
  'gap',
  'row-gap',
  'column-gap',
  'justify-content',
  'align-items',
  'align-content',
  'grid-template-columns',
  'grid-template-rows',
]);

function sanitizeClassName(name: string): string {
  // Strip data-binding delimiters: {{...}} → ...
  const stripped = name.replace(/^\{\{|\}\}$/g, '');
  // Split on non-alphanumeric chars to get word segments
  const segments = stripped.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (segments.length === 0) return 'unnamed';
  // camelCase: first segment lowercased, rest capitalized
  return segments
    .map((s, i) => i === 0 ? s.charAt(0).toLowerCase() + s.slice(1) : s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
}

function filterInstanceCSS(css: string): string | undefined {
  const props = parseCSSProperties(css);
  for (const prop of INSTANCE_LAYOUT_PROPS) props.delete(prop);
  if (props.size === 0) return undefined;
  return [...props].map(([k, v]) => `${k}: ${v}`).join(';\n') + ';\n';
}

function resolveContainerFrame(node: FigmaNode): ContainerFrame | undefined {
  if (!node.name || !node.generatedCSS?.base) return undefined;
  const css = node.type === 'FRAME' ? node.generatedCSS.base
    : node.type === 'INSTANCE' ? filterInstanceCSS(node.generatedCSS.base)
    : undefined;
  if (!css) return undefined;
  return {
    className: node.generatedCSS.className ?? sanitizeClassName(node.name),
    base: css,
  };
}

function walkForFrameCSS(nodeList: FigmaNode[], frames: ContainerFrame[]): void {
  for (const node of nodeList) {
    const frame = resolveContainerFrame(node);
    if (frame) frames.push(frame);
    if (node.type !== 'INSTANCE' && node.children) {
      walkForFrameCSS(node.children, frames);
    }
  }
}

export function extractContainerFrames(nodes: FigmaNode[]): ContainerFrame[] {
  const frames: ContainerFrame[] = [];
  const rootChildren = nodes[0]?.children ?? nodes;
  const mainFrame = rootChildren.find(
    (n) => n.type === 'FRAME' && n.name?.toLowerCase() === 'main',
  );

  if (mainFrame) {
    if (mainFrame.name && mainFrame.generatedCSS?.base) {
      frames.push({
        className: mainFrame.generatedCSS.className ?? sanitizeClassName(mainFrame.name),
        base: mainFrame.generatedCSS.base,
      });
    }
    if (mainFrame.children) walkForFrameCSS(mainFrame.children, frames);
  } else {
    walkForFrameCSS(rootChildren, frames);
  }

  return frames;
}

// ── CSS Property Parsing ──

function parseCSSProperties(css: string): Map<string, string> {
  const props = new Map<string, string>();
  const declarations = css.split(';').map((d) => d.trim()).filter(Boolean);
  for (const decl of declarations) {
    const colonIdx = decl.indexOf(':');
    if (colonIdx === -1) continue;
    const prop = decl.substring(0, colonIdx).trim();
    const value = decl.substring(colonIdx + 1).trim();
    if (prop && value) props.set(prop, value);
  }
  return props;
}

// ── Responsive CSS Merging ──

function buildBaseRules(mobileFrames: ContainerFrame[]): string[] {
  return mobileFrames.map((f) => `.${f.className} { ${ensureStickyZIndex(f.base)} }`);
}

function buildMediaOverrides(
  mobileFrames: ContainerFrame[],
  desktopByClass: Map<string, ContainerFrame>,
): string[] {
  const mediaRules: string[] = [];
  const processedClasses = new Set<string>();

  for (const mobile of mobileFrames) {
    processedClasses.add(mobile.className);
    const desktop = desktopByClass.get(mobile.className);
    if (!desktop) continue;

    const mobileProps = parseCSSProperties(mobile.base);
    const desktopProps = parseCSSProperties(desktop.base);
    const overrides: string[] = [];

    for (const [prop, value] of desktopProps) {
      if (mobileProps.get(prop) !== value) {
        overrides.push(`${prop}: ${value}`);
      }
    }

    for (const [prop] of mobileProps) {
      if (!desktopProps.has(prop)) {
        overrides.push(`${prop}: unset`);
      }
    }

    if (overrides.length > 0) {
      mediaRules.push(`  .${mobile.className} { ${overrides.join('; ')}; }`);
    }
  }

  return mediaRules;
}

function buildDesktopOnlyRules(
  desktopFrames: ContainerFrame[],
  processedClasses: Set<string>,
): string[] {
  return desktopFrames
    .filter((f) => !processedClasses.has(f.className))
    .map((f) => `  .${f.className} { ${ensureStickyZIndex(f.base)} }`);
}

export function mergeResponsiveCSS(
  mobileFrames: ContainerFrame[],
  desktopFrames: ContainerFrame[],
): string {
  const desktopByClass = new Map<string, ContainerFrame>();
  for (const f of desktopFrames) desktopByClass.set(f.className, f);

  const processedClasses = new Set(mobileFrames.map((f) => f.className));
  const baseRules = buildBaseRules(mobileFrames);
  const mediaRules = buildMediaOverrides(mobileFrames, desktopByClass);
  const desktopOnly = buildDesktopOnlyRules(desktopFrames, processedClasses);
  const allMedia = [...mediaRules, ...desktopOnly];

  const parts: string[] = ['/* Mobile-first base styles */', ...baseRules];
  if (allMedia.length > 0) {
    parts.push('', '/* Desktop overrides */', '@media (min-width: 1024px) {', ...allMedia, '}');
  }

  return parts.join('\n') + '\n';
}

// ── Parent Centering Propagation ──

/**
 * When the first frame (skipped parent like <main>) has `align-items: center`,
 * propagate centering to fixed-width children as `margin: 0 auto`.
 */
export function propagateParentCentering(
  parentFrame: ContainerFrame | undefined,
  contentFrames: ContainerFrame[],
): void {
  if (!parentFrame) return;
  const parentProps = parseCSSProperties(parentFrame.base);
  if (parentProps.get('align-items') !== 'center') return;

  for (const frame of contentFrames) {
    const props = parseCSSProperties(frame.base);
    const width = props.get('width');
    if (width && /^\d+px$/.test(width)) {
      frame.base = frame.base.trimEnd() + '\nmargin: 0 auto;\n';
    }
  }
}

// ── Parent Centering Inference ──

export function inferParentCentering(frames: ContainerFrame[]): void {
  if (frames.length < 2) return;
  const parent = frames[0];
  const parentProps = parseCSSProperties(parent.base);
  if (parentProps.get('flex-direction') !== 'column') return;
  if (parentProps.get('align-items') === 'center') return;

  const hasFixedWidthChild = frames.slice(1).some((f) => {
    const props = parseCSSProperties(f.base);
    const w = props.get('width');
    return w !== undefined && /^\d+px$/.test(w);
  });

  if (hasFixedWidthChild) {
    parent.base = parent.base.trimEnd() + '\nalign-items: center;\n';
  }
}

// ── Sticky Z-Index ──

export function ensureStickyZIndex(css: string, zValue: number = 10): string {
  if (/position:\s*sticky/i.test(css) && !/z-index/i.test(css)) {
    return css.trimEnd() + `\nz-index: ${zValue};\n`;
  }
  return css;
}

// ── Frame CSS Class ──

export function buildFrameCSSClass(frameCSS: string, className: string = 'pageLayoutFrame'): string {
  const lines = frameCSS.trim().split('\n').map(l => `  ${l.trim()}`).join('\n');
  return `.${className} {\n${lines}\n}\n`;
}

export function buildResponsiveFrameBlock(
  frameCSS: { mobile: string | undefined; desktop: string | undefined },
  className: string = 'pageLayoutFrame',
): string {
  if (frameCSS.mobile && frameCSS.desktop) {
    const mobile: ContainerFrame = { className, base: frameCSS.mobile };
    const desktop: ContainerFrame = { className, base: frameCSS.desktop };
    return mergeResponsiveCSS([mobile], [desktop]);
  }
  return buildFrameCSSClass(frameCSS.mobile ?? frameCSS.desktop!, className);
}

// ── Multi-Wrapper CSS ──

export function wrapperClassName(index: number): string {
  return index === 0 ? 'pageLayoutFrame' : `pageLayoutFrame${index}`;
}

interface WrapperCSS {
  css: { mobile: string | undefined; desktop: string | undefined };
}

export function buildMultiWrapperCSS(wrappers: WrapperCSS[]): string {
  return wrappers
    .map((w, i) => buildResponsiveFrameBlock(w.css, wrapperClassName(i)))
    .join('\n');
}

// ── Instance Sizing CSS ──

function buildSizingProps(entry: InstanceSizing): string[] {
  const props: string[] = [];
  if (entry.width) props.push(`width: ${entry.width}`);
  if (entry.height) props.push(`height: ${entry.height}`);
  return props;
}

export function buildInstanceSizingCSS(
  componentName: string,
  entries: InstanceSizing[],
): { className: string; mobile: string; desktop?: string } | undefined {
  const mobile = entries.find(e => /mobile/i.test(e.pageName));
  const desktop = entries.find(e => !/mobile/i.test(e.pageName));
  if (!mobile && !desktop) return undefined;

  const className = componentName.charAt(0).toLowerCase() + componentName.slice(1);
  const base = mobile ?? desktop!;
  const mobileProps = buildSizingProps(base);

  const override = mobile ? desktop : undefined;
  let desktopCSS: string | undefined;
  if (override) {
    const overrideProps: string[] = [];
    if (override.width && override.width !== base.width) overrideProps.push(`width: ${override.width}`);
    if (override.height && override.height !== base.height) overrideProps.push(`height: ${override.height}`);
    if (overrideProps.length > 0) desktopCSS = overrideProps.join('; ');
  }

  return { className, mobile: mobileProps.join('; '), desktop: desktopCSS };
}
