import { z } from "zod";
import { publicProcedure, router } from "../trpc";
import * as db from "../db";
import { ENV } from "../_core/env";
import sgMail from "@sendgrid/mail";

const schema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  phone: z.string().optional().default(""),
  budget: z.string().min(1),
  market: z.string().min(1),
  callTime: z.string().min(1),
  message: z.string().optional().default(""),
});

export const bookACallRouter = router({
  submit: publicProcedure.input(schema).mutation(async ({ input }) => {
    await db.db
      .insertInto("investorLeads")
      .values({
        name: input.name,
        email: input.email,
        whatsapp: input.phone,
        investmentBudget: input.budget,
        mandateInterest: input.market,
        notes: `Call time: ${input.callTime}${input.message ? ". " + input.message : ""}`,
        pageSource: "book-a-call",
        doNotContact: 0,
        replied: 0,
        genuineReply: 0,
        sequenceStep: 0,
        createdAt: new Date(),
      })
      .executeTakeFirst();

    if (ENV.sendgridApiKey) {
      sgMail.setApiKey(ENV.sendgridApiKey);

      await sgMail.send({
        to: "founder@thecm2.com",
        from: "invest@thecm2.com",
        subject: `New call request: ${input.name} (${input.budget})`,
        text: [
          `Name: ${input.name}`,
          `Email: ${input.email}`,
          `Phone: ${input.phone || "—"}`,
          `Budget: ${input.budget}`,
          `Market: ${input.market}`,
          `Call time: ${input.callTime}`,
          `Message: ${input.message || "—"}`,
        ].join("\n"),
      }).catch(() => {});

      await sgMail.send({
        to: input.email,
        from: "invest@thecm2.com",
        subject: "Your call request — Square Centimetre (CM²)",
        html: `
<div style="font-family:'DM Sans',Arial,sans-serif;background:#0b1628;color:#e2e8f0;padding:40px 24px;max-width:520px;margin:0 auto;">
  <img src="https://d2xsxph8kpxj0f.cloudfront.net/310419663031253658/68KcWAaMsChVyE7UijVTrv/cm2-logo-transparent_3206076e.png"
    alt="CM²" style="height:28px;filter:brightness(0) invert(1);opacity:0.8;margin-bottom:32px;display:block;">
  <h2 style="color:#fff;font-size:20px;font-weight:600;margin:0 0 12px;">Call request confirmed</h2>
  <p style="color:#8b9ab1;font-size:14px;line-height:1.6;margin:0 0 24px;">
    Hi ${input.name.split(" ")[0]}, thank you for reaching out. Julian will be in touch within
    24 hours to confirm your call at a time that suits you.
  </p>
  <div style="background:#0f1c2e;border:1px solid #1e2d42;border-radius:8px;padding:20px;margin-bottom:24px;">
    <table style="width:100%;font-size:13px;border-collapse:collapse;">
      <tr><td style="color:#3d5068;padding:4px 0;width:120px;">Budget</td><td style="color:#e2e8f0;">${input.budget}</td></tr>
      <tr><td style="color:#3d5068;padding:4px 0;">Market</td><td style="color:#e2e8f0;">${input.market}</td></tr>
      <tr><td style="color:#3d5068;padding:4px 0;">Preferred time</td><td style="color:#e2e8f0;">${input.callTime}</td></tr>
    </table>
  </div>
  <p style="color:#3d5068;font-size:12px;margin:0;">Square Centimetre Ltd · London · <a href="https://www.thecm2.com" style="color:#c9a84c;text-decoration:none;">thecm2.com</a></p>
</div>`,
      }).catch(() => {});
    }

    return { success: true };
  }),
});
