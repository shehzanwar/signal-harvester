import { useEffect } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
}

/** Mobile-only modal sheet anchored to the bottom of the screen. */
export function BottomSheet({ open, onClose, title, children }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 sm:hidden" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden />
      <div className="absolute inset-x-0 bottom-0 bg-neutral-900 border-t border-neutral-700 rounded-t-2xl p-4 pb-[max(2rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-neutral-700" aria-hidden />
        {title && <h2 className="text-sm font-semibold text-neutral-300 mb-3">{title}</h2>}
        {children}
      </div>
    </div>
  );
}
