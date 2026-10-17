'use client';

import { useState, type SubmitEvent } from 'react';
import { ROUTES } from '../../lib/account';
import { sendJson } from '../../lib/client-api';
import { formPassword, formText } from '../../lib/form';
import { manualSecret, qrModules } from '../../lib/totp-qr';
import { FormError } from './form-error';

interface Enrolment {
  totpURI: string;
  backupCodes: string[];
}

function QrCode({ text }: { text: string }) {
  const { size, dark } = qrModules(text);
  return (
    <svg
      className="qr"
      viewBox={`0 0 ${String(size)} ${String(size)}`}
      role="img"
      aria-label="QR code for your authenticator app"
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="#fff" />
      {dark.map(([x, y]) => (
        <rect key={`${String(x)},${String(y)}`} x={x} y={y} width={1} height={1} fill="#000" />
      ))}
    </svg>
  );
}

/** Confirms the password, shows the QR code and backup codes, then checks one code. */
export function TwoFactorSetup() {
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await sendJson<Enrolment>('POST', '/api/auth/two-factor/enable', {
      password: formPassword(event.currentTarget, 'password'),
    });
    setBusy(false);
    if (result.ok) setEnrolment(result.data);
    else setError(result.message);
  }

  async function verify(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = formText(event.currentTarget, 'code').replace(/\s/g, '');
    setBusy(true);
    setError(null);
    const result = await sendJson('POST', '/api/auth/two-factor/verify-totp', { code });
    setBusy(false);
    if (result.ok) window.location.assign(ROUTES.home);
    else setError(result.message);
  }

  if (enrolment === null) {
    return (
      <form className="form" onSubmit={(event) => void start(event)} noValidate>
        <p className="hint">
          Owners protect their business with a code from an authenticator app (such as Google
          Authenticator, 1Password or Authy) each time they sign in.
        </p>
        <label>
          Confirm your password
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <FormError message={error} />
        <button type="submit" disabled={busy}>
          Continue
        </button>
      </form>
    );
  }

  return (
    <form className="form" onSubmit={(event) => void verify(event)} noValidate>
      <ol className="steps">
        <li>
          Scan this code with your authenticator app.
          <QrCode text={enrolment.totpURI} />
          <span className="hint">
            Can’t scan? Enter this key:{' '}
            <code data-testid="totp-secret">{manualSecret(enrolment.totpURI)}</code>
          </span>
        </li>
        <li>
          Save these backup codes somewhere safe. Each works once if you lose your phone.
          <ul className="backup-codes" data-testid="backup-codes">
            {enrolment.backupCodes.map((code) => (
              <li key={code}>
                <code>{code}</code>
              </li>
            ))}
          </ul>
        </li>
        <li>
          <label>
            Enter the 6-digit code the app shows
            <input name="code" inputMode="numeric" autoComplete="one-time-code" required />
          </label>
        </li>
      </ol>
      <FormError message={error} />
      <button type="submit" disabled={busy}>
        Turn on two-step verification
      </button>
    </form>
  );
}
