"use client";

import { useEffect, useState } from "react";

type ViewportState = {
  width: number;
  height: number;
  reduced: boolean;
  cardWidth: number;
};

function getCardWidth(width: number, height: number, centerHeight: number): number {
  if (!width || !height) return 64;
  const base = Math.max(44, Math.min(96, Math.min(height * 0.105, width * 0.17)));
  if (!centerHeight || centerHeight >= base * 1.47 + 72) return base;
  return Math.max(44, Math.min(base, (centerHeight - 72) / 1.47));
}

export function useViewport() {
  const [size, setSize] = useState<ViewportState>({ width: 0, height: 0, reduced: false, cardWidth: 64 });

  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    const check = () => {
      const scrollHeight = document.scrollingElement?.scrollHeight ?? 0;
      if (scrollHeight > innerHeight + 1) console.warn("UNO viewport overflow", { scrollHeight, innerHeight });
    };
    const frame = requestAnimationFrame(check);
    window.addEventListener("resize", check);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", check);
    };
  }, []);

  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      const width = innerWidth;
      const height = visualViewport?.height ?? innerHeight;
      const centerHeight = document.querySelector<HTMLElement>("[data-layout-role='table'] .table-center-zone")?.clientHeight ?? 0;
      setSize({ width, height, reduced: media.matches, cardWidth: getCardWidth(width, height, centerHeight) });
    };
    const table = document.querySelector<HTMLElement>("[data-layout-role='table']");
    const observer = table ? new ResizeObserver(update) : undefined;
    if (table) observer?.observe(table);
    const mutationObserver = new MutationObserver(update);
    mutationObserver.observe(document.body, { childList: true, subtree: true });
    update();
    window.addEventListener("resize", update);
    visualViewport?.addEventListener("resize", update);
    media.addEventListener("change", update);
    return () => {
      observer?.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", update);
      visualViewport?.removeEventListener("resize", update);
      media.removeEventListener("change", update);
    };
  }, []);

  return {
    ...size,
    short: size.height < 480 && size.width > size.height,
    phone: size.width < 700,
    portrait: size.width < size.height,
  };
}
