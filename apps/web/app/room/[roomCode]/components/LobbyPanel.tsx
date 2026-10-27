"use client";

import type { PublicRoom } from "@uno/protocol";

export function LobbyPanel({ room, isHost, onStart, onTransferHost, onCopy }: { room: PublicRoom; isHost: boolean; onStart: () => void; onTransferHost: (playerId: string) => void; onCopy: () => void }) {
  const manyPlayers = room.players.length > 4;
  const hostName = room.players.find((player) => player.isHost)?.displayName ?? "the host";

  return (
    <div className="lobby-panel" data-layout-role="lobby-panel">
      <span className="lobby-kicker">Room lobby</span>
      <h1>Ready when you are?</h1>
      <p>{room.players.length < 2 ? "Invite at least one more player to unlock the match." : "Everyone is in. The host can start the table."}</p>
      <div className="lobby-code-row">
        <span className="lobby-code-label">Room code</span>
        <strong>{room.code}</strong>
        <button type="button" onClick={onCopy}>Copy</button>
      </div>
      <div className={`lobby-player-list ${manyPlayers ? "lobby-player-list-many" : ""}`} aria-label="Players in the room">
        {room.players.map((player) => (
          <div className="lobby-player" key={player.id}>
            <span className={`lobby-avatar ${player.connected ? "" : "offline"}`}>{player.displayName.slice(0, 1).toUpperCase()}</span>
            <span className="lobby-player-name">{player.displayName}</span>
            <span className="lobby-player-state">{player.isHost ? "Host" : player.connected ? "Ready" : "Offline"}</span>
            {isHost && !player.isHost ? <button type="button" className="make-host" onClick={() => onTransferHost(player.id)}>Make host</button> : null}
          </div>
        ))}
      </div>
      {isHost ? <button type="button" disabled={room.players.length < 2} onClick={onStart} className="lobby-start">Start game <span aria-hidden="true">→</span></button> : <div className="lobby-waiting">Waiting for {hostName} to start</div>}
    </div>
  );
}
