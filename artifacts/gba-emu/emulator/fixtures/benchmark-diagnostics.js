'use strict';
// Run outside the VM proxy so this measures JavaScript bookkeeping, not
// cross-context property access. Synthetic throughput is not device FPS.
const { performance } = require('node:perf_hooks');
const { extractCoreScript } = require('./extract-core');
const { makeSandbox } = require('./run-core');
const { sandbox } = makeSandbox();
const names = Object.keys(sandbox);
const bench = new Function(...names, extractCoreScript().replace(/\}\)\(\);\s*$/, `
window.benchmarkDiagnostics=function(count) {
  traceActive=false;
  for(var i=0;i<count;i++)recordStep(0x08000000+((i&7)*4),0xe1a00000,'ARM');
};
})();`));
bench(...names.map(name => sandbox[name]));
const run = sandbox.window.benchmarkDiagnostics;
run(1000000);
const samples = [];
for (let i = 0; i < 7; i++) {
  const start = performance.now();
  run(3000000);
  samples.push(performance.now() - start);
}
samples.sort((a,b) => a-b);
console.log(JSON.stringify({instructions:3000000, medianMs:samples[3], samplesMs:samples}));