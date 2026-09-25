# Prettier Plugin Django Templates

Format Django HTML templates with Prettier.

## Prerequisites

- Node.js 22+
- Prettier 3

## Install

```bash
npm i -D prettier prettier-plugin-django-templates
```

## Usage

Add the plugin to your Prettier config:

```json
{
  "plugins": ["prettier-plugin-django-templates"]
}
```

The plugin provides the `django-html` parser for Django HTML templates in `.html` files. In most setups, adding the plugin is enough. If you need to force the parser for specific files, use a Prettier override:

```json
{
  "plugins": ["prettier-plugin-django-templates"],
  "overrides": [
    {
      "files": "*.html",
      "options": {
        "parser": "django-html"
      }
    }
  ]
}
```

## Inline element whitespace

Prettier preserves whitespace around inline elements by default, which can produce formatting like this:

```html
<a href="{% url 'detail' object.pk %}" title="{{ object.title }}"
  >{{ object.title }}</a
>
```

To allow Prettier to normalize the whitespace, set [htmlWhitespaceSensitivity](https://prettier.io/docs/options#html-whitespace-sensitivity) to `ignore`:

```json
{
  "htmlWhitespaceSensitivity": "ignore"
}
```

The same element will then be formatted as:

```html
<a href="{% url 'detail' object.pk %}" title="{{ object.title }}">
  {{ object.title }}
</a>
```

This can change how whitespace renders between inline elements.

## Ignore regions

Ignore regions tell the plugin to leave part of a Django HTML template unchanged:

```html
<!-- prettier-ignore-start -->
<script>
  window.someData = {{ data|safe }}
</script>
<!-- prettier-ignore-end -->

<!-- prettier-ignore-start -->
<style>
  :root { --accent-color: {{ theme_accent_color }} }
</style>
<!-- prettier-ignore-end -->
```

Or using template comments:

```html
{# prettier-ignore-start #}
<script>
  window.someData = {{ data|safe }}
</script>
{# prettier-ignore-end #}

{# prettier-ignore-start #}
<style>
  :root { --accent-color: {{ theme_accent_color }} }
</style>
{# prettier-ignore-end #}
```

## Usage in the browser

Import `prettier-plugin-django-templates/browser` from an ESM-aware bundler to get an entry that depends on `prettier/standalone` and does not use Node APIs. The browser entry is intended for bundlers such as Vite. It is not a self-contained bundle and direct no-build CDN or script-tag usage is not supported.

## Credits

- [prettier-plugin-jinja-template](https://github.com/davidodenwald/prettier-plugin-jinja-template/tree/master) (parser, printer, tests)
- [prettier-plugin-svelte](https://github.com/sveltejs/prettier-plugin-svelte/tree/main) (tooling)

## License

Licensed under the [MIT license](https://github.com/EpicAlbin03/prettier-plugin-django-templates/blob/main/LICENSE).
