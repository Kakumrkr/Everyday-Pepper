/**
 * The component gallery (`/dev/gallery`, S40, AC-X-4) is a developer page: on only where
 * `PEPPER_GALLERY=1` (local development and CI's screenshot run), a 404 everywhere else.
 */
export function galleryEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env['PEPPER_GALLERY'] === '1';
}
