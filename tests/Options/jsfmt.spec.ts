import { runSpec } from '../../tests_config/run-spec'

runSpec(import.meta.url, ['django'], {
  djangoAlwaysBreakObjects: false,
  djangoPrintWidth: 120,
  djangoOutputEndblockName: true
})
