function haptic(): void {
  if ("vibrate" in navigator) navigator.vibrate(10);
}

interface NavBtnProps {
  label: string;
  active?: boolean;
  badge?: number;
  onClick: () => void;
  children: React.ReactNode;
}

function NavBtn({ label, active, badge, onClick, children }: NavBtnProps) {
  return (
    <button
      onClick={() => {
        haptic();
        onClick();
      }}
      className={`flex flex-col items-center justify-center gap-0.5 py-2 min-h-[56px] relative
                  text-xs transition-colors active:bg-neutral-800
                  ${active ? "text-blue-400" : "text-neutral-500"}`}
      aria-pressed={active}
    >
      <span className="text-lg leading-none relative">
        {children}
        {badge != null && badge > 0 && (
          <span className="absolute -top-1 -right-2.5 min-w-[16px] h-4 px-0.5 flex items-center justify-center
                           text-[9px] font-bold rounded-full bg-blue-600 text-white">
            {badge > 99 ? "99+" : badge}
          </span>
        )}
      </span>
      <span className="text-[10px] leading-none">{label}</span>
    </button>
  );
}

// Small ring around the Today icon showing overall read progress — reuses
// data App.tsx already computes (readProgress), so this is purely a display
// addition, not a new source of truth for what "read" means.
function ProgressRing({ pct, size = 30 }: { pct: number; size?: number }) {
  const stroke = 2;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - Math.min(1, Math.max(0, pct)));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="absolute -top-1 -left-1" aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={stroke} className="text-neutral-800" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeDasharray={c}
        strokeDashoffset={offset}
        strokeLinecap="round"
        className="text-blue-500 transition-[stroke-dashoffset] duration-300"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

interface Props {
  todayOnly: boolean;
  showSavedOnly: boolean;
  savedCount: number;
  filterCount: number;
  todayUnreadCount: number;
  readProgress: { read: number; total: number };
  onTodayToggle: () => void;
  onSearchFocus: () => void;
  onSavedToggle: () => void;
  onFilterSheet: () => void;
}

export function BottomNav({
  todayOnly,
  showSavedOnly,
  savedCount,
  filterCount,
  todayUnreadCount,
  readProgress,
  onTodayToggle,
  onSearchFocus,
  onSavedToggle,
  onFilterSheet,
}: Props) {
  const pct = readProgress.total > 0 ? readProgress.read / readProgress.total : 0;
  return (
    <nav
      className="sm:hidden fixed bottom-0 left-0 right-0 z-30 grid grid-cols-4
                 bg-neutral-950/95 backdrop-blur-sm border-t border-neutral-800"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
      aria-label="Bottom navigation"
    >
      <NavBtn label="Today" active={todayOnly} badge={todayUnreadCount} onClick={onTodayToggle}>
        <span className="relative inline-flex items-center justify-center">
          <ProgressRing pct={pct} />
          📅
        </span>
      </NavBtn>
      <NavBtn label="Search" onClick={onSearchFocus}>
        🔍
      </NavBtn>
      <NavBtn label="Saved" active={showSavedOnly} badge={savedCount} onClick={onSavedToggle}>
        ★
      </NavBtn>
      <NavBtn label="Filters" badge={filterCount} onClick={onFilterSheet}>
        ⚙︎
      </NavBtn>
    </nav>
  );
}
