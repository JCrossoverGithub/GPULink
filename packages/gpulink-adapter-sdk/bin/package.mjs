#!/usr/bin/env node
import path from "node:path";
import {initBatchAdapter, preparePythonCatalog, inspectAdapter, operatorCatalogCandidate, packAdapter} from '../src/package-workflow.mjs';

function options(tokens) {
  const values = {};
  for (let i=0; i<tokens.length; i+=2) {
    const key = tokens[i];
    if (!['--source','--out','--bundle','--interpreter','--type','--adapter-id','--library-path'].includes(key) ||
        Object.hasOwn(values,key) || typeof tokens[i+1] !== 'string' ||
        tokens[i+1].length === 0) throw new Error('invalid_cli_arguments');
    values[key] = tokens[i+1];
  }
  return values;
}
const [verb,...argv] = process.argv.slice(2);
try {
  if (verb === 'init-batch') {
    const o = options(argv);
    if (!o['--out'] || !o['--type'] || Object.keys(o).some(k => !['--out','--type','--adapter-id'].includes(k))) throw new Error('usage');
    const recipe = await initBatchAdapter({outDir:path.resolve(o['--out']),type:o['--type'],adapterId:o['--adapter-id']});
    console.log(`PASS: created Python batch starter for ${recipe.manifest.type}; edit workload.py before packaging.`);
  } else if (verb === 'prepare-python') {
    const o = options(argv);
    if (!o['--bundle'] || !o['--interpreter'] || !o['--out'] || Object.keys(o).some(k => !['--bundle','--interpreter','--out','--library-path'].includes(k))) throw new Error('usage');
    const r = await preparePythonCatalog({bundleDir:path.resolve(o['--bundle']),interpreter:o['--interpreter'],outDir:path.resolve(o['--out']),libraryPath:o['--library-path'] ?? null});
    console.log(JSON.stringify(r,null,2));
    console.error('Review the source, launcher and runtime before explicit worker approve-catalog. Nothing approved or executed.');
  } else if (verb === 'pack') {
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
  console.error('       gpulink-adapter-package init-batch --out DIR --type external.batch.NAME [--adapter-id ID]');
  console.error('       gpulink-adapter-package prepare-python --bundle DIR --interpreter /absolute/python --out DIR [--library-path /absolute/lib]');
  console.error('Usage: gpulink-adapter-package pack --source /absolute/author-dir --out /absolute/new-bundle-dir');
  console.error('       gpulink-adapter-package inspect --bundle /absolute/bundle-dir');
  console.error('       gpulink-adapter-package catalog --bundle /absolute/bundle-dir --interpreter /absolute/python');
  console.error('       gpulink-adapter-package catalog-direct --bundle /absolute/bundle-dir');
  process.exitCode = 1;
}
