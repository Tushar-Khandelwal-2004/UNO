"use client";

export function ConnectionBanner({ disconnected, recovered }: { disconnected: boolean; recovered: boolean }) {
  if (!disconnected && !recovered) return null;
  return <div className={`absolute left-1/2 top-0 z-overlay -translate-x-1/2 rounded-b-full px-4 py-1 text-xs font-extrabold ${disconnected ? "bg-uno-error text-[#351416]" : "bg-emerald-400 text-[#082a1b]"}`}>{disconnected ? "Reconnecting…" : "Connected again"}</div>;
}
