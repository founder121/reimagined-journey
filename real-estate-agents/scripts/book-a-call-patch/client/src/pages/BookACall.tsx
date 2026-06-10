import { useState } from "react";
import { trpc } from "../trpc";

type FormState = {
  name: string;
  email: string;
  phone: string;
  budget: string;
  market: string;
  callTime: string;
  message: string;
};

const INITIAL: FormState = {
  name: "",
  email: "",
  phone: "",
  budget: "",
  market: "",
  callTime: "",
  message: "",
};

export default function BookACall() {
  const [form, setForm] = useState<FormState>(INITIAL);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  const submit = trpc.bookACall.submit.useMutation({
    onSuccess: () => setSubmitted(true),
    onError: (e) => setError(e.message || "Something went wrong. Please try again."),
  });

  function set(field: keyof FormState) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
      setForm((f) => ({ ...f, [field]: e.target.value }));
      setError("");
    };
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name || !form.email || !form.budget || !form.market || !form.callTime) {
      setError("Please fill in all required fields.");
      return;
    }
    submit.mutate(form);
  }

  if (submitted) {
    return (
      <div className="min-h-screen bg-[#0b1628] flex items-center justify-center px-4">
        <div className="w-full max-w-md text-center">
          <div className="w-16 h-16 rounded-full bg-[#c9a84c]/10 border border-[#c9a84c]/30 flex items-center justify-center mx-auto mb-6">
            <svg className="w-8 h-8 text-[#c9a84c]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-white text-2xl font-semibold mb-3">Call request received</h1>
          <p className="text-[#8b9ab1] text-sm leading-relaxed mb-8">
            Thank you, {form.name.split(" ")[0]}. Julian will be in touch within 24 hours to confirm
            your call. A confirmation has been sent to {form.email}.
          </p>
          <a
            href="/"
            className="inline-block px-6 py-3 border border-[#c9a84c]/40 text-[#c9a84c] text-sm rounded-lg hover:bg-[#c9a84c]/10 transition-colors"
          >
            Back to home
          </a>
        </div>
      </div>
    );
  }

  const inputClass =
    "w-full px-4 py-3 bg-[#0f1c2e] border border-[#1e2d42] rounded-lg text-white placeholder-[#3d5068] focus:outline-none focus:border-[#c9a84c]/60 transition-colors text-sm";
  const labelClass = "block text-[#8b9ab1] text-xs font-medium uppercase tracking-wider mb-1.5";
  const selectClass = inputClass + " appearance-none cursor-pointer";

  return (
    <div className="min-h-screen bg-[#0b1628] px-4 py-16">
      <div className="w-full max-w-lg mx-auto">
        <div className="text-center mb-10">
          <a href="/">
            <img
              src="https://d2xsxph8kpxj0f.cloudfront.net/310419663031253658/68KcWAaMsChVyE7UijVTrv/cm2-logo-transparent_3206076e.png"
              alt="CM²"
              className="h-8 mx-auto mb-8 brightness-0 invert opacity-80"
            />
          </a>
          <h1 className="text-white text-2xl font-semibold tracking-tight mb-2">Book a call</h1>
          <p className="text-[#8b9ab1] text-sm max-w-sm mx-auto">
            Speak directly with Julian Noble about prime London and international property investment.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2 sm:col-span-1">
              <label className={labelClass}>Full name *</label>
              <input
                type="text"
                value={form.name}
                onChange={set("name")}
                placeholder="Julian Noble"
                required
                className={inputClass}
              />
            </div>
            <div className="col-span-2 sm:col-span-1">
              <label className={labelClass}>Email *</label>
              <input
                type="email"
                value={form.email}
                onChange={set("email")}
                placeholder="you@example.com"
                required
                className={inputClass}
              />
            </div>
          </div>

          <div>
            <label className={labelClass}>Phone / WhatsApp</label>
            <input
              type="tel"
              value={form.phone}
              onChange={set("phone")}
              placeholder="+44 7700 000000"
              className={inputClass}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Investment budget *</label>
              <div className="relative">
                <select value={form.budget} onChange={set("budget")} required className={selectClass}>
                  <option value="">Select range</option>
                  <option value="Under £500k">Under £500k</option>
                  <option value="£500k–£1M">£500k – £1M</option>
                  <option value="£1M–£3M">£1M – £3M</option>
                  <option value="£3M+">£3M+</option>
                </select>
                <div className="pointer-events-none absolute inset-y-0 right-3 flex items-center">
                  <svg className="w-4 h-4 text-[#3d5068]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </div>
            </div>

            <div>
              <label className={labelClass}>Market interest *</label>
              <div className="relative">
                <select value={form.market} onChange={set("market")} required className={selectClass}>
                  <option value="">Select market</option>
                  <option value="London">London</option>
                  <option value="UAE">UAE</option>
                  <option value="Dubai">Dubai</option>
                  <option value="Egypt">Egypt</option>
                  <option value="Multiple">Multiple</option>
                </select>
                <div className="pointer-events-none absolute inset-y-0 right-3 flex items-center">
                  <svg className="w-4 h-4 text-[#3d5068]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </div>
            </div>
          </div>

          <div>
            <label className={labelClass}>Preferred call time *</label>
            <div className="grid grid-cols-4 gap-2">
              {["Morning", "Afternoon", "Evening", "Flexible"].map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => { setForm((f) => ({ ...f, callTime: t })); setError(""); }}
                  className={`py-2.5 text-xs font-medium rounded-lg border transition-colors ${
                    form.callTime === t
                      ? "bg-[#c9a84c]/15 border-[#c9a84c]/60 text-[#c9a84c]"
                      : "bg-[#0f1c2e] border-[#1e2d42] text-[#8b9ab1] hover:border-[#c9a84c]/30"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className={labelClass}>Message (optional)</label>
            <textarea
              value={form.message}
              onChange={set("message")}
              rows={3}
              placeholder="Tell us a little about what you're looking for…"
              className={inputClass + " resize-none"}
            />
          </div>

          {error && <p className="text-red-400 text-sm">{error}</p>}

          <button
            type="submit"
            disabled={submit.isPending}
            className="w-full py-3.5 bg-[#c9a84c] hover:bg-[#b8973b] disabled:opacity-40 text-black font-semibold rounded-lg transition-colors text-sm tracking-wide"
          >
            {submit.isPending ? "Sending…" : "Request a call"}
          </button>

          <p className="text-center text-[#3d5068] text-xs">
            We'll respond within 24 hours. No spam, ever.
          </p>
        </form>
      </div>
    </div>
  );
}
