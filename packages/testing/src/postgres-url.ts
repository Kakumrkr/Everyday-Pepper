/**
 * `url` with other credentials, e.g. the services' login role on a test container whose
 * `url` connects as the (superuser) migration role.
 */
export function postgresUrlAs(url: string, user: string, password: string): string {
  const result = new URL(url);
  result.username = encodeURIComponent(user);
  result.password = encodeURIComponent(password);
  return result.toString();
}
