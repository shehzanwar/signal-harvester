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
      onClick={onClick}
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

interface Props {
  todayOnly: boolean;
  showSavedOnly: boolean;
  savedCount: number;
  filterCount: number;
  onTodayToggle: () => void;
  onSearchFocus: () => void;
  onSavedToggle: () => void;
  onFilterSheet: () => void;
  onSettings: () => void;
}

export function BottomNav({
  todayOnly,
  showSavedOnly,
  savedCount,
  filterCount,
  onTodayToggle,
  onSearchFocus,
  onSavedToggle,
  onFilterSheet,
  onSettings,
}: Props) {
  return (
    <nav
      className="sm:hidden fixed bottom-0 left-0 right-0 z-30 grid grid-cols-5
                 bg-neutral-950/95 backdrop-blur-sm border-t border-neutral-800"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
      aria-label="Bottom navigation"
    >
      <NavBtn label="Today" active={todayOnly} onClick={onTodayToggle}>
        📅
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
      <NavBtn label="Settings" onClick={onSettings}>
        ☰
      </NavBtn>
    </nav>
  );
}
