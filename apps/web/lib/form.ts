/** A text field of a submitted form, trimmed (`''` when missing or a file). */
export function formText(form: HTMLFormElement | FormData, name: string): string {
  const value = (form instanceof FormData ? form : new FormData(form)).get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/** A password field, untrimmed: spaces may be part of it. */
export function formPassword(form: HTMLFormElement | FormData, name: string): string {
  const value = (form instanceof FormData ? form : new FormData(form)).get(name);
  return typeof value === 'string' ? value : '';
}
