// Regression stress: pokeemerald-style IntrMain with VBlank + VCount +
// Timer0 IRQs nesting inside each other, CpuSet inside the handler, an
// agbcc-style pop{r0};bx r0 leaf return, and an IntrWait mainline. Guards
// the HLE IRQ return-context stack against push/pop imbalance (the
// pc-unmapped 0xfffffff4 underflow class) and against scratch-register
// corruption across nested dispatches.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');

test('nested IRQ stress: VBlank+VCount+timer nesting stays balanced', () => {
  const out = execFileSync(process.execPath, [__dirname + '/../fixtures/nested-irq-stress.js'], {
    encoding: 'utf8', timeout: 240000,
  });
  assert.match(out, /OK — frames: \d+ handler runs: \d+/);
  const m = out.match(/OK — frames: (\d+) handler runs: (\d+)/);
  assert.ok(Number(m[1]) > 1000, 'mainline kept running (frame counter advanced)');
  assert.ok(Number(m[2]) > 3000, 'VBlank+VCount+timer handlers all ran');
  assert.ok(!/CRASHED/.test(out), 'no crash report');
});
