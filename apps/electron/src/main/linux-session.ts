export function isWaylandSession(): boolean {
  return (
    process.env.XDG_SESSION_TYPE?.toLowerCase() === "wayland" ||
    Boolean(process.env.WAYLAND_DISPLAY)
  );
}
