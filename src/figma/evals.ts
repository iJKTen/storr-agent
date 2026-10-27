import type { EvalError, EvalResult, SemanticElement, WriteComponentPayload, YAMLDesignData } from '../types.js';
import { parseYAMLDesignData, extractSemanticElements } from './yaml-parser.js';

/**
 * Rule 1: TSX must not use `hidden={...}`.
 * Use React conditional rendering instead.
 */
export function evalHiddenAttribute(payload: WriteComponentPayload): EvalResult {
  const { tsxContent } = payload;
  const errors: EvalError[] = [];

  const hiddenPattern = /hidden=\{/g;
  let match: RegExpExecArray | null;
  while ((match = hiddenPattern.exec(tsxContent)) !== null) {
    const lineNum = tsxContent.substring(0, match.index).split('\n').length;
    errors.push({
      rule: 'no-hidden-attribute',
      message: `TSX line ${lineNum}: Do not use "hidden={...}". Use React conditional rendering (ternary or &&) instead.`,
    });
  }

  return errors.length === 0 ? { pass: true } : { pass: false, errors };
}

/**
 * Rule 2: componentName must be PascalCase: /^[A-Z][a-zA-Z0-9]+$/
 */
export function evalNoPascalCaseFileName(payload: WriteComponentPayload): EvalResult {
  const { componentName } = payload;
  const pascalCasePattern = /^[A-Z][a-zA-Z0-9]+$/;

  if (!pascalCasePattern.test(componentName)) {
    return {
      pass: false,
      errors: [
        {
          rule: 'pascal-case-name',
          message: `Component name "${componentName}" does not match PascalCase pattern /^[A-Z][a-zA-Z0-9]+$/. Use a name like "ProductCard" or "ColorSwatch".`,
        },
      ],
    };
  }

  return { pass: true };
}

/**
 * Rule 3: Components must use named exports, not export default.
 * This ensures a consistent import convention across the codebase:
 * `import {Name} from '~/components/Name'`
 */
export function evalNamedExport(payload: WriteComponentPayload): EvalResult {
  const { tsxContent, componentName } = payload;

  if (/export\s+default\s/.test(tsxContent)) {
    return {
      pass: false,
      errors: [
        {
          rule: 'named-export',
          message: `Component uses "export default". Use a named export instead: "export function ${componentName}() { ... }". Never use "export default".`,
        },
      ],
    };
  }

  return { pass: true };
}

/**
 * Run all eval interceptors on a write_component payload.
 * Returns combined errors from all rules.
 */
export function runEvals(payload: WriteComponentPayload): EvalResult {
  const results = [
    evalHiddenAttribute(payload),
    evalNoPascalCaseFileName(payload),
    evalNamedExport(payload),
  ];

  const allErrors: EvalError[] = [];
  for (const result of results) {
    if (!result.pass) {
      allErrors.push(...result.errors);
    }
  }

  return allErrors.length === 0 ? { pass: true } : { pass: false, errors: allErrors };
}

/**
 * Rule 4: YAML text content must appear in the generated TSX.
 * Catches hallucinated text where the LLM invents copy instead of using the YAML values.
 */
export function evalTextContent(payload: WriteComponentPayload, data: YAMLDesignData): EvalResult {
  const { tsxContent, contentTsContent } = payload;
  const errors: EvalError[] = [];

  for (const textValue of data.texts) {
    if (!tsxContent.includes(textValue) && (!contentTsContent || !contentTsContent.includes(textValue))) {
      errors.push({
        rule: 'missing-yaml-text',
        message: `YAML text "${textValue}" does not appear in the generated TSX or content.ts. Use the exact text from the design data.`,
      });
    }
  }

  return errors.length === 0 ? { pass: true } : { pass: false, errors };
}

const STRIP_SVG_NAMES = new Set<string>();

/**
 * Convert a slug like "shopping-bag" to camelCase "shoppingBag".
 */
function camelCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s_-]+(.)/g, (_, c: string) => c.toUpperCase());
}

/**
 * Rule 5: Every IMAGE-SVG node in the YAML must have a matching SVG import in the TSX.
 * When assetPath is available, derive the expected filename from it (e.g. "search-2.svg").
 * Otherwise fall back to slugified name (e.g. "search.svg").
 */
export function evalImageSvgNodes(
  payload: WriteComponentPayload,
  data: YAMLDesignData,
): EvalResult {
  const { tsxContent } = payload;
  const errors: EvalError[] = [];
  const tsxLower = tsxContent.toLowerCase();

  for (const entry of data.svgNodes) {
    if (STRIP_SVG_NAMES.has(entry.name.toLowerCase())) continue;

    const slug = entry.name.toLowerCase().replace(/[\s_]+/g, '-');
    const expectedFile = entry.assetPath
      ? entry.assetPath.split('/').pop()!        // "search-2.svg"
      : `${slug}.svg`;                           // fallback: "search.svg"

    if (!tsxLower.includes(expectedFile.toLowerCase())) {
      const cc = camelCase(entry.name);
      const importPath = entry.assetPath
        ? `~/` + entry.assetPath.replace(/^app\//, '')
        : `~/assets/${slug}.svg`;
      errors.push({
        rule: 'missing-image-svg',
        message: `YAML node "${entry.name}" (type: IMAGE-SVG) has no matching SVG import. Add: import ${cc}Svg from '${importPath}'; and render it as <img src={${cc}Svg} alt="${entry.name}" />.`,
      });
    }
  }

  return errors.length === 0 ? { pass: true } : { pass: false, errors };
}

/**
 * Rule 6: Do not create content.ts when the YAML has no static text.
 * Catches hallucinated content.ts files where the LLM invents text
 * for components whose text is fully dynamic (data-binding).
 */
export function evalNoUnnecessaryContentTs(
  payload: WriteComponentPayload,
  data: YAMLDesignData,
): EvalResult {
  if (data.texts.length === 0 && payload.contentTsContent) {
    return {
      pass: false,
      errors: [{
        rule: 'unnecessary-content-ts',
        message:
          'YAML design data contains no static text. Do not create content.ts — omit the contentTsContent parameter.',
      }],
    };
  }
  return { pass: true };
}

/**
 * Rule 6b: content.ts is REQUIRED when the YAML has static text.
 * Catches cases where the LLM inlines static strings in JSX
 * instead of extracting them into a content.ts file.
 */
export function evalRequiredContentTs(
  payload: WriteComponentPayload,
  data: YAMLDesignData,
): EvalResult {
  if (data.texts.length > 0 && !payload.contentTsContent) {
    return {
      pass: false,
      errors: [{
        rule: 'missing-content-ts',
        message:
          'YAML contains static text. You MUST extract it into content.ts. ' +
          'Populate the contentTsContent parameter.',
      }],
    };
  }
  return { pass: true };
}

/**
 * Rule 7: Every generatedCSS.className from the YAML must appear in the CSS module.
 * Catches hallucinated class names where the LLM invents its own CSS selectors
 * instead of using the YAML's generatedCSS classNames.
 */
export function evalGeneratedCSS(payload: WriteComponentPayload, data: YAMLDesignData): EvalResult {
  if (data.classNames.length === 0) return { pass: true };

  const { cssContent } = payload;
  const errors: EvalError[] = [];

  if (!cssContent) {
    return {
      pass: false,
      errors: [{
        rule: 'missing-generated-css',
        message: `YAML defines ${data.classNames.length} generatedCSS className(s) but no CSS module was provided. Include a cssContent with the component.`,
      }],
    };
  }

  for (const className of data.classNames) {
    if (!cssContent.includes(`.${className} `) && !cssContent.includes(`.${className}{`) && !cssContent.includes(`.${className}\n`)) {
      errors.push({
        rule: 'missing-generated-css',
        message: `YAML generatedCSS className "${className}" does not appear as ".${className}" in the CSS module. Use the exact className from the design data.`,
      });
    }
  }

  return errors.length === 0 ? { pass: true } : { pass: false, errors };
}

/**
 * Rule 8: Every semantic HTML element in the YAML must appear in the TSX.
 * Catches cases where the LLM uses <div> instead of the named semantic element.
 */
export function evalSemanticElements(
  payload: WriteComponentPayload,
  elements: SemanticElement[],
): EvalResult {
  if (elements.length === 0) return { pass: true };
  const tsx = payload.tsxContent;
  const errors: EvalError[] = [];
  const seen = new Set<string>();
  for (const el of elements) {
    if (seen.has(el.element)) continue;
    seen.add(el.element);
    if (!tsx.includes(`<${el.element}`)) {
      errors.push({
        rule: 'missing-semantic-element',
        message: `YAML node "${el.element}" must be rendered as <${el.element}>, not <div>.`,
      });
    }
  }
  return errors.length === 0 ? { pass: true } : { pass: false, errors };
}

/**
 * Run YAML-aware evals that need both the payload and the original YAML content.
 * Parallel to runEvals (payload-only); keeps eval signatures clean.
 */
export function runYAMLEvals(payload: WriteComponentPayload, yamlContent: string): EvalResult {
  const data = parseYAMLDesignData(yamlContent);
  const semanticElements = extractSemanticElements(yamlContent);

  const results = [
    evalTextContent(payload, data),
    evalImageSvgNodes(payload, data),
    evalGeneratedCSS(payload, data),
    evalNoUnnecessaryContentTs(payload, data),
    evalRequiredContentTs(payload, data),
    evalSemanticElements(payload, semanticElements),
  ];

  const allErrors: EvalError[] = [];
  for (const result of results) {
    if (!result.pass) {
      allErrors.push(...result.errors);
    }
  }

  return allErrors.length === 0 ? { pass: true } : { pass: false, errors: allErrors };
}

/**
 * Format eval errors into a human-readable string for the LLM.
 */
export function formatEvalErrors(errors: EvalError[]): string {
  const lines = ['EVAL ERRORS - Fix these issues and re-call write_component:', ''];
  for (const err of errors) {
    lines.push(`  [${err.rule}] ${err.message}`);
  }
  return lines.join('\n');
}
