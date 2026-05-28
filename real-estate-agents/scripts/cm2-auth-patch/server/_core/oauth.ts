import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import type { Express } from "express";
import * as db from "../db";
import { getSessionCookieOptions } from "./cookies";
import { ENV } from "./env";
import { sdk } from "./sdk";

export function registerOAuthRoutes(app: Express) {
  app.post("/api/auth/login", async (req, res) => {
    const { password } = req.body as { password?: string };

    if (!password || password !== ENV.adminPassword) {
      res.status(401).json({ error: "Invalid password" });
      return;
    }

    await db.upsertUser({
      openId: ENV.ownerOpenId,
      name: "Julian Noble",
      email: "juliannoble1@gmail.com",
      loginMethod: "password",
      lastSignedIn: new Date(),
    });

    const sessionToken = await sdk.createSessionToken(ENV.ownerOpenId, {
      name: "Julian Noble",
      expiresInMs: ONE_YEAR_MS,
    });

    const cookieOptions = getSessionCookieOptions(req);
    res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
    res.json({ success: true });
  });
}
