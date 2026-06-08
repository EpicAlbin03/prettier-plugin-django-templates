import test from 'ava';
import { format } from 'prettier';
import * as DjangoPlugin from '../src';

test('formats html around django tags', async (t) => {
    const input = `<div><span>{{value}}</span>{% if user %}<strong>{{ user.name }}</strong>{% endif %}</div>`;
    const output = await format(input, {
        parser: 'django-html',
        plugins: [DjangoPlugin],
    });

    t.is(
        output,
        `<div>\n  <span>{{ value }}</span\n  >{% if user %}<strong>{{ user.name }}</strong>{% endif %}\n</div>\n`,
    );
});

test('preserves verbatim blocks', async (t) => {
    const input = `<div>{% verbatim %}{{ untouched }}{% endverbatim %}</div>`;
    const output = await format(input, {
        parser: 'django-html',
        plugins: [DjangoPlugin],
    });

    t.is(output, `<div>{% verbatim %}{{ untouched }}{% endverbatim %}</div>\n`);
});
