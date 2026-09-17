/* eslint no-console: off */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const source = path.join(root, 'chromium')
const dist = path.join(root, 'dist')
const output = path.join(dist, 'chromium')

// Keep Firefox's generated addon and development-only files out of this package.
const files = [
  'manifest.json',
  'sidebar.html',
  'sidebar.js',
  'sidebar.css',
  'background.js',
  'model.js',
  'options.html',
  'options.js',
  'options.css',
  'icons/16.png',
  'icons/32.png',
  'icons/48.png',
  'icons/128.png',
]

let staging

async function main() {
  const args = process.argv.slice(2)
  if (args.some(arg => arg !== '--zip')) throw new Error('Usage: node build/chromium.js [--zip]')

  // Validate before replacing an existing build, so incomplete sources fail loudly.
  const required = [...files.map(file => path.join(source, file)), path.join(root, 'LICENSE')]
  for (const file of required) {
    const stat = await fs.stat(file).catch(() => null)
    if (!stat?.isFile() || !stat.size)
      throw new Error(`Required extension file missing or empty: ${file}`)
  }
  const manifest = JSON.parse(await fs.readFile(path.join(source, 'manifest.json'), 'utf8'))
  if (manifest.manifest_version !== 3)
    throw new Error('Chromium requires this edition’s MV3 manifest')
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(manifest.version)) {
    throw new Error('The Chromium manifest must have a numeric extension version')
  }
  for (const file of files.filter(file => file.endsWith('.js'))) {
    execFileSync(process.execPath, ['--check', path.join(source, file)], { stdio: 'inherit' })
  }

  await fs.mkdir(dist, { recursive: true })
  staging = await fs.mkdtemp(path.join(dist, '.chromium-build-'))
  for (const file of files) {
    const destination = path.join(staging, file)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.copyFile(path.join(source, file), destination)
  }
  await fs.copyFile(path.join(root, 'LICENSE'), path.join(staging, 'LICENSE'))
  await fs.rm(output, { recursive: true, force: true })
  await fs.rename(staging, output)
  staging = undefined
  console.log(`Chromium extension ready: ${output}`)

  if (args.includes('--zip')) {
    const archive = path.join(dist, `sidebery-chromium-${manifest.version}.zip`)
    await fs.rm(archive, { force: true })
    try {
      execFileSync('zip', ['-q', '-X', '-r', archive, '.'], { cwd: output, stdio: 'inherit' })
    } catch (error) {
      await fs.rm(archive, { force: true })
      throw new Error(
        'Could not create ZIP; install the zip command or omit --zip. The unpacked build is ready.',
        {
          cause: error,
        }
      )
    }
    console.log(`Chromium extension archive: ${archive}`)
  }
}

main().catch(async error => {
  if (staging) await fs.rm(staging, { recursive: true, force: true })
  console.error(`Chromium build failed: ${error.message}`)
  process.exitCode = 1
})
