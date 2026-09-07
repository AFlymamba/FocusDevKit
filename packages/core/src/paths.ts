import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const FXDEVKIT_HOME = process.env.FXDEVKIT_HOME
  ? path.resolve(process.env.FXDEVKIT_HOME)
  : path.join(os.homedir(), '.fxdevkit')

export const paths = {
  home: FXDEVKIT_HOME,
  hooks: path.join(FXDEVKIT_HOME, 'hooks'),
  events: path.join(FXDEVKIT_HOME, 'events'),
  logs: path.join(FXDEVKIT_HOME, 'logs'),
  cache: path.join(FXDEVKIT_HOME, 'cache'),
  plugins: path.join(FXDEVKIT_HOME, 'plugins'),
  mockServer: path.join(FXDEVKIT_HOME, 'mock-server'),
  globalConfig: path.join(FXDEVKIT_HOME, 'config.yaml'),
  devices: path.join(FXDEVKIT_HOME, 'device.json'),
}

export const REPO_CONFIG_FILE = '.fxdevkit.yaml'

export function ensureDir(target: string): void {
  fs.mkdirSync(target, { recursive: true })
}

export function ensureLayout(): void {
  for (const dir of [paths.home, paths.hooks, paths.events, paths.logs, paths.cache, paths.plugins, paths.mockServer]) {
    ensureDir(dir)
  }
}

export function readTextIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

export function readJsonIfExists<T>(file: string): T | null {
  const text = readTextIfExists(file)
  if (text == null || text.trim() === '') return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}
