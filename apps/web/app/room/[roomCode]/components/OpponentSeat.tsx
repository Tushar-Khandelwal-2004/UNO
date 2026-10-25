"use client";

import type { PublicPlayer } from "@uno/protocol";
import { CardBack } from "./Card";

export function OpponentSeat({ player, isTurn, turnEndsAt, onCatchUno }: { player: PublicPlayer; isTurn: boolean; turnEndsAt?: number; onCatchUno?: () => void }) {
  return (
    <article aria-label={`${player.displayName}, ${player.cardCount} cards${isTurn ? ", their turn" : ""}`} className="relative w-[clamp(96px,10vw,140px)] text-center">
      <div className={`mx-auto inline-flex max-w-full items-center gap-2 rounded-button bg-[#121618]/90 px-2 py-1.5 text-left ${isTurn ? "turn-ring border border-uno-accent" : "border border-white/10"}`}>
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full border-2 border-uno-blue bg-[#7a4c31] font-extrabold ${player.connected ? "" : "grayscale opacity-50"}`}>{player.displayName.slice(0, 1).toUpperCase()}</span>
        <span className="min-w-0"><strong className="block max-w-24 truncate text-xs">{player.displayName}</strong><small className="block text-[10px] text-uno-muted">{player.cardCount} card{player.cardCount === 1 ? "" : "s"}</small></span>
        {isTurn && turnEndsAt ? <span className="grid h-7 w-7 place-items-center rounded-full border-2 border-uno-accent text-[10px] font-extrabold">{Math.max(0, Math.ceil((turnEndsAt - Date.now()) / 1000))}</span> : null}
      </div>
      {!player.connected ? <span className="absolute -right-1 top-0 rounded-full bg-uno-error px-1.5 py-0.5 text-[9px] font-extrabold text-[#351416]">OFFLINE</span> : null}
      <div className="mt-2 flex items-center justify-center gap-1"><div className="flex justify-center">{Array.from({ length: Math.min(player.cardCount, 5) }).map((_, index) => <CardBack key={`${player.id}-${index}`} className="-ml-6 first:ml-0 !h-[clamp(44px,6dvh,64px)] !w-[clamp(30px,3.2vw,44px)]" />)}</div>{player.cardCount > 0 ? <span className="grid min-h-7 min-w-7 place-items-center rounded-full border-2 border-uno-blue bg-[#14191c] px-1 text-xs font-extrabold">{player.cardCount}</span> : null}</div>
      {player.cardCount === 1 ? <div className="mt-2 flex items-center justify-center gap-1.5"><span className="rounded-full bg-uno-error px-2 py-0.5 text-[9px] font-extrabold uppercase text-[#351416]">UNO</span>{!player.unoCalled && onCatchUno ? <button type="button" onClick={onCatchUno} className="min-h-8 rounded-full bg-uno-error/20 px-2 text-[10px] font-extrabold text-uno-error hover:bg-uno-error/30">Catch</button> : null}</div> : null}
      {player.reaction ? <span className="mt-1 block text-[10px] font-extrabold capitalize text-uno-accent">{player.reaction.replaceAll("-", " ")}</span> : null}
    </article>
  );
}
