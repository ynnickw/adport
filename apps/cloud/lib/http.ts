import { NextResponse } from 'next/server';
import { AdportError } from '@adport/core';

export class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'HttpError';
  }
}

function errorStatus(error: unknown): number {
  if (error instanceof HttpError) return error.status;
  if (error instanceof AdportError) {
    if (error.code === 'POLICY_VIOLATION') return 403;
    if (error.code === 'UNKNOWN_TOOL') return 404;
    if (error.code === 'PROVIDER_ERROR') return 502;
    if (error.code === 'INVALID_INPUT') return 400;
    return 409;
  }
  return 500;
}

export function apiError(error: unknown, status?: number): NextResponse {
  const responseStatus = status ?? errorStatus(error);
  const message = responseStatus >= 500
    ? 'Internal server error.'
    : error instanceof Error ? error.message : 'Request failed.';
  if (responseStatus >= 500) console.error(error);
  return NextResponse.json({ error: message }, { status: responseStatus });
}

export function noStoreJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });
}
