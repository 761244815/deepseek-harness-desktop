import test from 'node:test'
import assert from 'node:assert/strict'
import { extractHarnessUrl } from '../lib/harness-manager.mjs'
import { shortCommit } from '../lib/updater.mjs'

test('extractHarnessUrl accepts only the local Harness startup line', () => {
  assert.equal(extractHarnessUrl('dsh web: http://127.0.0.1:43127'), 'http://127.0.0.1:43127')
  assert.equal(extractHarnessUrl('dsh web: http://0.0.0.0:3080'), null)
  assert.equal(extractHarnessUrl('http://127.0.0.1:3080'), null)
})

test('shortCommit validates and truncates Git object IDs', () => {
  assert.equal(shortCommit('47f943859bef60e4160492346772ded9b24f765a'), '47f943859bef')
  assert.throws(() => shortCommit('master'), /Invalid Git commit/)
})
