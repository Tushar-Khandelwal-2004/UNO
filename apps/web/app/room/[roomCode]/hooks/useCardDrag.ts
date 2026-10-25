"use client";

import { useCallback, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent, type RefObject } from "react";
import type { Card } from "@uno/game-engine";

interface PointerState {
  card: Card;
  pointerId: number;
  startX: number;
  startY: number;
  dragging: boolean;
}

interface UseCardDragOptions {
  hand: Card[];
  legalCardIds: Set<string>;
  isMyTurn: boolean;
  onPlay: (card: Card) => void;
  onIllegalTap: (card: Card) => void;
  onLockedTap: () => void;
}

export interface CardDragState {
  dropTargetRef: RefObject<HTMLDivElement | null>;
  selectedCardId?: string;
  draggedCardId?: string;
  isDropActive: boolean;
  shakeCardId?: string;
  ghost?: { card: Card; x: number; y: number; rotation: number };
  clearSelection: () => void;
  dropSelectedCard: () => void;
  getCardProps: (card: Card) => {
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
    onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void;
    onPointerUp: (event: PointerEvent<HTMLButtonElement>) => void;
    onPointerCancel: () => void;
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
    onContextMenu: (event: MouseEvent<HTMLButtonElement>) => void;
    style: CSSProperties;
  };
}

const DRAG_THRESHOLD = 6;

function isInsideDropTarget(element: HTMLDivElement | null, x: number, y: number): boolean {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  return x >= rect.left - 24 && x <= rect.right + 24 && y >= rect.top - 24 && y <= rect.bottom + 24;
}

export function useCardDrag({ hand, legalCardIds, isMyTurn, onPlay, onIllegalTap, onLockedTap }: UseCardDragOptions): CardDragState {
  const dropTargetRef = useRef<HTMLDivElement | null>(null);
  const pointerRef = useRef<PointerState | undefined>(undefined);
  const [selectedCardId, setSelectedCardId] = useState<string>();
  const [draggedCardId, setDraggedCardId] = useState<string>();
  const [isDropActive, setIsDropActive] = useState(false);
  const [shakeCardId, setShakeCardId] = useState<string>();
  const [ghost, setGhost] = useState<CardDragState["ghost"]>();

  const showIllegalFeedback = useCallback((card: Card) => {
    setShakeCardId(card.id);
    onIllegalTap(card);
    window.setTimeout(() => setShakeCardId(undefined), 170);
  }, [onIllegalTap]);

  const clearDrag = useCallback(() => {
    pointerRef.current = undefined;
    setDraggedCardId(undefined);
    setIsDropActive(false);
    setGhost(undefined);
  }, []);

  const playOrSelect = useCallback((card: Card) => {
    if (!isMyTurn) {
      onLockedTap();
      return;
    }
    if (!legalCardIds.has(card.id)) {
      showIllegalFeedback(card);
      return;
    }
    if (selectedCardId === card.id) {
      setSelectedCardId(undefined);
      onPlay(card);
    } else {
      setSelectedCardId(card.id);
    }
  }, [isMyTurn, legalCardIds, onLockedTap, onPlay, selectedCardId, showIllegalFeedback]);

  const dropSelectedCard = useCallback(() => {
    if (!selectedCardId) return;
    const card = hand.find((candidate) => candidate.id === selectedCardId);
    if (card) onPlay(card);
  }, [hand, onPlay, selectedCardId]);

  const getCardProps = useCallback((card: Card) => {
    const legal = isMyTurn && legalCardIds.has(card.id);
    return {
      onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
        event.preventDefault();
        if (!isMyTurn) {
          onLockedTap();
          return;
        }
        if (!legal) {
          showIllegalFeedback(card);
          return;
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        pointerRef.current = { card, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, dragging: false };
      },
      onPointerMove: (event: PointerEvent<HTMLButtonElement>) => {
        const pointer = pointerRef.current;
        if (!pointer || pointer.pointerId !== event.pointerId) return;
        const distance = Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY);
        if (!pointer.dragging && distance > DRAG_THRESHOLD) {
          pointer.dragging = true;
          setDraggedCardId(card.id);
          setSelectedCardId(card.id);
        }
        if (!pointer.dragging) return;
        setGhost({ card, x: event.clientX, y: event.clientY, rotation: Math.max(-8, Math.min(8, (event.clientX - pointer.startX) / 18)) });
        setIsDropActive(isInsideDropTarget(dropTargetRef.current, event.clientX, event.clientY));
      },
      onPointerUp: (event: PointerEvent<HTMLButtonElement>) => {
        const pointer = pointerRef.current;
        if (!pointer || pointer.pointerId !== event.pointerId) return;
        if (pointer.dragging && isInsideDropTarget(dropTargetRef.current, event.clientX, event.clientY)) {
          setSelectedCardId(undefined);
          onPlay(card);
        } else if (!pointer.dragging) {
          playOrSelect(card);
        }
        clearDrag();
      },
      onPointerCancel: clearDrag,
      onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.key === "Escape") {
          setSelectedCardId(undefined);
          return;
        }
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        playOrSelect(card);
      },
      onContextMenu: (event: MouseEvent<HTMLButtonElement>) => event.preventDefault(),
      style: { touchAction: legal ? "none" : "auto" },
    };
  }, [clearDrag, isMyTurn, legalCardIds, onLockedTap, onPlay, playOrSelect, showIllegalFeedback]);

  return {
    dropTargetRef,
    selectedCardId,
    draggedCardId,
    isDropActive,
    shakeCardId,
    ghost,
    clearSelection: () => setSelectedCardId(undefined),
    dropSelectedCard,
    getCardProps,
  };
}
