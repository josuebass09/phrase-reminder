import sharp from 'sharp';

// Run with `npm run icons` after changing public/icon.svg, then commit the PNGs.
// Flattening fills the SVG's rounded corners, because iOS and Android apply their
// own mask to these icons and would show transparent corners as black.
const BACKGROUND = '#0E5E6F';

const icons = [
  { file: 'apple-touch-icon.png', size: 180 },
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
];

for (const { file, size } of icons) {
  await sharp('public/icon.svg')
    .resize(size, size)
    .flatten({ background: BACKGROUND })
    .png()
    .toFile(`public/${file}`);
  console.log(`Wrote public/${file}`);
}
