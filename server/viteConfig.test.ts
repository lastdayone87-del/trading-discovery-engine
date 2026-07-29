import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredAllowedHosts } from '../vite.config';

test('allows the Railway dashboard hostname without disabling host validation',()=>{const hosts=configuredAllowedHosts();assert.ok(Array.isArray(hosts));assert.ok(hosts.includes('trading-discovery-engine-production.up.railway.app'))});
test('additional production hosts are explicit comma-separated entries',()=>{assert.deepEqual(configuredAllowedHosts('dashboard.example.com, admin.example.com'),['trading-discovery-engine-production.up.railway.app','dashboard.example.com','admin.example.com'])});
