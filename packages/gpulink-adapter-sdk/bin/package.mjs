#!/usr/bin/env node
import {inspectAdapter, operatorCatalogCandidate, packAdapter} from '../src/package-workflow.mjs';

function options(tokens) {
  const values = {};
  for (let i=0; i<tokens.length; i+=2) {
    const key = tokens[i];
    if (!['--source','--out','--bundle','--interpreter'].includes(key) ||
        Object.hasOwn(values,key) || typeof tokens[i+1] !== 'string' ||
        tokens[i+1].length === 0) throw new Error('invalid_cli_arguments');
    values[key] = tokens[i+1];
  }
  return values;
}
const [verb,...argv] = process.argv.slice(2);
try {
  if (verb === 'pack') {
    const o = options(argv);
    if (Object.keys(o).sort().join(',') !== '--out,--source') throw new Error('usage');
    const result = await packAdapter({sourceDir:o['--source'],outDir:o['--out']});
    console.log(`PASS: created portable package, digest ${result.lock.sha256}`);
  } else if (verb === 'inspect') {
    const o = options(argv);
    if (Object.keys(o).join(',') !== '--bundle') throw new Error('usage');
    const result = await inspectAdapter({bundleDir:o['--bundle']});
    console.log(`PASS: bundle integrity ${result.lock.sha256}`);
  } else if (verb === 'catalog') {
    const o = options(argv);
    if (Object.keys(o).sort().join(',') !== '--bundle,--interpreter') throw new Error('usage');
    const candidate = await operatorCatalogCandidate({bundleDir:o['--bundle'],interpreter:o['--interpreter']});
    process.stdout.write(JSON.stringify(candidate,null,2) + '\n');
  } else if (verb === 'catalog-direct') {
    const o = options(argv);
    if (Object.keys(o).join(',') !== '--bundle') throw new Error('usage');
    const candidate = await operatorCatalogCandidate({bundleDir:o['--bundle'],direct:true});
    process.stdout.write(JSON.stringify(candidate,null,2) + '\n');
  } else throw new Error('usage');
} catch (e) {
  console.error(`FAIL: ${e?.code ?? e?.message ?? 'package_error'}`);
  console.error('Usage: gpulink-adapter-package pack --source /absolute/author-dir --out /absolute/new-bundle-dir');
  console.error('       gpulink-adapter-package inspect --bundle /absolute/bundle-dir');
  console.error('       gpulink-adapter-package catalog --bundle /absolute/bundle-dir --interpreter /absolute/python');
  console.error('       gpulink-adapter-package catalog-direct --bundle /absolute/bundle-dir');
  process.exitCode = 1;
}
