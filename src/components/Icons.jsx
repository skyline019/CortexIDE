const S = ({ children, size = 15, ...rest }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    {...rest}
  >
    {children}
  </svg>
);

export const IconFiles = (p) => (
  <S {...p}>
    <path d="M15 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z" />
    <path d="M15 3v4h4" />
  </S>
);
export const IconSearch = (p) => (
  <S {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </S>
);
export const IconBrain = (p) => (
  <S {...p}>
    <path d="M9 4a3 3 0 0 0-3 3 2.6 2.6 0 0 0-1 5 3 3 0 0 0 1.5 5A3 3 0 0 0 12 19V5a2 2 0 0 0-3-1Z" />
    <path d="M15 4a3 3 0 0 1 3 3 2.6 2.6 0 0 1 1 5 3 3 0 0 1-1.5 5A3 3 0 0 1 12 19" />
  </S>
);
export const IconHistory = (p) => (
  <S {...p}>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 4v4h4" />
    <path d="M12 8v4l3 2" />
  </S>
);
export const IconGear = (p) => (
  <S {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.4-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.4l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4Z" />
  </S>
);
export const IconSend = (p) => (
  <S {...p}>
    <path d="m4 12 16-8-6 16-2.5-6.5L4 12Z" />
  </S>
);
export const IconStop = (p) => (
  <S {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </S>
);
export const IconPlus = (p) => (
  <S {...p}>
    <path d="M12 5v14M5 12h14" />
  </S>
);
export const IconTrash = (p) => (
  <S {...p}>
    <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
  </S>
);
export const IconPin = (p) => (
  <S {...p}>
    <path d="M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6Z" />
    <path d="M12 15v5" />
  </S>
);
export const IconClose = (p) => (
  <S {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </S>
);
export const IconSave = (p) => (
  <S {...p}>
    <path d="M5 4h11l3 3v13H5z" />
    <path d="M8 4v5h7V4M8 20v-6h8v6" />
  </S>
);
export const IconCmd = (p) => (
  <S {...p}>
    <path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3Z" />
  </S>
);
export const IconChat = (p) => (
  <S {...p}>
    <path d="M21 12a8 8 0 0 1-8 8H8l-4 2 1.2-3.6A8 8 0 1 1 21 12Z" />
  </S>
);
export const IconSpark = (p) => (
  <S {...p}>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" />
  </S>
);
export const IconTerminal = (p) => (
  <S {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="m7 9 3 3-3 3M13 15h4" />
  </S>
);
export const IconDownload = (p) => (
  <S {...p}>
    <path d="M12 4v10M8 11l4 4 4-4M5 20h14" />
  </S>
);
export const IconUpload = (p) => (
  <S {...p}>
    <path d="M12 16V6M8 9l4-4 4 4M5 20h14" />
  </S>
);
export const IconCheck = (p) => (
  <S {...p}>
    <path d="m5 13 4 4L19 7" />
  </S>
);
export const IconSync = (p) => (
  <S {...p}>
    <path d="M21 12a9 9 0 0 1-15.5 6.2M3 12a9 9 0 0 1 15.5-6.2" />
    <path d="M21 4v5h-5" />
    <path d="M3 20v-5h5" />
  </S>
);
export const IconShield = (p) => (
  <S {...p}>
    <path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z" />
    <path d="M9.5 12l1.8 1.8 3.4-3.6" />
  </S>
);
export const IconDiff = (p) => (
  <S {...p}>
    <path d="M6 3v12" />
    <path d="M3 6h6" />
    <circle cx="6" cy="18" r="2.4" />
    <path d="M18 21V9" />
    <path d="M15 12h6" />
    <circle cx="18" cy="6" r="2.4" />
  </S>
);

export const IconPlay = (p) => (
  <S {...p}>
    <path d="M7 4.5l12 7.5-12 7.5z" />
  </S>
);
export const IconPlug = (p) => (
  <S {...p}>
    <path d="M9 3v5M15 3v5" />
    <path d="M6 8h12v3a6 6 0 0 1-12 0z" />
    <path d="M12 17v4" />
  </S>
);

export const IconFlow = (p) => (
  <S {...p}>
    <rect x="3" y="4" width="6" height="5" rx="1.2" />
    <rect x="15" y="15" width="6" height="5" rx="1.2" />
    <path d="M9 6.5h4a2 2 0 0 1 2 2V15" />
    <path d="M15 17.5h-4a2 2 0 0 1-2-2V9" />
  </S>
);

export const IconBook = (p) => (
  <S {...p}>
    <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v16H6.5A2.5 2.5 0 0 0 4 21.5z" />
    <path d="M4 18.5A2.5 2.5 0 0 1 6.5 16H19" />
    <path d="M9 7h6M9 10h4" />
  </S>
);

export const IconClip = (p) => (
  <S {...p}>
    <path d="M21 11.5 12.5 20a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7-7" />
  </S>
);
export const IconAt = (p) => (
  <S {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M16 8v5a3 3 0 0 0 5 2.2A9 9 0 1 0 17 20.5" />
  </S>
);
export const IconFolder = (p) => (
  <S {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </S>
);

export const IconPanelLeft = (p) => (
  <S {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </S>
);
export const IconPanelRight = (p) => (
  <S {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M15 4v16" />
  </S>
);
export const IconChevronLeft = (p) => (
  <S {...p}>
    <path d="m14 6-6 6 6 6" />
  </S>
);
export const IconChevronRight = (p) => (
  <S {...p}>
    <path d="m10 6 6 6-6 6" />
  </S>
);
export const IconMore = (p) => (
  <S {...p}>
    <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
  </S>
);
