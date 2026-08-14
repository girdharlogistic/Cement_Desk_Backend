export type Role = 'owner' | 'admin' | 'member' | 'viewer';

export const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

declare module 'fastify' {
  interface FastifyRequest {
    /** Authenticated user id (set by the `authenticate` preHandler). */
    userId: string;
    /** Current session id (sid claim). */
    sessionId: string;
    /** Firm from the route params (set by `firmAccess` preHandler). */
    firmId: string;
    /** Resolved membership role for `firmId` (set by `firmAccess`). */
    firmRole: Role;
  }
}
