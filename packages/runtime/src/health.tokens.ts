import type { ServiceName } from '@floty/contracts';
import type { HealthCheck } from '@floty/core';

/** Injection token: the readiness checks, keyed by dependency name. */
export const READINESS_CHECKS = Symbol('READINESS_CHECKS');
export type ReadinessChecks = Readonly<Record<string, HealthCheck>>;

/** Injection token: the `ServiceName` reported in health responses. */
export const SERVICE_NAME = Symbol('SERVICE_NAME');
export type { ServiceName };

/** Injection token: the `Clock` used for report timestamps. */
export const CLOCK = Symbol('CLOCK');

/** How long one readiness check may take before it counts as down. */
export const READINESS_TIMEOUT_MS = 2_000;
