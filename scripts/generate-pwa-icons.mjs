import path from 'node:path'
import sharp from 'sharp'

// Everything is rendered from the logo SVGs, which are drawn as shapes (no fonts needed).
const publicDir = path.resolve('public')
const logo = path.join(publicDir, 'logo.svg')
const maskable = path.join(publicDir, 'logo-maskable.svg')

async function writeIcon(src, filePath, size, label = path.basename(filePath)) {
  await sharp(src, { density: 1024 })
    .resize(size, size)
    .png()
    .toFile(filePath)
  console.log(`Generated ${label} (${size}x${size})`)
}

await writeIcon(logo, path.join(publicDir, 'icon.png'), 512)
await writeIcon(logo, path.resolve('icon.png'), 512, 'icon.png (repo root, used by the README)')
await writeIcon(logo, path.join(publicDir, 'pwa-192.png'), 192)
await writeIcon(logo, path.join(publicDir, 'pwa-512.png'), 512)
await writeIcon(maskable, path.join(publicDir, 'pwa-maskable-512.png'), 512)
await writeIcon(maskable, path.join(publicDir, 'apple-touch-icon.png'), 180)

// 1280x640 card for GitHub's "Social preview" setting (uploaded by hand, not read by the app).
const iconBuf = await sharp(logo, { density: 1024 }).resize(380, 380).png().toBuffer()
await sharp({ create: { width: 1280, height: 640, channels: 4, background: '#0d1f36' } })
  .composite([{ input: iconBuf, gravity: 'center' }])
  .png()
  .toFile(path.resolve('docs/social-preview.png'))
console.log('Generated docs/social-preview.png (1280x640)')
