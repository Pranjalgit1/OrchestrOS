const PATHS = {
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
};

/** Small local line icons; decorative icons never replace button labels. */
export function Icon({ name, className = "" }) {
  return (
    <svg className={`icon ${className}`} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false">
      {name === "info" ? <circle cx="12" cy="12" r="9" /> : null}
      <path d={PATHS[name] ?? PATHS.info} />
    </svg>
  );
}
