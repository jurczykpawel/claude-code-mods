// Run: node --test cache-keeper/tests/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { VERSION } from '../hooks/version.mjs'

// /cache stats prints VERSION, so it must be the version the plugin ships as,
// otherwise a stale chat and a fresh one would look the same.
test('VERSION matches plugin.json', () => {
  const manifest = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'))
  assert.equal(VERSION, manifest.version)
})
