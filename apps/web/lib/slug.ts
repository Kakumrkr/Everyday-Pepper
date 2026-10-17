/**
 * A booking-link suggestion from a business name ("Juniper Hair Studio" → "juniper-hair-studio"),
 * shaped to pass `TenantSlugSchema` when the name has enough letters or digits.
 */
export function suggestSlug(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .slice(0, 63)
    .replace(/-+$/, '');
  return slug;
}
