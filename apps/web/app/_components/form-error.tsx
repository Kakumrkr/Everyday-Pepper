/** An error under a form, announced to screen readers. */
export function FormError({ message }: { message: string | null }) {
  return (
    <p className="form-error" role="alert" aria-live="assertive">
      {message ?? ''}
    </p>
  );
}
