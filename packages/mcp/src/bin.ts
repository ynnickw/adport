#!/usr/bin/env node
import { assembleRuntime, runStdioServer } from './index.js';

const runtime = await assembleRuntime();
await runStdioServer(runtime);
