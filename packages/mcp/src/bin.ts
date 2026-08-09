#!/usr/bin/env node
import { assembleRuntime, runStdioServer } from './index.js';

const runtime = await assembleRuntime(process.argv.includes('--demo') ? { includeMock: true } : {});
await runStdioServer(runtime);
