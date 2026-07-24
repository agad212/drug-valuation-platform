import { NextResponse, type NextRequest } from "next/server";
import { GATE_COOKIE, GATE_MAX_AGE, gateToken } from "./lib/gate";

/**
 * Server-side access gate. Everything is locked except:
 *  - /survey, /survey-admin (+ their /api/survey/* endpoints) — public for respondents
 *  - /api/auth/* (NextAuth), /gate + /api/gate (the unlock flow itself)
 *  - Next.js static assets
 * Pages redirect to /gate; API routes get 401 so nobody can burn AI credits
 * by calling endpoints directly.
 */
export async function middleware(req: NextRequest) {
  const token = await gateToken();
  const cookie = req.cookies.get(GATE_COOKIE)?.value;

  if (cookie === token) {
    const res = NextResponse.next();
    // Sliding renewal: every visit restarts the 400-day clock.
    res.cookies.set(GATE_COOKIE, token, {
      maxAge: GATE_MAX_AGE,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
    });
    return res;
  }

  if (req.nextUrl.pathname.startsWith("/api/")) {
    return new NextResponse(JSON.stringify({ error: "Locked — unlock the site first." }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/gate";
  const target = req.nextUrl.pathname + req.nextUrl.search;
  url.search = target === "/" ? "" : `?next=${encodeURIComponent(target)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|survey|gate|api/survey|api/auth|api/gate).*)"],
};
