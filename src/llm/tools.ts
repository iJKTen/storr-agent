import type { ToolDefinition, ToolParameterSchema } from '../types.js';

/**
 * JSON Schema for the write_component tool.
 */
export const WRITE_COMPONENT_SCHEMA: ToolParameterSchema = {
  type: 'object',
  properties: {
    componentName: {
      type: 'string',
      description:
        'PascalCase component name (e.g. "ProductCard"). Must match /^[A-Z][a-zA-Z0-9]+$/.',
    },
    tsxContent: {
      type: 'string',
      description:
        'Complete contents of index.tsx for this component. Includes imports, props interface, and the exported function.',
    },
    cssContent: {
      type: 'string',
      description:
        'Optional. Contents of ComponentName.module.css. Omit if the component needs no custom styles (e.g. it only renders child components or SVG imports). Every styles.xyz in the TSX must have a matching .xyz selector here.',
    },
    contentTsContent: {
      type: 'string',
      description:
        'Optional. Contents of content.ts for static text extracted from Figma YAML. Omit if the component has no static text.',
    },
  },
  required: ['componentName', 'tsxContent'],
  additionalProperties: false,
};

/**
 * Canonical tool definition used internally.
 */
export const WRITE_COMPONENT_TOOL: ToolDefinition = {
  name: 'write_component',
  description:
    'Write a React component file bundle (index.tsx, optional .module.css, optional content.ts) to the workspace. ' +
    'All files are validated by eval interceptors before being saved. ' +
    'If validation fails, the errors are returned and the LLM must fix and re-call. ' +
    'CRITICAL: Only include elements that exist in the component\'s YAML node tree. ' +
    'Never add UI elements, text, or child components that are not in the YAML. ' +
    'INSTANCE nodes must be rendered as <ComponentName /> imports — never rebuild their content inline.',
  parameters: WRITE_COMPONENT_SCHEMA,
};

/**
 * JSON Schema for the update_file tool.
 */
export const UPDATE_FILE_SCHEMA: ToolParameterSchema = {
  type: 'object',
  properties: {
    filePath: {
      type: 'string',
      description:
        'Workspace-relative file path to update (e.g. "app/components/templates/PageLayout/index.tsx" or "app/routes/_index.tsx").',
    },
    content: {
      type: 'string',
      description:
        'Complete updated file content. Must include ALL existing exports (loader, action, meta, ErrorBoundary) unchanged. Only add imports and modify the default export JSX.',
    },
  },
  required: ['filePath', 'content'],
  additionalProperties: false,
};

/**
 * Canonical tool definition for updating existing files.
 */
export const UPDATE_FILE_TOOL: ToolDefinition = {
  name: 'update_file',
  description:
    'Update an existing file in the workspace with new content. ' +
    'Use this to add component imports and JSX to route files or PageLayout. ' +
    'You MUST preserve all existing exports (loader, action, meta, ErrorBoundary) exactly as they are. ' +
    'Only add import statements and modify the returned JSX.',
  parameters: UPDATE_FILE_SCHEMA,
};

/**
 * Convert our tool definition to OpenAI SDK format.
 */
export function toOpenAITool(tool: ToolDefinition): {
  type: 'function';
  function: { name: string; description: string; parameters: ToolParameterSchema };
} {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

/**
 * Convert our tool definition to Anthropic SDK format.
 */
export function toAnthropicTool(tool: ToolDefinition): {
  name: string;
  description: string;
  input_schema: ToolParameterSchema;
} {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: { ...tool.parameters, type: 'object' as const },
  };
}
