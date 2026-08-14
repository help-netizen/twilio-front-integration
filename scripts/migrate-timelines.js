#!/usr/bin/env node
'use strict';

// TENANT-ISO-002: this unscoped one-time migration was completed long ago.
// Keeping it executable would let an operator mutate cross-tenant data without
// an explicit company contract, so every invocation now fails before loading DB.
const err = new Error(
    'scripts/migrate-timelines.js is retired; use numbered, tenant-safe database migrations instead.'
);
err.code = 'RETIRED_ONE_TIME_SCRIPT';
throw err;
