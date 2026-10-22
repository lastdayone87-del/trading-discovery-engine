import assert from 'node:assert/strict';
import test from 'node:test';
import { request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { parseConnectAuthority, resolvePinnedPublicAddress, startBrowserEgressProxy } from './browserEgressProxy';

const PUBLIC = { address: '93.184.216.1', family: 4 };
const PRIVATE = { address: '10.0.0.5', family: 4 };

const proxyRequest = (proxyUrl: string, path: string): Promise<number> => new Promise((resolve, reject) => {
  const port = Number(new URL(proxyUrl).port);
  const request = httpRequest({ host: '127.0.0.1', port, method: 'GET', path }, response => {
    response.resume();
    resolve(response.statusCode ?? 0);
  });
  request.once('error', reject);
  request.end();
});

const connectRequest = (proxyUrl: string, authority: string): Promise<string> => new Promise((resolve, reject) => {
  const port = Number(new URL(proxyUrl).port);
  const socket = netConnect({ host: '127.0.0.1', port }, () => {
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  });
  let data = '';
  socket.setEncoding('utf8');
  socket.once('data', chunk => {
    data += chunk;
    socket.destroy();
    resolve(data);
  });
  socket.once('error', reject);
  socket.setTimeout(2_000, () => {
    socket.destroy();
    reject(new Error('proxy response timeout'));
  });
});

test('pinned browser resolution accepts only wholly public answers', async () => {
  let lookups = 0;
  const pinned = await resolvePinnedPublicAddress('public.example', async () => {
    lookups++;
    return [PUBLIC];
  });
  assert.deepEqual(pinned, PUBLIC);
  assert.equal(lookups, 1);

  assert.deepEqual(await resolvePinnedPublicAddress('93.184.216.1'), PUBLIC);
  await assert.rejects(resolvePinnedPublicAddress('169.254.169.254'), /BLOCKED_DESTINATION/);
  await assert.rejects(resolvePinnedPublicAddress('private.example', async () => [PRIVATE]), /BLOCKED_DESTINATION/);
  await assert.rejects(
    resolvePinnedPublicAddress('mixed.example', async () => [PUBLIC, PRIVATE]),
    /BLOCKED_DESTINATION/,
  );
  await assert.rejects(resolvePinnedPublicAddress('empty.example', async () => []), /BLOCKED_DESTINATION/);
});

test('CONNECT authority parsing preserves explicit ports and rejects ambiguity', () => {
  assert.deepEqual(parseConnectAuthority('public.example:80'), { hostname: 'public.example', port: 80 });
  assert.deepEqual(parseConnectAuthority('public.example'), { hostname: 'public.example', port: 443 });
  assert.deepEqual(parseConnectAuthority('public.example:443'), { hostname: 'public.example', port: 443 });
  assert.deepEqual(parseConnectAuthority('[2001:4860:4860::8888]:443'), {
    hostname: '[2001:4860:4860::8888]',
    port: 443,
  });
  assert.equal(parseConnectAuthority('user@public.example:443'), undefined);
  assert.equal(parseConnectAuthority('public.example:443/path'), undefined);
  assert.equal(parseConnectAuthority('public.example:not-a-port'), undefined);
  assert.equal(parseConnectAuthority(undefined), undefined);
});

test('pinned browser resolution has a bounded DNS deadline', async () => {
  await assert.rejects(
    resolvePinnedPublicAddress('slow.example', () => new Promise(() => undefined), 20),
    /DNS_TIMEOUT/,
  );
});

test('browser proxy blocks private plain-HTTP destinations without caching', async () => {
  let lookups = 0;
  const proxy = await startBrowserEgressProxy({
    lookup: async () => {
      lookups++;
      return [PRIVATE];
    },
  });
  try {
    assert.equal(await proxyRequest(proxy.url, 'http://internal.example/'), 403);
    assert.equal(await proxyRequest(proxy.url, 'http://internal.example/second'), 403);
    assert.equal(lookups, 2, 'each connection attempt must perform a fresh lookup');
  } finally {
    await proxy.close();
  }
});

test('browser proxy blocks private CONNECT destinations and disallowed ports', async () => {
  const proxy = await startBrowserEgressProxy({ lookup: async () => [PRIVATE] });
  try {
    assert.match(await connectRequest(proxy.url, 'internal.example:443'), /^HTTP\/1\.1 403/);
    assert.equal(await proxyRequest(proxy.url, 'http://public.example:8080/'), 403);
  } finally {
    await proxy.close();
  }
});
