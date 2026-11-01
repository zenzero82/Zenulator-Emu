// Diagnostic driver: boots a real ROM headlessly, mashes buttons to get
// past intro/menus, and dumps framebuffer snapshots as PPM images so a
// rendering bug can be inspected visually without a device round-trip.
//
// Usage: node emulator/fixtures/drive-rom.js <rom> <outDir> [frames] [snapEvery]
'use strict';
const fs = require('fs');
const path = require('path');
const { bootCoreInteractive } = require('./run-core');

function writePPM(img, file) {
  const { width: w, height: h, data } = img;
  const head = Buffer.from(`P6\n${w} ${h}\n255\n`, 'ascii');
  const body = Buffer.alloc(w * h * 3);
  for (let i = 0, j = 0; i < w * h * 4; i += 4, j += 3) {
    body[j] = data[i]; body[j + 1] = data[i + 1]; body[j + 2] = data[i + 2];
  }
  fs.writeFileSync(file, Buffer.concat([head, body]));
}

(async () => {
  const [romPath, outDir, totalStr, everyStr] = process.argv.slice(2);
  const total = Number(totalStr || 4000), every = Number(everyStr || 250);
  fs.mkdirSync(outDir, { recursive: true });
  const rom = fs.readFileSync(romPath);
  const h = await bootCoreInteractive(rom);
  const pump = (n) => { for (let t = 0; t < n; t++) { h.advanceTime(16); const d = h.rafQueue.slice(); h.rafQueue.length = 0; d.forEach((e) => e.fn()); } };
  const tap = (key, holdFrames = 4, gapFrames = 8) => {
    h.send({ type: 'keydown', key }); pump(holdFrames);
    h.send({ type: 'keyup', key }); pump(gapFrames);
  };
  let f = 0;
  while (f < total) {
    // Alternate A and START taps — standard "get me into the game" mash.
    tap('a'); tap('a'); tap('start');
    f += 3 * 12;
    if (f % every < 36 && h.frames.last) writePPM(h.frames.last, path.join(outDir, `f${String(f).padStart(5, '0')}.ppm`));
  }
  if (h.frames.last) writePPM(h.frames.last, path.join(outDir, 'final.ppm'));
  console.log('done', total, 'frames; snapshots in', outDir);
  process.exit(0);
})();
