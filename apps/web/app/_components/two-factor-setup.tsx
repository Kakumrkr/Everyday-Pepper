'use client';

import { Button, Input } from '@pepper/ui';
import { useId, useState, type ReactNode, type SubmitEvent } from 'react';
import { ROUTES } from '../../lib/account';
import { sendJson } from '../../lib/client-api';
import { formPassword, formText } from '../../lib/form';
import { manualSecret, qrModules } from '../../lib/totp-qr';
import { AuthPage } from './auth-page';
import { Notice } from './form-parts';

interface Enrolment {
  totpURI: string;
  backupCodes: string[];
}

function QrCode({ text }: { text: string }) {
  const { size, dark } = qrModules(text);
  return (
    <svg
      className="h-auto w-50 max-w-full rounded-sm"
      viewBox={`0 0 ${String(size)} ${String(size)}`}
      role="img"
      aria-label="QR code for your authenticator app"
      shapeRendering="crispEdges"
    >
      {/* eslint-disable-next-line no-restricted-syntax -- a QR code stays black on white in both themes, so every scanner reads it */}
      <rect width={size} height={size} fill="#fff" />
      {dark.map(([x, y]) => (
        // eslint-disable-next-line no-restricted-syntax -- the QR code's modules: black on white, as above
        <rect key={`${String(x)},${String(y)}`} x={x} y={y} width={1} height={1} fill="#000" />
      ))}
    </svg>
  );
}

/** One numbered step of the setup: the number in a brand-soft circle, then what to do. */
function SetupStep({ n, title, children }: { n: number; title: string; children?: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-pill bg-brand-soft type-label text-brand tabular-nums"
      >
        {n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <p className="m-0 type-body font-semibold text-ink">{title}</p>
        {children}
      </div>
    </li>
  );
}

/** Confirms the password, shows the QR code and backup codes, then checks one code. */
export function TwoFactorSetup() {
  const formId = useId();
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

  const errorLine = error === null ? null : <Notice tone="error">{error}</Notice>;

  if (enrolment === null) {
    return (
      <AuthPage
        title="Protect your business"
        lead="Each time you sign in, Pepper also asks for a code from an authenticator app (such as Google Authenticator, 1Password or Authy). Your clients’ details stay safe even if your password leaks."
        action={
          <Button type="submit" form={formId} size="lg" block busy={busy}>
            {busy ? 'Checking…' : 'Continue'}
          </Button>
        }
      >
        <form
          id={formId}
          className="flex flex-col gap-4"
          onSubmit={(event) => void start(event)}
          noValidate
        >
          <Input
            label="Confirm your password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
          {errorLine}
        </form>
      </AuthPage>
    );
  }

  return (
    <AuthPage
      title="Protect your business"
      lead="Three steps, about a minute."
      action={
        <Button type="submit" form={formId} size="lg" block busy={busy}>
          {busy ? 'Turning it on…' : 'Turn on two-step verification'}
        </Button>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-4"
        onSubmit={(event) => void verify(event)}
        noValidate
      >
        <ol className="m-0 flex list-none flex-col gap-6 p-0">
          <SetupStep n={1} title="Scan this code with your authenticator app.">
            <QrCode text={enrolment.totpURI} />
            <p className="m-0 type-caption text-ink-2">
              Can’t scan? Enter this key:{' '}
              <code data-testid="totp-secret" className="font-mono text-ink wrap-anywhere">
                {manualSecret(enrolment.totpURI)}
              </code>
            </p>
          </SetupStep>
          <SetupStep
            n={2}
            title="Save these backup codes somewhere safe. Each one works once if you lose your phone."
          >
            <ul
              className="m-0 grid list-none grid-cols-2 gap-x-3 gap-y-1 rounded-md bg-surface-2 p-4"
              data-testid="backup-codes"
            >
              {enrolment.backupCodes.map((code) => (
                <li key={code}>
                  <code className="font-mono type-body text-ink tabular-nums">{code}</code>
                </li>
              ))}
            </ul>
          </SetupStep>
          <SetupStep n={3} title="Type the code the app shows.">
            <Input
              label="Enter the 6-digit code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
            />
          </SetupStep>
        </ol>
        {errorLine}
      </form>
    </AuthPage>
  );
}
