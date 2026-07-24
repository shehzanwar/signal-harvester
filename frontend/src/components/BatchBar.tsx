interface Props {
  count: number;
  onMarkRead: () => void;
  onSave: () => void;
  onMute: () => void;
  onCancel: () => void;
}

export function BatchBar({ count, onMarkRead, onSave, onMute, onCancel }: Props) {
  return (
    <div
      className="fixed bottom-20 sm:bottom-6 left-1/2 -translate-x-1/2 z-[60]
                 flex items-center gap-2 px-4 py-2.5 rounded-xl
                 bg-neutral-900 border border-neutral-700 shadow-2xl whitespace-nowrap"
      role="toolbar"
      aria-label="Batch actions"
    >
      <span className="text-sm text-neutral-400 mr-1">
        {count} selected
      </span>
      <button
        onClick={onMarkRead}
        className="text-sm px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 transition-colors"
      >
        Mark read
      </button>
      <button
        onClick={onSave}
        className="text-sm px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 transition-colors"
      >
        ★ Save
      </button>
      <button
        onClick={onMute}
        className="text-sm px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 transition-colors"
        title="Mute all tags from the selected articles"
      >
        🔇 Mute
      </button>
      <button
        onClick={onCancel}
        className="text-sm px-2 py-1.5 text-neutral-500 hover:text-neutral-300 transition-colors"
        aria-label="Exit batch mode"
      >
        ✕
      </button>
    </div>
  );
}
