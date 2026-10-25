"use client";

import { useState } from "react";
import type { PublicRoom } from "@uno/protocol";

export function TopBar({ room, onLeave, onTransferHost, hapticsEnabled, onToggleHaptics }: { room: PublicRoom; onLeave: () => void; onTransferHost: (playerId: string) => void; hapticsEnabled: boolean; onToggleHaptics: () => void }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard?.writeText(`${window.location.origin}/room/${room.code}`);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };
  const me = room.players.find((player) => player.isHost);
  return (
    <header className="relative z-40 flex h-[var(--topbar-height,60px)] shrink-0 items-center justify-between rounded-button bg-gradient-to-r from-[#0965bc] to-[#0d5da5] px-4 shadow-lg">
      <div className="flex items-center gap-3"><span className="text-xl">⚙</span><span className="text-lg font-extrabold">Room: <strong className="lowercase">{room.code}</strong></span><button type="button" onClick={copy} className="rounded-full bg-black/15 px-3 py-1 text-xs font-bold text-white/85 hover:bg-black/25">{copied ? "Copied" : "Copy invite"}</button></div>
      <div className="flex items-center gap-2"><span className="hidden rounded-full bg-black/15 px-3 py-1 text-xs font-bold sm:inline">{room.status === "finished" ? "Finished" : `${room.players.length}/${room.maxPlayers} players`}</span><button type="button" aria-expanded={open} aria-label="Open room settings" onClick={() => setOpen((value) => !value)} className="grid min-h-11 min-w-11 place-items-center rounded-full bg-black/15 text-lg hover:bg-black/25">⋮</button></div>
      {open ? <div className="absolute right-3 top-[calc(var(--topbar-height,60px)-.25rem)] w-64 rounded-panel border border-white/15 bg-uno-panel p-4 text-sm shadow-panel"><p className="m-0 text-xs font-bold uppercase tracking-[.12em] text-uno-muted">Room settings</p><p className="mt-2">Code <strong>{room.code}</strong></p><p>Turn timer <strong>{room.turnSeconds}s</strong></p><p>Host <strong>{me?.displayName ?? "—"}</strong></p><button type="button" onClick={onToggleHaptics} className="mt-2 flex min-h-10 w-full items-center justify-between rounded-button bg-white/10 px-3 text-left font-bold hover:bg-white/15"><span>Haptics</span><span className={hapticsEnabled ? "text-emerald-300" : "text-uno-muted"}>{hapticsEnabled ? "On" : "Off"}</span></button><div className="mt-3 grid gap-2">{room.players.filter((player) => !player.isHost).map((player) => <button type="button" key={player.id} onClick={() => onTransferHost(player.id)} className="min-h-10 rounded-button bg-white/10 px-3 text-left font-bold hover:bg-white/15">Make {player.displayName} host</button>)}<button type="button" onClick={onLeave} className="min-h-10 rounded-button bg-uno-error/20 px-3 text-left font-bold text-uno-error hover:bg-uno-error/30">Leave room</button></div></div> : null}
    </header>
  );
}
