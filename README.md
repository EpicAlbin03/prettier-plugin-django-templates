# prettier-plugin-django

Prettier plugin for Django templates.

## What changed

This repo now targets a modern toolchain:

- Prettier 3
- ESLint flat config (`eslint.config.js`)
- Vite library build
- Vitest snapshot tests
- TypeScript 5.9.3 source
- Bun for local development workflows
- Django-only public parser surface

## Install

```bash
bun add -d prettier prettier-plugin-django
```

The published plugin stays a standard JavaScript package, but this repo now uses Bun for development workflows.

## Use

```bash
bunx prettier --plugin prettier-plugin-django --parser django --write "**/*.django"
```

Example Prettier config:

```json
{
  "overrides": [
    {
      "files": ["*.django"],
      "options": {
        "parser": "django"
      }
    }
  ]
}
```

## Options

- `djangoSingleQuote` - use single quotes in template strings
- `djangoAlwaysBreakObjects` - always break object literals
- `djangoPrintWidth` - override print width for Django templates
- `djangoSpaceAroundFilters` - print spaces around `|`
- `djangoOutputEndblockName` - print the block name in `endblock`

## Development

```bash
bun install
bun run build
bun run check
```
