import type { InteractiveUserRole } from "@culiu/authorization";
import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: DefaultSession["user"] & {
      id: string;
      role: InteractiveUserRole;
    };
  }

  interface User {
    role: InteractiveUserRole;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    role?: InteractiveUserRole;
  }
}
