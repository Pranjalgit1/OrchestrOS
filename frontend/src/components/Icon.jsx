const PATHS = {
  check: "m6 12 4 4 8-8",
  close: "m7 7 10 10M7 17 17 7",
  clock: "M12 7v5l3 2",
  search: "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  sort: "m8 8 4-4 4 4M8 16l4 4 4-4",
  arrowUp: "m7 10 5-5 5 5M12 5v14",
  arrowDown: "m7 14 5 5 5-5M12 5v14",
  play: "m8 5 11 7-11 7Z",
  pause: "M8 5v14M16 5v14",
  stop: "M6 6h12v12H6Z",
  plus: "M12 5v14M5 12h14",
  info: "M12 11v6M12 7h.01",
  cursor: "m4 3 16 7-7 3-3 7Z",
  box: "m12 3 9 5v8l-9 5-9-5V8Zm0 10v8M3 8l9 5 9-5",
  refresh: "M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2",
  camera: "M8 6l2-3h4l2 3h5v14H3V6Zm8 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  chevron: "m9 5 7 7-7 7",
  workflow: "M4 3h6v6H4ZM14 15h6v6h-6ZM7 9v8h7M10 6h7v9",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  scaling: "M4 17l5-5 4 4 7-7M14 9h6v6",
  compare: "M12 4v16M8 20h8M5 8h14M5 8l-2.5 6a2.5 2.5 0 0 0 5 0ZM19 8l-2.5 6a2.5 2.5 0 0 0 5 0Z",
  activity: "M3 12h4l3-7 4 14 3-7h4",
  sun: "M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  moon: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z",
};

/** Small local line icons; decorative icons never replace button labels. */
export function Icon({ name, className = "" }) {
  return (
    <svg className={`icon ${className}`} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false">
      {name === "info" || name === "clock" ? <circle cx="12" cy="12" r="9" /> : null}
      <path d={PATHS[name] ?? PATHS.info} />
    </svg>
  );
}
