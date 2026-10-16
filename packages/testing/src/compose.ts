import { readFileSync } from 'node:fs';

const COMPOSE_FILE = new URL('../../../docker-compose.yml', import.meta.url);

/**
 * The image a Compose service runs, so tests use exactly the pinned image (and digest) of the
 * dev stack, and Dependabot updates both at once.
 */
export function composeImage(
  service: string,
  compose = readFileSync(COMPOSE_FILE, 'utf8'),
): string {
  const match = new RegExp(`^  ${service}:\\n(?:    .*\\n)*?    image: (\\S+)$`, 'm').exec(compose);
  if (match?.[1] === undefined) {
    throw new Error(`No image for service "${service}" in docker-compose.yml`);
  }
  return match[1];
}
