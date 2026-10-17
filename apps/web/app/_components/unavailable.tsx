/** Shown when the api cannot answer (down or starting); nothing else can be done meanwhile. */
export function Unavailable() {
  return (
    <main>
      <h1 className="wordmark">floty</h1>
      <p className="tagline" role="alert">
        Floty can’t be reached right now. Try again in a moment.
      </p>
    </main>
  );
}
