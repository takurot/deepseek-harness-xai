/** Persistent local state for unpackaged Desktop launches. */
import { lstatSync, mkdirSync, readlinkSync, realpathSync, renameSync, statSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Separate locations for Harness state and the Electron browser profile. */
export interface DevelopmentState {
  readonly home: string
  readonly userData: string
}

/**
 * Identify legacy default locations that clean must not delete.
 * @param appRoot - Desktop application directory.
 * @returns Paths under the disposable development build tree.
 */
export function legacyDevelopmentState(appRoot: string): DevelopmentState {
  return statePaths(join(appRoot, '.desktop-build', 'development'))
}

function statePaths(root: string): DevelopmentState {
  return { home: join(root, 'home'), userData: join(root, 'electron-user-data') }
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function directoryExists(path: string): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat === undefined) return false
  if (!stat.isDirectory()) throw new Error(`desktop development: ${path} is not a real directory; move the data to a real directory outside the build tree and retry`)
  return true
}

function isWithin(directory: string, path: string): boolean {
  const child = relative(directory, path)
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

function absoluteLinkTarget(path: string, parent: string): string {
  const target = readlinkSync(path)
  const windows = process.platform === 'win32'
  const components = target.split(windows ? /[\\/]/ : '/')
  // Normalizing `..` can hide an intermediate directory that the OS traverses through a link.
  if (components.includes('..')) throw new Error(`link target contains a parent component: ${path}`)
  if (windows && !/^[a-z]:[\\/]/i.test(target) && (/^[\\/]/.test(target) || target.includes(':'))) {
    throw new Error(`unsupported Windows link target: ${path}`)
  }
  return isAbsolute(target) ? target : resolve(realpathSync.native(parent), target)
}

function overrideUsesDirectory(source: string, override: string, key: string): boolean {
  if (isWithin(source, override)) return true
  const identity = lstatSync(source, { bigint: true, throwIfNoEntry: false })
  if (!identity) return false

  // A final realpath can omit a legacy directory traversed inside a link target, and a
  // missing suffix does not prevent an existing ancestor from depending on that directory.
  const pending = new Set([override])
  for (const path of pending) {
    const parent = dirname(path)
    if (parent !== path) pending.add(parent)
    try {
      if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) pending.add(absoluteLinkTarget(path, parent))
      const canonical = realpathSync.native(path)
      const stat = statSync(canonical, { bigint: true })
      if (stat.dev === identity.dev && stat.ino === identity.ino) return true
      const canonicalParent = dirname(canonical)
      if (canonicalParent !== canonical) pending.add(canonicalParent)
    } catch (error) {
      if (isCode(error, 'ENOENT') || isCode(error, 'ENOTDIR')) continue
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`desktop development: cannot check ${key}=${override} before moving ${source}; use a direct path and retry: ${detail}`, { cause: error })
    }
  }
  return false
}

function assertProfileIdle(profile: string): void {
  try {
    // Chromium keeps this file open with delete-on-close on Windows.
    if (process.platform === 'win32') {
      if (!lstatSync(join(profile, 'lockfile'), { throwIfNoEntry: false })) return
    } else {
      // Chromium's POSIX lock is a symlink to <hostname>-<pid>, not a file at that target.
      const lock = readlinkSync(join(profile, 'SingletonLock'))
      const match = /^(.+)-(\d+)$/.exec(lock)
      const pid = Number(match?.[2])
      if (match?.[1] === hostname() && Number.isInteger(pid) && pid > 0 && pid <= 0x7fffffff) {
        try {
          process.kill(pid, 0)
        } catch (error) {
          if (isCode(error, 'ESRCH')) return
          throw error
        }
      }
    }
  } catch (error) {
    if (isCode(error, 'ENOENT')) return
    throw new Error(`desktop development: cannot verify ownership of legacy Electron profile ${profile}; quit all Desktop development processes and inspect the profile lock before retrying`, { cause: error })
  }
  throw new Error(`desktop development: legacy Electron profile ${profile} is locked; quit all Desktop development processes and verify the profile is idle before retrying`)
}

function moveDirectory(source: string, destination: string): void {
  try {
    renameSync(source, destination)
  } catch (error) {
    // Another launch can complete the same rename between checking and moving the source.
    if (isCode(error, 'ENOENT') && !directoryExists(source) && directoryExists(destination)) return
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`desktop development: cannot move ${source} to ${destination}; resolve the filesystem error before retrying: ${detail}`, { cause: error })
  }
  console.log(`desktop development: moved ${source} to ${destination}`)
}

/**
 * Resolve development defaults outside the build tree, moving each legacy default only when its
 * destination is missing. Quit old Desktop development processes before calling. A locked legacy
 * profile prevents all moves. If a later rename fails, earlier moves remain in place; launch stops.
 * @param appRoot - Desktop application directory.
 * @param environment - Explicit `DSH_HOME` or `DSH_DESKTOP_USER_DATA_DIR` values resolve from the launcher's cwd
 * and skip their own default migrations.
 * @returns Harness home and Electron profile paths for this launch.
 */
export function prepareDevelopmentState(appRoot: string, environment: NodeJS.ProcessEnv): DevelopmentState {
  const { DSH_HOME, DSH_DESKTOP_USER_DATA_DIR } = environment
  const root = join(appRoot, '.desktop-dev')
  const defaults = statePaths(root)
  const paths = {
    home: DSH_HOME === undefined ? defaults.home : resolve(DSH_HOME),
    userData: DSH_DESKTOP_USER_DATA_DIR === undefined ? defaults.userData : resolve(DSH_DESKTOP_USER_DATA_DIR),
  }
  if (DSH_HOME !== undefined && DSH_DESKTOP_USER_DATA_DIR !== undefined) return paths

  directoryExists(root)
  const build = join(appRoot, '.desktop-build')
  const hasLegacyRoot = directoryExists(build) && directoryExists(join(build, 'development'))

  const legacy = legacyDevelopmentState(appRoot)
  const candidates = [
    { usesDefault: DSH_HOME === undefined, source: legacy.home, destination: paths.home,
      otherOverride: DSH_DESKTOP_USER_DATA_DIR === undefined ? undefined : paths.userData, otherKey: 'DSH_DESKTOP_USER_DATA_DIR' },
    { usesDefault: DSH_DESKTOP_USER_DATA_DIR === undefined, source: legacy.userData, destination: paths.userData,
      otherOverride: DSH_HOME === undefined ? undefined : paths.home, otherKey: 'DSH_HOME' },
  ]
  const moves = candidates.filter(({ usesDefault, destination, source, otherOverride, otherKey }) => {
    if (!usesDefault || directoryExists(destination) || !hasLegacyRoot || !directoryExists(source)) return false
    if (otherOverride !== undefined && overrideUsesDirectory(source, otherOverride, otherKey)) {
      throw new Error(`desktop development: cannot move ${source} because ${otherKey} refers to it; move the legacy data manually and update the override before retrying`)
    }
    return true
  })
  if (moves.length === 0) return paths

  if (directoryExists(legacy.userData)) assertProfileIdle(legacy.userData)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  for (const { source, destination } of moves) moveDirectory(source, destination)
  return paths
}
