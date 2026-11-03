import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

import { signSession, SESSION_COOKIE, sessionExpiry } from "@/lib/db/session";

const { proxy } = await import("./proxy");

beforeEach(() => {
  process.env.AUTH_SECRET = "test-secret";
});

afterEach(() => {
  delete process.env.AUTH_SECRET;
});

function authed(url: string) {
  const token = signSession({ sid: "sid-1", sub: "user-1", exp: sessionExpiry() });
  return new NextRequest(url, { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
}

describe("proxy — Postgres session cookie", () => {
  it("redirects a signed-in user off /login", async () => {
    const res = await proxy(authed("https://app.test/login"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
  });

  it("redirects a signed-out user from /dashboard to /login", async () => {
    const res = await proxy(new NextRequest("https://app.test/dashboard"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("redirects a signed-in user with an invite token to /join/<token>", async () => {
    const res = await proxy(authed("https://app.test/login?invite=abc123"));
    expect(res.headers.get("location")).toContain("/join/abc123");
  });

  it("passes through for a signed-in user on a protected page", async () => {
    const res = await proxy(authed("https://app.test/dashboard"));
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("proxy — every dashboard route requires a session", () => {
  const dashboardRoutes = readdirSync(join(__dirname, "app", "(dashboard)"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `/${entry.name}`);

  it("finds the dashboard route group", () => {
    expect(dashboardRoutes).toContain("/dashboard");
  });

  it.each(dashboardRoutes)("redirects a signed-out visitor from %s to /login", async (route) => {
    const res = await proxy(new NextRequest(`https://app.test${route}`));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });
});
