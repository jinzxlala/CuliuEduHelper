import NextAuth from "next-auth";

import { authOptions } from "../../../../lib/auth-options";

type AuthRouteHandler = (request: Request, context: unknown) => Promise<Response>;

const handler = NextAuth(authOptions) as unknown as AuthRouteHandler;

export { handler as GET, handler as POST };
