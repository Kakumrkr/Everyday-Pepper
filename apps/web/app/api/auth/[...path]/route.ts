import { forwardRoute } from '../../../../lib/forward-route';

// Forwarded to the api at request time (API_INTERNAL_URL is read per request).
export const dynamic = 'force-dynamic';

export const GET = forwardRoute;
export const POST = forwardRoute;
export const PUT = forwardRoute;
export const PATCH = forwardRoute;
export const DELETE = forwardRoute;
