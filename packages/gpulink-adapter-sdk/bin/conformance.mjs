#!/usr/bin/env node
import { runEchoConformance } from '../src/echo-conformance.mjs';

// `--` ensures arguments intended for the child cannot be mistaken for tool flags.
const args = process.argv.slice(2);
const separator = args.indexOf('--');
if (separator < 0 || separator + 1 >= args.length ||
    args.slice(0, separator).length !== 0) {
  console.error('Usage: gpulink-adapter-conformance -- <trusted executable> [arguments...]');
  process.exitCode = 2;
} else {
  try {
    const cases = runEchoConformance({
      executable: args[separator + 1], args: args.slice(separator + 2),
    });
    for (const item of cases) console.log(`PASS: ${item}`);
    console.log('PASS: GLIP v1 echo profile only (not GPU, isolation or operator approval)');
  } catch (e) {
    console.error(`FAIL: ${e?.code ?? 'conformance_error'}`);
    process.exitCode = 1;
  }
}
