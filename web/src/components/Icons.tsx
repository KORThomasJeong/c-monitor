// 목업(docs/mockup/*.dc.html)의 인라인 SVG를 그대로 옮긴 아이콘. 모두 장식용(aria-hidden).
import type { ReactNode } from 'react';

type P = { size?: number; className?: string };

function Svg({ size = 18, className, children }: P & { children: ReactNode }) {
  return (
    <svg className={className ? `ico ${className}` : 'ico'} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {children}
    </svg>
  );
}

export const PulseIcon = (p: P) => <Svg {...p}><path d="M3 12h4l3-7 4 14 3-7h4" /></Svg>;
export const GridIcon = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
  </Svg>
);
export const ListIcon = (p: P) => <Svg {...p}><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></Svg>;
export const BellIcon = (p: P) => (
  <Svg {...p}><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></Svg>
);
export const BellOffIcon = (p: P) => (
  <Svg {...p}>
    <path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5" /><path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /><path d="m2 2 20 20" />
  </Svg>
);
export const SunIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </Svg>
);
export const MoonIcon = (p: P) => <Svg {...p}><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /></Svg>;
export const SlidersIcon = (p: P) => (
  <Svg {...p}><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" /></Svg>
);
/** 관리자(사용자 관리) 링크용. 목업의 선 굵기·크기 규칙을 따른다. */
export const UsersIcon = (p: P) => (
  <Svg {...p}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
  </Svg>
);
export const LogoutIcon = (p: P) => (
  <Svg {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5M21 12H9" /></Svg>
);
export const BackIcon = (p: P) => <Svg {...p}><path d="M19 12H5M12 19l-7-7 7-7" /></Svg>;
export const CloseIcon = (p: P) => <Svg {...p}><path d="M18 6 6 18M6 6l12 12" /></Svg>;
export const PcIcon = (p: P) => <Svg {...p}><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></Svg>;
export const ServerIcon = (p: P) => (
  <Svg {...p}>
    <rect x="2" y="2" width="20" height="8" rx="2" /><rect x="2" y="14" width="20" height="8" rx="2" />
    <path d="M6 6h.01M6 18h.01" />
  </Svg>
);
export const BranchIcon = (p: P) => (
  <Svg {...p}><path d="M6 3v12" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></Svg>
);
export const LockIcon = (p: P) => <Svg {...p}><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></Svg>;
export const AlertIcon = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" /></Svg>;
export const InfoIcon = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></Svg>;
export const TerminalIcon = (p: P) => <Svg {...p}><path d="m4 17 6-6-6-6M12 19h8" /></Svg>;
export const CheckCircleIcon = (p: P) => (
  <Svg {...p}><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><path d="M22 4 12 14.01l-3-3" /></Svg>
);
export const ClockIcon = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></Svg>;
export const PowerIcon = (p: P) => <Svg {...p}><path d="M18.36 6.64a9 9 0 1 1-12.73 0" /><path d="M12 2v10" /></Svg>;
export const CheckIcon = (p: P) => <Svg {...p}><path d="M20 6 9 17l-5-5" /></Svg>;
export const SpinIcon = (p: P) => <Svg {...p} className="spin"><path d="M21 12a9 9 0 1 1-6.22-8.56" /></Svg>;
export const WifiOffIcon = (p: P) => (
  <Svg {...p}>
    <path d="M2 2l20 20M8.5 16.5a5 5 0 0 1 7 0M5 12.86a10 10 0 0 1 5.17-2.69M19 12.86a10 10 0 0 0-2.3-1.6M2 8.82a15 15 0 0 1 4.18-2.65M22 8.82a15 15 0 0 0-11.29-3.76M12 20h.01" />
  </Svg>
);
export const SearchIcon = (p: P) => <Svg {...p}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></Svg>;
export const ChevronUpIcon = (p: P) => <Svg {...p}><path d="m18 15-6-6-6 6" /></Svg>;
export const ChevronDownIcon = (p: P) => <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>;
export const ArrowDownIcon = (p: P) => <Svg {...p}><path d="M12 5v14M19 12l-7 7-7-7" /></Svg>;
export const TrashIcon = (p: P) => (
  <Svg {...p}><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" /></Svg>
);
export const PanelIcon = (p: P) => <Svg {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M14 4v16" /></Svg>;
/** 원격 답장: 보내기(목업 Main의 종이비행기) */
export const SendIcon = (p: P) => <Svg {...p}><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></Svg>;
/** 원격 제어로 열기(새 탭) */
export const ExternalIcon = (p: P) => (
  <Svg {...p}><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></Svg>
);

/** 공유(세 점을 잇는 선) */
export const ShareIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
    <path d="m8.59 13.51 6.83 3.98M15.41 6.51l-6.82 3.98" />
  </Svg>
);
export const CopyIcon = (p: P) => (
  <Svg {...p}><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></Svg>
);
export const EyeIcon = (p: P) => (
  <Svg {...p}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></Svg>
);
export const VolumeIcon = (p: P) => (
  <Svg {...p}><path d="M11 5 6 9H2v6h4l5 4V5Z" /><path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14" /></Svg>
);

/** Google 로고(로그인 버튼). 목업 그대로. */
export const GoogleLogo = () => (
  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
    <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
    <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
    <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
  </svg>
);
