import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";

/**
 * Déconnexion. POST uniquement (le GET permettait un logout CSRF via <img src=/api/auth/logout>).
 * Le cookie de session est en sameSite=lax → un POST cross-site ne l'enverra pas : CSRF couvert.
 */
export async function POST(req: Request) {
  const res = NextResponse.redirect(new URL("/login", req.url), { status: 303 });
  res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
