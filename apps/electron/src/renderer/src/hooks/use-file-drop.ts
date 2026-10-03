import { useCallback, useState } from "react";

/** Drag-over/drop handlers for a single-file drop target. */
export function useFileDrop(
  onFile: (file: File) => void,
  disabled: boolean,
): {
  dragActive: boolean;
  handlers: {
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: () => void;
    onDrop: (e: React.DragEvent) => void;
  };
} {
  const [dragActive, setDragActive] = useState(false);
  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (!disabled) setDragActive(true);
    },
    [disabled],
  );
  const onDragLeave = useCallback(() => setDragActive(false), []);
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragActive(false);
      if (disabled) return;
      const file = e.dataTransfer.files?.[0];
      if (file) onFile(file);
    },
    [disabled, onFile],
  );
  return { dragActive, handlers: { onDragOver, onDragLeave, onDrop } };
}
