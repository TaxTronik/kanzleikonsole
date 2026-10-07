import { portalHandlers } from '@/server/auth/portal';

// B5: Nur csrf und signout erreichen Auth.js, alles andere antwortet 404
// (PORTAL_AUTHJS_ROUTE, server/auth/authjs-route.ts).
export const { GET, POST } = portalHandlers;
