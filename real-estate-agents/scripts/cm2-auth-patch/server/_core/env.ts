export const ENV = {
  appId: "cm2",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "oKaCpXvcwRHTtSLr2qbPVL",
  adminPassword: process.env.ADMIN_PASSWORD ?? "",
  isProduction: process.env.NODE_ENV === "production",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
};
