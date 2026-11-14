#!/usr/bin/env node
import { assembleRuntime, runStdioServer } from './index.js';

const includeRawTools = process.argv.includes('--raw-api-tools');
const runtime = await assembleRuntime({ includeMock: process.argv.includes('--demo') ? true : undefined, includeRawTools });
await runStdioServer(runtime, undefined, includeRawTools);
