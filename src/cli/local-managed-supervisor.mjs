#!/usr/bin/env node
import { runManagedSupervisor } from './local-lifecycle.mjs';

runManagedSupervisor(process.argv.slice(2)).catch(() => { process.exitCode = 1; });
