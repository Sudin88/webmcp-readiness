/**
 * Tests for the SSRF guard. These matter more than most of the rest of the
 * project: the service fetches URLs chosen by strangers, so this file is what
 * stands between a public endpoint and the internal network behind it.
 *
 * Runs with no network access: DNS is injected.
 */
import { isIP } from 'node:net';
import { isPrivateAddress, parseTargetUrl, resolveAndValidate, BlockedTarget } from './safety.mjs';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}`); } };
const throws = (fn, name, expectSubstring) => {
  try { fn(); fail++; console.log(`  FAIL  ${name} (did not throw)`); }
  catch (e) {
    if (e instanceof BlockedTarget && (!expectSubstring || String(e.message).toLowerCase().includes(expectSubstring))) {
      pass++; console.log(`  PASS  ${name}`);
    } else { fail++; console.log(`  FAIL  ${name} (threw ${e.name}: ${e.message})`); }
  }
};
const fakeDns = (map) => async (host) => {
  if (!(host in map)) { const e = new Error('ENOTFOUND'); e.code = 'ENOTFOUND'; throw e; }
  return [{ address: map[host], family: isIP(map[host]) }];
};

console.log('\nprivate address detection');
for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1',
                  '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fe80::1', 'fc00::1',
                  '::ffff:169.254.169.254']) {
  ok(isPrivateAddress(ip), `blocks ${ip}`);
}
for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '172.15.0.1', '2606:4700::1111']) {
  ok(!isPrivateAddress(ip), `allows public ${ip}`);
}

console.log('\nURL shape');
throws(() => parseTargetUrl('file:///etc/passwd'), 'blocks file: scheme', 'scheme');
throws(() => parseTargetUrl('gopher://x/'), 'blocks gopher: scheme', 'scheme');
throws(() => parseTargetUrl('javascript:alert(1)'), 'blocks javascript: scheme', 'scheme');
throws(() => parseTargetUrl('not a url'), 'blocks malformed input', 'valid');
throws(() => parseTargetUrl(''), 'blocks empty input', 'empty');
throws(() => parseTargetUrl('https://user:pw@example.com/'), 'blocks credentials', 'credentials');
throws(() => parseTargetUrl('https://example.com:6379/'), 'blocks non-web port', 'port');
throws(() => parseTargetUrl('http://127.0.0.1/'), 'blocks loopback literal', 'private');
throws(() => parseTargetUrl('http://169.254.169.254/latest/meta-data/'), 'blocks metadata literal', 'private');
ok(parseTargetUrl('https://example.com/x?y=1').hostname === 'example.com', 'accepts a normal URL');
ok(parseTargetUrl('  https://example.com/  ').hostname === 'example.com', 'tolerates whitespace');
ok(parseTargetUrl('http://example.com:8080/').port === '8080', 'accepts an allowed port');

console.log('\nIPv4-mapped and transition forms (the bypass that got through)');
// Drive these through parseTargetUrl, not isPrivateAddress directly. new URL()
// rewrites ::ffff:169.254.169.254 to ::ffff:a9fe:a9fe before any of our code
// runs, so a test on the dotted-quad string proves nothing.
for (const u of [
  'http://[::ffff:169.254.169.254]/latest/meta-data/',
  'http://[::ffff:a9fe:a9fe]/',
  'http://[0:0:0:0:0:ffff:169.254.169.254]/',
  'http://[::ffff:127.0.0.1]/',
  'http://[::ffff:10.0.0.1]/',
  'http://[::ffff:100.64.0.1]/',
  'http://[::169.254.169.254]/',        // v4-compatible
  'http://[64:ff9b::169.254.169.254]/', // NAT64
  'http://[2002:a9fe:a9fe::1]/',        // 6to4
  'http://[fe90::1]/', 'http://[febf::1]/', 'http://[fec0::1]/',
  'http://[fe80::1%25eth0]/'            // zone id
]) throws(() => parseTargetUrl(u), `blocks ${u}`);

for (const ip of ['::ffff:a9fe:a9fe','::ffff:127.0.0.1','::ffff:10.0.0.1','64:ff9b::a9fe:a9fe',
                  '::a9fe:a9fe','2002:a9fe:a9fe::','fe90::1','febf::1','fec0::1','::1','fe80::1','fc00::1'])
  ok(isPrivateAddress(ip), `blocks raw literal ${ip}`);

for (const ip of ['2606:4700::1111','2001:4860:4860::8888'])
  ok(!isPrivateAddress(ip), `allows public ${ip}`);

// Numeric IPv4 forms: WHATWG normalises these to dotted-quad, which is a real
// defence. Pin it so a refactor that stops using new URL() gets caught.
for (const u of ['http://2130706433/','http://0x7f000001/','http://017700000001/',
                 'http://127.1/','http://127.0.0.1./','HTTP://127.0.0.1/'])
  throws(() => parseTargetUrl(u), `blocks numeric IPv4 form ${u}`);

console.log('\nDNS resolution');
const dns = fakeDns({
  'good.example': '93.184.216.34',
  'internal.example': '10.1.2.3',
  'rebind.example': '8.8.8.8',
  'mixed.example': '1.1.1.1'
});
ok(true, 'fixture ready');
const good = await resolveAndValidate('https://good.example/', { dnsLookup: dns });
ok(good.addresses[0] === '93.184.216.34', 'allows a public hostname');
// The browser resolves DNS independently, so the validated ADDRESS has to
// survive to the caller or the check cannot be enforced on the connection.
ok(Array.isArray(good.addresses) && good.url.hostname === 'good.example',
   'returns resolved addresses so the caller can pin them');
const multiDns = async () => [{address:'1.1.1.1',family:4},{address:'8.8.8.8',family:4}];
const multi = await resolveAndValidate('https://multi.example/', { dnsLookup: multiDns });
ok(multi.addresses.length === 2, 'returns ALL addresses so every one can be pinned');

await (async () => {
  try {
    await resolveAndValidate('https://internal.example/', { dnsLookup: dns });
    fail++; console.log('  FAIL  blocks hostname resolving private');
  } catch (e) {
    ok(e instanceof BlockedTarget && e.reason.includes('private'), 'blocks hostname resolving private');
  }
})();

await (async () => {
  // Rebinding defence: the stub returns a public address on the first call (the
  // pre-flight check) and a private one afterwards (the actual connection).
  let calls = 0;
  const rebinding = async () => {
    calls++;
    return [{ address: calls === 1 ? '8.8.8.8' : '169.254.169.254', family: 4 }];
  };
  try {
    const { url } = await resolveAndValidate('https://rebind.example/', { dnsLookup: rebinding });
    const { assertRedirectAllowed } = await import('./safety.mjs');
    await assertRedirectAllowed(url.href, { dnsLookup: rebinding });
    fail++; console.log('  FAIL  catches DNS rebinding on a second lookup');
  } catch (e) {
    ok(e instanceof BlockedTarget, 'catches DNS rebinding on a second lookup');
  }
})();

await (async () => {
  // A host with both a public and a private address must be rejected outright:
  // the caller must not get to choose which one is used.
  const both = async () => [{ address: '8.8.8.8', family: 4 }, { address: '192.168.1.9', family: 4 }];
  try {
    await resolveAndValidate('https://mixed.example/', { dnsLookup: both });
    fail++; console.log('  FAIL  rejects host with mixed public/private answers');
  } catch (e) {
    ok(e instanceof BlockedTarget, 'rejects host with mixed public/private answers');
  }
})();

await (async () => {
  try {
    await resolveAndValidate('https://nx.example/', { dnsLookup: dns });
    fail++; console.log('  FAIL  rejects unresolvable host');
  } catch (e) {
    ok(e instanceof BlockedTarget, 'rejects unresolvable host');
  }
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);