import { ServicesResponseSchema, StaffResponseSchema } from '@pepper/contracts';
import { buttonClass, Card } from '@pepper/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ROUTES } from '../../../lib/account';
import { durationLabel, priceLabel, servicesByCategory } from '../../../lib/setup';
import { BookingPageCard } from '../../_components/setup/booking-page-card';
import { ServiceEditor } from '../../_components/setup/service-editor';
import { currentAccount, currentBusiness, currentJson } from '../../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Services · Pepper' };

/**
 * The service menu (S16): what clients can book, how long it takes, what it costs and who
 * offers it. Everyone may read it; owners and managers add and edit services.
 */
export default async function ServicesPage() {
  // The app layout has sent anyone without a usable session elsewhere already.
  const account = await currentAccount();
  if (account.state !== 'signed-in') return null;
  const current = await currentBusiness();
  if (!current?.permissions.includes('services.read')) redirect(ROUTES.home);

  const [services, staff] = await Promise.all([
    currentJson('/v1/services', ServicesResponseSchema),
    currentJson('/v1/staff', StaffResponseSchema),
  ]);
  const manages = current.permissions.includes('services.manage');
  const list = services?.services ?? [];
  const categories = [
    ...new Set(list.flatMap((service) => (service.category === null ? [] : [service.category]))),
  ];
  const offeredBy = (serviceId: string) =>
    (staff?.staff ?? [])
      .filter((member) => member.active && member.serviceIds.some((id) => id === serviceId))
      .map((member) => member.displayName);

  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="m-0 font-display text-2xl font-bold">Services</h1>
          <p className="m-0 text-ink-2">What clients can book, how long it takes and the price.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={ROUTES.rules} className={buttonClass({ variant: 'secondary', size: 'sm' })}>
            Booking rules
          </Link>
          {manages ? <ServiceEditor categories={categories} /> : null}
        </div>
      </header>

      {services === null ? (
        <p role="alert" className="mb-4 rounded-md bg-wait-soft px-4 py-3 font-semibold text-wait">
          I couldn’t load your services. Try again in a moment.
        </p>
      ) : null}

      {services !== null && list.length === 0 ? (
        <Card>
          <h2 className="m-0 font-display text-lg font-bold">No services yet</h2>
          <p className="mt-1 mb-0 text-ink-2">
            {manages
              ? 'Add what you offer, with how long it takes. Then choose who offers it on the Team page.'
              : 'An owner or manager adds the services you offer here.'}
          </p>
        </Card>
      ) : null}

      <div className="grid gap-4">
        <BookingPageCard
          slug={current.business.slug}
          brandColor={current.business.brandColor}
          manages={current.permissions.includes('settings.manage')}
        />
        {servicesByCategory(list).map((group) => (
          <Card key={group.category ?? ''} as="section">
            <h2 className="m-0 mb-2 font-display text-lg font-bold">
              {group.category ?? (categories.length === 0 ? 'Menu' : 'Other')}
            </h2>
            <ul className="m-0 grid list-none divide-y divide-line p-0" data-testid="services">
              {group.services.map((service) => {
                const people = offeredBy(service.id);
                const price = priceLabel(service);
                return (
                  <li
                    key={service.id}
                    className="flex items-center justify-between gap-3 py-3"
                    data-testid="service"
                  >
                    <div className="min-w-0">
                      <p className="m-0 font-bold">
                        {service.name}
                        {service.active ? null : (
                          <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-semibold text-ink-2">
                            Not bookable
                          </span>
                        )}
                      </p>
                      <p className="m-0 text-sm text-ink-2">
                        {[durationLabel(service.durationMinutes), price]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                      <p className="m-0 text-sm text-ink-2">
                        {people.length === 0 ? 'No one offers it yet' : people.join(', ')}
                      </p>
                    </div>
                    {manages ? <ServiceEditor service={service} categories={categories} /> : null}
                  </li>
                );
              })}
            </ul>
          </Card>
        ))}
      </div>
    </div>
  );
}
