import { afterAll, beforeEach, expect, jest, test } from '@jest/globals'
import { PnpmError } from '@pnpm/error'
import type { PathExtenderReport } from '@pnpm/os.env.path-extender'

jest.unstable_mockModule('@pnpm/os.env.path-extender', () => ({
  addDirToEnvPath: jest.fn(),
}))

const actualFs = await import('node:fs')
jest.unstable_mockModule('fs', () => {
  return {
    ...actualFs,
    promises: {
      ...actualFs.promises,
      readFile: jest.fn(),
      writeFile: jest.fn(),
    },
  }
})

const actualOs = await import('node:os')
jest.unstable_mockModule('node:os', () => {
  const homedir = jest.fn(() => actualOs.homedir())
  return {
    ...actualOs,
    default: {
      ...actualOs,
      homedir,
    },
    homedir,
  }
})

const { addDirToEnvPath } = await import('@pnpm/os.env.path-extender')
const { setup } = await import('@pnpm/engine.pm.commands')
const fs = await import('node:fs')
const os = await import('node:os')
const path = await import('node:path')

const originalFishVersion = process.env.FISH_VERSION
const originalHome = process.env.HOME
const originalShell = process.env.SHELL

beforeEach(() => {
  jest.clearAllMocks()
  delete process.env.FISH_VERSION
  process.env.SHELL = '/bin/bash'
  jest.mocked(os.default.homedir).mockReturnValue(originalHome ?? actualOs.homedir())
  jest.mocked(addDirToEnvPath).mockReset()
})

afterAll(() => {
  if (originalFishVersion == null) {
    delete process.env.FISH_VERSION
  } else {
    process.env.FISH_VERSION = originalFishVersion
  }
  if (originalShell == null) {
    delete process.env.SHELL
  } else {
    process.env.SHELL = originalShell
  }
  if (originalHome == null) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
})

test('setup makes no changes', async () => {
  jest.mocked(addDirToEnvPath).mockReturnValue(Promise.resolve<PathExtenderReport>({
    oldSettings: 'PNPM_HOME=dir',
    newSettings: 'PNPM_HOME=dir',
  }))
  const output = await setup.handler({ pnpmHomeDir: '' })
  expect(output).toBe('No changes to the environment were made. Everything is already up to date.')
})

test('setup makes changes on POSIX', async () => {
  jest.mocked(addDirToEnvPath).mockReturnValue(Promise.resolve<PathExtenderReport>({
    configFile: {
      changeType: 'created',
      path: '~/.bashrc',
    },
    oldSettings: 'export PNPM_HOME=dir1',
    newSettings: 'export PNPM_HOME=dir2',
  }))
  const output = await setup.handler({ pnpmHomeDir: '' })
  expect(output).toBe(`Created ~/.bashrc

Next configuration changes were made:
export PNPM_HOME=dir2

To start using pnpm, run:
source ~/.bashrc
`)
})

test('setup writes fish config to conf.d', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-setup-fish-'))
  jest.mocked(os.default.homedir).mockReturnValue(tempHome)
  process.env.FISH_VERSION = '3.7.0'
  try {
    const configFile = path.join(tempHome, '.config/fish/conf.d/pnpm.fish')
    const output = await setup.handler({ pnpmHomeDir: '/pnpm-home' })
    expect(fs.readFileSync(configFile, 'utf8')).toBe(`set -gx PNPM_HOME "/pnpm-home"
if not string match -q -- "$PNPM_HOME/bin" $PATH
  set -gx PATH "$PNPM_HOME/bin" $PATH
end
`)
    expect(jest.mocked(addDirToEnvPath)).not.toHaveBeenCalled()
    expect(output).toBe(`Created ${configFile}

Next configuration changes were made:
set -gx PNPM_HOME "/pnpm-home"
if not string match -q -- "$PNPM_HOME/bin" $PATH
  set -gx PATH "$PNPM_HOME/bin" $PATH
end

To start using pnpm, run:
source ${configFile}
`)
  } finally {
    fs.rmSync(tempHome, { force: true, recursive: true })
  }
})

test('setup skips existing fish config with CRLF line endings', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-setup-fish-'))
  jest.mocked(os.default.homedir).mockReturnValue(tempHome)
  process.env.FISH_VERSION = '3.7.0'
  try {
    const configFile = path.join(tempHome, '.config/fish/conf.d/pnpm.fish')
    fs.mkdirSync(path.dirname(configFile), { recursive: true })
    fs.writeFileSync(configFile, [
      'set -gx PNPM_HOME "/pnpm-home"',
      'if not string match -q -- "$PNPM_HOME/bin" $PATH',
      '  set -gx PATH "$PNPM_HOME/bin" $PATH',
      'end',
      '',
    ].join('\r\n'))

    const output = await setup.handler({ pnpmHomeDir: '/pnpm-home' })

    expect(fs.readFileSync(configFile, 'utf8')).toContain('\r\n')
    expect(jest.mocked(addDirToEnvPath)).not.toHaveBeenCalled()
    expect(output).toBe('No changes to the environment were made. Everything is already up to date.')
  } finally {
    fs.rmSync(tempHome, { force: true, recursive: true })
  }
})

test('setup makes changes on Windows', async () => {
  jest.mocked(addDirToEnvPath).mockReturnValue(Promise.resolve<PathExtenderReport>({
    oldSettings: 'export PNPM_HOME=dir1',
    newSettings: 'export PNPM_HOME=dir2',
  }))
  const output = await setup.handler({ pnpmHomeDir: '' })
  expect(output).toBe(`Next configuration changes were made:
export PNPM_HOME=dir2

Setup complete. Open a new terminal to start using pnpm.`)
})

test('hint is added to ERR_PNPM_BAD_ENV_FOUND error object', async () => {
  jest.mocked(addDirToEnvPath).mockReturnValue(Promise.reject(new PnpmError('BAD_ENV_FOUND', '')))
  let err!: PnpmError
  try {
    await setup.handler({ pnpmHomeDir: '' })
  } catch (_err: any) { // eslint-disable-line
    err = _err
  }
  expect(err?.hint).toBe('If you want to override the existing env variable, use the --force option')
})

test('hint is added to ERR_PNPM_BAD_SHELL_SECTION error object', async () => {
  jest.mocked(addDirToEnvPath).mockReturnValue(Promise.reject(new PnpmError('BAD_SHELL_SECTION', '')))
  let err!: PnpmError
  try {
    await setup.handler({ pnpmHomeDir: '' })
  } catch (_err: any) { // eslint-disable-line
    err = _err
  }
  expect(err?.hint).toBe('If you want to override the existing configuration section, use the --force option')
})
