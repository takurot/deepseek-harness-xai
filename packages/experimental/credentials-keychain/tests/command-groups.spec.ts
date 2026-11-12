/** Linux zombie-only groups release descriptors even when PID1 has not yet reaped them. */
import { describe, expect, it, vi } from 'vitest'
import { linuxGroupHasLiveMembers } from '../src/command-runner.ts'

const state = vi.hoisted(() => ({ entries: [] as string[], files: new Map<string, string>(), unreadable: false }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readdirSync: () => { if (state.unreadable) throw new Error('denied'); return state.entries },
    readFileSync: (path: string) => {
      const value = state.files.get(path)
      if (value === undefined) throw new Error('process exited')
      return value
    },
  }
})

function stat(pid: number, group: number, status: string, threads = 1): string {
  return `${String(pid)} (fixture comm) ${status} 1 ${String(group)} 1 0 0 0 0 0 0 0 0 0 0 0 0 0 ${String(threads)} 0`
}

describe('Linux command-group observations', () => {
  it('excludes observed zombies but retains live and unobservable groups', () => {
    state.unreadable = true
    expect(linuxGroupHasLiveMembers(42)).toBeUndefined()
    state.unreadable = false
    state.entries = ['self', '1', '2', '3']
    state.files.set('/proc/1/stat', stat(1, 7, 'S'))
    expect(linuxGroupHasLiveMembers(42)).toBeUndefined()
    state.files.set('/proc/2/stat', stat(2, 42, 'Z'))
    expect(linuxGroupHasLiveMembers(42)).toBe(false)
    state.files.set('/proc/2/stat', stat(2, 42, 'Z', 2))
    expect(linuxGroupHasLiveMembers(42)).toBe(true)
    state.files.set('/proc/2/stat', stat(2, 42, 'Z'))
    state.files.set('/proc/3/stat', stat(3, 42, 'S'))
    expect(linuxGroupHasLiveMembers(42)).toBe(true)
  })
})
