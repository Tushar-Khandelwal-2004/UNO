"use client";

import { useEffect, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { useRouter } from "next/navigation";
import type { PublicRoom } from "@uno/protocol";

const REALTIME_URL = process.env.NEXT_PUBLIC_REALTIME_URL ?? "http://localhost:4000";
type EntryMode = "choose" | "create" | "join";

function getGuestId(): string {
  const existing = window.localStorage.getItem("uno-guest-id");
  if (existing) return existing;
  const created = crypto.randomUUID();
  window.localStorage.setItem("uno-guest-id", created);
  return created;
}

export default function HomePage() {
  const router = useRouter();
  const [mode, setMode] = useState<EntryMode>("choose");
  const [displayName, setDisplayName] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [socket, setSocket] = useState<Socket | null>(null);

  useEffect(() => {
    return () => {
      socket?.disconnect();
    };
  }, [socket]);

  function connect(): Socket {
    const nextSocket = io(REALTIME_URL, { auth: { guestId: getGuestId() } });
    setSocket(nextSocket);
    return nextSocket;
  }

  function continueToRoom(room: PublicRoom, name: string) {
    window.localStorage.setItem(`uno-name:${room.code}`, name);
    window.localStorage.setItem("uno-last-room", room.code);
    router.push(`/room/${room.code}`);
  }

  function submit() {
    setError("");
    setBusy(true);
    const activeSocket = connect();
    const done = (result: { ok: boolean; room?: PublicRoom; message?: string }) => {
      setBusy(false);
      if (!result.ok || !result.room) {
        setError(result.message ?? "Unable to enter the room.");
        activeSocket.disconnect();
        return;
      }
      continueToRoom(result.room, displayName.trim());
    };

    if (mode === "create") {
      activeSocket.emit("room:create", { displayName }, done);
    } else {
      activeSocket.emit("room:join", { roomCode: roomCode.trim().toUpperCase(), displayName }, done);
    }
  }

  const canSubmit = displayName.trim().length > 0 && !busy && (mode === "create" || roomCode.trim().length === 6);

  return (
    <main className="fixed inset-0 grid place-items-center overflow-hidden bg-uno-background p-4 text-uno-text">
      <section className="w-full max-w-xl rounded-panel border border-white/15 bg-gradient-to-br from-[#30383d]/95 to-[#202528]/95 p-8 shadow-panel sm:p-14">
        <div className="mb-10 flex items-center gap-3">
          <span className="grid h-9 w-14 -rotate-6 place-items-center rounded-[50%] bg-gradient-to-br from-[#f6b900] via-[#ed2d42] to-[#457ce7] text-sm font-extrabold text-white">UNO</span>
          <span className="text-xs font-extrabold uppercase tracking-[.16em] text-uno-muted">Private rooms · No sign-in</span>
        </div>
        <h1 className="m-0 text-5xl font-extrabold tracking-[-.06em] sm:text-7xl">Ready to play?</h1>
        <p className="mb-9 mt-3 max-w-md text-base leading-7 text-uno-muted">Create a room for your friends or join an existing game with a room code.</p>

        {mode === "choose" ? (
          <div className="grid gap-3">
            <button className="flex items-center gap-4 rounded-panel border border-white/20 bg-gradient-to-r from-[#6e3b34] to-[#3f3030] p-4 text-left transition-transform hover:-translate-y-0.5 hover:border-uno-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-uno-accent" onClick={() => setMode("create")}>
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-button bg-white/15 text-3xl">＋</span>
              <span><strong className="block text-base">Create room</strong><small className="block text-sm text-white/75">Start a new game and invite friends</small></span>
            </button>
            <button className="flex items-center gap-4 rounded-panel border border-white/20 bg-gradient-to-r from-[#234e75] to-[#293a4c] p-4 text-left transition-transform hover:-translate-y-0.5 hover:border-uno-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-uno-accent" onClick={() => setMode("join")}>
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-button bg-white/15 text-3xl">→</span>
              <span><strong className="block text-base">Join room</strong><small className="block text-sm text-white/75">Enter a room code from a friend</small></span>
            </button>
          </div>
        ) : (
          <div className="grid gap-4">
            <div className="flex items-center gap-3">
              <button className="grid h-9 w-9 place-items-center rounded-full bg-white/10 text-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-uno-accent" onClick={() => { setMode("choose"); setError(""); }}>←</button>
              <div>
                <span className="text-xs font-extrabold uppercase tracking-[.16em] text-uno-muted">{mode === "create" ? "New game" : "Join game"}</span>
                <h2 className="m-1 text-2xl font-extrabold">{mode === "create" ? "Create your room" : "Join your friends"}</h2>
              </div>
            </div>
            <label className="grid gap-2 text-sm font-bold text-uno-muted">
              Your name
              <input className="min-h-11 rounded-button border border-white/20 bg-[#1c2225] px-3 text-uno-text outline-none focus:border-uno-accent focus:ring-2 focus:ring-uno-accent/30" autoFocus value={displayName} maxLength={20} onChange={(event) => setDisplayName(event.target.value)} placeholder="e.g. Card Shark" />
            </label>
            {mode === "join" ? (
              <label className="grid gap-2 text-sm font-bold text-uno-muted">
                Room code
                <input className="min-h-11 rounded-button border border-white/20 bg-[#1c2225] px-3 uppercase tracking-[.18em] text-uno-text outline-none focus:border-uno-accent focus:ring-2 focus:ring-uno-accent/30" value={roomCode} maxLength={6} onChange={(event) => setRoomCode(event.target.value.toUpperCase())} placeholder="ABC123" />
              </label>
            ) : null}
            <button className="min-h-11 rounded-button bg-uno-accent px-4 font-extrabold text-[#493600] transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-40" disabled={!canSubmit} onClick={submit}>{busy ? "Connecting…" : mode === "create" ? "Create room" : "Join room"}</button>
            {error ? <p className="m-0 text-sm text-uno-error">{error}</p> : null}
          </div>
        )}
      </section>
    </main>
  );
}
