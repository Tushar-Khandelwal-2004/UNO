"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";

const HAND_GAP = 8;

export interface HandRowLayout {
  cardWidth: number;
  step: number;
  overlap: boolean;
  width: number;
}

function layoutRow(count: number, width: number, desired: number, minimum: number): HandRowLayout {
  if (!count) return { cardWidth: desired, step: desired + HAND_GAP, overlap: false, width: 0 };
  const available = Math.max(0, width);
  const normalWidth = count * desired + Math.max(0, count - 1) * HAND_GAP;
  if (normalWidth <= available) return { cardWidth: desired, step: desired + HAND_GAP, overlap: false, width: normalWidth };

  const maximumVisibleWidth = available / (1 + Math.max(0, count - 1) * 0.4);
  const cardWidth = Math.min(desired, maximumVisibleWidth);
  const step = count === 1 ? 0 : Math.max(cardWidth * 0.4, (available - cardWidth) / (count - 1));
  return {
    cardWidth: Math.max(minimum, cardWidth),
    step,
    overlap: true,
    width: cardWidth + Math.max(0, count - 1) * step,
  };
}

function canFitOneRow(count: number, width: number, desired: number, minimum: number): boolean {
  if (count <= 1) return true;
  return width / (1 + (count - 1) * 0.4) >= minimum;
}

export function useHandLayout(count: number, desiredCardWidth: number, phone: boolean, short: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  const minimum = phone || short ? 44 : 44;

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setWidth(Math.max(0, node.clientWidth - 16));
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, [phone, short]);

  return useMemo(() => {
    const rows = count > 0 && !canFitOneRow(count, width, desiredCardWidth, minimum) ? 2 : 1;
    const capacity = rows === 2 ? Math.ceil(count / 2) : count;
    const rowCounts = rows === 2 ? [capacity, Math.max(0, count - capacity)] : [count];
    return {
      ref,
      rows,
      capacity,
      rowLayouts: rowCounts.map((rowCount) => layoutRow(rowCount, width, desiredCardWidth, minimum)),
    };
  }, [count, desiredCardWidth, minimum, width]);
}
