// @ts-nocheck

import { embed } from './embed.js'
import { parse } from './parser.js'
import { print } from './printer.js'

const languages = [
  {
    name: 'Django',
    parsers: ['django'],
    group: 'Template',
    tmScope: 'text.html.django',
    aceMode: 'html',
    codemirrorMode: 'htmlmixed',
    codemirrorMimeType: 'text/x-django',
    extensions: ['.django'],
    linguistLanguageId: 0,
    vscodeLanguageIds: ['django', 'django-html']
  }
]

const hasPragma = () => false
const locStart = () => -1
const locEnd = () => -1

const parsers = {
  django: {
    parse,
    astFormat: 'django',
    hasPragma,
    locStart,
    locEnd
  }
}

const canAttachComment = (node) => node.ast_type && node.ast_type !== 'comment'

const printComment = (commentPath) => {
  const comment = commentPath.getValue()

  switch (comment.ast_type) {
    case 'comment':
      return comment.value
    default:
      throw new Error(`Not a comment: ${JSON.stringify(comment)}`)
  }
}

const clean = (_ast, newObj) => {
  delete newObj.lineno
  delete newObj.col_offset
}

const printers = {
  django: {
    print,
    embed,
    printComment,
    canAttachComment,
    massageAstNode: clean,
    willPrintOwnComments: () => true
  }
}

const options = {
  djangoSingleQuote: {
    type: 'boolean',
    category: 'Global',
    default: true,
    description: 'Use single quotes in Django templates.'
  },
  djangoAlwaysBreakObjects: {
    type: 'boolean',
    category: 'Global',
    default: true,
    description: 'Always break object literals in Django templates.'
  },
  djangoPrintWidth: {
    type: 'int',
    category: 'Global',
    default: 80,
    description: 'Print width for Django templates.'
  },
  djangoSpaceAroundFilters: {
    type: 'boolean',
    category: 'Global',
    default: false,
    description: 'Print spaces around the filter separator.'
  },
  djangoOutputEndblockName: {
    type: 'boolean',
    category: 'Global',
    default: false,
    description: "Output the Django block name in the 'endblock' tag."
  }
}

const plugin = { languages, options, parsers, printers }

export { languages, options, parsers, printers }
export default plugin
