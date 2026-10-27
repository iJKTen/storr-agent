# storr-agent

A server-side AI coding agent that builds Shopify Hydrogen storefronts from pre-extracted Figma design data (YAML). It reads component specifications, generates React components with CSS Modules, validates them against a set of eval rules, integrates components into route files, and writes the output to a target workspace.

## How it works

The agent runs as a state machine that progresses through these phases:

```
boot -> foundation -> plan -> plan_eval -> component_loop <-> component_eval -> integration -> final_audit -> done
```

| Phase | What happens |
|---|---|
| **boot** | Scans the `.figma/yaml/` tree, loads `AGENTS.md` if present, builds the system message from rule modules |
| **foundation** | Generates `fonts.css` from `fonts.yaml` if the file is empty. Skips if already populated |
| **plan** | Reads all `inventory.yaml` files, asks the LLM to produce a build plan |
| **plan_eval** | Validates the plan contains "Unmapped Files: None". Rejects and retries if missing |
| **component_loop** | For each READY_FOR_DEV component: reads YAML, forces the LLM to call `write_component`, runs evals, saves or rejects |
| **integration** | Classifies page YAML instances into PageLayout (global chrome) vs Route targets, generates CSS modules, syncs data bindings, and asks the LLM to wire components into route/layout files via `update_file` |
| **final_audit** | Runs `pnpm typecheck`. Sends errors to the LLM for fixes. Up to 3 retries |
| **done** | All components written, typecheck passed |

### Ready for Dev filtering

Only Figma nodes inside frames, sections, or groups marked **Ready for Dev** in Figma are included in the pipeline output. The `storr-figma-parser` enforces this at parse time — components that aren't inside a `READY_FOR_DEV` container get no YAML file or inventory entry. The agent also performs a defense-in-depth check, skipping any FRAME/SECTION/GROUP inventory items that lack the `READY_FOR_DEV` status.

This means you control what the agent builds by toggling the "Ready for dev" status on container frames in Figma.

### Integration phase

The integration phase wires built components into existing route files and the PageLayout shell. It works with two target types:

- **PageLayout** (`app/components/PageLayout/index.tsx`) — global chrome components (header, footer, navigation) that appear on every page.
- **Route** (e.g. `app/routes/_index.tsx`, `app/routes/collections.$handle.tsx`) — page-specific components rendered inside the route's default export.

**Target classification pipeline:**

1. `classifyInstances()` walks each page YAML's node tree. INSTANCE nodes inside a `PageLayout` frame (or already rendered by the existing PageLayout) are classified as **global**. All other INSTANCE nodes are classified as **route** components.
2. Global instances accumulate into a single PageLayout target. Route instances are grouped by page name using `ROUTE_MAP` (defined in `context.ts`), which maps Figma page names like `HomepageDesktop` to route files like `app/routes/_index.tsx`.
3. For each target, the agent reads the existing target file, resolves instance names to built component names, reads component source files, and generates a CSS module.

**CSS module generation:**

- For route targets, `extractContainerFrames()` walks the page YAML for FRAME nodes with `generatedCSS.base` styles.
- Mobile and desktop page variants are collected separately and merged via `mergeResponsiveCSS()`, which outputs mobile-first base styles with `@media (min-width: 1024px)` desktop overrides.
- For PageLayout targets, a sizing CSS module (`app/styles/page-layout-sizing.module.css`) is generated with per-component width/height classes.

**Prompt and LLM call:**

The integration prompt includes: the existing file content, page YAML data, built component sources (with their props interfaces), instance-to-component name mapping, pre-generated CSS module class names, and type-specific instructions (e.g. how to modify the loader for data-bound routes). The LLM calls `update_file` to write the updated file, which is then typechecked with the same retry loop used in other phases.

### Data bindings

The data bindings pipeline connects Figma design data to live Shopify data (products, collections) instead of static content.

**Binding extraction and sync:**

- The Figma parser hoists GID patterns (e.g. `{{product.gid.12345}}`) into a `dataBindings` field on INSTANCE nodes.
- At the start of the integration phase, `syncBindings()` scans all page YAML files for `{{product.gid.NNNN}}`, `{{collection.gid.NNNN}}`, and `{{article.gid.NNNN}}` patterns. It generates `app/content/bindings.ts` with typed exports: `productGids` and `collectionGids` arrays containing the full Shopify GID strings.

**Integration target detection:**

- `classifyInstances()` checks each INSTANCE node for a non-empty `dataBindings` array and sets `hasDataBindings` on the classified result.
- When `hasDataBindings` is true for a route target, the integration prompt includes: the bindings file content, service functions from `app/lib/services/`, query fragments from `app/lib/queries/`, and instructions for the LLM to modify the route's loader to fetch data via `getProductsByGids(storefront, productGids)`.

**Triple-layered protection against static content for data-bound fields:**

1. `yaml-parser.ts` — all collectors (`collectTexts`, `collectSvgNodes`, `collectClassNames`, `collectPropTexts`) call `isDataBindingNode()` and skip `{{...}}` nodes, so data-bound text never appears in the eval checklist.
2. Component prompt — when YAML texts are empty (because all text is dynamic), the prompt explicitly says "Do NOT create content.ts".
3. `evalNoUnnecessaryContentTs()` — hard-gates content.ts creation: if `YAMLDesignData.texts` is empty but `contentTsContent` is provided, the eval fails.

**Dependency resolution:**

`resolveDataBindingDep()` stem-matches data-binding names to existing components. For example, `{{product.swatches}}` extracts the field `"swatches"`, stems it to `"swatch"`, and finds an existing component whose name contains that stem (e.g. `ColorSwatch`). This resolved component is included as a scaffold dependency in the component prompt.

### Dependency graph and build order

Components are built in dependency order using a topological sort. `buildDependencyGraph()` scans each component's YAML for `componentId:` references to other buildable components. `kahnSort()` (Kahn's algorithm) produces a linear order where dependencies are built first — so when a component like `ProductCard` depends on `ColorSwatch`, the swatch component is built and available as a scaffold dependency before the card.

If a circular dependency is detected, remaining components are appended in their original inventory order with a warning.

## Running locally (step by step)

This guide walks through setting up everything on your local machine using Docker and Ollama.

### What you need installed

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- [Ollama](https://ollama.com/)
- Node.js 22+ and pnpm (for the Figma parser)

### Directory layout

The guide assumes this sibling directory structure:

```
dev/
  storr-agent/          # this repo
  storr-prompt/         # contains rules/ directory with .md rule modules
  storr-figma-parser/   # Figma data extraction pipeline
  my-client-store/      # your workspace (a Hydrogen repo)
```

### Step 1: Pull an Ollama model

Pick a code-capable model and pull it. The agent defaults to `qwen3.6:35b` but you can use any model Ollama supports.

```bash
ollama pull qwen3.6:35b
```

### Step 2: Start Ollama with external access

The agent runs inside a Docker container and needs to reach Ollama on the host machine. By default Ollama only listens on `localhost`, so you need to open it up:

```bash
OLLAMA_HOST=0.0.0.0 ollama serve
```

Leave this running in a terminal tab. Verify it's accessible:

```bash
curl http://localhost:11434/v1/models
```

### Step 3: Generate the Figma YAML data

The agent reads pre-extracted YAML files from the workspace's `.figma/yaml/` directory. These are produced by `storr-figma-parser`.

```bash
cd ../storr-figma-parser
pnpm install
pnpm build
```

Run the pipeline against your workspace. You need a Figma API key and a `figma.config.json` in your workspace listing the Figma file keys:

```bash
# Create the pipeline config in your workspace
cat > ../my-client-store/figma.config.json << 'EOF'
{
  "files": ["your-figma-file-key-here"]
}
EOF

# Run the pipeline
FIGMA_API_KEY=figd_... node packages/pipeline/dist/bin.js \
  --config ../my-client-store/figma.config.json \
  --output ../my-client-store/.figma
```

After this completes, your workspace should have:

```
my-client-store/
  .figma/
    raw/               # raw Figma JSON
    yaml/
      components/
        inventory.yaml
        productcard.yaml
        ...
      homepage/
        inventory.yaml
        homepagedesktop.yaml
        ...
```

Only components inside frames marked **Ready for Dev** in Figma will appear in the YAML output and inventory. Everything else is filtered out at parse time.

The agent requires at least one `inventory.yaml` in `.figma/yaml/` to proceed past the plan phase.

### Step 4: Install storr-agent dependencies

```bash
cd ../storr-agent
pnpm install
```

### Step 5: Build the Docker image

The build script copies the `rules/` directory from `storr-prompt/` into the Docker image:

```bash
./build.sh
```

If your rules directory is somewhere else, set `RULES_PATH`:

```bash
RULES_PATH=/path/to/rules ./build.sh
```

### Step 6: Start the agent

The `docker-compose.yml` starts the agent container with the workspace mounted as a bind volume.

Point `EVE_PATH` to your workspace and start the container:

```bash
EVE_PATH=../my-client-store docker compose up
```

The agent container reaches Ollama on the host via `http://host.docker.internal:11434/v1` (configured in `docker-compose.yml`).

### Step 7: Watch the output

The agent logs each state transition to stdout:

```
[12:34:56] [boot] Loading rules...
[12:34:56] [boot] Found 14 YAML files.
[12:34:57] [foundation] fonts.css already populated. Skipping.
[12:34:57] [plan] Reading all inventories...
[12:35:12] [plan_eval] Plan validated.
[12:35:12] [component_loop] Processing 8 components: ProductCard, ColorSwatch, ...
[12:35:30] [component_loop] Wrote ProductCard: app/components/ProductCard/index.tsx, ...
...
[12:40:00] [integration] Processing route: app/routes/_index.tsx
[12:40:15] [integration] Updated: app/routes/_index.tsx
[12:42:15] [final_audit] Typecheck passed.
[12:42:15] [done] Agent run complete.
```

Component files are written directly to the workspace.

### Changing the model

Edit `docker-compose.yml` or override at runtime:

```bash
EVE_PATH=../my-client-store OPENAI_MODEL=llama3.1:70b docker compose up
```

### Running without Docker

If you prefer to skip Docker entirely, run the agent directly with Node:

```bash
LLM_PROVIDER=ollama \
WORKSPACE_PATH=../my-client-store \
RULES_PATH=../storr-prompt/rules \
pnpm start
```

This uses `TERMINAL_MODE=local` by default and runs `pnpm typecheck` directly on the host.

### Dry-run mode

Dry-run mode dumps all prompts to `.figma/dry-run/` as markdown files without calling the LLM. This is useful for inspecting what the agent would send to the model.

```bash
DRY_RUN=1 pnpm start
# or
pnpm start --dry-run
```

## Using cloud LLM providers

### OpenAI

```bash
LLM_PROVIDER=openai \
OPENAI_API_KEY=sk-... \
WORKSPACE_PATH=../my-client-store \
pnpm start
```

### Anthropic

```bash
LLM_PROVIDER=anthropic \
ANTHROPIC_API_KEY=sk-ant-... \
WORKSPACE_PATH=../my-client-store \
pnpm start
```

### AWS (production)

The same Docker setup works on AWS (ECS, EKS, EC2). Replace the bind mount with an EFS volume and swap Ollama for a cloud provider:

```bash
docker run --rm \
  -v workspace-efs:/workspace \
  -e LLM_PROVIDER=anthropic \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e WORKSPACE_PATH=/workspace \
  storr-agent
```

No `docker exec` is used between containers — the agent runs `pnpm typecheck` directly against the shared volume, so it works identically on ECS where cross-container exec isn't available.

## Configuration

Configuration is loaded from environment variables, with CLI argument overrides.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `LLM_PROVIDER` | `openai` | `openai`, `ollama`, or `anthropic` |
| `OPENAI_API_KEY` | | API key for OpenAI or any OpenAI-compatible provider |
| `OPENAI_MODEL` | `gpt-4o` | Model name for OpenAI/Ollama |
| `OPENAI_BASE_URL` | | Base URL override. Ollama defaults to `http://localhost:11434/v1` |
| `ANTHROPIC_API_KEY` | | API key for Anthropic |
| `ANTHROPIC_MODEL` | `claude-sonnet-5` | Model name for Anthropic |
| `WORKSPACE_PATH` | `../eve` | Path to the Hydrogen workspace |
| `RULES_PATH` | `../storr-prompt/rules` | Path to the directory containing `.md` rule modules |
| `TERMINAL_MODE` | `local` | `local` (child_process.exec) or `docker` (docker exec) |
| `DOCKER_CONTAINER` | | Container name, required when `TERMINAL_MODE=docker` |
| `MAX_RETRIES` | `3` | Max retries for plan validation and final typecheck |
| `MAX_EVAL_RETRIES` | `5` | Max eval retries per component |
| `DRY_RUN` | | Set to `1` to dump prompts without making LLM calls |

### CLI arguments

CLI args override environment variables:

```bash
pnpm start --provider anthropic --model claude-sonnet-5 --workspace /path/to/workspace --dry-run
```

## Architecture

```
storr-agent/
  src/
    index.ts              State machine orchestrator
    types.ts              Shared TypeScript interfaces
    log.ts                Timestamped phase-prefixed logger

    llm/                  LLM communication layer
      index.ts            Factory (createLLMClient) + barrel re-exports
      history.ts          ConversationHistory class
      tracker.ts          TokenTracker class + model pricing
      tools.ts            write_component + update_file JSON Schema + SDK format converters
      retry.ts            Generic retry-with-tool-call loop
      dry-run.ts          Dry-run mode (dumps prompts, no LLM calls)
      providers/
        openai.ts         OpenAI / Ollama message mapping + client
        anthropic.ts      Anthropic message mapping + client

    workspace/            Environment & filesystem interaction
      config.ts           Configuration loading (env vars + CLI args)
      terminal.ts         child_process.exec wrapper (local + docker modes)
      typecheck.ts        pnpm typecheck runner + error filtering/formatting
      WorkspaceFileSystem.ts  IFileReader/IFileWriter/IFileScanner implementation
      fileSystem.ts       YAML tree formatting helper

    figma/                Figma design data pipeline
      figma-node.ts       FigmaNode type definitions + data-binding helpers
      yaml-parser.ts      Parses YAML into YAMLDesignData (texts, SVGs, classNames, semantic elements)
      images.ts           Scans .figma/images/ for downloaded Figma assets
      page-sizing.ts      Instance sizing index builder + width/height resolution
      context.ts          Boot context, system message builder, YAML/component resolvers
      rules.ts            Phase-aware rule module selection and assembly
      detection-rules.json  Component detection heuristics (name/YAML pattern matching)
      evals.ts            8 eval interceptors (run before files are saved)
      component-meta.ts   Component prop metadata extraction
      variant-filter.ts   Variant usage tracking
      strategies/
        index.ts          Barrel re-export
        factory.ts        Strategy factory
        standard.ts       Standard strategy implementation
        types.ts          Strategy type definitions

    phases/
      foundation.ts       Foundation phase (fonts.css generation)
      plan.ts             Plan phase (inventory reading, LLM plan generation)
      audit.ts            Final audit phase (typecheck + LLM fix loop)
      component-loop/
        index.ts          Component loop orchestrator (dependency sort, build, eval retry)
        types.ts          Phase-specific types
        dependency-graph.ts  Topological sort (Kahn's algorithm)
        filtering.ts      Ready-for-dev filtering
        preparation.ts    Component prep helpers
        prompt-builder.ts Component-specific prompt assembly
        eval-retry.ts     Eval failure handling
        variant-usage.ts  Variant tracking for prompts
      integration/
        index.ts          Integration orchestrator (target processing, LLM call)
        targets.ts        Instance classification + target building
        bindings.ts       Data-binding GID extraction + bindings.ts generation
        css-generation.ts Container frame extraction, responsive CSS merge, sizing CSS
        prompt-builder.ts Integration prompt assembly
        instance-resolver.ts  Instance-to-component name resolution
  Dockerfile              Multi-stage build (node:22-slim)
  docker-compose.yml      Local dev setup (agent container)
  entrypoint.sh           Installs workspace deps, then runs agent
  build.sh                Copies rules/ into build context, builds image
```

### Rule modules

The system prompt is assembled from modular `.md` files in the rules directory. Each phase loads a different subset.

**Always loaded (every phase):**

| Module | Purpose |
|--------|---------|
| `core.md` | Core agent behavior, tool calling conventions, output format |
| `typescript.md` | TypeScript coding standards, strict mode, type safety |
| `css-core.md` | CSS Module conventions, class naming, responsive patterns |

**Phase-specific modules:**

| Phase | Modules |
|-------|---------|
| `foundation` | `phase-foundation.md` |
| `plan` | `phase-plan.md`, `yaml-interpretation.md`, `figma-directives.md`, `scaffold.md`, `routes.md`, `service-layer.md`, `storefront-types.md` |
| `component_loop` | `phase-component.md`, `yaml-interpretation.md`, `figma-directives.md`, `accessibility.md` |
| `integration` | `phase-integration.md`, `yaml-interpretation.md`, `scaffold.md`, `routes.md`, `service-layer.md` |
| `final_audit` | `phase-audit.md` |

**Component-detected modules** (loaded during `component_loop` only):

Detection works by matching component name patterns (case-insensitive regex) and/or YAML content patterns against the current component. If any pattern matches, the module is loaded into the system prompt. Hook files (if specified) are read from the workspace and included as "pre-built source files" in the component prompt.

| Module | Name Patterns | YAML Patterns | Hook Files |
|--------|--------------|---------------|------------|
| `product-card.md` | `product`, `card` | `HoverImage`, `{{product.` | `app/lib/hooks/useProductCard.ts`, `app/lib/product/product.ts` |
| `swatches.md` | `swatch`, `color` | `colorEllipse`, `selectedBorder` | -- |
| `cart.md` | `cart`, `minicart` | `{{product.variant.` | -- |
| `pdp.md` | `pdp` | -- | -- |
| `images.md` | `hero`, `banner` | `imageRef`, `type: IMAGE` | -- |
| `responsive.md` | -- | `Device` | -- |
| `scaffold.md` | `header`, `footer`, `aside`, `nav`, `menu` | -- | -- |
| `layout.md` | -- | `sizing.*(?:fill\|fixed)` | -- |
| `svg-assets.md` | `logo`, `icon`, `asset`, `favicon` | `type: IMAGE-SVG`, `assetPath:` | -- |

### LLM provider abstraction

A single `LLMClient` interface with a `chat()` method. Three providers share two implementations:

- **OpenAI** and **Ollama** use the OpenAI SDK (Ollama swaps `baseURL`)
- **Anthropic** uses its own SDK (different message format, system message handling, tool result wrapping)

SDKs are loaded via dynamic `import()` so only the configured provider's SDK is loaded at runtime.

### Tool calling

Two tools are available:

- **`write_component`** — Takes `componentName`, `tsxContent`, optional `cssContent`, and optional `contentTsContent`. Writes `index.tsx`, `{Name}.module.css`, and `content.ts` to `app/components/{Name}/`. Used during `component_loop`. The LLM is forced to use it via `tool_choice: required`.
- **`update_file`** — Takes `filePath` and `content`. Overwrites an existing file at the given workspace-relative path. Used during `integration` (to write route files and PageLayout) and `final_audit` (to fix typecheck errors).

### Eval interceptors

Evals run on the `write_component` tool call payload **before** files are written to disk. If any rule fails, the errors are formatted and sent back as a tool call result so the LLM self-corrects. Two eval runners exist:

- `runEvals(payload)` — runs rules 1-3 (payload-only, no YAML needed)
- `runYAMLEvals(payload, yamlContent)` — runs rules 4-8 (needs both the payload and the original YAML content)

On failure, errors are sent back and the LLM retries (up to `MAX_EVAL_RETRIES`, default 5).

#### Rule 1: `no-hidden-attribute`

**Function:** `evalHiddenAttribute` (`evals.ts:8-23`)

Scans TSX for `hidden={...}` patterns. Rejects conditional visibility via the `hidden` DOM attribute — the LLM must use React conditional rendering (ternary `? :` or `&&`) instead.

**Error:** `TSX line N: Do not use "hidden={...}". Use React conditional rendering (ternary or &&) instead.`

**Triggers retry:** Any occurrence of `hidden={` in the TSX content.

#### Rule 2: `pascal-case-name`

**Function:** `evalNoPascalCaseFileName` (`evals.ts:28-45`)

Validates `componentName` against `/^[A-Z][a-zA-Z0-9]+$/`. Rejects kebab-case, snake_case, lowercase, or single-character names.

**Error:** `Component name "name" does not match PascalCase pattern /^[A-Z][a-zA-Z0-9]+$/. Use a name like "ProductCard" or "ColorSwatch".`

**Triggers retry:** The `componentName` field fails the regex test.

#### Rule 3: `named-export`

**Function:** `evalNamedExport` (`evals.ts:52-68`)

Scans TSX for `export default`. Requires `export function ComponentName()` (named export) to ensure a consistent import convention: `import {Name} from '~/components/Name'`.

**Error:** `Component uses "export default". Use a named export instead: "export function ComponentName() { ... }". Never use "export default".`

**Triggers retry:** The regex `/export\s+default\s/` matches in TSX.

#### Rule 4: `missing-yaml-text`

**Function:** `evalTextContent` (`evals.ts:95-109`)

Compares every string in `YAMLDesignData.texts` against both the TSX and content.ts. Catches the LLM inventing copy instead of using the exact text values from the YAML.

**Error (per missing string):** `YAML text "value" does not appear in the generated TSX or content.ts. Use the exact text from the design data.`

**Triggers retry:** Any YAML text string is absent from both `tsxContent` and `contentTsContent`.

#### Rule 5: `missing-image-svg`

**Function:** `evalImageSvgNodes` (`evals.ts:127-156`)

For each IMAGE-SVG node in the YAML, checks TSX for a matching SVG import filename. Uses `assetPath` if available (e.g. `search-2.svg`), otherwise falls back to a slugified name (e.g. `search.svg`).

**Error:** `YAML node "name" (type: IMAGE-SVG) has no matching SVG import. Add: import nameSvg from '~/assets/name.svg'; and render it as <img src={nameSvg} alt="name" />.`

**Triggers retry:** The expected SVG filename does not appear (case-insensitive) in the TSX.

#### Rule 6: `unnecessary-content-ts`

**Function:** `evalNoUnnecessaryContentTs` (`evals.ts:163-178`)

Fails if `contentTsContent` is provided but `YAMLDesignData.texts` is empty. Prevents hallucinated content.ts files for data-binding components where all text is dynamic (e.g. `{{product.title}}`, `{{product.price}}`).

**Error:** `YAML design data contains no static text. Do not create content.ts — omit the contentTsContent parameter.`

**Triggers retry:** `data.texts.length === 0 && payload.contentTsContent` is truthy.

#### Rule 7: `missing-generated-css`

**Function:** `evalGeneratedCSS` (`evals.ts:185-211`)

For each `generatedCSS.className` in the YAML, checks the CSS module for a `.className` selector. Catches the LLM inventing its own CSS class names instead of using the design data. Data-binding nodes are excluded from the checklist (their classNames are skipped by the yaml-parser).

**Error:** `YAML generatedCSS className "name" does not appear as ".name" in the CSS module. Use the exact className from the design data.`

**Triggers retry:** Any YAML className is missing from the CSS module, or no CSS module is provided when classNames exist.

#### Rule 8: `missing-semantic-element`

**Function:** `evalSemanticElements` (`evals.ts:217-236`)

Extracts semantic HTML element names from YAML nodes (`section`, `nav`, `header`, `footer`, `main`, `article`, `aside`, `h1`-`h6`, `p`, `ul`, `ol`, `li`, `blockquote`, `figure`, `figcaption`, `form`, `fieldset`, `details`, `summary`, `address`). Checks TSX for `<element` presence. Catches the LLM using `<div>` where the design specifies a semantic element.

**Error:** `YAML node "element" must be rendered as <element>, not <div>.`

**Triggers retry:** Any semantic element name from the YAML is not found as an opening tag in the TSX.

### Context window management

- Conversation history is cleared between phases
- The system message is always preserved
- Within the component loop, history is trimmed to the last 4 messages if it exceeds 20

### Workspace output

The agent writes files to the workspace at these paths:

| Output | Path |
|---|---|
| Build plan | `.figma/plan.md` |
| Component TSX | `app/components/{Name}/index.tsx` |
| Component CSS | `app/components/{Name}/{Name}.module.css` |
| Static content | `app/components/{Name}/content.ts` (if applicable) |
| Generated fonts | `app/styles/fonts.css` (if empty) |
| Typography CSS | `app/styles/typography.css` |
| Route files | `app/routes/_index.tsx`, `app/routes/collections.$handle.tsx`, etc. |
| Route CSS modules | `app/styles/{route}.module.css` |
| Sizing CSS module | `app/styles/page-layout-sizing.module.css` |
| Data bindings | `app/content/bindings.ts` |
| Raster images | `app/assets/*.{jpg,png,webp}` |

## Development

```bash
# Type check the agent itself
pnpm typecheck

# Run directly with tsx
pnpm start

# Build for production
pnpm build
```
