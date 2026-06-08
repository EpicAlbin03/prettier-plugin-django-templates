const RAW = Symbol.for('raw')

export default {
  print(value: Record<symbol, string>) {
    return value[RAW]
  },
  test(value: unknown) {
    return Boolean(value && typeof value === 'object' && RAW in value && typeof (value as Record<symbol, unknown>)[RAW] === 'string')
  }
}
