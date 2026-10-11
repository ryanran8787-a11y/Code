import { compileList, decideApproval, isRetryable, isFatal, backoffMs } from '../server/policy.ts'

function eq(a: any, b: any, msg: string) {
  if (a !== b) { console.error(`FAIL ${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); process.exit(1) }
  console.log(`ok ${msg}`)
}

async function main() {
  const allow = compileList(['^(npm test|git status)(\\s|$)'])
  const deny = compileList(['rm\\s+-rf\\s+/(\\s|$)'])
  const bad = compileList(['([invalid'])
  eq(bad.length, 1, 'invalid regex degrades instead of throwing')
  eq(bad[0].test('([invalid'), true, 'invalid regex matches literally')

  const base = { autoRun: false, allow, deny }
  eq(decideApproval('npm test', base), 'allow', 'allowlist hit')
  eq(decideApproval('npm test -- --watch', base), 'allow', 'allowlist with args')
  eq(decideApproval('npmtest', base), 'ask', 'prefix without boundary asks')
  eq(decideApproval('rm -rf /', base), 'deny', 'denylist hit')
  eq(decideApproval('echo hi', base), 'ask', 'unknown asks')
  eq(decideApproval('echo hi', { ...base, autoRun: true }), 'allow', 'autoRun allows')
  eq(decideApproval('rm -rf /', { ...base, autoRun: true }), 'deny', 'deny wins over autoRun')
  eq(decideApproval('', base), 'ask', 'empty asks')

  eq(isRetryable({ status: 429 }), true, '429 retryable')
  eq(isRetryable({ status: 503 }), true, '503 retryable')
  eq(isRetryable({ status: 500 }), true, '500 retryable')
  eq(isRetryable({ status: 400 }), false, '400 not retryable')
  eq(isRetryable({ status: 401 }), false, '401 not retryable')
  eq(isRetryable(new Error('socket hang up')), true, 'hang up retryable')
  eq(isRetryable(new Error('Connection timeout')), true, 'timeout retryable')
  eq(isRetryable(new Error('nope')), false, 'plain error not retryable')
  eq(isFatal({ status: 401 }), true, '401 fatal')
  eq(isFatal({ status: 429 }), false, '429 not fatal')
  eq(isFatal({ name: 'AbortError' }), true, 'abort fatal')

  for (let i = 0; i < 20; i++) {
    const b0 = backoffMs(0)
    if (b0 < 800 || b0 > 1200) { console.error(`FAIL backoff(0) out of range: ${b0}`); process.exit(1) }
  }
  console.log('ok backoff(0) ~1s with jitter')
  const b3 = backoffMs(3)
  if (b3 < 6400 || b3 > 9600) { console.error(`FAIL backoff(3) out of range: ${b3}`); process.exit(1) }
  console.log('ok backoff(3) ~8s with jitter')
  if (backoffMs(99) > 15000 * 1.2) { console.error('FAIL backoff cap'); process.exit(1) }
  console.log('ok backoff capped')
  console.log('POLICY-UNIT-OK')
}
main().catch((e) => { console.error(e); process.exit(1) })
