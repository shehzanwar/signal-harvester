import { useCallback, useState } from "react";

export interface ToastState {
  message: string;
  undo: () => void;
  key: number;
}

export interface ToastResult {
  toast: ToastState | null;
  showToast: (message: string, undo: () => void) => void;
  dismissToast: () => void;
}

export function useToast(): ToastResult {
  const [toast, setToast] = useState<ToastState | null>(null);
  const showToast = useCallback((message: string, undo: () => void) => {
    setToast({ message, undo, key: Date.now() });
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);
  return { toast, showToast, dismissToast };
}
