import type { Parser, Printer, SupportLanguage } from 'prettier';
import * as prettierPluginHtml from 'prettier/plugins/html';

type PlaceholderMap = Record<string, string>;
type DjangoOptions = { __djangoPlaceholders?: PlaceholderMap };

type Token =
    | { type: 'text'; raw: string; content: string }
    | { type: 'block'; raw: string; content: string }
    | { type: 'var'; raw: string; content: string }
    | { type: 'comment'; raw: string; content: string };

const htmlParser = prettierPluginHtml.parsers.html;
const htmlPrinter = prettierPluginHtml.printers.html;
const DJANGO_TAG_RE = /({%[\s\S]*?%}|{{[\s\S]*?}}|{#[\s\S]*?#})/g;
const PLACEHOLDER_PREFIX = '___PRETTIER_DJANGO_';
const PLACEHOLDER_SUFFIX = '___';

function placeholderName(id: number) {
    return `${PLACEHOLDER_PREFIX}${id}${PLACEHOLDER_SUFFIX}`;
}

class PlaceholderStore {
    nextId = 0;
    values: PlaceholderMap = {};

    add(raw: string) {
        const key = placeholderName(this.nextId++);
        this.values[key] = raw;
        return key;
    }
}

function normalizeTag(raw: string, type: Token['type'], content: string) {
    const inner = content.trim();

    switch (type) {
        case 'var':
            return `{{ ${inner} }}`;
        case 'comment':
            return `{# ${inner} #}`;
        case 'block':
            return `{% ${inner} %}`;
        default:
            return raw;
    }
}

function tokenize(text: string): Token[] {
    const tokens: Token[] = [];
    let inTag = false;
    let verbatimEndTag: string | null = null;

    for (const chunk of text.split(DJANGO_TAG_RE)) {
        if (!chunk) {
            continue;
        }

        if (inTag) {
            const start = chunk.slice(0, 2);

            if (start === '{%') {
                const content = chunk.slice(2, -2).trim();

                if (verbatimEndTag) {
                    if (content === verbatimEndTag) {
                        verbatimEndTag = null;
                        tokens.push({ type: 'block', raw: chunk, content });
                    } else {
                        tokens.push({ type: 'text', raw: chunk, content: chunk });
                    }
                } else {
                    if (content === 'verbatim' || content.startsWith('verbatim ')) {
                        verbatimEndTag = `end${content}`;
                    }

                    tokens.push({ type: 'block', raw: chunk, content });
                }
            } else if (verbatimEndTag) {
                tokens.push({ type: 'text', raw: chunk, content: chunk });
            } else if (start === '{{') {
                tokens.push({ type: 'var', raw: chunk, content: chunk.slice(2, -2).trim() });
            } else {
                tokens.push({
                    type: 'comment',
                    raw: chunk,
                    content: chunk.slice(2, -2).trim(),
                });
            }
        } else {
            tokens.push({ type: 'text', raw: chunk, content: chunk });
        }

        inTag = !inTag;
    }

    return tokens;
}

function transformTemplate(text: string) {
    const placeholders = new PlaceholderStore();
    const transformed = tokenize(text)
        .map((token) => {
            if (token.type === 'text') {
                return token.content;
            }

            return placeholders.add(normalizeTag(token.raw, token.type, token.content));
        })
        .join('');

    return { transformed, placeholders: placeholders.values };
}

function replaceString(input: string, values: PlaceholderMap) {
    let output = input;

    for (const [key, value] of Object.entries(values)) {
        output = output.split(key).join(value);
    }

    return output;
}

function replacePlaceholdersInDoc(options: DjangoOptions, value: any): any {
    const placeholders = options.__djangoPlaceholders;

    if (!placeholders || Object.keys(placeholders).length === 0) {
        return value;
    }

    if (typeof value === 'string') {
        return replaceString(value, placeholders);
    }

    if (Array.isArray(value)) {
        return value.map((entry) => replacePlaceholdersInDoc(options, entry));
    }

    if (!value || typeof value !== 'object') {
        return value;
    }

    const copy: Record<string, any> = {};
    for (const [key, child] of Object.entries(value)) {
        copy[key] = replacePlaceholdersInDoc(options, child);
    }
    return copy;
}

export const languages: Partial<SupportLanguage>[] = [
    {
        name: 'HTML+Django',
        parsers: ['django-html'],
        extensions: ['.html'],
        vscodeLanguageIds: ['html'],
    },
];

export const parsers: Record<string, Parser> = {
    'django-html': {
        ...htmlParser,
        parse: (text, options) => {
            const { transformed, placeholders } = transformTemplate(text);
            (options as DjangoOptions).__djangoPlaceholders = placeholders;
            return htmlParser.parse(transformed, options);
        },
        astFormat: htmlParser.astFormat,
        locStart: htmlParser.locStart,
        locEnd: htmlParser.locEnd,
    },
};

export const printers: Record<string, Printer> = {
    html: {
        ...htmlPrinter,
        print(path, options, print) {
            const result = htmlPrinter.print(path, options, print);
            return replacePlaceholdersInDoc(options as DjangoOptions, result);
        },
    },
};

export const options = {};
