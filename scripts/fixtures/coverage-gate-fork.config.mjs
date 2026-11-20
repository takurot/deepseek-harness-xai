import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import base from '../../vitest.config.ts'

const scratch = process.env.DSH_TEST_FORK_CACHE
const projectName = process.env.DSH_TEST_FORK_PROJECT
if (!scratch || !projectName) throw new Error('coverage gate fixture requires private scratch and a project name')

const fixture = 'scripts/fixtures/coverage-fork.fixture.ts'

// Keep the gate-selected pool from each production project. Only the fixture may exit early.
export default {
  ...base,
  cacheDir: resolve(scratch, 'vite'),
  test: {
    ...base.test,
    cache: false,
    reporters: ['default', {
      async onTestRunEnd(modules) {
        await writeFile(resolve(scratch, 'results.json'), JSON.stringify({
          runnerPid: process.pid,
          modules: modules.map(module => ({
            project: module.project.name,
            pool: module.toTestSpecification().pool,
            file: module.relativeModuleId.replaceAll('\\', '/'),
            tests: Array.from(module.children.allTests(), test => ({ name: test.name, state: test.result().state })),
          })),
        }))
      },
    }],
    coverage: {
      ...base.test.coverage,
      include: [fixture],
      reportsDirectory: resolve(scratch, 'coverage'),
      reporter: ['text'],
    },
    projects: base.test.projects.map(project => ({
      ...project,
      test: {
        ...project.test,
        include: projectName === 'all' || project.test.name === projectName ? [fixture] : [],
        execArgv: [...project.test.execArgv, '--require', resolve(import.meta.dirname, 'coverage-fork-exit.cjs')],
      },
    })),
  },
}
