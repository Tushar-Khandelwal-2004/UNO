"use client";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

export function fitRow(count: number, width: number, desired: number, minimum: number) {
  if (!count) return { cardWidth: desired, step: 0, width: 0 };
  const cw = Math.max(minimum, Math.min(desired, width / (1 + .3 * (count - 1))));
  const step = count < 2 ? 0 : Math.min(cw + 6, (width - cw) / (count - 1));
  return { cardWidth: cw, step, width: cw + Math.max(0, count - 1) * step };
}

export function calculateHand(count: number, width: number, desired: number, minimum: number) {
  const oneRowCapacity = Math.max(1, Math.floor((width - minimum) / Math.max(30, minimum * .3)) + 1);
  const rows = count > oneRowCapacity ? 2 : 1;
  const capacity = rows === 2 ? Math.ceil(count / 2) : count;
  return { capacity, rows, perPage: count, pages: 1, desired, minimum, width };
}

export function useHandLayout(count: number, phone: boolean, short: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [measurement, setMeasurement] = useState({ width: 300, desired: 64 });
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      const probe = node.querySelector<HTMLElement>("[data-card-probe]");
      setMeasurement({ width: Math.max(48, node.clientWidth - 8), desired: probe?.getBoundingClientRect().width ?? 64 });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, [phone, short]);
  return useMemo(() => {
    const layout = calculateHand(count, measurement.width, measurement.desired, phone || short ? 48 : 56);
    const rowCount = layout.rows === 2 ? [Math.min(layout.capacity, count), Math.max(0, count - layout.capacity)] : [count];
    return {
      ref,
      ...layout,
      rowLayouts: rowCount.map((rowCountValue) => fitRow(rowCountValue, measurement.width, measurement.desired, layout.minimum)),
    };
  }, [count, measurement, phone, short]);
}
