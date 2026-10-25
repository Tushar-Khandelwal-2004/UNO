"use client";
import { useEffect, useState } from "react";

export function useOverflowWarning() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    const check = () => {
      const height = document.scrollingElement?.scrollHeight ?? 0;
      if (height > innerHeight + 1) console.warn("UNO viewport overflow", { height, innerHeight });
    };
    const frame = requestAnimationFrame(check);
    window.addEventListener("resize", check);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("resize", check); };
  });
}

export function useViewport() {
  const [size, setSize] = useState({ width: 0, height: 0, reduced: false });
  useOverflowWarning();
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setSize({ width: innerWidth, height: visualViewport?.height ?? innerHeight, reduced: media.matches });
    update();
    window.addEventListener("resize", update);
    visualViewport?.addEventListener("resize", update);
    media.addEventListener("change", update);
    return () => {
      window.removeEventListener("resize", update);
      visualViewport?.removeEventListener("resize", update);
      media.removeEventListener("change", update);
    };
  }, []);
  return { ...size, short: size.height < 480 && size.width > size.height, phone: size.width < 640, portrait: size.width < size.height };
}
