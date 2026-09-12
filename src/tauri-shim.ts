const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) { console.warn(`[dev] invoke('${cmd}') skipped`); return null as T; }
  const {invoke: f} = await import('@tauri-apps/api/core');
  return f<T>(cmd, args);
}

type UnlistenFn = () => void;
export async function listen<T>(
  event: string,
  handler: (e: {payload: T}) => void
): Promise<UnlistenFn> {
  if (!isTauri) return () => {};
  const {listen: f} = await import('@tauri-apps/api/event');
  return f<T>(event, handler);
}
