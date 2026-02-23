export default function ModelsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1
          className="text-2xl font-bold"
          style={{ color: "var(--text-primary)" }}
        >
          Models
        </h1>
        <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
          Compare usage and costs across different Claude models.
        </p>
      </div>

      <div className="card">
        <div
          className="flex h-96 items-center justify-center rounded-lg"
          style={{ backgroundColor: "var(--bg-secondary)" }}
        >
          <p style={{ color: "var(--text-muted)" }}>
            Models comparison placeholder - connect API to populate
          </p>
        </div>
      </div>
    </div>
  );
}
