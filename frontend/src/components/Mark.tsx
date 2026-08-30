/**
 * The brand mark: a signal glyph in the brand accent, standing in for the
 * "detect → diagnose → recover" loop without literally drawing a logo.
 */
export function Mark() {
  return (
    <span className="grid h-7 w-7 place-items-center rounded-md bg-brand text-on-brand shrink-0">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M3 13.5 8.5 8l4 4L21 3.5"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M15 3.5h6v6"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M3 20.5h18"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeOpacity="0.45"
        />
      </svg>
    </span>
  );
}
