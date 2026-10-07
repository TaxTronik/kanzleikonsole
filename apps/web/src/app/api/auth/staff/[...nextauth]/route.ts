import { staffHandlers } from '@/server/auth/staff';

// B5: Nur csrf, signout und die Staff-Callbacks erreichen Auth.js, alles andere
// antwortet 404 (STAFF_AUTHJS_ROUTE, server/auth/authjs-route.ts).
export const { GET, POST } = staffHandlers;
