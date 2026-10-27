"use client";

import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import type { Card as UnoCard } from "@uno/game-engine";

const CARD_BASE = "relative isolate grid shrink-0 place-items-center overflow-hidden rounded-card border-[3px] border-white text-white shadow-card transition-transform duration-150 ease-out focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-uno-accent/80";
const CARD_TONES: Record<UnoCard["color"], string> = {
  red: "bg-gradient-to-br from-card-red-start to-card-red-end",
  yellow: "bg-gradient-to-br from-card-yellow-start to-card-yellow-end",
  green: "bg-gradient-to-br from-card-green-start to-card-green-end",
  blue: "bg-gradient-to-br from-card-blue-start to-card-blue-end",
  wild: "bg-gradient-to-br from-card-wild-start to-card-wild-end",
};

export type CardVariant = "hand" | "discard" | "ghost" | "picker";

interface CardProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  card: UnoCard;
  variant?: CardVariant;
  legal?: boolean;
  isMyTurn?: boolean;
  selected?: boolean;
  shaking?: boolean;
  cardStyle?: CSSProperties;
  children?: ReactNode;
}

function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

export function cardLabel(card: UnoCard): string {
  if (card.kind === "number") return String(card.value);
  if (card.kind === "wildDraw4") return "+4";
  if (card.kind === "draw2") return "+2";
  if (card.kind === "skip") return "Skip";
  if (card.kind === "reverse") return "Reverse";
  return "Wild";
}

export function cardAriaLabel(card: UnoCard): string {
  const color = card.color === "wild" ? "Wild" : `${card.color.charAt(0).toUpperCase()}${card.color.slice(1)}`;
  return `${color} ${cardLabel(card).toLowerCase()} card`;
}

function CardIcon({ card }: { card: UnoCard }) {
  if (card.kind === "number") return <span className="card-number">{card.value}</span>;
  if (card.kind === "wild" || card.kind === "wildDraw4") return <span className="wild-icon"><span className="bg-red-500" /><span className="bg-yellow-300" /><span className="bg-blue-500" /><span className="bg-green-500" />{card.kind === "wildDraw4" ? <b>+4</b> : null}</span>;
  if (card.kind === "skip") return <svg aria-hidden="true" className="card-svg" viewBox="0 0 64 64" fill="none"><circle cx="32" cy="32" r="22" stroke="currentColor" strokeWidth="6" /><path d="M17 47 47 17" stroke="currentColor" strokeWidth="7" strokeLinecap="round" /></svg>;
  if (card.kind === "reverse") return <svg aria-hidden="true" className="card-svg" viewBox="0 0 64 64" fill="none"><path d="M12 24h35m0 0-9-9m9 9-9 9M52 40H17m0 0 9-9m-9 9 9 9" stroke="currentColor" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  return <svg aria-hidden="true" className="card-svg" viewBox="0 0 64 64" fill="none"><rect x="15" y="15" width="25" height="30" rx="4" stroke="currentColor" strokeWidth="5" /><path d="M26 11h23v30" stroke="currentColor" strokeWidth="5" /><path d="M45 25v14m-7-7h14" stroke="currentColor" strokeWidth="5" strokeLinecap="round" /></svg>;
}

export function Card({ card, variant = "hand", legal = false, isMyTurn = false, selected = false, shaking = false, cardStyle, className, children, ...buttonProps }: CardProps) {
  const interactive = variant === "hand";
  const stateClasses = interactive
    ? isMyTurn
      ? legal
        ? "legal-card cursor-grab hover:z-40 hover:-translate-y-3 hover:shadow-card-hover active:cursor-grabbing"
        : "cursor-not-allowed brightness-[.6] saturate-[.7]"
      : "cursor-default brightness-75 saturate-75"
    : "cursor-default";
  const { style: buttonStyle, ...restButtonProps } = buttonProps;
  const style = { ...cardStyle, ...buttonStyle, "--card-glow": `var(--color-card-${card.color}-end)` } as CSSProperties;
  return (
    <button
      type="button"
      data-card-id={card.id}
      data-card-legal={legal}
      aria-label={cardAriaLabel(card)}
      aria-pressed={selected}
      aria-disabled={interactive && (!isMyTurn || !legal)}
      className={cn(CARD_BASE, CARD_TONES[card.color], `h-[var(--card-height)] w-[var(--card-width)]`, stateClasses, selected && "z-40 -translate-y-3 scale-[1.04] shadow-card-hover ring-4 ring-uno-accent", shaking && "card-shake", variant === "discard" && "shadow-card-hover", variant === "ghost" && "pointer-events-none scale-[1.08] shadow-[0_22px_38px_rgb(0_0_0_/_55%)]", variant === "picker" && "h-36 w-24", className)}
      style={style}
      {...restButtonProps}
    >
      <span className="card-oval" />
      <span className="card-corner">{cardLabel(card)}</span>
      <CardIcon card={card} />
      <span className="card-corner card-corner-bottom">{cardLabel(card)}</span>
      {!legal && isMyTurn && interactive ? <span aria-hidden="true" className="card-slash" /> : null}
      {children}
    </button>
  );
}

export function CardBack({ dark = false, className }: { dark?: boolean; className?: string }) {
  return <span className={cn("uno-card-back relative grid h-[var(--card-height)] w-[var(--card-width)] shrink-0 place-items-center overflow-hidden rounded-card border-[3px] border-white/80 shadow-card", dark ? "uno-card-back-dark" : "", className)} aria-hidden="true"><span className="card-back-logo">UNO</span></span>;
}
