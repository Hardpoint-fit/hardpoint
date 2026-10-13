import { getConfig } from "#/lib/site-config";

function Readout({ label, value, on }: { label: string; value: string; on: boolean }) {
  return (
    <div className="flex items-center justify-between gap-6 border border-[color:var(--panel-border)] bg-[color:var(--content-bg)] px-3 py-2">
      <span className="text-secondary">{label}</span>
      <span className={on ? "text-positive" : "text-secondary"}>{value}</span>
    </div>
  );
}

export default function Home() {
  const config = getConfig();
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-6 px-6 py-16">
      <section className="bevel bg-[color:var(--panel-border)] p-px">
        <div className="bevel bg-panel">
          <header className="flex h-[var(--panel-header-height)] items-center bg-header px-3 text-[length:var(--font-size-small)] text-secondary">
            Theorycrafting
          </header>
          <div className="flex flex-col gap-5 p-6">
            <h1 className="text-[length:var(--font-size-header)] font-bold tracking-widest text-primary">
              Citadel ship fits
            </h1>
            <p className="text-primary/75">
              Build a ship, read its numbers from the game&apos;s own rules, and share the fit. The builder is on its way.
            </p>
            <div className="flex flex-col gap-2 text-[length:var(--font-size-small)]">
              <Readout label="Engine" value={config.engineUrl ? "Configured" : "Not configured"} on={!!config.engineUrl} />
              <Readout label="Fits database" value={config.databaseUrl ? "Configured" : "Not configured"} on={!!config.databaseUrl} />
              <Readout label="Sign-in" value={config.authEnabled ? "Enabled" : "Not configured"} on={config.authEnabled} />
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
