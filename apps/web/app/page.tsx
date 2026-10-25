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
    <main className="landing-shell">
      <section className="landing-card">
        <div className="landing-brand">
          <span className="brand-mark">UNO</span>
          <span className="eyebrow">Private rooms · No sign-in</span>
        </div>
        <h1>Ready to play?</h1>
        <p className="landing-copy">Create a room for your friends or join an existing game with a room code.</p>

        {mode === "choose" ? (
          <div className="entry-options">
            <button className="entry-option create-option" onClick={() => setMode("create")}>
              <span className="entry-icon">＋</span>
              <span><strong>Create room</strong><small>Start a new game and invite friends</small></span>
            </button>
            <button className="entry-option join-option" onClick={() => setMode("join")}>
              <span className="entry-icon">→</span>
              <span><strong>Join room</strong><small>Enter a room code from a friend</small></span>
            </button>
          </div>
        ) : (
          <div className="entry-form">
            <div className="entry-form-heading">
              <button className="back-button" onClick={() => { setMode("choose"); setError(""); }}>←</button>
              <div>
                <span className="eyebrow">{mode === "create" ? "New game" : "Join game"}</span>
                <h2>{mode === "create" ? "Create your room" : "Join your friends"}</h2>
              </div>
            </div>
            <label>
              Your name
              <input autoFocus value={displayName} maxLength={20} onChange={(event) => setDisplayName(event.target.value)} placeholder="e.g. Card Shark" />
            </label>
            {mode === "join" ? (
              <label>
                Room code
                <input value={roomCode} maxLength={6} onChange={(event) => setRoomCode(event.target.value.toUpperCase())} placeholder="ABC123" />
              </label>
            ) : null}
            <button className="button primary-action" disabled={!canSubmit} onClick={submit}>{busy ? "Connecting…" : mode === "create" ? "Create room" : "Join room"}</button>
            {error ? <p className="error">{error}</p> : null}
          </div>
        )}
      </section>
    </main>
  );
}
