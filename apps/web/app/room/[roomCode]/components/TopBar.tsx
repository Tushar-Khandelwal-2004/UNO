"use client";

import { useState } from "react";
import type { PublicRoom } from "@uno/protocol";

export function TopBar({ room, onLeave, onTransferHost, hapticsEnabled, onToggleHaptics, onCopyInvite }: { room: PublicRoom; onLeave: () => void; onTransferHost: (playerId: string) => void; hapticsEnabled: boolean; onToggleHaptics: () => void; onCopyInvite: () => void }) {
  const [open, setOpen] = useState(false);
  const host = room.players.find((player) => player.isHost);
  return (
    <header data-layout-role="top-bar" className="top-bar">
      <div className="top-bar-room"><span className="top-bar-gear">⚙</span><span>Room: <strong>{room.code.toLowerCase()}</strong></span><button type="button" onClick={onCopyInvite} className="top-bar-copy">Copy invite</button></div>
      <div className="top-bar-right"><span className="top-bar-count">{room.players.length}/{room.maxPlayers}</span><button type="button" aria-expanded={open} aria-label="Open room settings" className="top-bar-menu" onClick={() => setOpen((value) => !value)}>⋮</button></div>
      {open ? <div className="settings-popover"><p>Room settings</p><span>Turn timer <strong>{room.turnSeconds}s</strong></span><span>Host <strong>{host?.displayName ?? "—"}</strong></span><button type="button" onClick={onToggleHaptics}>Haptics <strong>{hapticsEnabled ? "On" : "Off"}</strong></button><div className="settings-host-list">{room.players.filter((player) => !player.isHost).map((player) => <button type="button" key={player.id} onClick={() => onTransferHost(player.id)}>Make {player.displayName} host</button>)}</div><button type="button" className="settings-leave" onClick={onLeave}>Leave room</button></div> : null}
    </header>
  );
}
