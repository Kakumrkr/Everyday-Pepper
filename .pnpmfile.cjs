// pnpm install hooks (https://pnpm.io/pnpmfile).
//
// better-auth declares optional peers for every framework and database it supports. pnpm
// resolves optional peers that exist anywhere in the workspace, so the api's production
// install (`pnpm deploy --prod`) pulled in next, react, vitest, drizzle-kit and playwright
// (~800 MB). We use only its Drizzle adapter on Postgres, so keep just those two peers.
const BETTER_AUTH_PEERS = new Set(['drizzle-orm', 'pg']);

/**
 * @template {{ name?: string, peerDependencies?: Record<string, unknown>, peerDependenciesMeta?: Record<string, unknown> }} T
 * @param {T} pkg
 * @returns {T}
 */
function readPackage(pkg) {
  if (pkg.name === 'better-auth') {
    /** @param {Record<string, unknown> | undefined} entries */
    const keep = (entries) =>
      entries &&
      Object.fromEntries(Object.entries(entries).filter(([name]) => BETTER_AUTH_PEERS.has(name)));
    pkg.peerDependencies = keep(pkg.peerDependencies);
    pkg.peerDependenciesMeta = keep(pkg.peerDependenciesMeta);
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
