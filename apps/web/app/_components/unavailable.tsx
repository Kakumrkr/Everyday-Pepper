import { AuthPage } from './auth-page';

/** Shown when the api cannot answer (down or starting); nothing else can be done meanwhile. */
export function Unavailable() {
  return (
    <AuthPage
      title="Pepper can’t be reached"
      lead={<span role="alert">Nothing is lost. Try again in a moment.</span>}
    />
  );
}
