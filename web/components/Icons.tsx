import type { ReactNode } from "react";

// The few icons the app uses, drawn inline so there is nothing to download. Each is decorative: the
// text beside it says what it means, so they are hidden from screen readers.

function Icon({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

interface IconProps {
  size?: number;
}

/** The mark: a filled bolt. */
export function BoltIcon({ size = 20 }: IconProps) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M13.5 2 4 13.5h6.2L9 22l10-12.2h-6.4L13.5 2Z" />
    </svg>
  );
}

export const ArrowRightIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Icon>
);

export const ArrowLeftIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </Icon>
);

export const CheckIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Icon>
);

export const CrossIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);

export const ClockIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Icon>
);

export const LockIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </Icon>
);

export const UsersIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8" />
  </Icon>
);

export const TicketIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M3 9V6a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v3a3 3 0 0 0 0 6v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a3 3 0 0 0 0-6Z" />
    <path d="M14 5v2.5M14 11v2M14 16.5V19" />
  </Icon>
);

export const CardIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
    <path d="M2.5 10h19M6.5 15h4" />
  </Icon>
);

export const CalendarIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
  </Icon>
);

export const UploadIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
  </Icon>
);

export const PlusIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const MinusIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M5 12h14" />
  </Icon>
);

export const PencilIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-4-4L4 16v4ZM13.5 6.5l4 4" />
  </Icon>
);

export const ShieldIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M12 3 4.5 6v5.5c0 4.5 3 8 7.5 9.5 4.5-1.5 7.5-5 7.5-9.5V6L12 3Z" />
    <path d="m9 12 2.2 2.2L15.2 10" />
  </Icon>
);

export const AlertIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M12 4 2.5 20h19L12 4ZM12 10v4.5M12 17.2v.3" />
  </Icon>
);
