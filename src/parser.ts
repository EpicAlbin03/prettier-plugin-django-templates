// @ts-nocheck

import { CharStream, Lexer, TokenStream, Parser } from './melody-parser/src'
import { extension as coreExtension } from './melody-extension-core/src'

const ORIGINAL_SOURCE = 'ORIGINAL_SOURCE'

const createConfiguredLexer = (code, ...extensions) => {
  const lexer = new Lexer(new CharStream(code))
  for (const extension of extensions) {
    if (extension.unaryOperators) {
      lexer.addOperators(...extension.unaryOperators.map((operator) => operator.text))
    }
    if (extension.binaryOperators) {
      lexer.addOperators(...extension.binaryOperators.map((operator) => operator.text))
    }
  }
  return lexer
}

const applyParserExtensions = (parser, ...extensions) => {
  for (const extension of extensions) {
    if (extension.tags) {
      for (const tag of extension.tags) {
        parser.addTag(tag)
      }
    }
    if (extension.unaryOperators) {
      for (const operator of extension.unaryOperators) {
        parser.addUnaryOperator(operator)
      }
    }
    if (extension.binaryOperators) {
      for (const operator of extension.binaryOperators) {
        parser.addBinaryOperator(operator)
      }
    }
    if (extension.tests) {
      for (const test of extension.tests) {
        parser.addTest(test)
      }
    }
  }
}

const createConfiguredParser = (code, ...extensions) => {
  const parser = new Parser(
    new TokenStream(createConfiguredLexer(code, ...extensions), {
      ignoreWhitespace: true,
      ignoreComments: false,
      ignoreHtmlComments: false,
      applyWhitespaceTrimming: false
    }),
    {
      ignoreComments: false,
      ignoreHtmlComments: false,
      ignoreDeclarations: false,
      decodeEntities: false,
      multiTags: {},
      allowUnknownTags: true
    }
  )

  applyParserExtensions(parser, ...extensions)
  return parser
}

const parse = (text) => {
  const parser = createConfiguredParser(text, coreExtension)
  const ast = parser.parse()
  ast[ORIGINAL_SOURCE] = text
  return ast
}

export { parse, ORIGINAL_SOURCE }
