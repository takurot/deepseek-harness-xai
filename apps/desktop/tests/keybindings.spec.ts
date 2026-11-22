import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { desktopKeybindings } from '../src/keybindings.ts'
import type { ShortcutCommandId, ShortcutConfigSnapshot } from '@deepseek-ai/dsh-client-shortcuts/protocol'

it('persists into the supplied userData, reloads null bindings, and retains original future-version bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-keybindings-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  let state!: ShortcutConfigSnapshot
  const first = desktopKeybindings(root, 'windows', (value) => { state = value })
  onTestFinished(() => { first.dispose() })
  const id = 'test.toggle' as ShortcutCommandId
  const definitions = [{ id, defaults: {
    'desktop:macos': { code: 'KeyB', modifiers: ['primary'] as const },
    'desktop:windows': { code: 'KeyB', modifiers: ['primary'] as const },
    'desktop:linux': { code: 'KeyB', modifiers: ['primary'] as const },
  } }]
  first.setDefinitions(definitions)
  await first.readCurrent()
  expect((await first.edit({ type: 'set', id, binding: null }, state.revision)).status).toBe('saved')
  const path = join(root, 'keybindings.json')
  const saved: unknown = JSON.parse(await readFile(path, 'utf8'))
  expect(saved).toMatchObject({ profiles: { 'desktop:windows': { [id]: null } } })
  const second = desktopKeybindings(root, 'windows', (value) => { state = value })
  onTestFinished(() => { second.dispose() })
  second.setDefinitions(definitions)
  expect((await second.readCurrent()).document.profiles['desktop:windows']?.[id]).toBeNull()
  expect((await second.edit({ type: 'reset', id }, state.revision)).status).toBe('saved')
  const original = '{"schemaVersion":7,"custom":"retain exactly"}\n'
  await writeFile(path, original)
  expect((await second.readCurrent()).error).toBe('future')
  expect((await second.edit({ type: 'reset-all' }, state.revision)).status).toBe('unreadable')
  expect(await readFile(path, 'utf8')).toBe(original)
})

it.each([
  ['an ordinary edit', { type: 'set', id: 'test.toggle' as ShortcutCommandId, binding: { code: 'KeyC', modifiers: ['control'] as const } }],
  ['Restore All', { type: 'reset-all' }],
] as const)('retains externally replaced future-version bytes when %s starts without rereading after the replacement', async (_label, edit) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-keybindings-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  let state!: ShortcutConfigSnapshot
  const store = desktopKeybindings(root, 'windows', (value) => { state = value })
  onTestFinished(() => { store.dispose() })
  const id = 'test.toggle' as ShortcutCommandId
  store.setDefinitions([{ id, defaults: {
    'desktop:macos': { code: 'KeyB', modifiers: ['primary'] as const },
    'desktop:windows': { code: 'KeyB', modifiers: ['primary'] as const },
    'desktop:linux': { code: 'KeyB', modifiers: ['primary'] as const },
  } }])
  await store.readCurrent()
  expect((await store.edit({ type: 'set', id, binding: null }, state.revision)).status).toBe('saved')
  const accepted = state.document
  const path = join(root, 'keybindings.json')
  const original = '{"schemaVersion":7,"custom":"retain exactly"}\n'
  await writeFile(path, original)
  const result = await store.edit(edit, state.revision)
  expect(result.status).toBe('unreadable')
  expect(result.snapshot).toMatchObject({ status: 'unreadable', error: 'future', document: accepted })
  expect(await readFile(path, 'utf8')).toBe(original)
})

it('retains externally replaced invalid bytes when Restore All starts without rereading after the replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-keybindings-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  let state!: ShortcutConfigSnapshot
  const store = desktopKeybindings(root, 'windows', (value) => { state = value })
  onTestFinished(() => { store.dispose() })
  const id = 'test.toggle' as ShortcutCommandId
  store.setDefinitions([{ id, defaults: {
    'desktop:macos': { code: 'KeyB', modifiers: ['primary'] as const },
    'desktop:windows': { code: 'KeyB', modifiers: ['primary'] as const },
    'desktop:linux': { code: 'KeyB', modifiers: ['primary'] as const },
  } }])
  await store.readCurrent()
  expect((await store.edit({ type: 'set', id, binding: null }, state.revision)).status).toBe('saved')
  const accepted = state.document
  const path = join(root, 'keybindings.json')
  const original = '{"schemaVersion":2,'
  await writeFile(path, original)
  const result = await store.edit({ type: 'reset-all' }, state.revision)
  expect(result.status).toBe('unreadable')
  expect(result.snapshot).toMatchObject({ status: 'unreadable', error: 'invalid', document: accepted })
  expect(await readFile(path, 'utf8')).toBe(original)
})
