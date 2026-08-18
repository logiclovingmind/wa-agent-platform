import type { ReactElement, ReactNode } from "react";

/**
 * The navigation icons, drawn to the logo's own rules.
 *
 * `public/logo.svg` is a heart built from nothing but horizontals, verticals and exact 45°
 * chamfers — no curves, no arbitrary angles. Every path below obeys the same three, so the
 * sidebar reads as one drawing rather than as a wordmark sitting above someone else's icon
 * set. If you add an icon here and a segment is neither flat nor 45°, it will look foreign
 * at 16px even though nobody will be able to say why.
 *
 * Stroked rather than filled, unlike the mark itself: the logo is 24px of solid black and
 * carries the brand, while these sit at 16px under `opacity-60` beside 14px text, and four
 * solid glyphs down the rail would out-shout the labels they belong to.
 *
 * These replaced lucide-react, which was 1.2MB installed for three glyphs.
 */
// `| undefined` spelled out because the project builds with `exactOptionalPropertyTypes`,
// under which an optional prop may be absent but not explicitly undefined.
export type Icon = (props: { className?: string | undefined }) => ReactElement;

function Glyph({
  className,
  children,
}: {
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** Flowin — the week's shape. A rising trace, every leg on the diagonal. */
export const FlowinIcon: Icon = ({ className }) => (
  <Glyph className={className}>
    <path d="M3 16 L8 11 L11 14 L16 9 H20" />
  </Glyph>
);

/** The desk — one conversation, chamfered where the mark is chamfered. */
export const DeskIcon: Icon = ({ className }) => (
  <Glyph className={className}>
    <path d="M4 8 L9 3 H15 L20 8 V11 L15 16 H8 L4 20 Z" />
  </Glyph>
);

/** The diary — a day with something in it. The dot is a zero-length round cap. */
export const DiaryIcon: Icon = ({ className }) => (
  <Glyph className={className}>
    <path d="M4 9 L7 6 H17 L20 9 V17 L17 20 H7 L4 17 Z" />
    <path d="M4 10.5 H20" />
    <path d="M8.5 3.5 V6" />
    <path d="M15.5 3.5 V6" />
    <path d="M12 15 h.01" />
  </Glyph>
);

/** All clients — the list, each line opening on the mark's chamfer. */
export const ClientsIcon: Icon = ({ className }) => (
  <Glyph className={className}>
    <path d="M3.5 8 L6 5.5 H20.5" />
    <path d="M3.5 13.5 L6 11 H20.5" />
    <path d="M3.5 19 L6 16.5 H20.5" />
  </Glyph>
);

/** The training console — a prompt, in a chamfered window. */
export const ConsoleIcon: Icon = ({ className }) => (
  <Glyph className={className}>
    <path d="M3 8 L6 5 H18 L21 8 V16 L18 19 H6 L3 16 Z" />
    <path d="M8 10 L10.5 12.5 L8 15" />
    <path d="M13 15 H16" />
  </Glyph>
);
