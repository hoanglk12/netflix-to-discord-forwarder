import test from 'node:test';
import assert from 'node:assert/strict';
import { isCrossOriginWrite, isLoopbackHost } from '../src/request-guard.js';

function request(method, headers) {
  return { method, headers };
}

test('allows reads regardless of origin', () => {
  assert.equal(isCrossOriginWrite(request('GET', { host: 'localhost:3000', origin: 'https://evil.example' })), false);
  assert.equal(isCrossOriginWrite(request('HEAD', { host: 'localhost:3000', origin: 'null' })), false);
});

test('allows same-origin writes from the dashboard', () => {
  assert.equal(isCrossOriginWrite(request('POST', {
    host: 'localhost:3000',
    origin: 'http://localhost:3000',
    'sec-fetch-site': 'same-origin',
  })), false);
  assert.equal(isCrossOriginWrite(request('POST', {
    host: 'forwarder.vercel.app',
    origin: 'https://forwarder.vercel.app',
  })), false);
});

test('allows writes from a proxy-forwarded host', () => {
  assert.equal(isCrossOriginWrite(request('POST', {
    host: 'internal-host',
    'x-forwarded-host': 'forwarder.vercel.app',
    origin: 'https://forwarder.vercel.app',
  })), false);
});

test('allows writes without an Origin header from non-browser clients', () => {
  assert.equal(isCrossOriginWrite(request('POST', { host: 'localhost:3000' })), false);
});

test('rejects writes from another origin, including simple text/plain posts', () => {
  assert.equal(isCrossOriginWrite(request('POST', {
    host: 'localhost:3000',
    origin: 'https://evil.example',
    'content-type': 'text/plain',
  })), true);
  assert.equal(isCrossOriginWrite(request('POST', {
    host: 'localhost:3000',
    origin: 'http://localhost:8080',
  })), true);
});

test('rejects the opaque "null" origin and unparseable origins', () => {
  assert.equal(isCrossOriginWrite(request('POST', { host: 'localhost:3000', origin: 'null' })), true);
  assert.equal(isCrossOriginWrite(request('POST', { host: 'localhost:3000', origin: '' })), true);
});

test('rejects writes the browser marks as cross-site even without an Origin header', () => {
  assert.equal(isCrossOriginWrite(request('POST', { host: 'localhost:3000', 'sec-fetch-site': 'cross-site' })), true);
  assert.equal(isCrossOriginWrite(request('DELETE', { host: 'localhost:3000', 'sec-fetch-site': 'same-site' })), true);
});

test('compares hosts case-insensitively', () => {
  assert.equal(isCrossOriginWrite(request('POST', {
    host: 'LocalHost:3000',
    origin: 'http://localhost:3000',
  })), false);
});

test('accepts only loopback names as the local server host', () => {
  assert.equal(isLoopbackHost('localhost:3000'), true);
  assert.equal(isLoopbackHost('127.0.0.1:3000'), true);
  assert.equal(isLoopbackHost('[::1]:3000'), true);
  assert.equal(isLoopbackHost('LOCALHOST'), true);
  assert.equal(isLoopbackHost('attacker.example:3000'), false);
  assert.equal(isLoopbackHost('192.168.1.20:3000'), false);
  assert.equal(isLoopbackHost(''), false);
  assert.equal(isLoopbackHost(undefined), false);
});
