"use client";

export function Toast({ message }: { message?: string }) {
  if (!message) return null;
  return <div role="status" className="pointer-events-none fixed bottom-24 left-1/2 z-overlay max-w-[min(90vw,420px)] -translate-x-1/2 rounded-full border border-white/15 bg-[#12181b]/95 px-4 py-2 text-center text-sm font-bold text-white shadow-panel">{message}</div>;
}
