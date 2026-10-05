function clamp(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

/** Outer CPU and inner memory rings show reservations, not measured host usage. */
export function CapacityGauge({ cpu, memory, label, caption = "reserved" }) {
  const cpuPercent = Math.round(clamp(cpu) * 100);
  const memoryPercent = Math.round(clamp(memory) * 100);
  return (
    <div className="capacity-gauge" title={`${label}: CPU ${cpuPercent}% reserved, memory ${memoryPercent}% reserved. Center shows the higher percentage.`}>
      <svg viewBox="0 0 120 120" aria-hidden="true" focusable="false">
        <circle className="gauge-track" cx="60" cy="60" r="50" />
        <circle className="gauge-track" cx="60" cy="60" r="36" />
        <circle className="gauge-cpu" cx="60" cy="60" r="50" pathLength="100"
          strokeDasharray={`${cpuPercent} 100`} />
        <circle className="gauge-memory" cx="60" cy="60" r="36" pathLength="100"
          strokeDasharray={`${memoryPercent} 100`} />
      </svg>
      <div className="gauge-center" aria-hidden="true">
        <strong>{Math.max(cpuPercent, memoryPercent)}%</strong>
        <span>{caption}</span>
      </div>
      <span className="sr-only">{label}: CPU {cpuPercent}% reserved, memory {memoryPercent}% reserved.</span>
    </div>
  );
}
