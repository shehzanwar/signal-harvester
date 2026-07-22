import { useEffect } from "react";

interface Props {
  message: string;
  onUndo: () => void;
  onDismiss: () => void;
}

export function Toast({ message, onUndo, onDismiss }: Props) {
  useEffect(() => {
    const id = setTimeout(onDismiss, 4000);
    return () => clearTimeout(id);
  }, [onDismiss]);

  return (
    <div
      className="fixed bottom-20 sm:bottom-6 left-1/2 -translate-x-1/2 z-[60]
                 flex items-center gap-3 px-4 py-3 rounded-lg
                 bg-neutral-800 border border-neutral-700 shadow-2xl
                 text-sm text-neutral-200 whitespace-nowrap"
      role="status"
      aria-live="polite"
    >
      <span>{message}</span>
      <button
        onClick={() => { onUndo(); onDismiss(); }}
        className="text-blue-400 hover:text-blue-300 font-medium transition-colors"
      >
        Undo
      </button>
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        className="text-neutral-500 hover:text-neutral-300 transition-colors text-base leading-none"
      >
        ×
      </button>
    </div>
  );
}
