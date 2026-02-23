export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1
          className="text-2xl font-bold"
          style={{ color: "var(--text-primary)" }}
        >
          Settings
        </h1>
        <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
          Configure your dashboard preferences.
        </p>
      </div>

      <div className="card">
        <h2
          className="mb-4 text-lg font-semibold"
          style={{ color: "var(--text-primary)" }}
        >
          Data Source
        </h2>
        <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
          The dashboard reads from the CC Analytics SQLite database. Configure
          the database path and refresh intervals here.
        </p>
        <div className="mt-4 space-y-3">
          <div>
            <label
              className="block text-xs font-medium uppercase tracking-wider"
              style={{ color: "var(--text-secondary)" }}
            >
              Database Path
            </label>
            <input
              type="text"
              readOnly
              value="~/.ccanalytics/ccanalytics.db"
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
              style={{
                backgroundColor: "var(--bg-input)",
                borderColor: "var(--border)",
                color: "var(--text-primary)",
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
