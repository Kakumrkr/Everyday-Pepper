import {
  BusinessPhotosSchema,
  ServicesResponseSchema,
  StaffResponseSchema,
} from '@pepper/contracts';
import { Badge, buttonStyle } from '@pepper/ui';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ROUTES } from '../../../lib/account';
import { durationLabel, priceLabel, servicesByCategory } from '../../../lib/setup';
import { BookingPageCard } from '../../_components/setup/booking-page-card';
import { PhotosCard } from '../../_components/setup/photos-card';
import { ServicesScreen } from '../../_components/setup/services-screen';
import { depositLabel } from '../../../lib/deposits';
import { ServiceEditor, type DepositsState } from '../../_components/setup/service-editor';
import {
  currentAccount,
  currentBusiness,
  currentJson,
  currentPayments,
} from '../../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Services · Pepper' };

/**
 * The service menu (S16): what clients can book, how long it takes, what it costs and who
 * offers it. Everyone may read it; owners and managers add and edit services. On the kit since
 * S42.2: a quiet section of hairline rows per category, and an empty menu that offers its
 * first service (AC-X-7).
 */
export default async function ServicesPage() {
  // The app layout has sent anyone without a usable session elsewhere already.
  const account = await currentAccount();
  if (account.state !== 'signed-in') return null;
  const current = await currentBusiness();
  if (!current?.permissions.includes('services.read')) redirect(ROUTES.home);

  const managesPage = current.permissions.includes('settings.manage');
  const manages = current.permissions.includes('services.manage');
  const [services, staff, photos, payments] = await Promise.all([
    currentJson('/v1/services', ServicesResponseSchema),
    currentJson('/v1/staff', StaffResponseSchema),
    // The booking page's photos (S47.2): owners and managers only.
    managesPage ? currentJson('/v1/tenant/photos', BusinessPhotosSchema) : Promise.resolve(null),
    // Whether deposits can be taken (S66.2): the deposit field and the refund window show only
    // where the deployment offers payments.
    manages ? currentPayments() : Promise.resolve(null),
  ]);
  const deposits: DepositsState =
    payments === null || payments.state === 'off'
      ? 'hidden'
      : payments.state === 'on' && !payments.account.chargesEnabled
        ? 'waiting'
        : 'open';
  const list = services?.services ?? [];
  const categories = [
    ...new Set(list.flatMap((service) => (service.category === null ? [] : [service.category]))),
  ];
  const offeredBy = (serviceId: string) =>
    (staff?.staff ?? [])
      .filter((member) => member.active && member.serviceIds.some((id) => id === serviceId))
      .map((member) => member.displayName);

  return (
    <ServicesScreen
      manages={manages}
      categories={categories}
      state={services === null ? 'failed' : list.length === 0 ? 'empty' : 'listed'}
      deposits={deposits}
      audience={current.business.depositAudience}
      actions={
        <Link href={ROUTES.rules} className={buttonStyle({ variant: 'secondary', size: 'sm' })}>
          Booking rules
        </Link>
      }
    >
      {servicesByCategory(list).map((group, index) => {
        const headingId = `services-${String(index)}`;
        return (
          <section
            key={group.category ?? ''}
            aria-labelledby={headingId}
            className="flex flex-col gap-3"
          >
            <h2 id={headingId} className="m-0 type-heading">
              {group.category ?? (categories.length === 0 ? 'Menu' : 'Other')}
            </h2>
            <ul
              className="m-0 list-none divide-y divide-line rounded-lg bg-surface p-0 px-4"
              data-testid="services"
            >
              {group.services.map((service) => {
                const people = offeredBy(service.id);
                return (
                  <ServiceRow
                    key={service.id}
                    name={service.name}
                    active={service.active}
                    meta={[
                      [durationLabel(service.durationMinutes), priceLabel(service)]
                        .filter(Boolean)
                        .join(' · '),
                      people.length === 0 ? 'No one offers it yet' : people.join(', '),
                      depositLabel(
                        service.deposit,
                        service.priceFromCents,
                        current.business.depositAudience,
                      ),
                    ].filter((line): line is string => line !== null)}
                    edit={
                      manages ? (
                        <ServiceEditor
                          service={service}
                          categories={categories}
                          deposits={deposits}
                          audience={current.business.depositAudience}
                        />
                      ) : null
                    }
                  />
                );
              })}
            </ul>
          </section>
        );
      })}
      <BookingPageCard
        slug={current.business.slug}
        brandColor={current.business.brandColor}
        profile={current.business}
        manages={managesPage}
        deposits={
          deposits === 'hidden'
            ? null
            : {
                refundHours: current.business.depositRefundHours,
                audience: current.business.depositAudience,
              }
        }
      />
      {managesPage ? (
        <PhotosCard
          slug={current.business.slug}
          businessName={current.business.name}
          initial={photos}
        />
      ) : null}
    </ServicesScreen>
  );
}

/** One service as a hairline row (the kit's ListRow look, with a test id and an Edit button). */
function ServiceRow({
  name,
  active,
  meta,
  edit,
}: {
  name: string;
  active: boolean;
  meta: string[];
  edit: ReactNode;
}) {
  return (
    <li className="flex min-h-14 items-center gap-3 py-3" data-testid="service">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="m-0 flex flex-wrap items-center gap-2 type-body font-semibold text-ink">
          {name}
          {active ? null : <Badge>Not bookable</Badge>}
        </p>
        {meta.map((line) => (
          <p key={line} className="m-0 type-caption text-ink-2 tabular-nums">
            {line}
          </p>
        ))}
      </div>
      {edit}
    </li>
  );
}
